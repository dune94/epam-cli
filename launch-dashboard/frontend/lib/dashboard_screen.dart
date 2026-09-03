import 'dart:async';
import 'package:flutter/material.dart';
import 'theme.dart';
import 'api.dart';
import 'config.dart';
import 'status_dot.dart';

/// The grid, and the one form that starts a run.
class DashboardScreen extends StatefulWidget {
  final Api api;
  final String who;
  final VoidCallback onLogout;
  const DashboardScreen({
    super.key,
    required this.api,
    required this.who,
    required this.onLogout,
  });

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _ticket = TextEditingController();
  bool _pauseAfterMint = false;
  bool _pauseBeforeWriter = false;
  List<Run> _runs = [];
  List<ProviderSetInfo> _providerSets = [];
  /// NO PRESELECTION, EVER. A guessed vendor is how MiniMax reached a claude run — the same rule
  /// applies here: the operator must choose explicitly, every time, or Save stays blocked.
  String? _providerSet;
  String? _error;
  bool _saving = false;
  Timer? _poll;
  Timer? _retry;
  /// True only when the API did not answer at all — distinct from an error it DID answer with.
  bool _offline = false;

  @override
  void initState() {
    super.initState();
    _refresh();
    _loadProviderSets();
    // The grid is a live view of something that takes minutes. Polling is enough — a websocket
    // would be a dependency and a reconnection story for a five-second refresh.
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _refresh(quiet: true));
  }

  Future<void> _loadProviderSets() async {
    try {
      final sets = await widget.api.listProviderSets();
      if (mounted) setState(() => _providerSets = sets);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      // Same "unreachable, not wrong" treatment as _refresh: the periodic poll's retry logic will
      // eventually reach the API again and _refresh's own offline banner already says so. Nothing
      // else to do here but try once more shortly.
      Future.delayed(const Duration(seconds: 3), _loadProviderSets);
    }
  }

  @override
  void dispose() { _poll?.cancel(); _retry?.cancel(); super.dispose(); }

  /// A DEAD API IS RETRIED, NOT REPORTED AND ABANDONED.
  ///
  /// "API offline" appeared while the nginx container was being recreated — a gap of a few seconds
  /// — and then stayed on screen until someone reloaded the page, because the next poll was five
  /// seconds away and quiet polls never cleared the message. An outage the operator has to
  /// hand-clear is indistinguishable from one that never ended.
  ///
  /// While unreachable, this retries every three seconds and recovers on its own. The banner says
  /// it is retrying rather than implying nothing is happening, and the last known rows stay on
  /// screen throughout: an empty grid would claim there are no runs, which is a different and
  /// wrong statement.
  void _scheduleRetry() {
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 3), () => _refresh(quiet: true));
  }

  Future<void> _refresh({bool quiet = false}) async {
    try {
      final rows = await widget.api.listRuns();
      _retry?.cancel();
      _retry = null;
      // RECOVERY CLEARS THE BANNER even on a quiet poll. Clearing only on a loud refresh is what
      // left the offline message up after the API came back.
      if (mounted) {
        setState(() {
          _runs = rows;
          _offline = false;
          if (!quiet || _error != null) _error = null;
        });
      }
      return;
    } on ApiException catch (e) {
      // THE SERVER ANSWERED, so this is not an outage and retrying every three seconds would only
      // repeat a refusal. It is reported and left alone.
      if (mounted) setState(() { _offline = false; _error = e.message; });
    } catch (e) {
      // UNREACHABLE: no response at all. The grid keeps its last known rows — an empty grid would
      // claim there are no runs, which is a different and wrong statement — and the retry runs
      // until it comes back.
      if (mounted) setState(() { _offline = true; _error = null; });
      _scheduleRetry();
    }
  }

  Future<void> _act(Future<void> Function() f) async {
    setState(() { _saving = true; _error = null; });
    try {
      await f();
      await _refresh();
    } on ApiException catch (e) {
      setState(() => _error = e.message);       // verbatim: a 409 names what is blocking
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  bool get _somethingRunning => _runs.any((r) => r.isActive);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text(appTitle, style: Theme.of(context).textTheme.titleLarge),
            const Spacer(),
            Text(widget.who, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(width: 14),
            // IF THERE IS A LOGIN THERE IS A LOGOUT. It also clears the stored password, which is
            // the only way to remove it from this browser short of clearing site data.
            TextButton(
              onPressed: widget.onLogout,
              style: TextButton.styleFrom(foregroundColor: Palette.muted),
              child: const Text('log out'),
            ),
          ]),
          const SizedBox(height: 18),
          _newRunForm(),
          if (_offline) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Palette.surface,
                border: Border.all(color: Palette.amber),
              ),
              // AMBER, NOT RED: nothing has failed, the page simply cannot reach the API yet and is
              // still trying. Red is reserved for a run that actually failed.
              child: const Text(
                'api unreachable — retrying every 3s, the rows below are the last known state',
                style: TextStyle(color: Palette.amber),
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Palette.surface,
                border: Border.all(color: Palette.red),
              ),
              child: Text(_error!, style: const TextStyle(color: Palette.red)),
            ),
          ],
          const SizedBox(height: 22),
          Expanded(child: _grid()),
        ]),
      ),
    );
  }

  Widget _newRunForm() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Palette.surface, border: Border.all(color: Palette.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: TextField(
              controller: _ticket,
              decoration: const InputDecoration(labelText: 'jira ticket id'),
              onSubmitted: (_) => _create(),
            ),
          ),
          const SizedBox(width: 12),
          FilledButton(
            onPressed: (_saving || _somethingRunning || _providerSet == null) ? null : _create,
            style: FilledButton.styleFrom(
              backgroundColor: Palette.green, foregroundColor: Palette.bg),
            child: const Text('save'),
          ),
        ]),
        const SizedBox(height: 6),
        Row(children: [
          _providerSetDropdown(
            value: _providerSet,
            options: _providerSets,
            onChanged: (v) => setState(() => _providerSet = v),
          ),
          const SizedBox(width: 18),
          _check('pause after roster mint', _pauseAfterMint,
              (v) => setState(() => _pauseAfterMint = v)),
          const SizedBox(width: 18),
          _check('pause before writer', _pauseBeforeWriter,
              (v) => setState(() => _pauseBeforeWriter = v)),
        ]),
        if (_somethingRunning)
          // Said BEFORE the click, not after a 409. The backend still enforces it — this is
          // courtesy, not the control.
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('a run is in progress — one at a time',
                style: TextStyle(color: Palette.muted, fontSize: 12)),
          )
        else if (_providerSet == null && _providerSets.isNotEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text('choose a provider set — never guessed',
                style: TextStyle(color: Palette.muted, fontSize: 12)),
          ),
      ]),
    );
  }

  /// [value] null means "nothing chosen" — the caller decides what that means (blocks Save on the
  /// new-launch form; means "keep the paused run's own set" in the resume dialog).
  Widget _providerSetDropdown({
    required String? value,
    required List<ProviderSetInfo> options,
    required ValueChanged<String?> onChanged,
    String? unselectedLabel,
  }) {
    return DropdownButton<String>(
      value: value,
      hint: Text(unselectedLabel ?? 'provider set', style: const TextStyle(fontSize: 12)),
      items: options
          .map((s) => DropdownMenuItem(
                value: s.name,
                child: Text(s.name, style: const TextStyle(fontSize: 12)),
              ))
          .toList(),
      onChanged: options.isEmpty ? null : onChanged,
    );
  }

  Widget _check(String label, bool value, ValueChanged<bool> onChanged) {
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Checkbox(value: value, onChanged: (v) => onChanged(v ?? false)),
      Text(label, style: const TextStyle(fontSize: 12)),
    ]);
  }

  Future<void> _create() async {
    final t = _ticket.text.trim();
    if (t.isEmpty) { setState(() => _error = 'a jira ticket id is required'); return; }
    final ps = _providerSet;
    if (ps == null) { setState(() => _error = 'a provider set is required'); return; }
    await _act(() async {
      await widget.api.createRun(
        ticket: t, requestedBy: widget.who, providerSet: ps,
        pauseAfterMint: _pauseAfterMint, pauseBeforeWriter: _pauseBeforeWriter,
      );
      _ticket.clear();
      setState(() => _providerSet = null); // no carry-over — the next launch chooses again
    });
  }

  /// Resume's picker excludes mockserver: the no-pay rehearsal set is never a live-run swap
  /// target, so an operator cannot land a real, paused run on the mock endpoint by mistake.
  List<ProviderSetInfo> get _resumeSafeProviderSets =>
      _providerSets.where((s) => s.name != 'mockserver').toList();

  /// Show params, get explicit confirmation, THEN act — the same rule that gates every launch.
  /// Pre-selected to the paused run's OWN set: continuing unchanged is one click, a swap is a
  /// second one, and no vendor is ever silently guessed.
  Future<void> _confirmResume(Run r) async {
    String? chosen = r.providerSet;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialogState) => AlertDialog(
          title: Text('resume ${r.ticket}'),
          content: Row(mainAxisSize: MainAxisSize.min, children: [
            const Text('provider set:', style: TextStyle(fontSize: 12)),
            const SizedBox(width: 10),
            _providerSetDropdown(
              value: chosen,
              options: _resumeSafeProviderSets,
              unselectedLabel: 'choose a set',
              onChanged: (v) => setDialogState(() => chosen = v),
            ),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('cancel')),
            FilledButton(
              onPressed: chosen == null ? null : () => Navigator.pop(ctx, true),
              child: const Text('resume'),
            ),
          ],
        ),
      ),
    );
    if (confirmed != true) return;
    await _act(() async { await widget.api.resume(r.id, widget.who, providerSet: chosen); });
  }

  Widget _grid() {
    if (_runs.isEmpty) {
      return const Center(child: Text('no runs yet', style: TextStyle(color: Palette.muted)));
    }
    return ListView.separated(
      itemCount: _runs.length,
      separatorBuilder: (_, __) => const Divider(color: Palette.border, height: 1),
      itemBuilder: (_, i) => _row(_runs[i]),
    );
  }

  Widget _row(Run r) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(children: [
        SizedBox(width: 150, child: Text(r.ticket)),
        SizedBox(width: 280, child: StatusDot(r)),
        SizedBox(width: 120,
          child: Text(r.requestedBy, style: Theme.of(context).textTheme.bodySmall)),
        SizedBox(width: 100,
          child: Text(r.codeLevel ?? '', style: Theme.of(context).textTheme.bodySmall)),
        SizedBox(width: 100,
          child: Text(r.providerSet ?? '', style: Theme.of(context).textTheme.bodySmall)),
        Expanded(
          child: Text(
            [
              if (r.pauseAfterMint) 'pause1',
              if (r.pauseBeforeWriter) 'pause2',
              if (r.detail?.isNotEmpty ?? false) r.detail!,
            ].join(' · '),
            style: Theme.of(context).textTheme.bodySmall,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (r.canStop) _action('stop', () => widget.api.stop(r.id), Palette.red),
        // Resume is offered only when the runId exists. Without it a resume would start a FRESH
        // run and reset the codeline, so the button is absent rather than allowed to fail.
        // Opens a dialog rather than firing immediately: the operator confirms (or swaps) the
        // provider set every time, the same "show params, get explicit confirmation" rule as a
        // new launch.
        if (r.canResume)
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: OutlinedButton(
              onPressed: _saving ? null : () => _confirmResume(r),
              style: OutlinedButton.styleFrom(
                foregroundColor: Palette.green, side: const BorderSide(color: Palette.green),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                minimumSize: Size.zero),
              child: const Text('resume', style: TextStyle(fontSize: 12)),
            ),
          ),
        if (r.canReplay) _action('replay', () async { await widget.api.replay(r.id, widget.who); }),
      ]),
    );
  }

  Widget _action(String label, Future<void> Function() f, [Color colour = Palette.green]) {
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: OutlinedButton(
        onPressed: _saving ? null : () => _act(f),
        style: OutlinedButton.styleFrom(
          foregroundColor: colour, side: BorderSide(color: colour),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          minimumSize: Size.zero),
        child: Text(label, style: const TextStyle(fontSize: 12)),
      ),
    );
  }
}
