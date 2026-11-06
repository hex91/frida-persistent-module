#!/system/bin/sh
# sync_prop.sh -- 把 config.sh 里的「进程名 / 端口 / 显示名 / 版本」同步进 module.prop
#
# 作用：SukiSU / KernelSU 模块列表里的「说明」是静态读取 module.prop 的，
#       本脚本按当前配置重新生成 module.prop，让列表里始终显示：
#         进程: sysmon | 端口: 127.0.0.1:39527 | PC: adb forward ...
#
# 调用时机：
#   1) set_config.sh 改完配置后自动调用
#   2) service.sh 开机时自动调用
#   3) 手动：su -c 'sh /data/adb/modules/frida_patched_server/sync_prop.sh'
#
# 注意：module.prop 的 id 必须保持不变，否则管理器会当成另一个模块。

MODDIR=${0%/*}
CONFIG="$MODDIR/config.sh"

# frida 版本 / 来源（唯一事实来源：frida_info.sh）
[ -f "$MODDIR/frida_info.sh" ] && . "$MODDIR/frida_info.sh"
[ -z "$FRIDA_VERSION" ]  && FRIDA_VERSION="17.5.2"
[ -z "$FRIDA_BUILD" ]    && FRIDA_BUILD="android16"
[ -z "$FRIDA_FLAVOR" ]   && FRIDA_FLAVOR="sijan2 补丁版"

[ -f "$CONFIG" ] && . "$CONFIG"

[ -z "$PORT" ]            && PORT=27042
[ -z "$BIN_NAME" ]        && BIN_NAME=frida-server
[ -z "$MOD_NAME" ]        && MOD_NAME="System Monitor"
[ -z "$MOD_VERSION" ]     && MOD_VERSION="1.7.0"
[ -z "$MOD_VERSION_CODE" ] && MOD_VERSION_CODE=10700

DESC="frida $FRIDA_VERSION-$FRIDA_BUILD ($FRIDA_FLAVOR) | 进程: $BIN_NAME | 端口: 127.0.0.1:$PORT | PC: adb forward tcp:$PORT tcp:$PORT | 修改: WebUI"

PROP="$MODDIR/module.prop"

# 用 cat > 覆盖（不要用 mv），这样能保留原文件的 SELinux 上下文
cat > "$PROP" <<EOF
id=frida_patched_server
name=$MOD_NAME
version=$MOD_VERSION
versionCode=$MOD_VERSION_CODE
author=hex91
description=$DESC
EOF

chmod 644 "$PROP"
chown root:root "$PROP" 2>/dev/null

echo "[OK] module.prop 已更新"
echo "     名称: $MOD_NAME"
echo "     版本: $MOD_VERSION ($MOD_VERSION_CODE)"
echo "     说明: $DESC"
