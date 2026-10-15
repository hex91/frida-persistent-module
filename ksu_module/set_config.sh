#!/system/bin/sh
# frida 模块配置助手 — 修改端口/进程名并立即生效 (v2 加固版)
# 用法(无参数): sh set_config.sh              → 查看当前配置和用法
# 用法(修改):   sh set_config.sh <端口> <进程名>  → 写入配置并立即重启生效
# 用法(重启):   sh set_config.sh restart      → 按当前配置重启 server
# 示例:         su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh 39527 sysmon'
MODDIR=${0%/*}
CONFIG="$MODDIR/config.sh"
LOG=/data/local/tmp/frida_patched.log

# 杀掉本模块拉起的所有 server 实例
# 判定: cmdline 以 "$MODDIR/" 开头 = server 二进制(脚本进程以 sh 开头, 不会误杀自己)
# 先 SIGTERM, 3 秒不退再 SIGKILL
kill_all_servers() {
  local pids="" p pid cmd i dead
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ "$pid" = "$$" ] && continue
    cmd=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$cmd" in
      "$MODDIR"/*) pids="$pids $pid" ;;
    esac
  done
  [ -z "$pids" ] && return 0
  kill $pids 2>/dev/null
  for i in 1 2 3; do
    dead=1
    for p in $pids; do
      [ -d "/proc/$p" ] && dead=0
    done
    [ "$dead" = "1" ] && return 0
    sleep 1
  done
  kill -9 $pids 2>/dev/null
  sleep 1
}

# 等待新 server 就绪: 进程存在且端口监听, 最长 15 秒
wait_ready() {
  local name="$1" port="$2" i
  for i in $(seq 1 15); do
    if [ -n "$(pidof "$name" 2>/dev/null)" ] && netstat -tln 2>/dev/null | grep -q ":$port "; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ---------- 无参数: 显示当前配置和用法 ----------
if [ $# -eq 0 ]; then
  echo "=== 当前配置 ==="
  cat "$CONFIG" 2>/dev/null || echo "(config.sh 不存在, 使用默认值 27042/frida-server)"
  echo ""
  echo "=== 当前运行中的实例 ==="
  for p in /proc/[0-9]*; do
    cmd=$(cat "$p/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$cmd" in
      "$MODDIR"/*) echo "  pid ${p#/proc/}: $cmd" ;;
    esac
  done
  echo ""
  echo "=== 用法 ==="
  echo "修改并立即生效: su -c 'sh $MODDIR/set_config.sh <端口> <进程名>'"
  echo "示例:           su -c 'sh $MODDIR/set_config.sh 39527 sysmon'"
  echo "仅重启 server:  su -c 'sh $MODDIR/set_config.sh restart'"
  echo "注意: 改了端口后, PC 端跑脚本要带端口号:"
  echo "      python run_frida.py <脚本.js> [时长] <端口>"
  exit 0
fi

# ---------- restart: 按当前配置重启 ----------
if [ "$1" = "restart" ]; then
  . "$CONFIG" 2>/dev/null
  [ -z "$BIN_NAME" ] && BIN_NAME=frida-server
  [ -z "$PORT" ] && PORT=27042
  echo "[*] 停止旧实例..."
  kill_all_servers
  echo "[*] 按配置启动: $BIN_NAME @ 127.0.0.1:$PORT"
  sh "$MODDIR/service.sh"
  if wait_ready "$BIN_NAME" "$PORT"; then
    echo "[OK] 进程 $BIN_NAME(pid $(pidof "$BIN_NAME")) 监听 127.0.0.1:$PORT"
  else
    echo "[失败] 未就绪, 查日志: cat $LOG"
  fi
  exit 0
fi

# ---------- 修改: 校验 → 写入 → 重启生效 ----------
if [ $# -lt 2 ]; then
  echo "参数不足。无参数运行可查看用法。"
  exit 1
fi

PORT="$1"
BIN_NAME="$2"

# 端口校验: 纯数字
case "$PORT" in
  ''|*[!0-9]*) echo "错误: 端口必须是纯数字, 收到 '$PORT'"; exit 1 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "错误: 端口需在 1024-65535 之间"
  exit 1
fi

# 进程名校验: <=15 字符, 安全字符
NAMELEN=$(echo -n "$BIN_NAME" | wc -c)
if [ "$NAMELEN" -gt 15 ]; then
  echo "错误: 进程名超过 15 字符 (当前 $NAMELEN, Linux comm 名上限 15)"
  exit 1
fi
case "$BIN_NAME" in
  *[!a-zA-Z0-9._-]*) echo "错误: 进程名只允许字母/数字/._- , 收到 '$BIN_NAME'"; exit 1 ;;
esac

echo "[*] 写入配置: PORT=$PORT BIN_NAME=$BIN_NAME"
printf 'PORT=%s\nBIN_NAME=%s\n' "$PORT" "$BIN_NAME" > "$CONFIG"

echo "[*] 停止所有旧实例..."
kill_all_servers

echo "[*] 按新配置启动(改名副本复制约需数秒)..."
sh "$MODDIR/service.sh"

if wait_ready "$BIN_NAME" "$PORT"; then
  echo ""
  echo "=== 生效 ✓ ==="
  echo "进程: $BIN_NAME (pid $(pidof "$BIN_NAME"))"
  echo "端口: 127.0.0.1:$PORT 监听中"
  echo "PC 端: adb forward tcp:$PORT tcp:$PORT 后, 脚本带端口 $PORT"
else
  echo ""
  echo "=== 未就绪, 查日志: cat $LOG ==="
  tail -5 "$LOG" 2>/dev/null
fi
