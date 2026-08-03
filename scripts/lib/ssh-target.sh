#!/usr/bin/env bash
# scripts/lib/ssh-target.sh
#
# Board directive (ALP-590): always connect to studio hosts via a
# ~/.ssh/config alias, never hardcode `-i <key>` or `user@host`/IP. LAN
# alias is tried first, falling back to the Tailscale alias if unreachable.
#
# Source this file, then call:
#   resolve_ssh_alias NAS_ALIAS alpha-nas-lan alpha-nas
#
# Sets the named variable to whichever alias answered. If the named
# variable is already set in the environment, that value is used as-is and
# the LAN/Tailscale probe is skipped entirely -- this is the escape hatch
# for overriding the target (e.g. NAS_ALIAS=alpha-nas to force Tailscale).
#
# Kept byte-identical to the render-stack repos' copy of this helper so the
# two don't drift; fix bugs in both.

_ssh_alias_reachable() {
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$1" true >/dev/null 2>&1
}

resolve_ssh_alias() {
  local __var="$1" __lan="$2" __ts="$3"
  local __current
  eval "__current=\${$__var:-}"
  if [ -n "$__current" ]; then
    echo "== $__var=$__current already set -- skipping LAN/Tailscale probe ==" >&2
    return 0
  fi

  echo "== Resolving $__var: probing $__lan (LAN) ==" >&2
  if _ssh_alias_reachable "$__lan"; then
    eval "$__var=$__lan"
    echo "   $__lan reachable -- using it." >&2
    return 0
  fi

  echo "   $__lan unreachable -- falling back to $__ts (Tailscale)" >&2
  if _ssh_alias_reachable "$__ts"; then
    eval "$__var=$__ts"
    echo "   $__ts reachable -- using it." >&2
    return 0
  fi

  echo "ERROR: neither $__lan (LAN) nor $__ts (Tailscale) answered SSH." >&2
  echo "  Check ~/.ssh/config has both Host entries and the target is powered on/reachable." >&2
  echo "  Escape hatch: set $__var explicitly to skip this probe." >&2
  return 1
}

# Print the HostName ~/.ssh/config resolves an alias to -- useful for
# building plain-HTTP URLs (e.g. curl health checks) that can't take an
# ssh alias directly.
ssh_alias_hostname() {
  ssh -G "$1" 2>/dev/null | awk '$1=="hostname"{print $2; exit}'
}
