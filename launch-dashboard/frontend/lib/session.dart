import 'package:web/web.dart' as web;

/// THE SESSION SURVIVES A REFRESH, because losing it on F5 is not a security control.
///
/// Before this, the whole app state lived in memory: a refresh, a crashed tab, or a laptop waking
/// up put you back on the login screen while a run was going. On an operational surface whose job
/// is telling you whether a run is still alive, being logged out at the moment you look at it is
/// the worst possible time.
///
/// WHAT IS STORED, PLAINLY: this API authenticates with the shared password sent as a bearer token
/// on every request — there is no token exchange to persist instead, so persisting the session
/// means persisting that password in the browser's localStorage. The trade is deliberate and worth
/// stating rather than hiding:
///
///   - localStorage is readable by any script on this origin, so a cross-site-scripting hole in
///     this page would expose the password. The page loads no third-party script and no user
///     content, which is what keeps that narrow.
///   - It is per-browser and per-origin: it never travels, and Logout removes it.
///   - It is a SHARED operational password for an internal tool, not a personal credential.
///
/// If this ever needs to be stronger, the fix is a real session token issued by the API with an
/// expiry — not moving this same password somewhere marginally less visible.
class Session {
  static const _keyPassword = 'launch.password';
  static const _keyWho = 'launch.who';

  /// The stored credentials, or null when nothing is saved.
  ///
  /// Storage can THROW rather than return null — Safari in private mode, and any browser with site
  /// data blocked, raise on access. A dashboard that will not paint because it could not read a
  /// convenience cache is a worse failure than asking someone to log in again.
  static ({String password, String who})? read() {
    try {
      final p = web.window.localStorage.getItem(_keyPassword);
      final w = web.window.localStorage.getItem(_keyWho);
      if (p == null || p.isEmpty || w == null || w.isEmpty) return null;
      return (password: p, who: w);
    } catch (_) {
      return null;
    }
  }

  static void save(String password, String who) {
    try {
      web.window.localStorage.setItem(_keyPassword, password);
      web.window.localStorage.setItem(_keyWho, who);
    } catch (_) {
      // Not fatal: the session simply will not survive the next refresh.
    }
  }

  static void clear() {
    try {
      web.window.localStorage.removeItem(_keyPassword);
      web.window.localStorage.removeItem(_keyWho);
    } catch (_) {
      // Nothing to do — and never block a logout on a storage error.
    }
  }
}
