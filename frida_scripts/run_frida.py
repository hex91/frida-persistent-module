#!/usr/bin/env python3
# 黄果短剧 1.0.8 — Frida 注入 runner（配 17.1.5 设备端 server + TCP 转发）
# 用法:
#   python run_frida.py <脚本.js> [时长秒] [端口]
# 例如:
#   python run_frida.py vip_observe.js 45          # 默认端口 27042
#   python run_frida.py vip_bypass.js 45 39527     # 自定义端口(配合模块 config.sh)
#
# 前置:
#   设备端已运行: /data/local/tmp/frida-server-17.1.5-android-arm64
#   PC 已: adb forward tcp:27042 tcp:27042
import frida, sys, time, subprocess

PKG = "dark.rrJCm.PeeDN"
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 27042
HOST = "127.0.0.1:%d" % PORT
ADB = r"E:/repo/android/Sdk/platform-tools/adb"

JS = sys.argv[1] if len(sys.argv) > 1 else "vip_observe.js"
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 45

with open(JS, "r", encoding="utf-8") as f:
    js = f.read()

def on_message(message, data):
    t = message.get("type")
    if t == "send":
        print("[APP]", message.get("payload"))
    elif t == "log":
        print("[LOG]", message.get("payload"))
    elif t == "error":
        print("[ERR]", message.get("stack") or message.get("description"))
    else:
        print("[MSG]", message)

# 确保干净启动，便于抓到 fromMap 初次调用
try:
    subprocess.run([ADB, "shell", "am", "force-stop", PKG],
                   capture_output=True, timeout=15)
    time.sleep(1)
except Exception as e:
    print("[*] force-stop note:", e)

# 端口转发（自定义端口时与设备端 config.sh 保持一致）
subprocess.run([ADB, "forward", "tcp:%d" % PORT, "tcp:%d" % PORT],
               capture_output=True, timeout=15)

print("[*] connecting to", HOST)
device = frida.get_device_manager().add_remote_device(HOST)
print("[*] device:", device.name, "|", device.id)

# Android 15 上 frida spawn(zygote 注入) 不稳定；改为 am/monkey 启动 + attach 已运行进程
def launch_and_find_pid():
    try:
        subprocess.run([ADB, "shell", "am", "force-stop", PKG],
                       capture_output=True, timeout=15)
        time.sleep(1)
        subprocess.run([ADB, "shell", "monkey", "-p", PKG, "-c",
                        "android.intent.category.LAUNCHER", "1"],
                       capture_output=True, timeout=15)
    except Exception as e:
        print("[*] launch note:", e)
    for _ in range(25):
        try:
            out = subprocess.run([ADB, "shell", "pidof", PKG],
                                 capture_output=True, timeout=15).stdout.decode().strip()
            if out:
                return int(out.split()[0])
        except Exception:
            pass
        time.sleep(1)
    return None

pid = launch_and_find_pid()
if pid is None:
    raise SystemExit("未能启动/找到 app 进程，请手动打开 App 后重试")
print("[*] attaching to pid", pid)

session = device.attach(pid)
script = session.create_script(js)
script.on("message", on_message)
script.load()
print("[*] 脚本已加载，运行", DURATION, "秒（期间可在 App 内刷新/触发 /mine/info）")

try:
    time.sleep(DURATION)
except KeyboardInterrupt:
    pass
print("[*] 结束，detach")
try:
    session.detach()
except Exception:
    pass
