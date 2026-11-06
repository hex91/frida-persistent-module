# frida 持久化模块 —— 出厂默认配置（升级会覆盖，勿在此存个人配置）
# 个人配置写入同目录 config.sh（首次启动自动生成），升级不会丢失。
#
# PORT            : 监听端口（设备绑定 127.0.0.1:PORT；PC 端 adb forward tcp:PORT tcp:PORT）
# BIN_NAME        : 进程名 = 磁盘文件名，≤15 字符；改名可躲 ps / pidof / 27042 端口探测
# MOD_NAME        : 模块列表里显示的名字（伪装用，随便改）
# MOD_VERSION     : 模块列表里显示的版本号（随便写，与 frida 版本无关）
# MOD_VERSION_CODE: 版本代码，纯数字，管理器据此判断是否有更新
PORT=27042
BIN_NAME=frida-server
MOD_NAME="System Monitor"
MOD_VERSION="1.4.2"
MOD_VERSION_CODE=10402
