# frida 持久化模块配置 — 修改后重启生效（或用文档里的"免重启应用"命令）
# 监听端口: 设备上绑定 127.0.0.1:PORT; PC 端需 adb forward tcp:PORT tcp:PORT
# 进程名:   即磁盘文件名, ≤15 字符; 改名可躲 ps/pidof/27042 探测类检测;
#           母本 frida-server 保留, 开机自动复制出改名副本
PORT=27042
BIN_NAME=frida-server
