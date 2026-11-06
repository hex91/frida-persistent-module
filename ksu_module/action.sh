#!/system/bin/sh
# action.sh —— 模块列表里的「执行」按钮
# 只显示当前状态，不做任何修改，防止误触。

MODDIR=${0%/*}
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"
[ -z "$PORT" ]        && PORT=27042
[ -z "$BIN_NAME" ]    && BIN_NAME=frida-server
[ -z "$MOD_NAME" ]    && MOD_NAME="System Monitor"
[ -z "$MOD_VERSION" ] && MOD_VERSION="1.4.2"

PID=$(pidof "$BIN_NAME" 2>/dev/null)

echo "模块    : $MOD_NAME  $MOD_VERSION"
echo "进程名  : $BIN_NAME  (pid: ${PID:-未运行})"
echo "端口    : 127.0.0.1:$PORT"
echo "PC 连接 : adb forward tcp:$PORT tcp:$PORT"
echo "Frida   : frida -H 127.0.0.1:$PORT -n <包名> -l <脚本>"
echo ""
echo "改配置  : su -c 'sh $MODDIR/set_config.sh <端口> <进程名>'"
echo "看全部  : su -c 'sh $MODDIR/set_config.sh'"
