#!/usr/bin/env bash
#
# run.sh — lifecycle manager for memento (SurrealDB + daemon).
#
# install.sh sets the machine up once; run.sh starts/stops the long-running
# processes and bootstraps your data.
#
# Usage:
#   ./run.sh start [db|daemon|serve|all]  Start services (default: all = db+daemon)
#   ./run.sh stop  [db|daemon|serve|all]  Stop services (default: all)
#   ./run.sh restart [db|daemon|serve|all] Stop then start
#   ./run.sh serve                   Start the web UI / API server (background)
#   ./run.sh cli <cmd> [args...]     Run a CLI command (search, notes, pin, doctor, …)
#   ./run.sh status                  Show what's running
#   ./run.sh logs [db|daemon|serve]  Tail a service log (Ctrl-C to exit)
#   ./run.sh bootstrap               init schema + backfill Cursor sessions
#   ./run.sh -h | --help             Show this help

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
# Resolved in main() after .env is loaded so MEM_DATA_DIR can be set there.
DATA_DIR=""; DB_DIR=""; LOG_DIR=""; RUN_DIR=""
resolve_paths() {
  DATA_DIR="${MEM_DATA_DIR:-${HOME}/.local/share/memento}"
  DB_DIR="${DATA_DIR}/db"
  LOG_DIR="${DATA_DIR}/logs"
  RUN_DIR="${DATA_DIR}/run"
}

# ----- output helpers -----
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_INFO=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RESET=""; C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""
fi
info() { printf '%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf '%s ok%s  %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%serr%s  %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"; }

# Load .env (MEM_DB_* etc.) if present, without clobbering the environment.
load_env() {
  local envf="$SCRIPT_DIR/.env"
  [[ -f "$envf" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source <(grep -vE '^\s*(#|$)' "$envf")
  set +a
}

# Config with defaults (after load_env).
DB_URL=""; DB_USER=""; DB_PASS=""; DB_HOST=""; DB_PORT=""
SERVE_HOST=""; SERVE_PORT=""
resolve_config() {
  DB_URL="${MEM_DB_URL:-ws://127.0.0.1:8000/rpc}"
  DB_USER="${MEM_DB_USER:-root}"
  DB_PASS="${MEM_DB_PASS:-root}"
  # Parse host:port out of ws://host:port/rpc.
  local hostport="${DB_URL#*://}"; hostport="${hostport%%/*}"
  DB_HOST="${hostport%%:*}"; DB_PORT="${hostport##*:}"
  if [[ "$DB_HOST" == "$hostport" ]]; then DB_PORT="8000"; fi
  SERVE_HOST="${MEM_SERVE_HOST:-127.0.0.1}"
  SERVE_PORT="${MEM_SERVE_PORT:-7077}"
}

# Pick built output if available, else run from source via node.
cli()    { _node_run cli "$@"; }
_node_run() {
  local kind="$1"; shift || true
  if [[ -f "$SCRIPT_DIR/dist/${kind}/index.js" ]]; then
    ( cd "$SCRIPT_DIR" && node "dist/${kind}/index.js" "$@" )
  else
    ( cd "$SCRIPT_DIR" && node --experimental-transform-types "src/${kind}/index.ts" "$@" )
  fi
}
daemon_cmd() {
  if [[ -f "$SCRIPT_DIR/dist/daemon/index.js" ]]; then
    echo "node $SCRIPT_DIR/dist/daemon/index.js"
  else
    echo "node --experimental-transform-types $SCRIPT_DIR/src/daemon/index.ts"
  fi
}
serve_cmd() {
  if [[ -f "$SCRIPT_DIR/dist/serve/server.js" ]]; then
    echo "node $SCRIPT_DIR/dist/serve/server.js"
  else
    echo "node --experimental-transform-types $SCRIPT_DIR/src/serve/server.ts"
  fi
}

pid_of() { local f="$RUN_DIR/$1.pid"; [[ -f "$f" ]] && kill -0 "$(cat "$f")" 2>/dev/null && cat "$f"; }
db_healthy() { curl -sf -m 3 "http://${DB_HOST}:${DB_PORT}/health" >/dev/null 2>&1; }
serve_healthy() { curl -sf -m 3 "http://${SERVE_HOST}:${SERVE_PORT}/api/stats" >/dev/null 2>&1; }

start_db() {
  command -v surreal >/dev/null 2>&1 || die "surreal not found on PATH. Run ./install.sh or see https://surrealdb.com/install"
  if db_healthy; then ok "SurrealDB already running at ${DB_HOST}:${DB_PORT}"; return; fi
  info "Starting SurrealDB (rocksdb://${DB_DIR})"
  nohup surreal start --user "$DB_USER" --pass "$DB_PASS" \
    --bind "${DB_HOST}:${DB_PORT}" "rocksdb://${DB_DIR}" \
    > "$LOG_DIR/surreal.log" 2>&1 &
  echo $! > "$RUN_DIR/db.pid"
  for _ in $(seq 1 20); do db_healthy && break; sleep 0.5; done
  db_healthy && ok "SurrealDB up (pid $(cat "$RUN_DIR/db.pid"))" || die "SurrealDB failed to become healthy; see $LOG_DIR/surreal.log"
}

start_daemon() {
  if [[ -n "$(pid_of daemon)" ]]; then ok "daemon already running (pid $(pid_of daemon))"; return; fi
  db_healthy || die "SurrealDB is not running; start it first (./run.sh start db)"
  info "Starting daemon (live capture + enrichment + mdc export)"
  # Detach all std fds so the daemon never keeps a parent pipe/tty open
  # (otherwise `run.sh start daemon | ...` would hang). `exec` keeps $! == node.
  nohup bash -c "cd '$SCRIPT_DIR' && exec $(daemon_cmd)" \
    </dev/null >"$LOG_DIR/daemon.log" 2>&1 &
  echo $! >"$RUN_DIR/daemon.pid"
  sleep 1
  [[ -n "$(pid_of daemon)" ]] && ok "daemon up (pid $(pid_of daemon))" || die "daemon failed to start; see $LOG_DIR/daemon.log"
}

start_serve() {
  if [[ -n "$(pid_of serve)" ]]; then ok "serve already running (pid $(pid_of serve))"; return; fi
  db_healthy || die "SurrealDB is not running; start it first (./run.sh start db)"
  [[ -f "$SCRIPT_DIR/web/dist/index.html" ]] || warn "web UI not built yet; API works but the page 404s. Build it: (cd web && npm install && npm run build)"
  info "Starting web UI / API server"
  nohup bash -c "cd '$SCRIPT_DIR' && exec $(serve_cmd)" \
    </dev/null >"$LOG_DIR/serve.log" 2>&1 &
  echo $! >"$RUN_DIR/serve.pid"
  for _ in $(seq 1 20); do serve_healthy && break; sleep 0.5; done
  serve_healthy && ok "serve up -> http://${SERVE_HOST}:${SERVE_PORT}" || die "serve failed to start; see $LOG_DIR/serve.log"
}

stop_one() {
  local name="$1" pid; pid="$(pid_of "$name" || true)"
  if [[ -z "$pid" ]]; then ok "$name not running"; rm -f "$RUN_DIR/$name.pid"; return; fi
  info "Stopping $name (pid $pid)"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$RUN_DIR/$name.pid"
  ok "$name stopped"
}

cmd_start() {
  case "${1:-all}" in
    db)     start_db ;;
    daemon) start_daemon ;;
    serve)  start_serve ;;
    all)    start_db; start_daemon ;;
    *)      die "unknown target: ${1} (db|daemon|serve|all)" ;;
  esac
}
cmd_stop() {
  case "${1:-all}" in
    db)     stop_one db ;;
    daemon) stop_one daemon ;;
    serve)  stop_one serve ;;
    all)    stop_one serve; stop_one daemon; stop_one db ;;
    *)      die "unknown target: ${1} (db|daemon|serve|all)" ;;
  esac
}

cmd_status() {
  printf 'SurrealDB : '
  if db_healthy; then printf '%srunning%s (%s:%s)\n' "$C_OK" "$C_RESET" "$DB_HOST" "$DB_PORT"
  else printf '%sstopped%s\n' "$C_WARN" "$C_RESET"; fi
  printf 'daemon    : '
  if [[ -n "$(pid_of daemon)" ]]; then printf '%srunning%s (pid %s)\n' "$C_OK" "$C_RESET" "$(pid_of daemon)"
  else printf '%sstopped%s\n' "$C_WARN" "$C_RESET"; fi
  printf 'serve     : '
  if [[ -n "$(pid_of serve)" ]]; then printf '%srunning%s (pid %s) -> http://%s:%s\n' "$C_OK" "$C_RESET" "$(pid_of serve)" "$SERVE_HOST" "$SERVE_PORT"
  else printf '%sstopped%s\n' "$C_WARN" "$C_RESET"; fi
  if db_healthy; then info "node counts"; cli stats || true; fi
}

cmd_logs() {
  local svc="${1:-daemon}" f
  case "$svc" in db) f="$LOG_DIR/surreal.log" ;; daemon) f="$LOG_DIR/daemon.log" ;; serve) f="$LOG_DIR/serve.log" ;; *) die "unknown log: $svc (db|daemon|serve)";; esac
  [[ -f "$f" ]] || die "no log yet: $f"
  tail -f "$f"
}

cmd_bootstrap() {
  start_db
  info "Initializing schema"
  cli init
  info "Backfilling Cursor sessions (this can take a few minutes)"
  cli backfill --tool cursor
  ok "bootstrap complete"
}

main() {
  load_env
  resolve_paths
  mkdir -p "$DB_DIR" "$LOG_DIR" "$RUN_DIR"
  resolve_config
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    start)     cmd_start "${1:-all}" ;;
    stop)      cmd_stop "${1:-all}" ;;
    restart)   cmd_stop "${1:-all}"; cmd_start "${1:-all}" ;;
    serve)     start_serve ;;
    cli)       cli "$@" ;;
    status)    cmd_status ;;
    logs)      cmd_logs "${1:-daemon}" ;;
    bootstrap) cmd_bootstrap ;;
    -h|--help|"") usage ;;
    *)         die "unknown command: $cmd (use --help)" ;;
  esac
}

main "$@"
