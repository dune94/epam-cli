# The UI: a Flutter web bundle served by nginx. Two stages so the 40MB of build tooling does not
# ship — only the compiled bundle does.
FROM ghcr.io/cirruslabs/flutter:stable AS build
WORKDIR /app
COPY pubspec.yaml ./
RUN flutter pub get
COPY . .
# API_BASE empty means same-origin: nginx proxies /api to the backend, so the browser never needs
# to know where the API lives and there is no CORS surface.
RUN flutter build web --release --dart-define=API_BASE=

FROM nginx:alpine
COPY --from=build /app/build/web /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
