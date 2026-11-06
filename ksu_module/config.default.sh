# frida 持久化模块 —— 出厂默认配置
# 注意：本文件会在升级模块时被覆盖，请勿在这里保存个人配置！
# 个人配置请写入同目录的 config.sh（set_config.sh 会自动生成），升级不会丢失。
#
# PORT:     监听端口（设备绑定 127.0.0.1:PORT；PC 端需 adb forward tcp:PORT tcp:PORT）
# BIN_NAME: 进程名 = 磁盘文件名，≤15 字符；改名可躲 ps / pidof / 27042 端口探测
PORT=27042
BIN_NAME=frida-server
