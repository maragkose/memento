#!/usr/bin/env bash
#
# install.sh — set up memorcy on this machine.
#
# Steps: check prerequisites -> install npm deps -> build -> create .env + data dir
#        -> (optional) install SurrealDB -> (optional) register MCP with Cursor.
#
# Usage:
#   ./install.sh [options]
#
# Options:
#   -y, --yes          Non-interactive: accept defaults for all prompts.
#       --with-surreal Install SurrealDB if missing (no prompt).
#       --no-surreal   Never install SurrealDB.
#       --mcp          Register the MCP server in ~/.cursor/mcp.json (no prompt).
#       --no-build     Skip the TypeScript build (use dev scripts instead).
#   -h, --help         Show this help and exit.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
NODE_MIN_MAJOR=22
DATA_DIR="${HOME}/.local/share/memorcy"
MCP_CONFIG="${HOME}/.cursor/mcp.json"

# ----- options -----
ASSUME_YES=0
SURREAL_MODE="prompt" # prompt | yes | no
DO_MCP="prompt"       # prompt | yes
DO_BUILD=1

# ----- output helpers -----
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RESET=""; C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""
fi
info()  { printf '%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()    { printf '%s ok%s  %s\n' "$C_OK" "$C_RESET" "$*"; }
warn()  { printf '%swarn%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()   { printf '%serr%s  %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

# ask "question" -> returns 0 for yes, 1 for no. Respects --yes.
ask() {
  local prompt="$1"
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  local reply
  read -r -p "$prompt [Y/n] " reply || true
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes)        ASSUME_YES=1 ;;
      --with-surreal)  SURREAL_MODE="yes" ;;
      --no-surreal)    SURREAL_MODE="no" ;;
      --mcp)           DO_MCP="yes" ;;
      --no-build)      DO_BUILD=0 ;;
      -h|--help)       usage; exit 0 ;;
      *)               die "unknown option: $1 (use --help)" ;;
    esac
    shift
  done
}

check_node() {
  info "Checking Node.js (>= ${NODE_MIN_MAJOR}) and npm"
  command -v node >/dev/null 2>&1 || die "node not found. Install Node.js >= ${NODE_MIN_MAJOR}."
  command -v npm  >/dev/null 2>&1 || die "npm not found. Install npm."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge "$NODE_MIN_MAJOR" ]] || die "Node $major found; need >= ${NODE_MIN_MAJOR}."
  ok "node $(node -v), npm $(npm -v)"
}

install_deps() {
  info "Installing npm dependencies"
  ( cd "$SCRIPT_DIR" && npm install )
  ok "dependencies installed"
}

build_project() {
  if [[ "$DO_BUILD" -eq 0 ]]; then
    warn "skipping build (--no-build); use the dev:* scripts to run from source"
    return
  fi
  info "Building TypeScript"
  ( cd "$SCRIPT_DIR" && npm run build )
  ok "build complete (dist/)"
}

setup_env() {
  info "Setting up configuration"
  if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    ok "created .env from .env.example"
  else
    ok ".env already exists (left untouched)"
  fi
  mkdir -p "$DATA_DIR/db"
  ok "data directory: $DATA_DIR/db"
}

install_surreal() {
  if command -v surreal >/dev/null 2>&1; then
    ok "SurrealDB present: $(surreal version 2>/dev/null | head -1)"
    return
  fi
  case "$SURREAL_MODE" in
    no) warn "SurrealDB not installed and --no-surreal set; install it manually before running" ; return ;;
    yes) : ;;
    prompt)
      if ! ask "SurrealDB is not installed. Install it now via the official installer?"; then
        warn "skipping SurrealDB install; see https://surrealdb.com/install"
        return
      fi ;;
  esac
  info "Installing SurrealDB"
  command -v curl >/dev/null 2>&1 || die "curl required to install SurrealDB"
  curl -sSf https://install.surrealdb.com | sh
  hash -r 2>/dev/null || true
  if command -v surreal >/dev/null 2>&1; then
    ok "SurrealDB installed: $(surreal version 2>/dev/null | head -1)"
    return
  fi
  # The official installer often drops the binary in ~/.surrealdb without adding
  # it to PATH. Symlink it into ~/.local/bin (widely on PATH) as a fallback.
  link_surreal_onto_path
}

# Find a freshly-installed surreal binary and make it callable from PATH.
link_surreal_onto_path() {
  local found=""
  for cand in "$HOME/.surrealdb/surreal" "$HOME/.local/bin/surreal" "/usr/local/bin/surreal"; do
    [[ -x "$cand" ]] && { found="$cand"; break; }
  done
  if [[ -z "$found" ]]; then
    warn "SurrealDB installer ran but the 'surreal' binary was not found; see https://surrealdb.com/install"
    return
  fi
  mkdir -p "$HOME/.local/bin"
  if [[ "$found" != "$HOME/.local/bin/surreal" ]]; then
    ln -sf "$found" "$HOME/.local/bin/surreal"
  fi
  hash -r 2>/dev/null || true
  if command -v surreal >/dev/null 2>&1; then
    ok "linked surreal onto PATH: $HOME/.local/bin/surreal -> $found"
  else
    warn "linked surreal to $HOME/.local/bin but that dir is not on your PATH."
    warn "add it: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
  fi
}

register_mcp() {
  if [[ "$DO_MCP" == "prompt" ]]; then
    ask "Register the MCP server in ${MCP_CONFIG} (for Cursor)?" || return
  fi
  local server_js="$SCRIPT_DIR/dist/mcp/server.js"
  local cmd args
  if [[ "$DO_BUILD" -eq 1 && -f "$server_js" ]]; then
    cmd="node"; args="[\"$server_js\"]"
  else
    cmd="node"; args="[\"--experimental-transform-types\", \"$SCRIPT_DIR/src/mcp/server.ts\"]"
  fi
  info "Registering MCP server in $MCP_CONFIG"
  mkdir -p "$(dirname "$MCP_CONFIG")"
  # Safe JSON merge via node (guaranteed present).
  MCP_CONFIG="$MCP_CONFIG" MCP_CMD="$cmd" MCP_ARGS="$args" node <<'NODE'
const fs = require("fs");
const path = process.env.MCP_CONFIG;
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers["memorcy"] = { command: process.env.MCP_CMD, args: JSON.parse(process.env.MCP_ARGS) };
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
NODE
  ok "MCP server 'memorcy' registered"
}

print_next_steps() {
  cat <<EOF

${C_OK}Installation complete.${C_RESET}

Next steps (via run.sh — the lifecycle manager):
  cd ${SCRIPT_DIR}
  1. Bootstrap (starts DB, inits schema, backfills your Cursor sessions):
       ./run.sh bootstrap
  2. Start the daemon (live capture + enrichment + always-apply digest):
       ./run.sh start daemon      # or: ./run.sh start all
  3. Check status / query:
       ./run.sh status
       npm run dev:cli -- search "your topic"
       npm run dev:cli -- resume --project home-maragos
  Manage services anytime: ./run.sh start|stop|restart|status|logs

The daemon writes an always-apply digest to ~/.cursor/rules/memorcy.mdc,
so any Cursor chat sees recent history with no MCP required. If you also
registered MCP, restart Cursor to expose the memory tools (see ARCHITECTURE.md §8).
EOF
}

main() {
  parse_args "$@"
  info "memorcy installer (dir: $SCRIPT_DIR)"
  check_node
  install_deps
  build_project
  setup_env
  install_surreal
  register_mcp
  print_next_steps
}

main "$@"
