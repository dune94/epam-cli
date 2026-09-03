import 'package:flutter/material.dart';
import 'theme.dart';
import 'api.dart';
import 'config.dart';
import 'session.dart';
import 'login_screen.dart';
import 'dashboard_screen.dart';

export 'config.dart' show apiBase, appTitle;

void main() => runApp(const LaunchDashboardApp());

class LaunchDashboardApp extends StatefulWidget {
  const LaunchDashboardApp({super.key});
  @override
  State<LaunchDashboardApp> createState() => _LaunchDashboardAppState();
}

/// Which of the three things the app is doing on this frame.
///
/// A saved session has to be CHECKED before it is trusted — the password may have been changed on
/// the server since it was stored. Without a restoring state the app would flash the login screen
/// on every refresh before replacing it, which looks exactly like the bug this fixes.
enum _Phase { restoring, loggedOut, loggedIn }

class _LaunchDashboardAppState extends State<LaunchDashboardApp> {
  _Phase _phase = _Phase.restoring;
  Api? _api;
  String _who = '';

  @override
  void initState() {
    super.initState();
    _restore();
  }

  /// Re-authenticate from stored credentials, and VERIFY them against the server.
  ///
  /// listRuns() is the cheapest call that proves the password is still accepted. A stored password
  /// the server now rejects is silently discarded and the login screen shown — never left in place
  /// to fail later on the click that starts a run.
  Future<void> _restore() async {
    final saved = Session.read();
    if (saved == null) {
      setState(() => _phase = _Phase.loggedOut);
      return;
    }
    final api = Api(apiBase, saved.password);
    try {
      await api.listRuns();
      if (!mounted) return;
      setState(() { _api = api; _who = saved.who; _phase = _Phase.loggedIn; });
    } on ApiException {
      // The password no longer works. Drop it rather than keep prompting against a dead one.
      Session.clear();
      if (mounted) setState(() => _phase = _Phase.loggedOut);
    } catch (_) {
      // THE SERVER BEING UNREACHABLE IS NOT A BAD PASSWORD, so the session is kept. The dashboard
      // shows its own connection error, which says what is actually wrong. Clearing here would log
      // someone out over a momentary blip.
      if (!mounted) return;
      setState(() { _api = api; _who = saved.who; _phase = _Phase.loggedIn; });
    }
  }

  void _logout() {
    Session.clear();
    setState(() { _api = null; _who = ''; _phase = _Phase.loggedOut; });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: appTitle,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: switch (_phase) {
        // Deliberately bare: this is on screen for one request, and a spinner that flashes is
        // noisier than a background that does not.
        _Phase.restoring => const Scaffold(body: SizedBox.shrink()),
        _Phase.loggedOut => LoginScreen(
            apiBase: apiBase,
            onAuthenticated: (api, who) {
              setState(() { _api = api; _who = who; _phase = _Phase.loggedIn; });
            },
          ),
        _Phase.loggedIn => DashboardScreen(api: _api!, who: _who, onLogout: _logout),
      },
    );
  }
}
