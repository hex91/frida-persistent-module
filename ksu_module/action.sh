#!/system/bin/sh
# SukiSU / KernelSU 管理器模块页「操作」按钮：显示当前配置、运行状态与修改方法
MODDIR=${0%/*}

PORT=27042
BIN_NAME=frida-server
if [ -f "$MODDIR/config.sh" ]; then
  . "$MODDIR/config.sh"
elif [ -f "$MODDIR/config.default.sh" ]; then
  . "$MODDIR/config.default.sh"
fi

echo "===== frida 持久化模块 ====="
echo "当前端口:   $PORT"
echo "当前进程名: $BIN_NAME"
if pidof "$BIN_NAME" >/dev/null 2>&1; then
  echo "运行状态:   运行中 (pid $(pidof "$BIN_NAME"))"
else
  echo "运行状态:   未运行"
fi
echo ""
echo "修改并立即生效:"
echo "  su -c 'sh $MODDIR/set_config.sh <新端口> <新进程名>'"
echo "示例:"
echo "  su -c 'sh $MODDIR/set_config.sh 39527 sysmon'"
echo ""
echo "PC 端连接: adb forward tcp:$PORT tcp:$PORT"
echo "运行脚本: python run_frida.py <脚本.js> [时长] $PORT"
