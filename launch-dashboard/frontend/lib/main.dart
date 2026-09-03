import 'package:flutter/material.dart';
import 'theme.dart';
import 'api.dart';
import 'login_screen.dart';
import 'dashboard_screen.dart';

/// The API base is injected at build time so the same bundle can be served anywhere:
///   flutter build web --dart-define=API_BASE=http://host:8099
/// Defaults to same-origin, which is what the nginx image serves.
const apiBase = String.fromEnvironment('API_BASE', defaultValue: '');

void main() => runApp(const LaunchDashboardApp());

class LaunchDashboardApp extends StatefulWidget {
  const LaunchDashboardApp({super.key});
  @override
  State<LaunchDashboardApp> createState() => _LaunchDashboardAppState();
}

class _LaunchDashboardAppState extends State<LaunchDashboardApp> {
  Api? _api;
  String _who = '';

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'epam · run dashboard',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: _api == null
          ? LoginScreen(
              apiBase: apiBase,
              onAuthenticated: (api, who) => setState(() { _api = api; _who = who; }),
            )
          : DashboardScreen(api: _api!, who: _who),
    );
  }
}
