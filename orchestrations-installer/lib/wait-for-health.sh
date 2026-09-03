# wait-for-health.sh — is the service ACTUALLY up, not "did the launch command exit zero".
#
# `docker compose up -d` exits 0 the instant containers are CREATED, which is not the same moment
# they are ready to answer a request — and a client install that reports "ready" before a container
# has finished booting teaches the next click to fail against a service that isn't there yet.

# wait_for_health <url> [tries] [interval_secs]
#
# Polls a JSON health endpoint (expects {"ok":true}) until it answers or the tries are exhausted.
# Uses node rather than curl/wget: node is already a required prerequisite for this installer
# (checked earlier in install.sh), curl is not — this adds no new dependency.
wait_for_health() {
    local _url="$1" _tries="${2:-30}" _interval="${3:-1}"
    while [ "$_tries" -gt 0 ]; do
        if "${NODE_BIN:-node}" -e '
          const http = require("http");
          const req = http.get(process.argv[1], (res) => {
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => {
              process.exit(res.statusCode === 200 && /"ok"\s*:\s*true/.test(body) ? 0 : 1);
            });
          });
          req.on("error", () => process.exit(1));
          req.setTimeout(2000, () => { req.destroy(); process.exit(1); });
        ' "$_url" >/dev/null 2>&1; then
            return 0
        fi
        _tries=$((_tries - 1))
        [ "$_tries" -gt 0 ] && sleep "$_interval"
    done
    return 1
}
