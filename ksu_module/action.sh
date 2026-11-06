#!/system/bin/sh
# action.sh —— 模块列表里的「执行 / 操作」按钮
# 只读：显示当前状态与常用命令，不做任何修改（防止误触）

MODDIR=${0%/*}
# frida 版本 / 来源（唯一事实来源：frida_info.sh）
[ -f "$MODDIR/frida_info.sh" ] && . "$MODDIR/frida_info.sh"
[ -z "$FRIDA_VERSION" ] && FRIDA_VERSION="17.5.2"
[ -z "$FRIDA_BUILD" ]   && FRIDA_BUILD="android16"
[ -z "$FRIDA_FLAVOR" ]  && FRIDA_FLAVOR="sijan2 补丁版"
[ -z "$FRIDA_REPO" ]    && FRIDA_REPO="https://github.com/sijan2/frida"
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"
[ -z "$PORT" ]        && PORT=27042
[ -z "$BIN_NAME" ]    && BIN_NAME=frida-server
[ -z "$MOD_NAME" ]    && MOD_NAME="System Monitor"
[ -z "$MOD_VERSION" ] && MOD_VERSION="1.7.0"

PID=""
# 按 /proc/<pid>/exe 指向的路径找本模块的进程
# （不能用 pidof：进程名可能与系统守护进程重名；也不要逐个 cat cmdline：700+ 进程要十几秒）
PID=$(ls -l /proc/[0-9]*/exe 2>/dev/null | awk -v tgt="$MODDIR/$BIN_NAME" '
  {
    if ($0 !~ / -> /) next
    t = $0; sub(/^.* -> /, "", t)
    if (t != tgt) next
    p = $0; sub(/^.*\/proc\//, "", p); sub(/\/exe.*$/, "", p)
    if (p ~ /^[0-9]+$/) { print p; exit }
  }')

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
echo "frida   : $FRIDA_VERSION-$FRIDA_BUILD ($FRIDA_FLAVOR)"
echo "来源    : $FRIDA_REPO"
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
