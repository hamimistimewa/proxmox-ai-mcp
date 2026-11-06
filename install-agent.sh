#!/bin/sh
# Proxmox AI — one-line setup for your own AI client.
#
#   curl -fsSL https://proxmox.ai.id/install-agent.sh | sh -s -- --key pak_...
#
# The same script is served as /mcp.sh; either URL works and they are byte-identical.
#
# It sets up whichever of these it finds on the machine: Codex CLI, DeepSeek CLI, Qwen Code,
# Gemini CLI, Cursor, Windsurf, Claude Desktop and VS Code. Claude Code is the exception and is
# better installed as a plugin, which asks for the key itself; the script says so at the end.
#
# That one line is the whole install. It fetches github.com/hamimistimewa/proxmox-ai-mcp into
# ~/.proxmox-ai/src and registers a real MCP server with every AI client on this machine.
#
# Node is a requirement of the MCP server, not of the person installing it, so this script supplies
# it: if the machine has no Node 20 or newer, the official build is fetched into ~/.proxmox-ai/node,
# checked against the SHA-256 that nodejs.org publishes beside it, and used from there. Nothing
# outside ~/.proxmox-ai is touched, no package manager runs, and the system Node — if one arrives
# later — is preferred over this copy.
#
# Should that fail (an unknown platform, no network to nodejs.org), the install still completes by
# the dependency-free curl path, which needs nothing but curl and gives the agent a `pmx` command
# instead of first-class tools. Pass --curl-only to choose that path outright.
#
# The key is verified against the platform before anything is written, and it is stored only in
# ~/.proxmox-ai/config.json (owner only) — never in an AI client's own config file.
set -eu

REPO="https://github.com/hamimistimewa/proxmox-ai-mcp"
DEVICE=""
DEVNAME=""
AGENT=""
URL="https://proxmox.ai.id"
KEY=""
CURL_ONLY=0
DIR="${PROXMOX_AI_SRC:-$HOME/.proxmox-ai/src}"
# Pinned, not "latest": the version that ships is the version that was tested.
NODE_VERSION="v24.22.2"
NODE_HOME="$HOME/.proxmox-ai/node"

usage() {
  cat >&2 <<'EOF'

Proxmox AI — sets up every AI agent on this machine: Codex CLI, DeepSeek CLI, Qwen Code,
Gemini CLI, Cursor, Windsurf, Claude Desktop, VS Code. (Claude Code: use the plugin instead.)

  curl -fsSL https://proxmox.ai.id/install-agent.sh | sh -s -- --key pak_...

  --key   pak_...     your API key (Dashboard -> API keys -> New key)
  --url   https://... the platform, if you self-host (default: https://proxmox.ai.id)
  --agent <name>      install an AI agent first, when the machine has none: claude, codex,
                      qwen, or none. Left out, the script asks. Each agent signs in to its
                      own provider account; this script never supplies model credentials.
  --device  <id>      use this machine id for a key that is pinned to machines, instead of
                      generating one. The dashboard then already knows the machine, so there
                      is nothing to approve. Optional.
  --device-name <s>   the label that machine shows under API keys -> Pinned machines
  --curl-only         skip the MCP server; install the `pmx` command only

Start with a readonly key. It cannot change anything, and you can raise it later.

EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:?--key needs a value}"; shift 2 ;;
    --url) URL="${2:?--url needs a value}"; shift 2 ;;
    --key=*) KEY="${1#--key=}"; shift ;;
    --url=*) URL="${1#--url=}"; shift ;;
    --agent) AGENT="${2:?--agent needs a value}"; shift 2 ;;
    --agent=*) AGENT="${1#--agent=}"; shift ;;
    --device) DEVICE="${2:?--device needs a value}"; shift 2 ;;
    --device=*) DEVICE="${1#--device=}"; shift ;;
    --device-name) DEVNAME="${2:?--device-name needs a value}"; shift 2 ;;
    --device-name=*) DEVNAME="${1#--device-name=}"; shift ;;
    --curl-only) CURL_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'mcp.sh: unknown argument "%s"\n' "$1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$KEY" ] || { printf 'mcp.sh: --key is required.\n' >&2; usage; exit 2; }
command -v curl >/dev/null 2>&1 || { echo 'mcp.sh: curl is required' >&2; exit 1; }

# True when the given binary is a Node new enough for the server (package.json asks for >= 20).
node_ok() {
  _v="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ -n "$_v" ] || return 1
  [ "$_v" -ge 20 ] 2>/dev/null || return 1
}

# The system Node first, then a copy a previous run left behind. Prints the path it settled on.
find_node() {
  if command -v node >/dev/null 2>&1 && node_ok node; then command -v node; return 0; fi
  if node_ok "$NODE_HOME/bin/node"; then printf '%s\n' "$NODE_HOME/bin/node"; return 0; fi
  return 1
}

# The official build, verified, unpacked under ~/.proxmox-ai. Prints the path, or fails quietly and
# lets the caller fall back.
fetch_node() {
  case "$(uname -s)" in Linux) _os=linux ;; Darwin) _os=darwin ;; *) return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) _arch=x64 ;; aarch64|arm64) _arch=arm64 ;; *) return 1 ;; esac
  if command -v sha256sum >/dev/null 2>&1; then _sha='sha256sum'
  elif command -v shasum >/dev/null 2>&1; then _sha='shasum -a 256'
  else return 1; fi

  _pkg="node-$NODE_VERSION-$_os-$_arch.tar.gz"
  _tmp="$HOME/.proxmox-ai/.node-download"
  rm -rf "$_tmp"; mkdir -p "$_tmp" || return 1

  curl -fsSL -o "$_tmp/$_pkg" "https://nodejs.org/dist/$NODE_VERSION/$_pkg" || return 1
  curl -fsSL -o "$_tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" || return 1
  # Without this the install would trust whatever the network handed back.
  _want="$(grep "  $_pkg\$" "$_tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  _got="$($_sha "$_tmp/$_pkg" | cut -d' ' -f1)"
  [ -n "$_want" ] && [ "$_want" = "$_got" ] || {
    printf '  x  checksum mismatch on %s — not used\n' "$_pkg" >&2
    rm -rf "$_tmp"; return 1
  }

  rm -rf "$NODE_HOME"; mkdir -p "$NODE_HOME" || return 1
  tar -xzf "$_tmp/$_pkg" -C "$NODE_HOME" --strip-components 1 || { rm -rf "$_tmp"; return 1; }
  rm -rf "$_tmp"
  node_ok "$NODE_HOME/bin/node" || return 1
  printf '%s\n' "$NODE_HOME/bin/node"
}

# ---- the agent itself -------------------------------------------------------------------------
#
# A fresh machine often has no AI agent at all, and then there is nothing for the rest of this
# script to register. So offer to install one. Each agent then signs in to its own provider
# account: this script supplies the Proxmox tools, never model credentials.
#
# Reading a choice needs care here, because `curl … | sh` has already given stdin to the script.
# The prompt therefore reads /dev/tty, and where there is no terminal the choice must come from
# --agent instead.
agent_installed() {
  for c in claude codex qwen wwhale; do command -v "$c" >/dev/null 2>&1 && return 0; done
  [ -d "$HOME/.claude" ] || [ -d "$HOME/.codex" ] || [ -d "$HOME/.qwen" ] || [ -d "$HOME/.weiping-whale" ]
}

ask_agent() {
  [ -r /dev/tty ] || { printf '  .  no terminal to ask on — pass --agent claude|codex|qwen|none\n'; AGENT="none"; return; }
  printf '\nThis machine has no AI agent yet. Which one should I install?\n\n'
  printf '  1) Claude Code   — Anthropic account\n'
  printf '  2) Codex CLI     — OpenAI account\n'
  printf '  3) Qwen Code     — Qwen or any OpenAI-compatible account\n'
  printf '  4) none          — just set up the Proxmox tools\n\n'
  printf 'Choice [1-4]: '
  read _c < /dev/tty || _c=4
  case "$_c" in
    1) AGENT="claude" ;;
    2) AGENT="codex" ;;
    3) AGENT="qwen" ;;
    *) AGENT="none" ;;
  esac
  printf '\n'
}

# Put a newly installed binary where the user's shell will find it, the same place `pmx` goes.
# sh has no local variables, so every name here is prefixed to avoid clobbering the caller's.
link_bin() {
  _lb_src="$1"; _lb_name="$2"
  [ -x "$_lb_src" ] || return 0
  _lb_dir=""
  for d in "$HOME/.local/bin" "$HOME/bin"; do
    case ":$PATH:" in *":$d:"*) _lb_dir="$d"; break ;; esac
  done
  [ -n "$_lb_dir" ] || _lb_dir="$HOME/.local/bin"
  mkdir -p "$_lb_dir"
  ln -sf "$_lb_src" "$_lb_dir/$_lb_name"
  case ":$PATH:" in
    *":$_lb_dir:"*) : ;;
    *) printf '  !  %s is not on your PATH yet. Add it:\n       echo '"'"'export PATH="%s:$PATH"'"'"' >> ~/.profile\n' "$_lb_dir" "$_lb_dir" ;;
  esac
}

install_agent() {
  case "$AGENT" in
    claude) _pkg="@anthropic-ai/claude-code"; _bin="claude"; _cfg="$HOME/.claude"
            _acct="Anthropic"; _signin="claude"; _check="claude mcp list" ;;
    codex)  _pkg="@openai/codex";             _bin="codex";  _cfg="$HOME/.codex"
            _acct="OpenAI";    _signin="codex login"; _check="codex mcp list" ;;
    qwen)   _pkg="@qwen-code/qwen-code";      _bin="qwen";   _cfg="$HOME/.qwen"
            _acct="Qwen";      _signin="qwen"; _check="" ;;
    *) return 0 ;;
  esac
  # A freshly installed agent has a binary but no config directory until its first run, and the
  # registration step below looks for that directory to decide whether the agent is present. Create
  # it now, or the agent we just installed would be the one thing skipped.
  mkdir -p "$_cfg"
  if command -v "$_bin" >/dev/null 2>&1; then
    printf '  v  %s is already installed\n' "$_bin"
    AGENT_BIN="$_bin"; AGENT_ACCT="$_acct"; AGENT_SIGNIN="$_signin"; AGENT_CHECK="$_check"
    return 0
  fi
  _npm="$(dirname "$NODE")/npm"
  [ -x "$_npm" ] || _npm="$(command -v npm || true)"
  [ -n "$_npm" ] || { printf '  x  no npm available to install %s\n' "$_pkg" >&2; return 1; }
  # An explicit prefix keeps the agent inside ~/.proxmox-ai whatever Node is in use. Without it a
  # system Node would install into /usr/lib/node_modules, which needs root and changes the machine
  # outside the one directory this script owns.
  _prefix="$HOME/.proxmox-ai/agents"
  mkdir -p "$_prefix"
  # npm spawns child scripts whose shebang is `#!/usr/bin/env node`, and the agent's own binary has
  # the same one. When Node came from this script rather than the system, it is only reachable by
  # absolute path, so those children die with `env: 'node': No such file or directory`. Put the Node
  # we are using on PATH for the install, and link it beside the agent so the agent still runs after.
  _nodedir="$(dirname "$NODE")"
  case ":$PATH:" in *":$_nodedir:"*) : ;; *) PATH="$_nodedir:$PATH"; export PATH ;; esac
  printf '  .  installing %s (into ~/.proxmox-ai/agents) …\n' "$_pkg"
  # Keep npm's own diagnosis. Swallowing it leaves a failure nobody can act on: the reason is
  # almost always in the last few lines npm prints, and it is different on every machine.
  _log="$HOME/.proxmox-ai/agent-install.log"
  if "$_npm" install -g --prefix "$_prefix" "$_pkg" >"$_log" 2>&1; then
    link_bin "$_prefix/bin/$_bin" "$_bin"
    # The agent is a Node script whose shebang is `#!/usr/bin/env node`, so node has to be findable
    # by name or it fails the moment it is typed, having installed perfectly well. Testing PATH here
    # is no good: this function just put our own node on PATH for the install. What decides it is
    # whose node this is — ours, under ~/.proxmox-ai, has to be linked for the user's own shell.
    case "$_nodedir" in
      "$HOME/.proxmox-ai"/*) link_bin "$_nodedir/node" "node" ;;
    esac
    printf '  v  %s installed\n' "$_bin"
    AGENT_BIN="$_bin"; AGENT_ACCT="$_acct"; AGENT_SIGNIN="$_signin"; AGENT_CHECK="$_check"
  else
    printf '  x  could not install %s. npm said:\n' "$_pkg" >&2
    # Print the tail unconditionally. Filtering for error-looking lines first left nothing on
    # screen when none matched, because `tail` succeeds on empty input and the fallback never ran.
    if [ -s "$_log" ]; then
      tail -14 "$_log" | sed 's/^/       /' >&2
    else
      printf '       (npm wrote nothing — it may not have run at all)\n' >&2
      printf '       npm used: %s\n' "$_npm" >&2
    fi
    printf '     full log: %s\n' "$_log" >&2
    printf '     The Proxmox tools are still set up below. Install the agent yourself and run this\n' >&2
    printf '     again, or pick another with --agent claude|qwen.\n' >&2
  fi
}

printf '\nFetching %s …\n' "$REPO"
mkdir -p "$(dirname "$DIR")"
if [ -d "$DIR/.git" ] && command -v git >/dev/null 2>&1; then
  git -C "$DIR" fetch --quiet --depth 1 origin main && git -C "$DIR" reset --quiet --hard FETCH_HEAD
  printf '  v  updated — %s\n' "$DIR"
elif command -v git >/dev/null 2>&1; then
  rm -rf "$DIR"
  git clone --quiet --depth 1 "$REPO" "$DIR"
  printf '  v  cloned — %s\n' "$DIR"
else
  # No git: take the tarball. Nothing here needs a build step, so a snapshot is enough.
  rm -rf "$DIR"; mkdir -p "$DIR"
  curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$DIR" --strip-components 1
  printf '  v  downloaded — %s\n' "$DIR"
fi

# The MCP server gives the client first-class tools; the curl path gives it a command. Both end at
# the same API, and both stop every change at propose -> confirm.
if [ "$CURL_ONLY" -eq 0 ]; then
  NODE="$(find_node || true)"
  if [ -z "$NODE" ]; then
    printf '  .  no Node on this machine — fetching the official build (~35 MB, into ~/.proxmox-ai) …\n'
    NODE="$(fetch_node || true)"
    [ -n "$NODE" ] && printf '  v  Node %s ready — %s\n' "$NODE_VERSION" "$NODE"
  fi
  if [ -n "$NODE" ]; then
    # Nothing to register on a machine with no agent, so settle that first.
    if [ -z "$AGENT" ] && ! agent_installed; then ask_agent; fi
    AGENT_BIN=""; AGENT_ACCT=""; AGENT_SIGNIN=""; AGENT_CHECK=""
    [ -n "$AGENT" ] && [ "$AGENT" != "none" ] && install_agent

    "$NODE" "$DIR/server/install.mjs" --url "$URL" --key "$KEY" \
      ${DEVICE:+--device "$DEVICE"} ${DEVNAME:+--device-name "$DEVNAME"} || exit $?

    if [ -n "$AGENT_BIN" ]; then
      printf '\nFrom here, in order:\n\n'
      printf '  1.  %s\n' "$AGENT_SIGNIN"
      printf '      Sign in to your own %s account. This is what pays for the model.\n\n' "$AGENT_ACCT"
      if [ -n "$AGENT_CHECK" ]; then
        printf '  2.  %s\n' "$AGENT_CHECK"
        printf '      Should list proxmox_ai. If it does, the tools arrived.\n\n'
        printf '  3.  %s\n' "$AGENT_BIN"
        printf '      Starts it. Then ask, in your own words:\n'
      else
        printf '  2.  %s\n' "$AGENT_BIN"
        printf '      Starts it. Then ask, in your own words:\n'
      fi
      printf '        "node mana yang RAM-nya paling mepet?"\n\n'
      printf '  If the shell cannot find %s, open a new one: it was linked into a directory\n' "$AGENT_BIN"
      printf '  your current shell had already read.\n\n'
      printf '  The Proxmox key carries no model access, and your %s account grants no\n' "$AGENT_ACCT"
      printf '  infrastructure. Neither stands in for the other.\n\n'
    fi
    exit 0
  fi
  printf '  .  could not supply Node — installing the curl path instead\n'
fi

exec sh "$DIR/install.sh" --url "$URL" --key "$KEY"
