#!/system/bin/sh
# action.sh —— 模块列表里的「执行 / 操作」按钮
# 只读：显示当前状态与常用命令，不做任何修改（防止误触）

MODDIR=${0%/*}
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"
[ -z "$PORT" ]        && PORT=27042
[ -z "$BIN_NAME" ]    && BIN_NAME=frida-server
[ -z "$MOD_NAME" ]    && MOD_NAME="System Monitor"
[ -z "$MOD_VERSION" ] && MOD_VERSION="1.5.0"

PID=$(pidof "$BIN_NAME" 2>/dev/null)

# 运行时长（开机后多久拉起的）
UPTIME_TXT=""
if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then
  UP=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
  ST=$(awk '{print int($22/100)}' "/proc/$PID/stat" 2>/dev/null)
  if [ -n "$UP" ] && [ -n "$ST" ]; then
    SEC=$((UP - ST))
    UPTIME_TXT="（已运行 $((SEC / 86400))d $((SEC % 86400 / 3600))h $((SEC % 3600 / 60))m）"
  fi
fi

# 监听状态
if netstat -tln 2>/dev/null | grep -q ":$PORT "; then
  LISTEN_TXT="监听中"
else
  LISTEN_TXT="未监听"
fi

# 开机自启状态
if [ -f "$MODDIR/noautostart" ]; then
  AUTO_TXT="已关闭"
else
  AUTO_TXT="已开启"
fi

echo "模块    : $MOD_NAME  $MOD_VERSION"
echo "进程名  : $BIN_NAME  (pid: ${PID:-未运行})$UPTIME_TXT"
echo "端口    : 127.0.0.1:$PORT  [$LISTEN_TXT]"
echo "开机自启: $AUTO_TXT"
echo "PC 连接 : adb forward tcp:$PORT tcp:$PORT"
echo "Frida   : frida -H 127.0.0.1:$PORT -n <包名> -l <脚本>"
echo ""
echo "改配置  : 打开本模块的 WebUI（图形化，推荐）"
echo "          或 su -c 'sh $MODDIR/set_config.sh <端口> <进程名>'"
echo "看全部  : su -c 'sh $MODDIR/set_config.sh'"
echo "自启开关: su -c 'sh $MODDIR/set_config.sh on|off'"
echo ""
echo "--- 最近日志 ---"
tail -3 /data/local/tmp/frida_patched.log 2>/dev/null || echo "(无日志)"
