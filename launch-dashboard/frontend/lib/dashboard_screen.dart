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
    // The grid is a live view of something that takes minutes. Polling is enough — a websocket
    // would be a dependency and a reconnection story for a five-second refresh.
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _refresh(quiet: true));
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
            onPressed: (_saving || _somethingRunning) ? null : _create,
            style: FilledButton.styleFrom(
              backgroundColor: Palette.green, foregroundColor: Palette.bg),
            child: const Text('save'),
          ),
        ]),
        const SizedBox(height: 6),
        Row(children: [
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
          ),
      ]),
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
    await _act(() async {
      await widget.api.createRun(
        ticket: t, requestedBy: widget.who,
        pauseAfterMint: _pauseAfterMint, pauseBeforeWriter: _pauseBeforeWriter,
      );
      _ticket.clear();
    });
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
        if (r.canResume) _action('resume', () async { await widget.api.resume(r.id, widget.who); }),
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
