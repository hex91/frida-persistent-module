#!/system/bin/sh
# frida-server (sijan2 patched 17.5.2-android16) autostart — v3 可配置端口/进程名/模块显示
# runs as root in late_start service context (KernelSU / SukiSU / Magisk)
MODDIR=${0%/*}

# 默认值（可被 config.sh 覆盖）
PORT=27042
BIN_NAME=frida-server
MOD_NAME="System Monitor"
MOD_VERSION="1.4.2"
MOD_VERSION_CODE=10402

# 用户配置不随模块升级丢失：config.sh 不在 zip 内，缺失时从 config.default.sh 播种
if [ ! -f "$MODDIR/config.sh" ] && [ -f "$MODDIR/config.default.sh" ]; then
  cp "$MODDIR/config.default.sh" "$MODDIR/config.sh" 2>/dev/null
  chmod 600 "$MODDIR/config.sh" 2>/dev/null
fi
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"

# 开机先把当前进程名/端口写进 module.prop，模块列表里直接可见
[ -x "$MODDIR/sync_prop.sh" ] && sh "$MODDIR/sync_prop.sh" >/dev/null 2>&1

(
  # wait for boot complete
  until [ "$(getprop sys.boot_completed)" = "1" ]; do
    sleep 5
  done
  sleep 10

  # kill switch: touch "disable" in module dir to prevent autostart
  [ -f "$MODDIR/disable" ] && exit 0

  # 进程名伪装: 进程 comm 名 = 二进制文件名（≤15 字符）
  # 若配置了 BIN_NAME 且改名副本不存在，从母本 frida-server 复制一份
  if [ "$BIN_NAME" != "frida-server" ] && [ ! -f "$MODDIR/$BIN_NAME" ]; then
    cp "$MODDIR/frida-server" "$MODDIR/$BIN_NAME" || exit 1
    chmod 755 "$MODDIR/$BIN_NAME"
  fi

  # avoid double-start（按配置的进程名查）
  pidof "$BIN_NAME" >/dev/null 2>&1 && exit 0

  chmod 755 "$MODDIR/frida-server"
  setsid "$MODDIR/$BIN_NAME" -l "127.0.0.1:$PORT" > /data/local/tmp/frida_patched.log 2>&1 < /dev/null &
) &
