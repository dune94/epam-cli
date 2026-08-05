#!/usr/bin/env bash
# service-urls.sh — resolve a service endpoint from configuration, never from a literal.
#
# Ports for the dashboard, Langfuse, Grafana and friends were written into 20+ code sites.
# Moving a service to a different port meant finding every copy, and missing one produced a
# health check that passed against a service nobody was using.
#
# Order: the service's own env var (so a machine can differ without editing anything), then
# orchestrations/config/services.json. No default is invented here — an unknown service
# name returns empty and the caller decides, rather than this file guessing a port.
#
# Usage:  . lib/service-urls.sh ; url="$(service_url dashboard)"

_service_config_path() {
  local dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
  local candidate
  for _ in 1 2 3 4 5; do
    candidate="$dir/orchestrations/config/services.json"
    [ -f "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    candidate="$dir/config/services.json"
    [ -f "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    dir="$(dirname "$dir")"
    [ "$dir" = "/" ] && break
  done
  return 1
}

# service_url <name>
service_url() {
  local name="${1:?service name required}" cfg env_name url

  cfg="$(_service_config_path)" || {
    echo "[service-urls] orchestrations/config/services.json not found — cannot resolve '${name}'" >&2
    return 1
  }

  # The env var this service declares takes precedence, so a differing machine needs no edit.
  env_name="$(jq -r --arg n "$name" '.services[$n].env // empty' "$cfg" 2>/dev/null)"
  if [ -n "$env_name" ]; then
    url="$(printf '%s' "${!env_name:-}")"
    [ -n "$url" ] && { printf '%s' "$url"; return 0; }
  fi

  url="$(jq -r --arg n "$name" '.services[$n].url // empty' "$cfg" 2>/dev/null)"
  if [ -z "$url" ]; then
    echo "[service-urls] no service '${name}' in ${cfg} — add it there rather than writing a URL in code" >&2
    return 1
  fi
  printf '%s' "$url"
}
