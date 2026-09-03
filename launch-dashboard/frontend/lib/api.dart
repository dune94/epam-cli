import 'dart:convert';
import 'package:http/http.dart' as http;

/// One run, as the backend records it.
///
/// Field names mirror the API exactly. Renaming here would create a second definition of the same
/// fact, and two definitions drift.
class Run {
  final String id;
  final String ticket;
  final String requestedBy;
  final String status;
  final String? stage;
  final String? runId;
  final String? detail;
  final String? codeLevel;
  final String? providerSet;
  final bool pauseAfterMint;
  final bool pauseBeforeWriter;
  final String createdAt;
  final String updatedAt;

  Run.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        ticket = j['ticket'] as String,
        requestedBy = (j['requestedBy'] ?? '') as String,
        status = j['status'] as String,
        stage = j['stage'] as String?,
        runId = j['runId'] as String?,
        detail = j['detail'] as String?,
        codeLevel = j['codeLevel'] as String?,
        providerSet = j['providerSet'] as String?,
        pauseAfterMint = (j['pauseAfterMint'] ?? 0) == 1,
        pauseBeforeWriter = (j['pauseBeforeWriter'] ?? 0) == 1,
        createdAt = (j['createdAt'] ?? '') as String,
        updatedAt = (j['updatedAt'] ?? '') as String;

  bool get isActive => status == 'pending' || status == 'running' || status == 'stopping';
  bool get isPaused => status == 'paused';
  bool get isFinished => !isActive && !isPaused;

  /// A paused run is resumable ONLY if it recorded the pipeline runId. Resuming without it would
  /// launch a FRESH run — which on a brownfield defect resets the codeline and discards committed
  /// work. That happened live on 2026-09-02, so the button is hidden rather than allowed to fail.
  bool get canResume => isPaused && (runId?.isNotEmpty ?? false);
  bool get canReplay => isFinished;
  bool get canStop => isActive;
}

/// One entry from GET /api/provider-sets — read live from orchestrations/config/provider-sets.json,
/// never a hardcoded list, so a 5th set added there needs no change here.
class ProviderSetInfo {
  final String name;
  final String description;
  ProviderSetInfo.fromJson(Map<String, dynamic> j)
      : name = j['name'] as String,
        description = (j['description'] ?? '') as String;
}

class ApiException implements Exception {
  final int status;
  final String message;
  ApiException(this.status, this.message);
  @override
  String toString() => message;
}

class Api {
  final String base;
  String password;
  Api(this.base, this.password);

  Map<String, String> get _headers => {
        'content-type': 'application/json',
        'authorization': 'Bearer $password',
      };

  Future<List<Run>> listRuns() async {
    final r = await http.get(Uri.parse('$base/api/runs'), headers: _headers);
    _check(r);
    return (jsonDecode(r.body) as List)
        .map((e) => Run.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<ProviderSetInfo>> listProviderSets() async {
    final r = await http.get(Uri.parse('$base/api/provider-sets'), headers: _headers);
    _check(r);
    return (jsonDecode(r.body) as List)
        .map((e) => ProviderSetInfo.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<Run> createRun({
    required String ticket,
    required String requestedBy,
    required String providerSet,
    bool pauseAfterMint = false,
    bool pauseBeforeWriter = false,
  }) async {
    final r = await http.post(Uri.parse('$base/api/runs'),
        headers: _headers,
        body: jsonEncode({
          'ticket': ticket,
          'requestedBy': requestedBy,
          'providerSet': providerSet,
          'pauseAfterMint': pauseAfterMint,
          'pauseBeforeWriter': pauseBeforeWriter,
        }));
    _check(r);
    return Run.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  Future<void> stop(String id) async =>
      _check(await http.post(Uri.parse('$base/api/runs/$id/stop'), headers: _headers));

  /// providerSet is OPTIONAL: absent continues with the paused run's own set (never a guess — a
  /// carry-forward of a choice already made). Given, it is a swap.
  Future<Run> resume(String id, String by, {String? providerSet}) =>
      _post('$base/api/runs/$id/resume', by, extra: providerSet == null ? null : { 'providerSet': providerSet });
  Future<Run> replay(String id, String by) => _post('$base/api/runs/$id/replay', by);

  Future<Run> _post(String url, String requestedBy, {Map<String, dynamic>? extra}) async {
    final r = await http.post(Uri.parse(url),
        headers: _headers, body: jsonEncode({'requestedBy': requestedBy, ...?extra}));
    _check(r);
    return Run.fromJson(jsonDecode(r.body) as Map<String, dynamic>);
  }

  /// The backend's message is surfaced VERBATIM. A 409 says what is blocking — "A-1 is already
  /// running (started ...)". Rewriting that to "busy" here would throw away the only useful part.
  void _check(http.Response r) {
    if (r.statusCode >= 200 && r.statusCode < 300) return;
    String msg;
    try {
      msg = (jsonDecode(r.body) as Map<String, dynamic>)['error']?.toString() ?? r.body;
    } catch (_) {
      msg = r.body.isEmpty ? 'HTTP ${r.statusCode}' : r.body;
    }
    throw ApiException(r.statusCode, msg);
  }
}
