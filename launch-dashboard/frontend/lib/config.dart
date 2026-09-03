/// WHAT THIS BUNDLE IS TOLD AT BUILD TIME, in one place.
///
/// Both values are injected with --dart-define, so the same source produces a bundle for any
/// installation without an edit:
///
///     flutter build web --dart-define=API_BASE=http://host:8099 --dart-define=APP_TITLE='...'
///
/// They live here rather than in main.dart because the login screen needs the title too, and
/// reaching into main.dart from a screen it constructs is a cycle. The title was previously the
/// literal 'epam · run dashboard' in BOTH files — declared twice, which is how two copies of one
/// string drift apart.
library;

/// Empty means same-origin, which is what the nginx image serves: it proxies /api to the backend,
/// so the browser never needs to know where the API lives and there is no CORS surface.
const apiBase = String.fromEnvironment('API_BASE', defaultValue: '');

/// The name shown on the login screen and in the browser tab.
///
/// THE FALLBACK NAMES NO PROJECT, deliberately. A Jira programme key identifies one client's
/// engagement; compiling it in would ship it to whoever installs next. It belongs in .env as
/// LAUNCH_TITLE, which the compose build passes through as APP_TITLE.
const appTitle = String.fromEnvironment('APP_TITLE', defaultValue: 'run dashboard');
