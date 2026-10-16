# frida-persistent-module

[![Release](https://img.shields.io/github/v/release/hex91/frida-persistent-module?label=Release)](https://github.com/hex91/frida-persistent-module/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/hex91/frida-persistent-module/total?label=Downloads)](https://github.com/hex91/frida-persistent-module/releases)

KernelSU / Magisk / SukiSU 通用模块：开机自启 **sijan2 补丁版 frida-server 17.5.2-android16**，支持**自定义端口与进程名**（对抗初级 frida 检测）。

> 适用设备：Android 14 / 15 / 16（已实测 Pixel 6 + Android 15 + KernelSU）
>
> 背景：frida 官方 17.2~17.5.x 在 Android 14/15 上存在 ART 兼容 bug（注入即崩 / 拖垮 system_server），本模块内置 [sijan2/frida](https://github.com/sijan2/frida) v17.5.2-android16 补丁版（禁用 zygote/system_server 注入 + 修复 ART 偏移），详见 [兼容性排查报告](docs/frida兼容性问题排查报告_Pixel6_Android15.md)。

## 仓库内容

```
├── ksu_module/                  # 模块源文件（六件套）
│   ├── module.prop              # 模块信息
│   ├── service.sh               # 开机自启（读 config.sh → 改名副本 → 启动）
│   ├── config.sh                # 配置：端口 + 进程名
│   ├── set_config.sh            # 配置助手：一条命令修改并立即生效
│   ├── 说明.txt                 # 放在手机里的速查说明
│   └── frida-server             # server 母本（仅打进 zip，不入库，见下）
├── dist/
│   └── frida_patched_server-17.5.2-android16.zip   # 可直接安装的模块包
├── frida_scripts/               # PC 端注入脚本（配套 run_frida.py runner）
└── docs/                        # 使用文档 + 兼容性排查报告
```

> 说明：52MB 的 `frida-server` 裸二进制不直接入库（GitHub 对 >50MB 文件告警），已完整包含在 `dist/` 的模块 zip 中，安装/打包以 zip 为准。

## 安装

```bash
adb push dist/frida_patched_server-17.5.2-android16.zip /data/local/tmp/
adb shell su -c 'ksud module install /data/local/tmp/frida_patched_server-17.5.2-android16.zip'
# 或在 KernelSU / SukiSU 管理器 App 中选择 zip 安装；安装后重启一次生效
```

重启后 frida-server 自动就绪（监听 `127.0.0.1:27042`），PC 端：

```bash
adb forward tcp:27042 tcp:27042
python frida_scripts/run_frida.py <脚本.js> [时长秒] [端口]
```

## 修改端口 / 进程名（对抗检测）

一条命令，改完立即生效：

```bash
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh 39527 sysmon'
```

- 无参数运行 `set_config.sh` 可查看当前配置、运行中实例与用法
- 进程名规则：即磁盘文件名，≤15 字符（Linux comm 名上限），母本保留、副本开机自动生成
- 完整说明：[使用文档](docs/frida持久化模块使用文档.md)

## 检测对抗边界

| 检测手段 | 是否绕过 |
|---|---|
| `ps` / `pidof` / 扫进程名含 "frida" | ✅ |
| 探测 127.0.0.1:27042 默认端口 | ✅ |
| 扫 `/proc/self/maps` 含 frida-agent | ❌ |
| 线程名（gum-js-loop、pool-frida-*） | ❌ |
| D-Bus / portal 主动探测 | ❌ |

## 管理命令速查

```bash
# 禁用自启（重启即停）
adb shell su -c 'touch /data/adb/modules/frida_patched_server/disable'
# 手动按当前配置启动 / 重启
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh restart'
# 查看运行日志
adb shell su -c 'cat /data/local/tmp/frida_patched.log'
```

## 声明

本项目仅用于**个人设备上的安全研究与调试**（动态分析、协议验证、逆向学习）。请勿用于未授权访问他人设备或绕过他人系统的防护。使用本模块产生的一切后果由使用者自行承担。
