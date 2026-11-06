#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
run_template.py —— Frida 模板通用加载器

解决一个 Frida 17 的具体问题：
    从 17.0 起，Java bridge 不再内置在 GumJS 里。
    用 frida CLI 加载脚本时它自带 bridge，但用 Python `create_script`
    加载含 `Java.use(...)` 的脚本会直接报 "Java is not defined"。

本工具在加载前把 frida-tools 里的 bridge 拼到脚本前面，
所以用 frida-python 也能跑 Java 模板，不需要 CLI、不需要 frida-compile。

依赖：
    pip install frida==<与设备 server 一致的版本>
    pip install frida-tools    # 只为拿它的 bridges/java.js

用法示例：
    # 列出设备上的进程
    python run_template.py --list

    # 附到已运行的应用，加载 Java 基础模板
    python run_template.py --js 01_java_basic.js -n com.example.app

    # 启动新进程并注入（能抓到启动早期逻辑）
    python run_template.py --js 03_native_basic.js -f com.example.app

    # 同时加载多个脚本
    python run_template.py --js 01_java_basic.js --js 05_common_targets.js -f com.example.app

    # 目标进程不含 Java（纯 native），跳过 bridge 拼接
    python run_template.py --js 03_native_basic.js -n com.example.app --no-java
"""

import argparse
import json
import os
import subprocess
import sys
import time

try:
    import frida
except ImportError:
    sys.exit("缺少依赖：pip install frida")


# ---------------------------------------------------------------------------
# 定位 Java bridge
# ---------------------------------------------------------------------------
def find_java_bridge():
    """
    在已安装的 frida-tools 里找 bridges/java.js。

    返回 (路径, 说明)。找不到时路径为 None。
    注意：bridge 的版本要与 frida-python / 设备端 server 大致同代，
          frida-tools 14.5.x 对应 frida 17.5.x。
    """
    try:
        import frida_tools
        base = os.path.dirname(os.path.abspath(frida_tools.__file__))
        p = os.path.join(base, "bridges", "java.js")
        if os.path.isfile(p):
            return p, ""
    except ImportError:
        return None, "未安装 frida-tools"

    # 兜底：按 site-packages 搜索
    try:
        import site
        for d in site.getsitepackages() + [site.getusersitepackages()]:
            p = os.path.join(d, "frida_tools", "bridges", "java.js")
            if os.path.isfile(p):
                return p, ""
    except Exception:
        pass

    return None, "找不到 frida_tools/bridges/java.js"


def build_script(js_files, need_java):
    """
    拼接最终脚本：bridge shim + 用户脚本。
    没有 bridge 时给出清晰提示，而不是让 Java 报 ReferenceError。
    """
    parts = []

    if need_java:
        bridge_path, why = find_java_bridge()
        if bridge_path is None:
            sys.exit(
                "找不到 Java bridge（%s）。\n"
                "  → 安装配套版本：pip install \"frida-tools==14.5.2\"\n"
                "    查询对应关系：https://pypi.org/project/frida-tools/#history\n"
                "  → 或者改用 frida CLI 加载（CLI 自带 bridge）" % why
            )
        with open(bridge_path, "r", encoding="utf-8") as f:
            bridge_src = f.read()
        # 与 frida-tools 自身的做法一致：把 bridge 挂到 globalThis.Java
        parts.append(
            "(function () {\n"
            + bridge_src
            + "\nObject.defineProperty(globalThis, 'Java', {"
              " value: bridge, enumerable: true, configurable: true });\n"
              "})();\n"
        )
        print("[i] 已注入 Java bridge: %s" % bridge_path)

    for path in js_files:
        if not os.path.isfile(path):
            sys.exit("脚本不存在: %s" % path)
        with open(path, "r", encoding="utf-8") as f:
            parts.append("\n// ==== %s ====\n" % os.path.basename(path))
            parts.append(f.read())

    return "".join(parts)


# ---------------------------------------------------------------------------
# 消息处理
# ---------------------------------------------------------------------------
def make_handler(log_file=None):
    def on_message(message, data):
        mtype = message.get("type")
        if mtype == "send":
            payload = message.get("payload")
            text = json.dumps(payload, ensure_ascii=False) if not isinstance(payload, str) else payload
            _emit("[send] %s" % text, log_file)
        elif mtype == "error":
            _emit("[error] %s" % message.get("description", ""), log_file)
            stack = message.get("stack") or ""
            if stack:
                _emit(stack, log_file)
        else:
            _emit("[%s] %s" % (mtype, json.dumps(message, ensure_ascii=False)), log_file)

        if data:
            _emit("[data] %d bytes: %s" % (len(data), data[:64].hex()), log_file)

    return on_message


def _emit(line, log_file):
    print(line, flush=True)
    if log_file:
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 设备与端口
# ---------------------------------------------------------------------------
def connect_device(host, do_forward):
    """连远程 frida-server；host 形如 127.0.0.1:39527"""
    if do_forward:
        port = host.split(":")[-1]
        try:
            subprocess.run(
                ["adb", "forward", "tcp:%s" % port, "tcp:%s" % port],
                check=False, capture_output=True, timeout=15
            )
            print("[i] 已执行 adb forward tcp:%s tcp:%s" % (port, port))
        except FileNotFoundError:
            print("[!] 未找到 adb，跳过端口转发（如需请手动执行）")
        except Exception as e:
            print("[!] adb forward 失败: %s" % e)

    try:
        return frida.get_device_manager().add_remote_device(host)
    except Exception as e:
        sys.exit("连接 %s 失败: %s\n  检查：frida-server 是否在跑、adb forward 是否已执行" % (host, e))


def list_targets(device):
    print("=== 进程 ===")
    procs = sorted(device.enumerate_processes(), key=lambda p: p.name)
    for p in procs:
        print("  %6d  %s" % (p.pid, p.name))
    print("\n=== 应用（有界面的）===")
    for a in sorted(device.enumerate_applications(), key=lambda x: x.identifier):
        mark = "*" if a.pid else " "
        print("  %s %6s  %s  %s" % (mark, a.pid or "-", a.identifier, a.name))


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="Frida 模板加载器（自动处理 Java bridge 与端口转发）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法示例：")[-1]
    )
    ap.add_argument("--js", action="append", default=[], help="要加载的 JS 文件，可重复")
    ap.add_argument("--host", default="127.0.0.1:39527", help="frida-server 地址，默认 127.0.0.1:39527")
    ap.add_argument("-n", "--name", help="附到已运行进程（进程名 / 应用标识符）")
    ap.add_argument("-f", "--file", help="spawn 启动进程并注入（包名 / Activity）")
    ap.add_argument("-p", "--pid", type=int, help="附到指定 pid")
    ap.add_argument("--no-java", action="store_true", help="不注入 Java bridge（纯 native 脚本）")
    ap.add_argument("--no-forward", action="store_true", help="不自动执行 adb forward")
    ap.add_argument("--list", action="store_true", help="列出设备进程/应用后退出")
    ap.add_argument("--seconds", type=float, default=0, help="运行指定秒数后自动退出（0=一直运行）")
    ap.add_argument("--log", help="同时把输出写入文件")
    args = ap.parse_args()

    device = connect_device(args.host, not args.no_forward)

    if args.list:
        list_targets(device)
        return

    if not args.js:
        sys.exit("至少指定一个 --js（或用 --list 看看设备上有哪些进程）")
    if not (args.name or args.file or args.pid):
        sys.exit("需要指定目标：-n 进程名 / -f 包名 / -p pid")

    # 决定是否拼 bridge：用户显式关掉，或脚本里根本没用到 Java
    need_java = not args.no_java
    if need_java:
        joined = "".join(open(f, "r", encoding="utf-8").read() for f in args.js if os.path.isfile(f))
        if "Java." not in joined and "importClass" not in joined:
            need_java = False
            print("[i] 脚本未使用 Java API，跳过 bridge 注入")

    source = build_script(args.js, need_java)

    # --- spawn 模式 ---
    spawned_pid = None
    if args.file:
        spawned_pid = device.spawn([args.file])
        print("[i] spawn %s → pid %d" % (args.file, spawned_pid))
        session = device.attach(spawned_pid)
    elif args.pid:
        session = device.attach(args.pid)
        print("[i] attach pid %d" % args.pid)
    else:
        session = device.attach(args.name)
        print("[i] attach %s" % args.name)

    script = session.create_script(source)
    script.on("message", make_handler(args.log))
    try:
        script.load()
        print("[i] 脚本已加载")
    except Exception as e:
        sys.exit("脚本加载失败: %s" % e)

    if spawned_pid is not None:
        device.resume(spawned_pid)
        print("[i] 进程已放行")

    print("[i] Ctrl+C 退出\n")

    try:
        if args.seconds > 0:
            time.sleep(args.seconds)
        else:
            while True:
                time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[i] 收到中断，正在分离")
    finally:
        try:
            session.detach()
        except Exception:
            pass


if __name__ == "__main__":
    main()
