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
  local name="${1:?service name required}" cfg env_name url state_var state_file port

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

  # THE INSTALL'S OWN PORT, if this is an isolated install. install.sh persists the port it
  # actually allocated for this service to .pipeline-services-state.env (see
  # isolated-compose-identity.sh) — the SAME file pre-run-reset.sh and pipeline-services.sh
  # already read for the subnet/project identity. Without this, every consumer of service_url()
  # silently fell through to the static default below, which is only correct for the hand-run dev
  # checkout. Confirmed live 2026-09-04, pipeline-tests-9: tier3-metrolinx-run.sh's own
  # observability preflight checked http://localhost:3100/3001 (the compose file's bare defaults)
  # against a stack actually running on 3120/3021, and aborted the launch — while curl against the
  # REAL ports showed both services healthy.
  state_var="$(jq -r --arg n "$name" '.services[$n].stateVar // empty' "$cfg" 2>/dev/null)"
  if [ -n "$state_var" ]; then
    # cfg is always "<root>/orchestrations/config/services.json" — strip that suffix to get root,
    # rather than re-deriving it a second way.
    state_file="${cfg%/orchestrations/config/services.json}/.pipeline-services-state.env"
    if [ -f "$state_file" ]; then
      port="$(sed -n "s/^${state_var}=//p" "$state_file" | head -1)"
      [ -n "$port" ] && { printf 'http://localhost:%s' "$port"; return 0; }
    fi
  fi

  url="$(jq -r --arg n "$name" '.services[$n].url // empty' "$cfg" 2>/dev/null)"
  if [ -z "$url" ]; then
    echo "[service-urls] no service '${name}' in ${cfg} — add it there rather than writing a URL in code" >&2
    return 1
  fi
  printf '%s' "$url"
}
