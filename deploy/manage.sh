#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${PROXY_DEPLOY_CONFIG:-$ROOT/.local/docker.env}"
COMPOSE="${PROXY_COMPOSE_FILE:-$ROOT/deploy/docker/compose.yaml}"

usage() {
  cat <<'HELP'
Usage:
  manage.sh setup                      interactive first install: asks, builds, starts, prints a summary
  manage.sh init --host HOST [--mode fingerprint|certificate|nginx]
    [--data ABSOLUTE_PATH] [--control-port 8787]
    [--cert FULLCHAIN --key PRIVATE_KEY] [--url wss://DOMAIN/ws] [--token SECRET]
    [--web-relay 0|1] [--web-relay-port 5270] [--web-relay-bind 0.0.0.0|127.0.0.1]
    [--web-relay-origin https://DOMAIN]
  manage.sh build|up|status|logs|stop|restart|uninstall|connection|summary
  manage.sh upgrade [--from SERVER_ARCHIVE]   rebuild the image and replace the container in place
  manage.sh client INSTALLER_EXE              offer a Windows installer to connected clients
  manage.sh token [SECRET]                    replace the service token (random when omitted) and restart
  manage.sh release-token [FILE]              save a read-only GitHub token for following releases (none: remove)
  manage.sh backup ABSOLUTE_ARCHIVE_PATH
  manage.sh restore ABSOLUTE_ARCHIVE_PATH
  manage.sh certificate FULLCHAIN PRIVATE_KEY
  manage.sh renew

Requires Docker Engine + Compose v2+, Bash, OpenSSL, curl, tar.
Use sudo if your user cannot access Docker. Config defaults to .local/docker.env;
set PROXY_DEPLOY_CONFIG to manage a different isolated installation.
Set PROXY_COMPOSE_FILE when managing an image-only standalone compose.yml.
Web relay is off by default. Enabling it adds a port on the same container;
nginx mode requires --web-relay-origin and binds the relay to loopback by default.
Uninstall keeps all data; backup/restore pause the service.
HELP
}
fail() { echo "$*" >&2; exit 1; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535)); }
valid_token() { ((${#1} >= 24 && ${#1} <= 512)) && [[ "$1" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; }
safe_value() { [[ "$1" != *"'"* && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *'$'* && "$1" != *'`'* ]]; }
write_var() { safe_value "$2" || fail "Unsupported characters in $1"; printf "%s='%s'\n" "$1" "$2"; }
dc() {
  local files=(-f "$COMPOSE")
  if [[ "${WEB_RELAY_ENABLED:-0}" = 1 ]]; then
    [[ -f "$ROOT/deploy/compose.relay.yml" ]] || fail "Missing deploy/compose.relay.yml; unpack the complete server archive."
    files+=(-f "$ROOT/deploy/compose.relay.yml")
  fi
  docker compose --env-file "$CONFIG" -p "$PROJECT_NAME" "${files[@]}" "$@"
}
relay_config() {
  [[ "${WEB_RELAY_ENABLED:-0}" =~ ^[01]$ ]] || fail "WEB_RELAY_ENABLED must be 0 or 1."
  [[ "${WEB_RELAY_ENABLED:-0}" = 1 ]] || return 0
  WEB_RELAY_PORT="${WEB_RELAY_PORT:-5270}"
  WEB_RELAY_BIND="${WEB_RELAY_BIND:-$CONTROL_BIND}"
  WEB_RELAY_ORIGIN="${WEB_RELAY_ORIGIN:-}"
  [[ "$WEB_RELAY_PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$WEB_RELAY_PORT >= 1 && 10#$WEB_RELAY_PORT <= 65535)) \
    || fail "The Web relay port must be 1..65535."
  ((10#$WEB_RELAY_PORT != 10#$CONTROL_PORT)) || fail "Web relay and control need different host ports."
  [[ "$WEB_RELAY_BIND" = 0.0.0.0 || "$WEB_RELAY_BIND" = 127.0.0.1 ]] \
    || fail "WEB_RELAY_BIND must be 0.0.0.0 or 127.0.0.1."
  if [[ -n "$WEB_RELAY_ORIGIN" ]]; then
    [[ "$WEB_RELAY_ORIGIN" =~ ^https?://([A-Za-z0-9][A-Za-z0-9.-]*|\[[A-Fa-f0-9:]+\])(:[0-9]{1,5})?/?$ ]] \
      || fail "Web relay origin must be an HTTP(S) origin without credentials, path, query or fragment."
    local origin_port="${BASH_REMATCH[2]:-}"
    [[ -z "$origin_port" ]] || { origin_port="${origin_port#:}"; ((10#$origin_port >= 1 && 10#$origin_port <= 65535)); } \
      || fail "Invalid Web relay origin port."
  fi
  [[ ( "$MODE" != nginx && "$WEB_RELAY_BIND" != 127.0.0.1 ) || -n "$WEB_RELAY_ORIGIN" ]] \
    || fail "A reverse-proxied relay needs --web-relay-origin (WEB_RELAY_ORIGIN) with the public HTTP(S) entrance."
}
load() {
  [[ -f "$CONFIG" ]] || fail "Run init first."
  # This file is a private, locally generated deployment configuration.
  WEB_RELAY_ENABLED=0 WEB_RELAY_PORT='' WEB_RELAY_BIND='' WEB_RELAY_ORIGIN=''
  source "$CONFIG"
  [[ "$DATA_DIR" = /* && -f "$DATA_DIR/.cc-desk-tunnel-data" ]] || fail "Invalid managed data directory."
  DATA_DIR="$(realpath -- "$DATA_DIR")"
  relay_config
}
cert_pair() {
  openssl x509 -in "$1" -noout -checkend 86400 >/dev/null || fail "Certificate expires within one day."
  local public private
  public="$(openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)"
  private="$(openssl pkey -in "$2" -pubout -outform DER | sha256sum)"
  [[ "$public" = "$private" ]] || fail "Certificate and private key do not match."
}
cert_name() {
  local output
  if [[ "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    output="$(openssl x509 -in "$1" -noout -checkip "$2")"
  else
    output="$(openssl x509 -in "$1" -noout -checkhost "$2")"
  fi
  [[ "$output" != *"NOT"* ]] || fail "Certificate does not match $2."
}
make_cert() {
  local name="$1" prefix="$2" days="$3" ca="$4"
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days "$days" \
    -subj "/CN=$name" -addext "subjectAltName=DNS:$name" \
    -addext "basicConstraints=critical,CA:$ca" \
    -keyout "$prefix.key" -out "$prefix.crt" >/dev/null 2>&1
}
wait_healthy() {
  local id state
  id="$(dc ps -q proxy)"
  [[ -n "$id" ]] || fail "Container did not start."
  for _ in {1..60}; do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$id")"
    [[ "$state" = healthy ]] && return
    [[ "$(docker inspect --format '{{.State.Running}}' "$id")" = true ]] || break
    sleep 2
  done
  fail "Service is not healthy. Run manage.sh logs; credentials are not printed automatically."
}
running() { [[ -n "$(dc ps --status running -q proxy)" ]]; }
ask() {
  local prompt="$1" default="${2:-}" answer
  read -r -p "$prompt${default:+ [$default]}: " answer
  printf '%s' "${answer:-$default}"
}
# Everything the Windows client and the administrator need after an install or upgrade.
public_port() {
  local authority="${1#*://}"
  authority="${authority%%/*}"
  if [[ "$authority" =~ ^(\[[^]]+\]|[^:]+):([0-9]+)$ ]]; then printf '%s' "${BASH_REMATCH[2]}"
  elif [[ "$1" = https://* || "$1" = wss://* ]]; then printf 443
  else printf 80; fi
}
summary() {
  local id ports control_public relay_public
  echo
  echo "================ CC Desk Tunnel 部署汇总 ================"
  echo "客户端填写"
  echo "  服务地址   $CONNECTION_URL"
  if [[ "$MODE" = fingerprint ]]; then
    echo "  证书指纹   $(openssl x509 -in "$DATA_DIR/tls/control.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
  else
    echo "  证书指纹   留空（按 CA 与域名校验）"
  fi
  echo "  服务凭据   $(sed -n "s/^PROXY_TOKEN='\(.*\)'$/\1/p" "$DATA_DIR/config/service.env")"
  echo "服务器"
  echo "  入口模式   $MODE"
  ports="$([[ "$MODE" = nginx ]] && echo "nginx 的 443/TCP" || echo "$CONTROL_PORT/TCP")"
  control_public="$CONTROL_PORT"
  if [[ "${WEB_RELAY_ENABLED:-0}" = 1 && "$MODE" = nginx ]]; then
    control_public="$(public_port "$CONNECTION_URL")"
    ports="nginx 的 $control_public/TCP"
  fi
  if [[ "${WEB_RELAY_ENABLED:-0}" = 1 && "$WEB_RELAY_BIND" = 0.0.0.0 && "$WEB_RELAY_PORT" != "$control_public" ]]; then
    ports+=", $WEB_RELAY_PORT/TCP（Web 中继）"
  fi
  if [[ "${WEB_RELAY_ENABLED:-0}" = 1 && -n "$WEB_RELAY_ORIGIN" ]]; then
    relay_public="$(public_port "$WEB_RELAY_ORIGIN")"
    if [[ "$relay_public" != "$control_public" && ( "$WEB_RELAY_BIND" != 0.0.0.0 || "$relay_public" != "$WEB_RELAY_PORT" ) ]]; then
      ports+=", $relay_public/TCP（中继反代入口）"
    fi
  fi
  echo "  需放行端口 $ports"
  if [[ "${WEB_RELAY_ENABLED:-0}" = 1 ]]; then
    echo "  Web 中继  $WEB_RELAY_BIND:$WEB_RELAY_PORT → 容器 5270"
    [[ -z "$WEB_RELAY_ORIGIN" ]] || echo "  浏览器入口 $WEB_RELAY_ORIGIN"
    [[ "$WEB_RELAY_BIND" != 127.0.0.1 ]] || echo "  中继仅监听宿主回环，请由现有反代提供公网入口。"
  fi
  echo "  数据目录   $DATA_DIR"
  echo "  部署配置   $CONFIG"
  id="$(dc ps -q proxy 2>/dev/null || true)"
  echo "  容器状态   $([[ -n "$id" ]] && docker inspect --format '{{.State.Health.Status}}' "$id" || echo 未启动)"
  echo "下一步"
  if [[ "${WEB_RELAY_ENABLED:-0}" = 1 ]]; then
    echo "  1. 云防火墙按上面“需放行端口”放行；回环中继端口无需公网放行。"
  else
    echo "  1. 云防火墙只放行上面“需放行端口”一项；本项目不需要其他入站端口。"
  fi
  echo "  2. Windows 客户端填入服务地址、指纹和凭据并连接。"
  echo "  3. 在客户端账号页登录 Claude 账号。"
  echo "  使用第三方 API 时编辑 $DATA_DIR/config/provider.json 后执行 manage.sh restart。"
  echo "以上凭据等同于服务器登录权限，请勿外传。"
  echo "======================================================="
}
command="${1:-help}"
shift || true
case "$command" in
  help|--help|-h) usage; exit ;;
  setup)
    if [[ -f "$CONFIG" ]]; then
      echo "已有部署配置（$CONFIG），跳过问答，直接构建并启动。"
    else
      [[ -t 0 ]] || fail "setup needs an interactive terminal; use init with options in scripts."
      echo "CC Desk Tunnel 首次安装。直接回车使用方括号内的默认值。"
      detected="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
      [[ "$detected" =~ ^[0-9.]+$ ]] || detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
      host="$(ask "Windows 能访问到的公网 IP 或域名" "$detected")"
      echo "入口方式：1) 自签证书 + 指纹（无域名时用）  2) 已有域名证书  3) 已有 nginx 反代"
      case "$(ask "选择 1 / 2 / 3" 1)" in
        1) mode=fingerprint ;; 2) mode=certificate ;; 3) mode=nginx ;; *) fail "Invalid choice." ;;
      esac
      options=(--host "$host" --mode "$mode")
      if [[ "$mode" = certificate ]]; then
        options+=(--cert "$(ask "证书链文件 fullchain.pem 的路径")" --key "$(ask "私钥文件 privkey.pem 的路径")")
      fi
      if [[ "$mode" = nginx ]]; then
        options+=(--url "$(ask "客户端使用的 WSS 地址" "wss://$host/ws")")
      fi
      options+=(--control-port "$(ask "控制端口" 8787)")
      default_data="${HOME}/.local/share/cc-desk-tunnel-container"
      [[ "$(id -u)" != 0 ]] || default_data=/srv/cc-desk-tunnel
      options+=(--data "$(ask "数据目录（新建，存放账号、会话与证书）" "$default_data")")
      token="$(ask "服务凭据（至少 24 位；留空自动生成）")"
      [[ -z "$token" ]] || options+=(--token "$token")
      bash "${BASH_SOURCE[0]}" init "${options[@]}"
    fi
    load
    echo "构建镜像（首次需要几分钟）…"
    dc build --pull
    dc up -d
    wait_healthy
    summary
    exit ;;
  init)
    HOST='' MODE=fingerprint DATA_DIR="${HOME}/.local/share/cc-desk-tunnel-container"
    [[ "$(id -u)" != 0 ]] || DATA_DIR=/srv/cc-desk-tunnel
    CONTROL_PORT=8787 CERT='' KEY='' URL='' TOKEN=''
    WEB_RELAY_ENABLED=0 WEB_RELAY_PORT='' WEB_RELAY_BIND='' WEB_RELAY_ORIGIN=''
    while (($#)); do
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      case "$1" in
        --host) HOST="$2" ;; --mode) MODE="$2" ;; --data) DATA_DIR="$2" ;;
        --control-port) CONTROL_PORT="$2" ;;
        --web-relay) WEB_RELAY_ENABLED="$2" ;;
        --web-relay-port) WEB_RELAY_PORT="$2" ;;
        --web-relay-bind) WEB_RELAY_BIND="$2" ;;
        --web-relay-origin) WEB_RELAY_ORIGIN="$2" ;;
        # Given by scripts written for 0.2.9 and earlier, when the execution channel had a port of its own.
        --frps-port) ;;
        --cert) CERT="$2" ;; --key) KEY="$2" ;; --url) URL="$2" ;; --token) TOKEN="$2" ;;
        *) fail "Unknown option: $1" ;;
      esac
      shift 2
    done
    [[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail "--host needs an IPv4 address or DNS name reachable by Windows (no IPv6 yet)."
    [[ "$MODE" =~ ^(fingerprint|certificate|nginx)$ ]] || fail "Invalid mode."
    valid_port "$CONTROL_PORT" || fail "The port must be 1024..65535."
    CONTROL_BIND=0.0.0.0
    [[ "$MODE" != nginx ]] || CONTROL_BIND=127.0.0.1
    if [[ "$WEB_RELAY_ENABLED" != 1 && -n "$WEB_RELAY_PORT$WEB_RELAY_BIND$WEB_RELAY_ORIGIN" ]]; then
      fail "Use --web-relay 1 together with Web relay options."
    fi
    relay_config
    [[ "$DATA_DIR" = /* && "$DATA_DIR" != / && "$DATA_DIR" != "$HOME" ]] || fail "Choose an absolute dedicated data directory."
    DATA_DIR="$(realpath -m -- "$DATA_DIR")"
    [[ "$DATA_DIR" != / && "$DATA_DIR" != "$(realpath -- "$HOME")" ]] || fail "Choose a dedicated data directory."
    [[ ! -e "$CONFIG" ]] || fail "Configuration already exists; use upgrade or a separate PROXY_DEPLOY_CONFIG."
    safe_value "$DATA_DIR" || fail "Unsupported data path."
    [[ "$(id -u)" = 0 || "$(id -u)" = 1000 ]] || fail "Run init with sudo; container data needs uid 1000 ownership."
    [[ ! -e "$DATA_DIR" ]] || fail "Data directory already exists; do not overwrite it."
    command -v docker >/dev/null && docker compose version >/dev/null || fail "Install Docker Engine and Compose first."
    command -v openssl >/dev/null || fail "Install OpenSSL first."
    if [[ "$MODE" = certificate ]]; then
      [[ -n "$CERT" && -n "$KEY" ]] || fail "--cert and --key required."
      cert_pair "$CERT" "$KEY"
      cert_name "$CERT" "$HOST"
    fi
    URL="${URL:-wss://$HOST:$CONTROL_PORT/ws}"
    if [[ "$MODE" = nginx && "$URL" = "wss://$HOST:$CONTROL_PORT/ws" ]]; then URL="wss://$HOST/ws"; fi
    [[ "$URL" =~ ^wss://[^/@?#]+/ws$ ]] || fail "--url must be a WSS /ws address."
    [[ -n "$TOKEN" ]] || TOKEN="$(openssl rand -hex 32)"
    valid_token "$TOKEN" || fail "--token needs 24..512 characters from A-Z a-z 0-9 . _ ~ + / = -"
    mkdir -p "$DATA_DIR"/{config,tls,home,state,workspace} "$(dirname -- "$CONFIG")"
    touch "$DATA_DIR/.cc-desk-tunnel-data"
    CERT_NAME=cc-desk-tunnel.local
    if [[ "$MODE" = fingerprint ]]; then
      make_cert "$CERT_NAME" "$DATA_DIR/tls/control" 365 FALSE
    elif [[ "$MODE" = certificate ]]; then
      cp -- "$CERT" "$DATA_DIR/tls/control.crt"
      cp -- "$KEY" "$DATA_DIR/tls/control.key"
      CERT_NAME="$HOST"
    fi
    {
      write_var PROXY_ADAPTER claude-code
      write_var PROXY_TOKEN "$TOKEN"
      write_var PROXY_HOST 0.0.0.0
      write_var PROXY_PORT 8787
      write_var PROXY_TLS_MODE "$([[ "$MODE" = nginx ]] && echo reverse-proxy || echo direct)"
      write_var PROXY_TLS_CERT /data/tls/control.crt
      write_var PROXY_TLS_KEY /data/tls/control.key
      write_var PROXY_CERT_NAME "$CERT_NAME"
      write_var PROXY_DATA_DIR /data/state
      write_var CLAUDE_CONTEXT_RETENTION_DAYS 3650
      write_var CLAUDE_SETTINGS_PATH /data/config/provider.json
    } > "$DATA_DIR/config/service.env"
    printf '{}\n' > "$DATA_DIR/config/provider.json"
    PROJECT_NAME="cc-desk-tunnel-$(openssl rand -hex 4)"
    {
      write_var PROJECT_NAME "$PROJECT_NAME"
      write_var DATA_DIR "$DATA_DIR"
      write_var CONTROL_BIND "$CONTROL_BIND"
      write_var CONTROL_PORT "$CONTROL_PORT"
      write_var MODE "$MODE"
      write_var CONNECTION_URL "$URL"
      write_var PROXY_IMAGE cc-desk-tunnel:local
      if [[ "$WEB_RELAY_ENABLED" = 1 ]]; then
        write_var WEB_RELAY_ENABLED 1
        write_var WEB_RELAY_PORT "$WEB_RELAY_PORT"
        write_var WEB_RELAY_BIND "$WEB_RELAY_BIND"
        [[ -z "$WEB_RELAY_ORIGIN" ]] || write_var WEB_RELAY_ORIGIN "$WEB_RELAY_ORIGIN"
      fi
    } > "$CONFIG"
    if [[ "$(id -u)" = 0 ]]; then
      chown -R 1000:1000 "$DATA_DIR"
    fi
    echo "Initialized. Edit $DATA_DIR/config/provider.json for API settings, then build and up."
    echo "Private client connection information: manage.sh connection"
    exit ;;
esac
load
case "$command" in
  build) dc build --pull ;;
  up) dc up -d; wait_healthy ;;
  status) dc ps ;;
  logs) dc logs --tail=100 -f ;;
  stop) dc stop ;;
  restart) dc restart; wait_healthy ;;
  upgrade)
    # Data, account and configuration live outside the image; only the program is replaced.
    if [[ "${1:-}" = --from ]]; then
      [[ $# = 2 && -f "$2" ]] || fail "Specify the server archive: upgrade --from /path/cc-desk-tunnel-server.tar.gz"
      if tar -tzf "$2" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then fail "Unsafe archive paths."; fi
      tar -tzf "$2" | grep -Fx 'deploy/manage.sh' >/dev/null || fail "Not a CC Desk Tunnel server archive."
      tar -xzf "$2" -C "$ROOT" --no-same-owner
      exec bash "$ROOT/deploy/manage.sh" upgrade
    fi
    # The port frp had before 0.2.10 is no longer published; its setting goes with it.
    if grep -q '^FRPS_PORT=' "$CONFIG"; then sed -i '/^FRPS_PORT=/d' "$CONFIG"; fi
    dc build --pull; dc up -d; wait_healthy; summary ;;
  summary) summary ;;
  client)
    [[ $# = 1 && -f "$1" && "$(basename -- "$1")" =~ ^CC-Desk-Tunnel-Setup-[0-9]+\.[0-9]+\.[0-9]+-x64\.exe$ ]] \
      || fail "Specify the installer as built: CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe"
    mkdir -p "$DATA_DIR/state/client"
    install -m 644 "$1" "$DATA_DIR/state/client/"
    [[ "$(id -u)" != 0 ]] || chown -R 1000:1000 "$DATA_DIR/state/client"
    echo "Installer published. Clients see the upgrade the next time they connect."
    ;;
  token)
    # Every saved client login stops working; the summary prints the new token.
    [[ $# -le 1 ]] || fail "Specify at most one token."
    TOKEN="${1:-$(openssl rand -hex 32)}"
    valid_token "$TOKEN" || fail "The token needs 24..512 characters from A-Z a-z 0-9 . _ ~ + / = -"
    temp="$(mktemp "$DATA_DIR/config/service.env.XXXXXX")"
    { grep -v '^PROXY_TOKEN=' "$DATA_DIR/config/service.env"; write_var PROXY_TOKEN "$TOKEN"; } > "$temp"
    chmod 600 "$temp"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$temp"
    mv -- "$temp" "$DATA_DIR/config/service.env"
    if running; then dc restart; wait_healthy; fi
    summary ;;
  release-token)
    # Read-only access to the releases of a private repository; without an argument the token is removed.
    [[ $# -le 1 ]] || fail "Specify at most one token file."
    RELEASE_TOKEN=""
    if [[ $# = 1 ]]; then
      [[ -f "$1" ]] || fail "Specify the file holding the token."
      RELEASE_TOKEN="$(tr -d '[:space:]' < "$1")"
      [[ "$RELEASE_TOKEN" =~ ^[A-Za-z0-9_]{20,255}$ ]] || fail "That file does not hold a GitHub token."
    fi
    temp="$(mktemp "$DATA_DIR/config/service.env.XXXXXX")"
    {
      grep -v '^PROXY_RELEASE_TOKEN=' "$DATA_DIR/config/service.env" || true
      [[ -z "$RELEASE_TOKEN" ]] || write_var PROXY_RELEASE_TOKEN "$RELEASE_TOKEN"
    } > "$temp"
    chmod 600 "$temp"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$temp"
    mv -- "$temp" "$DATA_DIR/config/service.env"
    if running; then dc restart; wait_healthy; fi
    echo "Release token $([[ -n "$RELEASE_TOKEN" ]] && echo saved || echo removed)."
    ;;
  uninstall) dc down --remove-orphans; echo "Removed containers/network. Data and config retained: $DATA_DIR" ;;
  connection)
    echo "URL: $CONNECTION_URL"
    if [[ "$MODE" = fingerprint ]]; then
      openssl x509 -in "$DATA_DIR/tls/control.crt" -noout -fingerprint -sha256
    else
      echo "Certificate fingerprint: leave empty for standard CA/domain verification."
    fi
    grep '^PROXY_TOKEN=' "$DATA_DIR/config/service.env"
    ;;
  backup)
    [[ $# = 1 && "$1" = /* && ! -e "$1" ]] || fail "Specify a new absolute archive path."
    archive="$(realpath -m -- "$1")"
    [[ "$archive" != "$DATA_DIR/"* ]] || fail "Backup must be outside the data directory."
    was_running=false; running && was_running=true
    trap 'if $was_running; then dc start >/dev/null; fi' EXIT
    dc stop
    tar --exclude=./state/connections --exclude=./state/devices --exclude=./state/backups --exclude=./home/.cache -czf "$1" -C "$DATA_DIR" .
    chmod 600 "$1"
    echo "Backup saved; contains private credentials and conversation data."
    ;;
  restore)
    [[ $# = 1 && "$1" = /* && -f "$1" ]] || fail "Specify an absolute backup path."
    running && fail "Stop the service first."
    [[ -z "$(find "$DATA_DIR/state" "$DATA_DIR/home" "$DATA_DIR/workspace" -mindepth 1 -print -quit)" ]] \
      || fail "Restore only into a fresh initialized deployment; existing data will not be overwritten."
    tar -tzf "$1" | grep -Fx './.cc-desk-tunnel-data' >/dev/null || fail "Not a managed backup."
    if tar -tzf "$1" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then fail "Unsafe archive paths."; fi
    tar -xzf "$1" -C "$DATA_DIR" --no-same-owner
    [[ "$(id -u)" != 0 ]] || chown -R 1000:1000 "$DATA_DIR"
    echo "Restored. Confirm config/service.env, host, port and certificate settings before up."
    ;;
  certificate|renew)
    [[ "$MODE" != nginx ]] || fail "nginx owns and renews the frontend certificate; reload nginx there."
    temp="$(mktemp -d)"
    trap 'rm -rf -- "$temp"' EXIT
    if [[ "$command" = renew ]]; then
      [[ "$MODE" = fingerprint ]] || fail "Use certificate FULLCHAIN KEY for CA certificates."
      make_cert cc-desk-tunnel.local "$temp/control" 365 FALSE
    else
      [[ $# = 2 ]] || fail "Specify certificate and key."
      cert_pair "$1" "$2"
      if [[ "$MODE" = certificate ]]; then
        name="$(sed -n "s/^PROXY_CERT_NAME='\(.*\)'$/\1/p" "$DATA_DIR/config/service.env")"
        cert_name "$1" "$name"
      fi
      cp -- "$1" "$temp/control.crt"; cp -- "$2" "$temp/control.key"
    fi
    was_running=false; running && was_running=true
    dc stop
    install -m 600 "$temp/control.crt" "$DATA_DIR/tls/control.crt"
    install -m 600 "$temp/control.key" "$DATA_DIR/tls/control.key"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$DATA_DIR"/tls/control.{crt,key}
    if $was_running; then dc start; wait_healthy; fi
    echo "Frontend certificate replaced. Fingerprint mode clients must update their pin."
    ;;
  *) usage; fail "Unknown command: $command" ;;
esac
