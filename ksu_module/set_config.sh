#!/system/bin/sh
# frida 模块配置助手 — 端口 / 进程名 / 模块显示名 / 显示版本
#
# 用法（无参数 = 查看当前配置和用法）：
#   su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh'
#
#   su -c 'sh .../set_config.sh 39527 sysmon'          改端口 + 进程名（立即生效）
#   su -c 'sh .../set_config.sh name "System Monitor"'  改模块列表显示名
#   su -c 'sh .../set_config.sh version "1.5.0" 10500'  改模块列表显示版本（第二个参数可省）
#   su -c 'sh .../set_config.sh restart'                按当前配置重启 frida-server
#   su -c 'sh .../set_config.sh status'                 只看运行状态（适合脚本调用）
#   su -c 'sh .../set_config.sh off'                    关闭开机自启（保留模块）
#   su -c 'sh .../set_config.sh on'                     重新开启开机自启
#
# 图形化修改：管理器模块页 → WebUI（webroot/index.html），无需敲命令

MODDIR=${0%/*}
CONFIG="$MODDIR/config.sh"
PERSIST=/data/adb/frida_module.conf
LOG=/data/local/tmp/frida_patched.log

# config.sh 缺失时：优先用模块目录外的持久化备份，其次出厂模板
# （模块被重装/目录被清空后仍能恢复原来的端口与进程名）
if [ ! -f "$CONFIG" ]; then
  if [ -f "$PERSIST" ]; then
    cp "$PERSIST" "$CONFIG" 2>/dev/null
  elif [ -f "$MODDIR/config.default.sh" ]; then
    cp "$MODDIR/config.default.sh" "$CONFIG" 2>/dev/null
  fi
  chmod 600 "$CONFIG" 2>/dev/null
fi

[ -f "$CONFIG" ] && . "$CONFIG"
# 首次运行且还没有备份时补一份
[ -f "$CONFIG" ] && [ ! -f "$PERSIST" ] && { cp "$CONFIG" "$PERSIST" 2>/dev/null; chmod 600 "$PERSIST" 2>/dev/null; }
[ -z "$PORT" ]             && PORT=27042
[ -z "$BIN_NAME" ]         && BIN_NAME=frida-server
[ -z "$MOD_NAME" ]         && MOD_NAME="System Monitor"
[ -z "$MOD_VERSION" ]      && MOD_VERSION="1.5.0"
[ -z "$MOD_VERSION_CODE" ] && MOD_VERSION_CODE=10500

# ---------- 工具函数 ----------
# 安全地改 config.sh 里的一个 key（保留其它行和注释）
set_kv() {
  _k="$1"
  _v=$(printf '%s' "$2" | tr -d '"')
  _tmp="$CONFIG.tmp.$$"
  if [ -f "$CONFIG" ]; then
    grep -v "^$_k=" "$CONFIG" > "$_tmp" 2>/dev/null
  else
    : > "$_tmp"
  fi
  printf '%s="%s"\n' "$_k" "$_v" >> "$_tmp"
  # 用 cat > 覆盖，保留 SELinux 上下文
  cat "$_tmp" > "$CONFIG"
  rm -f "$_tmp"
  # 同步到模块目录之外的备份，重装模块后可从备份恢复
  cp "$CONFIG" "$PERSIST" 2>/dev/null && chmod 600 "$PERSIST" 2>/dev/null
}

# 杀掉本模块拉起的所有 server 实例（按 cmdline 前缀判断，不会误杀脚本自己）
kill_all_servers() {
  _pids=""
  _p=""
  _pid=""
  _cmd=""
  _i=""
  _dead=""
  for _p in /proc/[0-9]*; do
    _pid=${_p#/proc/}
    [ "$_pid" = "$$" ] && continue
    _cmd=$(cat "$_p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$_cmd" in
      "$MODDIR"/*) _pids="$_pids $_pid" ;;
    esac
  done
  [ -z "$_pids" ] && return 0
  kill $_pids 2>/dev/null
  for _i in 1 2 3; do
    _dead=1
    for _p in $_pids; do
      [ -d "/proc/$_p" ] && _dead=0
    done
    [ "$_dead" = "1" ] && return 0
    sleep 1
  done
  kill -9 $_pids 2>/dev/null
  sleep 1
}

# 等待新 server 就绪：进程存在且端口监听，最长 15 秒
wait_ready() {
  _name="$1"
  _port="$2"
  _i=""
  for _i in $(seq 1 15); do
    if [ -n "$(pidof "$_name" 2>/dev/null)" ] && netstat -tln 2>/dev/null | grep -q ":$_port "; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_server() {
  echo "[*] 停止旧实例..."
  kill_all_servers
  echo "[*] 按配置启动: $BIN_NAME @ 127.0.0.1:$PORT"
  sh "$MODDIR/service.sh"
  if wait_ready "$BIN_NAME" "$PORT"; then
    echo ""
    echo "=== 生效 ==="
    echo "进程: $BIN_NAME (pid $(pidof "$BIN_NAME"))"
    echo "端口: 127.0.0.1:$PORT 监听中"
    echo "PC 端: adb forward tcp:$PORT tcp:$PORT"
  else
    echo ""
    echo "=== 未就绪，查日志: cat $LOG ==="
    tail -5 "$LOG" 2>/dev/null
  fi
}

show() {
  echo "=== 当前配置（config.sh）==="
  cat "$CONFIG" 2>/dev/null || echo "(config.sh 不存在，使用默认值)"
  echo ""
  echo "=== 模块列表显示（module.prop）==="
  grep -E '^(id|name|version|versionCode|description)=' "$MODDIR/module.prop" 2>/dev/null
  echo ""
  echo "=== 运行中的实例 ==="
  for p in /proc/[0-9]*; do
    cmd=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$cmd" in
      "$MODDIR"/*) echo "  pid ${p#/proc/}: $cmd" ;;
    esac
  done
  echo ""
  echo "=== 用法 ==="
  echo "图形化      : 管理器模块页 → WebUI（推荐，无需命令）"
  echo "改端口/进程名: su -c 'sh $MODDIR/set_config.sh <端口> <进程名>'"
  echo "              例: su -c 'sh $MODDIR/set_config.sh 39527 sysmon'"
  echo "改显示名    : su -c 'sh $MODDIR/set_config.sh name \"System Monitor\"'"
  echo "改显示版本  : su -c 'sh $MODDIR/set_config.sh version \"1.5.0\" 10500'"
  echo "仅重启      : su -c 'sh $MODDIR/set_config.sh restart'"
  echo "开机自启    : su -c 'sh $MODDIR/set_config.sh on|off'"
  echo ""
  echo "提示: 改完若模块列表没刷新，下拉刷新或退出重进管理器。"
}

# 紧凑状态（供 WebUI / 脚本解析，格式固定：key=value）
status_compact() {
  PID=$(pidof "$BIN_NAME" 2>/dev/null)
  LISTEN=0
  netstat -tln 2>/dev/null | grep -q ":$PORT " && LISTEN=1
  AUTO=1
  [ -f "$MODDIR/noautostart" ] && AUTO=0
  echo "BIN_NAME=$BIN_NAME"
  echo "PORT=$PORT"
  echo "PID=${PID:-0}"
  echo "LISTEN=$LISTEN"
  echo "AUTOSTART=$AUTO"
  echo "MOD_NAME=$MOD_NAME"
  echo "MOD_VERSION=$MOD_VERSION"
  echo "MOD_VERSION_CODE=$MOD_VERSION_CODE"
  if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then
    UP=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
    ST=$(awk '{print int($22/100)}' "/proc/$PID/stat" 2>/dev/null)
    [ -n "$UP" ] && [ -n "$ST" ] && echo "UPTIME=$((UP - ST))"
  fi
}

# ---------- 无参数：查看 ----------
if [ $# -eq 0 ]; then
  show
  exit 0
fi

# ---------- 子命令 ----------
case "$1" in
  restart)
    restart_server
    exit 0
    ;;

  name)
    shift
    NEW_NAME=$(printf '%s' "$*" | tr -d '"')
    if [ -z "$NEW_NAME" ]; then
      echo "错误: 名字不能为空。例: set_config.sh name \"System Monitor\""
      exit 1
    fi
    set_kv MOD_NAME "$NEW_NAME"
    echo "[*] 模块显示名 -> $NEW_NAME"
    sh "$MODDIR/sync_prop.sh"
    echo "[!] 管理器里下拉刷新（或退出重进）即可看到新名字。"
    exit 0
    ;;

  version)
    shift
    NEW_VER=$(printf '%s' "$1" | tr -d '"')
    NEW_CODE="$2"
    if [ -z "$NEW_VER" ]; then
      echo "错误: 版本号不能为空。例: set_config.sh version \"1.4.2\" 10402"
      exit 1
    fi
    set_kv MOD_VERSION "$NEW_VER"
    if [ -n "$NEW_CODE" ]; then
      case "$NEW_CODE" in
        *[!0-9]*) echo "错误: versionCode 必须是纯数字"; exit 1 ;;
      esac
      set_kv MOD_VERSION_CODE "$NEW_CODE"
    fi
    echo "[*] 模块版本 -> $NEW_VER ${NEW_CODE:+($NEW_CODE)}"
    sh "$MODDIR/sync_prop.sh"
    echo "[!] 管理器里下拉刷新（或退出重进）即可看到新版本。"
    exit 0
    ;;

  status)
    status_compact
    exit 0
    ;;

  off)
    : > "$MODDIR/noautostart"
    chmod 644 "$MODDIR/noautostart"
    echo "[*] 已关闭开机自启（当前实例仍在运行，重启后不会再自动启动）"
    echo "    重新开启: sh $MODDIR/set_config.sh on"
    exit 0
    ;;

  on)
    rm -f "$MODDIR/noautostart"
    echo "[*] 已开启开机自启（下次开机自动启动）"
    pidof "$BIN_NAME" >/dev/null 2>&1 || { echo "[*] 当前未运行，立即启动..."; restart_server; }
    exit 0
    ;;
esac

# ---------- 位置参数：<端口> <进程名> ----------
if [ $# -lt 2 ]; then
  echo "参数不足。无参数运行可查看用法。"
  exit 1
fi

NEW_PORT="$1"
NEW_BIN="$2"

# 端口校验
case "$NEW_PORT" in
  ''|*[!0-9]*) echo "错误: 端口必须是纯数字，收到 '$NEW_PORT'"; exit 1 ;;
esac
if [ "$NEW_PORT" -lt 1024 ] || [ "$NEW_PORT" -gt 65535 ]; then
  echo "错误: 端口需在 1024-65535 之间"
  exit 1
fi

# 进程名校验（Linux comm 上限 15 字符）
NAMELEN=$(printf '%s' "$NEW_BIN" | wc -c)
if [ "$NAMELEN" -gt 15 ]; then
  echo "错误: 进程名超过 15 字符（当前 $NAMELEN，Linux 上限 15）"
  exit 1
fi
case "$NEW_BIN" in
  *[!a-zA-Z0-9._-]*) echo "错误: 进程名只允许字母/数字/._- ，收到 '$NEW_BIN'"; exit 1 ;;
esac

# 端口占用检查：新端口已被别的进程占用时直接拒绝（同端口即重启场景，跳过）
if [ "$NEW_PORT" != "$PORT" ] && netstat -tln 2>/dev/null | grep -q ":$NEW_PORT "; then
  echo "错误: 端口 $NEW_PORT 已被占用"
  netstat -tlnp 2>/dev/null | grep ":$NEW_PORT " | head -2
  echo "     换一个端口，或先停掉占用该端口的进程"
  exit 1
fi

# 记住旧进程名，切换成功后清理旧副本（否则每改一次名就多占 52MB）
OLD_BIN="$BIN_NAME"

echo "[*] 写入配置: PORT=$NEW_PORT BIN_NAME=$NEW_BIN"
set_kv PORT "$NEW_PORT"
set_kv BIN_NAME "$NEW_BIN"

echo "[*] 同步模块列表说明..."
sh "$MODDIR/sync_prop.sh"

echo "[*] 停止所有旧实例..."
kill_all_servers

echo "[*] 按新配置启动（改名副本首次复制约需数秒）..."
sh "$MODDIR/service.sh"

if wait_ready "$NEW_BIN" "$NEW_PORT"; then
  echo ""
  echo "=== 生效 ==="
  echo "进程: $NEW_BIN (pid $(pidof "$NEW_BIN"))"
  echo "端口: 127.0.0.1:$NEW_PORT 监听中"
  echo "PC 端: adb forward tcp:$NEW_PORT tcp:$NEW_PORT"
  echo ""
  echo "（模块列表里的说明已同步，下拉刷新可见）"
else
  echo ""
  echo "=== 未就绪，查日志: cat $LOG ==="
  tail -5 "$LOG" 2>/dev/null
fi

# 清理旧进程名留下的副本（母本 frida-server 永不删除）
if [ -n "$OLD_BIN" ] && [ "$OLD_BIN" != "$NEW_BIN" ] && [ "$OLD_BIN" != "frida-server" ]; then
  if [ -f "$MODDIR/$OLD_BIN" ]; then
    rm -f "$MODDIR/$OLD_BIN"
    echo "（已删除旧进程名副本: $OLD_BIN）"
  fi
fi
