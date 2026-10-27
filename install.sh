#!/bin/sh
# Set up Proxmox AI for your AI client — no Node, no npm, nothing to build.
#
#   ./install.sh --url https://proxmox.ai.id --key pak_...
#
# Verifies the key, saves it to ~/.proxmox-ai/config.json (owner only), puts `pmx` on your PATH, and copies
# the curl skill into ~/.claude/skills/ and ~/.codex/skills/ when those exist. Claude Code and Codex can then
# run `pmx` straight from the shell — no MCP server involved.
#
# Prefer first-class MCP tools instead? Use: node server/install.mjs --url … --key …
set -eu

URL=""; KEY=""
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
[ -n "$URL" ] && [ -n "$KEY" ] || { echo "Usage: ./install.sh --url https://proxmox.ai.id --key pak_..." >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "install.sh: curl is required" >&2; exit 1; }

HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
BASE="$(printf '%s' "$URL" | sed -e 's#/*$##' -e 's#/api/v1$##')"
API="$BASE/api/v1"

printf '\nChecking %s …\n' "$API"
MANIFEST="$(printf 'authorization: Bearer %s\n' "$KEY" \
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
printf '{\n  "url": "%s",\n  "key": "%s"\n}\n' "$BASE" "$KEY" > "$HOME/.proxmox-ai/config.json"
chmod 600 "$HOME/.proxmox-ai/config.json" 2>/dev/null || true
printf '  v  credentials saved — %s/.proxmox-ai/config.json (owner only)\n' "$HOME"

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
    mkdir -p "$d/proxmox-ai"
    cp "$HERE/skills/proxmox-ai-curl/SKILL.md" "$d/proxmox-operations/SKILL.md"
    printf '  v  skill installed — %s/proxmox-ai\n' "$d"
  else
    printf '  .  %s — not installed\n' "$parent"
  fi
done

printf '\nTry it now:\n  pmx me\n  pmx tools\n  pmx get /nodes\n\n'
case "$MANIFEST" in
  *'"propose_action"'*) printf 'This key may propose changes. Nothing runs until a human confirms it.\n\n' ;;
  *) printf 'This key is read only — it cannot change anything.\n\n' ;;
esac
