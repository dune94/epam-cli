# The UI: a Flutter web bundle served by nginx. Two stages so the 40MB of build tooling does not
# ship — only the compiled bundle does.
FROM ghcr.io/cirruslabs/flutter:stable AS build
WORKDIR /app
COPY pubspec.yaml ./
RUN flutter pub get
COPY . .
# THE TITLE NAMES THE INSTALLATION, so it is a build ARG rather than a literal: it identifies one
# client's programme, and this image is built from source that ships to whoever installs next.
#
# No default here. An empty APP_TITLE falls back to the project-neutral wording in config.dart —
# never to another client's programme name accidentally left behind in a Dockerfile.
ARG APP_TITLE=

# API_BASE empty means same-origin: nginx proxies /api to the backend, so the browser never needs
# to know where the API lives and there is no CORS surface.
RUN flutter build web --release --dart-define=API_BASE= --dart-define=APP_TITLE="$APP_TITLE"

FROM nginx:alpine
COPY --from=build /app/build/web /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
