#!/bin/sh
# Set up Proxmox AI for your AI client — no Node, no npm, nothing to build.
#
#   ./install.sh --url https://proxmox.ai.id --key pak_...
#
# Verifies the key, saves it to ~/.proxmox-ai/config.json (owner only), puts `pmx` on your PATH, and copies
# the curl skill into ~/.claude/skills/ and ~/.codex/skills/ when those exist. Claude Code and Codex can then
# run `pmx` straight from the shell — no MCP server involved.
#
# The key saved here belongs to the `pmx` shell command alone. It is sent only to the platform URL you
# passed above, and the MCP plugin never reads it: inside Claude Code the plugin asks for the key itself
# and keeps it in Claude Code's own credential store.
#
# Prefer first-class MCP tools instead? Use: node server/install.mjs --url … --key …
# Using Claude Code? Install the plugin instead:
#   /plugin marketplace add hamimistimewa/proxmox-ai-mcp
#   /plugin install proxmox-ai
set -eu

URL="https://proxmox.ai.id"; KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:?--url needs a value}"; shift 2 ;;
    --key) KEY="${2:?--key needs a value}"; shift 2 ;;
    --url=*) URL="${1#--url=}"; shift ;;
    --key=*) KEY="${1#--key=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
# Asking is kinder than refusing, and the bootstrap already does it — doing it here too means
# --key is optional wherever you start from.
if [ -z "$KEY" ] && [ -r /dev/tty ]; then
  printf '\nPaste your Proxmox AI key (Dashboard -> API keys). It starts with pak_\nKey: '
  read KEY < /dev/tty || KEY=""
  KEY="$(printf '%s' "$KEY" | tr -d ' \t\r\n')"
  printf '\n'
fi
[ -n "$URL" ] && [ -n "$KEY" ] || { echo "Usage: ./install.sh [--url https://proxmox.ai.id] --key pak_..." >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "install.sh: curl is required" >&2; exit 1; }

HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
BASE="$(printf '%s' "$URL" | sed -e 's#/*$##' -e 's#/api/v1$##')"
API="$BASE/api/v1"

printf '\nChecking %s …\n' "$API"
# A key pinned to machines is refused without an identifier for this machine, so make one before the
# check rather than after: otherwise the check fails and the install stops on a key that is fine.
DEVICE="$(sed -n 's/.*"device"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME/.proxmox-ai/config.json" 2>/dev/null | head -n 1)"
if [ -z "$DEVICE" ]; then
  DEVICE="$( (od -An -tx1 -N16 /dev/urandom 2>/dev/null || date +%s%N) | tr -d ' \n')"
fi
DEVICE_NAME="$(id -un 2>/dev/null || echo user)@$(hostname 2>/dev/null || echo machine)"

MANIFEST="$(printf 'authorization: Bearer %s\nx-pmx-device: %s\nx-pmx-device-name: %s\n' "$KEY" "$DEVICE" "$DEVICE_NAME" \
  | curl -sS --fail-with-body -H @- -H 'accept: application/json' "$API/mcp/manifest" 2>/dev/null)" || true
case "$MANIFEST" in
  *'"tools"'*) : ;;
  *) printf '  x  %s\n\n     Nothing was changed. Check the URL, the key, and that your IP is on the key whitelist.\n\n' \
       "$(printf '%s' "$MANIFEST" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)" >&2
     exit 1 ;;
esac
ROLE="$(printf '%s' "$MANIFEST" | sed -n 's/.*"role"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
ORG="$(printf '%s' "$MANIFEST" | sed -n 's/.*"organization"[^}]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
COUNT="$(printf '%s' "$MANIFEST" | tr ',' '\n' | grep -c '"method"' || true)"
printf '  v  key accepted — %s%s, %s tools\n' "${ORG:-platform scope}" "${ROLE:+ · role $ROLE}" "$COUNT"

mkdir -p "$HOME/.proxmox-ai"
umask 077
printf '{\n  "url": "%s",\n  "key": "%s",\n  "device": "%s",\n  "device_name": "%s"\n}\n' \
  "$BASE" "$KEY" "$DEVICE" "$DEVICE_NAME" > "$HOME/.proxmox-ai/config.json"
chmod 600 "$HOME/.proxmox-ai/config.json" 2>/dev/null || true
printf '  v  key saved for the pmx command — %s/.proxmox-ai/config.json (owner only)\n' "$HOME"

# put pmx somewhere the agent's shell will find it
BIN=""
for d in "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in *":$d:"*) BIN="$d"; break ;; esac
done
[ -n "$BIN" ] || BIN="$HOME/.local/bin"
mkdir -p "$BIN"
ln -sf "$HERE/server/pmx" "$BIN/pmx"
printf '  v  pmx linked — %s/pmx\n' "$BIN"
case ":$PATH:" in
  *":$BIN:"*) : ;;
  *) printf '  !  %s is not on your PATH yet. Add it:\n       echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.profile\n' "$BIN" "$BIN" ;;
esac

# the skill is what teaches the agent the propose -> confirm discipline
for d in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  parent="$(dirname "$d")"
  if [ -d "$parent" ]; then
    mkdir -p "$d/proxmox-operations"
    cp "$HERE/cli-skill/SKILL.md" "$d/proxmox-operations/SKILL.md"
    printf '  v  skill installed — %s/proxmox-operations\n' "$d"
  else
    printf '  .  %s — not installed\n' "$parent"
  fi
done

printf '\nTry it now:\n  pmx me\n  pmx tools\n  pmx get /nodes\n\n'
case "$MANIFEST" in
  *'"propose_action"'*) printf 'This key may propose changes. Nothing runs until a human confirms it.\n\n' ;;
  *) printf 'This key is read only — it cannot change anything.\n\n' ;;
esac
