#!/system/bin/sh
# frida_info.sh —— 内置 frida-server 二进制的「版本 + 来源」信息（唯一事实来源）
#
# 升级二进制时只改这个文件，其它脚本（set_config.sh / sync_prop.sh / action.sh）
# 和 WebUI「关于」卡片都从这里取，不用各处找。
#
# 署名与出处：
#   frida 上游项目：https://github.com/frida/frida  （作者 Ole André V. Ravnås / @oleavr）
#   本模块内置的补丁版：sijan2/frida  v17.5.2-android16
#     https://github.com/sijan2/frida
#     https://github.com/sijan2/frida/releases/tag/v17.5.2-android16
#
# 该补丁版在上游 17.5.2 基础上加了两个 Android 15/16（API 35/36）兼容修复：
#   1. Compat Spawn（frida-core）
#      API 35+ 默认关闭 zygote/system_server 注入，改用 am/monkey 拉起目标 App，
#      避免注入系统进程导致整机卡死 / 重启。可用 FRIDA_ANDROID_ZYGOTE_INJECTION=1 恢复旧行为。
#   2. Java Bridge Fix（frida-tools）
#      修正 API 36 的 ART 类/方法偏移，解决 Java.perform() 触发 ToReflectedMethod SIGSEGV。
#
# 许可：frida 主体为 wxWindows Library Licence（LGPL 风格的宽松条款，允许再分发）；
#       补丁部分版权归 sijan2，见其仓库。本仓库只做「持久化模块 + 伪装 + WebUI」封装，
#       不修改 frida 本体源码。
#
# 校验（可自行核对下载物）：
#   官方 release 资产 frida-server-17.5.2-android16-arm64.xz
#     sha256 = bb9d13c16132068cae58946dded615fb41132e82851041adcf6b9a439fe5c909
#   解压后的裸二进制（本模块内 frida-server）
#     sha256 = 4935431b8df061e43941f41913a60df009688ebdd59bd9defe29d7c5120ad4b8
#     size   = 52035728 字节
#   设备上可用 `sh set_config.sh info` 或 WebUI「关于」卡片直接看到实际值。

FRIDA_VERSION="17.5.2"
FRIDA_BUILD="android16"
FRIDA_ARCH="arm64"
FRIDA_FLAVOR="sijan2 补丁版"
FRIDA_AUTHOR="sijan2"
FRIDA_LICENSE="wxWindows Library Licence"
FRIDA_REPO="https://github.com/sijan2/frida"
FRIDA_RELEASE="https://github.com/sijan2/frida/releases/tag/v17.5.2-android16"
FRIDA_UPSTREAM="https://github.com/frida/frida"
FRIDA_XZ_SHA256="bb9d13c16132068cae58946dded615fb41132e82851041adcf6b9a439fe5c909"
FRIDA_BIN_SIZE="52035728"
FRIDA_BIN_SHA256="4935431b8df061e43941f41913a60df009688ebdd59bd9defe29d7c5120ad4b8"
