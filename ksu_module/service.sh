#!/system/bin/sh
# frida-server (sijan2 patched 17.5.2-android16) autostart — v3 可配置端口/进程名
# runs as root in late_start service context (KernelSU / SukiSU / Magisk)
MODDIR=${0%/*}

# 默认值（可被 config.sh 覆盖）
PORT=27042
BIN_NAME=frida-server

# 用户配置不随模块升级丢失：config.sh 不在 zip 内，缺失时从 config.default.sh 播种
if [ ! -f "$MODDIR/config.sh" ] && [ -f "$MODDIR/config.default.sh" ]; then
  cp "$MODDIR/config.default.sh" "$MODDIR/config.sh" 2>/dev/null
  chmod 600 "$MODDIR/config.sh" 2>/dev/null
fi
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"

# 同步管理器（SukiSU / KernelSU）模块页提示：当前端口 / 进程名 / 修改方法
if [ -f "$MODDIR/sync_desc.sh" ]; then
  sh "$MODDIR/sync_desc.sh" >/dev/null 2>&1
fi

(
  # wait for boot complete
  until [ "$(getprop sys.boot_completed)" = "1" ]; do
    sleep 5
  done
  sleep 10

  # kill switch: touch "disable" in module dir to prevent autostart
  [ -f "$MODDIR/disable" ] && exit 0

  # 进程名伪装: 进程 comm 名 = 二进制文件名(≤15字符)
  # 若配置了 BIN_NAME 且改名副本不存在, 从母本 frida-server 复制一份
  if [ "$BIN_NAME" != "frida-server" ] && [ ! -f "$MODDIR/$BIN_NAME" ]; then
    cp "$MODDIR/frida-server" "$MODDIR/$BIN_NAME" || exit 1
    chmod 755 "$MODDIR/$BIN_NAME"
  fi

  # avoid double-start (按配置的进程名查)
  pidof "$BIN_NAME" >/dev/null 2>&1 && exit 0

  chmod 755 "$MODDIR/frida-server"
  setsid "$MODDIR/$BIN_NAME" -l "127.0.0.1:$PORT" > /data/local/tmp/frida_patched.log 2>&1 < /dev/null &
) &
