import 'package:flutter/material.dart';
import 'theme.dart';
import 'api.dart';
import 'config.dart';
import 'session.dart';

/// A shared password, and the name of whoever is asking.
///
/// The name is not decoration and not authentication: a click here spends real money on a shared
/// key, and the question after "why is this expensive" is "who ran it". It is recorded on every run.
class LoginScreen extends StatefulWidget {
  final String apiBase;
  final void Function(Api api, String who) onAuthenticated;
  const LoginScreen({super.key, required this.apiBase, required this.onAuthenticated});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _password = TextEditingController();
  final _who = TextEditingController();
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    if (_password.text.isEmpty || _who.text.trim().isEmpty) {
      setState(() => _error = 'both a name and the password are required');
      return;
    }
    setState(() { _busy = true; _error = null; });
    final api = Api(widget.apiBase, _password.text);
    try {
      await api.listRuns();                       // the cheapest call that proves the password
      // SAVED ONLY AFTER THE SERVER ACCEPTED IT, so a rejected password is never persisted and
      // then replayed on the next refresh.
      Session.save(_password.text, _who.text.trim());
      widget.onAuthenticated(api, _who.text.trim());
    } on ApiException catch (e) {
      setState(() => _error = e.status == 401 ? 'that password was not accepted' : e.message);
    } catch (e) {
      setState(() => _error = 'cannot reach the server: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(appTitle, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 28),
            TextField(
              controller: _who,
              decoration: const InputDecoration(labelText: 'your name'),
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'password'),
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _busy ? null : _submit,
                style: FilledButton.styleFrom(
                  backgroundColor: Palette.green, foregroundColor: Palette.bg),
                child: Text(_busy ? 'checking…' : 'enter'),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!, style: const TextStyle(color: Palette.red)),
            ],
          ]),
        ),
      ),
    );
  }
}
