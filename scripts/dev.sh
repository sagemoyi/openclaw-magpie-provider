#!/usr/bin/env bash
# dev.sh — 插件开发隔离包装器
#
# 所有手动 OpenClaw 操作强制走 `--profile dev`（独立的配置、状态目录、
# workspace 和固定端口 19001），绝不触碰默认 profile 的生产 Gateway（18789）。
#
# 规范见仓库根目录 AGENTS.md。新机器首次使用：scripts/dev.sh setup
#
# 用法：
#   scripts/dev.sh setup                  初始化 dev profile（新机器只需一次）
#   scripts/dev.sh install                以 --link 方式把本仓库装入 dev 实例（开发循环）
#   scripts/dev.sh reload                 等价于 restart，确保 --link 的 ESM helper 重新加载
#   scripts/dev.sh restart                重启 dev Gateway（reload 不生效时用）
#   scripts/dev.sh inspect                查看插件运行时注册情况（--runtime --json）
#   scripts/dev.sh start|stop|status      按需启停 dev Gateway（默认不运行，测试时才启动）
#   scripts/dev.sh logs                   跟踪 dev Gateway 日志
#   scripts/dev.sh call <method> [args..] 调用 dev Gateway RPC（如 call models.list）
#   scripts/dev.sh pack-verify            发布前验证：npm pack + npm-pack: 安装 + inspect
#   scripts/dev.sh uninstall              从 dev 实例卸载本插件
set -euo pipefail

PROFILE="dev"
PLUGIN_ID="magpie"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 解析全局 openclaw CLI：跳过仓库内的 node_modules/.bin
# （npm run 会把它放到 PATH 最前，--link 安装时新版主机会报虚假的所有权冲突，
#   与 test/install-host-plugin.js 的 resolveHostCli 同理）
resolve_cli() {
  local dir cand real
  local IFS=':'
  for dir in ${PATH:-}; do
    [ -n "$dir" ] || continue
    cand="$dir/openclaw"
    [ -x "$cand" ] || continue
    real="$(readlink -f "$cand" 2>/dev/null || printf '%s' "$cand")"
    case "$real" in
      "$REPO_ROOT"|"$REPO_ROOT"/*) continue ;;
    esac
    printf '%s' "$cand"
    return 0
  done
  printf 'openclaw'
}

CLI="$(resolve_cli)"

# HOME 是唯一允许的根目录输入（测试可以用临时 HOME）；不接受 OpenClaw/平台
# fallback home 覆盖，也不把相对 HOME 或 / 悄悄解析成另一个实例。
case "${HOME:-}" in
  /*) ;;
  *) echo 'dev.sh: HOME 必须是已存在的绝对目录' >&2; exit 2 ;;
esac
if [ ! -d "$HOME" ]; then
  echo 'dev.sh: HOME 必须是已存在的绝对目录' >&2
  exit 2
fi
DEV_HOME="$(cd -P -- "$HOME" && pwd -P)"
if [ "$DEV_HOME" = / ]; then
  echo 'dev.sh: 不允许使用 / 作为 HOME' >&2
  exit 2
fi
STATE_DIR="$DEV_HOME/.openclaw-$PROFILE"
CONFIG_PATH="$STATE_DIR/openclaw.json"
# 已有 symlink 也不能把固定 dev 路径转回生产；不创建任何目录来做检查。
if [ -L "$STATE_DIR" ] || { [ -e "$STATE_DIR" ] && [ ! -d "$STATE_DIR" ]; } ||
   [ -L "$CONFIG_PATH" ] || { [ -e "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; }; then
  echo 'dev.sh: dev state/config 必须是普通目录/文件，不能是符号链接' >&2
  exit 2
fi

# 拒绝目标/profile/目录覆盖，包括 =value 和 -- 后的参数；在任何 help 探测、
# install 或 systemctl 操作前检查，而不只是检查最终转发给 CLI 的参数。
validate_args() {
  local arg option
  for arg in "$@"; do
    option="${arg%%=*}"
    case "$option" in
      --profile|--dev|--no-dev|--url|--port|--gateway-url|--gateway-port|--host|--bind|--remote|--container|--home|--root|--state-dir|--config|--config-path|--workspace|--workspace-dir|--agent|--agent-dir|--service|--systemd-unit|--launchd-label|--windows-task-name|--env|--env-file|-p|-p?*)
        echo "dev.sh: 不允许覆盖开发实例目标或目录（$option）" >&2
        exit 2 ;;
    esac
  done
}
validate_args "$@"

# 不用 env -i：保留 PATH、Node 运行时/证书、代理等必要环境。清除宿主全部
# 命名空间，覆盖 pinned host 的 config/service selectors，并清除兼容名称、
# agent fallback、平台 home/XDG、systemd 总线和 Node 注入式选项。
# 在子 shell 内执行，所有 CLI 调用（包括 consent help）都走同一入口。
dev_env() (
  local name
  for name in $(compgen -e); do
    case "$name" in
      OPENCLAW_*|CLAWDBOT_*|MOLTBOT_*|PI_CODING_AGENT_DIR|USERPROFILE|HOMEDRIVE|HOMEPATH|PREFIX|ANDROID_DATA|XDG_*|DBUS_*|SYSTEMD_*|SUDO_*|NODE_OPTIONS)
        unset "$name" ;;
    esac
  done
  export HOME="$DEV_HOME"
  export XDG_CONFIG_HOME="$DEV_HOME/.config" XDG_CACHE_HOME="$DEV_HOME/.cache"
  export XDG_DATA_HOME="$DEV_HOME/.local/share" XDG_STATE_HOME="$DEV_HOME/.local/state"
  export XDG_RUNTIME_DIR="/run/user/$UID"
  export OPENCLAW_HOME="$DEV_HOME" OPENCLAW_PROFILE="$PROFILE"
  export OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
  export OPENCLAW_WORKSPACE_DIR="$STATE_DIR/workspace" OPENCLAW_GATEWAY_PORT=19001
  # 固定 loopback URL 作为兜底，替换继承值；下方 RPC/status 另用固定本地
  # port 保留 dev config 认证，同时忽略 config 中的 remote URL/mode。
  export OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19001
  "$@"
)

oc() {
  validate_args "$@"
  # pinned host 的 URL override 不复用 config token；RPC/status 显式指定本地
  # port 才既忽略远端 URL/mode，又保留 dev config 的本地认证。用户不能覆盖。
  case "${1:-}:${2:-}" in
    gateway:call|gateway:status)
      local action="$2"
      shift 2
      dev_env "$CLI" --profile "$PROFILE" gateway "$action" --port 19001 "$@" ;;
    logs:*)
      shift
      dev_env "$CLI" --profile "$PROFILE" logs --port 19001 "$@" ;;
    *) dev_env "$CLI" --profile "$PROFILE" "$@" ;;
  esac
}

need_plugin_linked_hint() {
  echo "hint: 先运行 scripts/dev.sh install 把仓库链接进 dev 实例" >&2
}

consent_flags() {
  # --force 是非交互确认本地来源；新版主机对 link/tarball 安装都要求显式能力同意
  local help
  help="$(oc plugins install --help 2>&1 || true)"
  local extra=(--force)
  case "$help" in *"--accept-capabilities"*) extra+=(--accept-capabilities) ;; esac
  printf '%s\n' "${extra[@]}"
}

cmd_install() {
  # --link 不复制目录，改代码即时作用于 dev 实例（restart 后生效）
  local extra=()
  mapfile -t extra < <(consent_flags)
  oc plugins install --link "${extra[@]}" "$REPO_ROOT"
  echo
  echo "已链接安装到 dev 实例。改代码后运行 scripts/dev.sh restart 生效。"
}

cmd_pack_verify() {
  # 官方发布前验证：tarball 走托管 npm 项目安装，能发现源码 checkout 掩盖的依赖问题
  local dest tgz
  dest="$(mktemp -d)"
  (cd "$REPO_ROOT" && npm pack --pack-destination "$dest" >/dev/null)
  tgz="$(ls "$dest"/*.tgz | head -1)"
  echo "tarball: $tgz"
  local extra=()
  mapfile -t extra < <(consent_flags)
  oc plugins install "npm-pack:$tgz" "${extra[@]}"
  echo
  echo "--- 运行时验证 ---"
  oc plugins inspect "$PLUGIN_ID" --runtime --json
  echo
  echo "注意：pack-verify 后安装形态变为 tarball 拷贝；继续开发请重新 scripts/dev.sh install 恢复 --link。"
}

cmd_setup() {
  echo "初始化 dev profile（config/state/workspace 位于 $STATE_DIR，端口固定 19001）..."
  oc setup --baseline
  # 使用与 CLI 完全相同的路径和环境；修复已有 dev 配置中的远端目标/监听设置。
  dev_env node - <<'EOF'
const fs = require("node:fs");
const crypto = require("node:crypto");
const p = process.env.OPENCLAW_CONFIG_PATH;
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.gateway = cfg.gateway ?? {};
cfg.gateway.mode = "local";
cfg.gateway.bind = "loopback";
cfg.gateway.port = 19001;
delete cfg.gateway.remote;
if (cfg.gateway.auth?.mode !== "token" || !cfg.gateway.auth?.token) {
  cfg.gateway.auth = { mode: "token", token: crypto.randomBytes(24).toString("hex") };
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.chmodSync(p, 0o600);
console.log("gateway 配置：", JSON.stringify({ ...cfg.gateway, auth: { mode: "token", token: "<redacted>" } }));
EOF
  echo
  echo "安装 dev Gateway 服务（systemd user，独立于生产的 openclaw-gateway.service）..."
  oc gateway install --force
  dev_env systemctl --user disable openclaw-gateway-$PROFILE.service 2>/dev/null || true  # dev 实例不常驻：默认不开机自启，测试时才 start
  echo
  echo "setup 完成（服务已安装但默认不启动、不开机自启）。需要手动验证时：scripts/dev.sh install && scripts/dev.sh start，用完 scripts/dev.sh stop"
}

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  setup)       cmd_setup "$@" ;;
  install)     cmd_install "$@" ;;
  pack-verify) cmd_pack_verify "$@" ;;
  reload)      oc gateway restart "$@" ;;  # --link 代码改动使用进程级重启，确保清除 ESM 模块缓存
  restart)     oc gateway restart "$@" ;;
  inspect)     oc plugins inspect "$PLUGIN_ID" --runtime --json "$@" ;;
  start)       oc gateway start "$@" ;;
  stop)        dev_env systemctl --user stop openclaw-gateway-$PROFILE.service ;;  # 直接走固定 dev unit，不让 gateway stop 探测其他实例
  status)      oc gateway status "$@" ; echo ; oc plugins list 2>/dev/null | grep -i "$PLUGIN_ID" || need_plugin_linked_hint ;;
  logs)        oc logs --follow "$@" ;;
  call)        oc gateway call "$@" ;;
  run)         oc gateway run "$@" ;;   # 前台调试模式
  uninstall)   oc plugins uninstall "$PLUGIN_ID" "$@" ;;
  help|--help|-h)
    sed -n '2,30p' "${BASH_SOURCE[0]}" ;;
  *)
    echo "dev.sh: 未知命令 '$cmd'（已自动限定 --profile $PROFILE）" >&2
    echo "运行 scripts/dev.sh help 查看用法" >&2
    exit 2 ;;
esac
