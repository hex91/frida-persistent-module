# frida 持久化模块使用文档（可配置端口/进程名版）

> 设备：Pixel 6 / Android 15 / KernelSU
> server：sijan2 补丁版 frida 17.5.2-android16（Android 14/15/16 兼容）
> 模块 ID：`frida_patched_server`，安装位置 `/data/adb/modules/frida_patched_server/`

---

## 一、模块构成

| 文件 | 作用 |
|---|---|
| `module.prop` | 模块信息 |
| `service.sh` | 开机自启脚本（读 config.sh → 复制改名副本 → 启动 server） |
| `config.sh` | **配置文件：端口 + 进程名**（本版新增） |
| `frida-server` | server 母本二进制（保留原名，作为改名副本的来源） |

工作流程：开机 → 等 boot_completed → 检查 `disable` 开关 → 若配置了 `BIN_NAME` 且改名副本不存在则从母本复制 → 按配置的进程名防重复启动 → 以 `-l 127.0.0.1:PORT` 启动。

---

## 二、日常使用（默认配置）

默认 `PORT=27042`、`BIN_NAME=frida-server`，开机后什么都不用做：

```bash
# PC 端三步
adb forward tcp:27042 tcp:27042
python run_frida.py vip_observe.js 45          # 观察脚本
python run_frida.py vip_bypass.js 60           # bypass 脚本
```

runner（`run_frida.py`）已支持第三个参数指定端口，且**自动建转发**：

```
python run_frida.py <脚本.js> [时长秒] [端口]
python run_frida.py vip_bypass.js 60 39527     # 用自定义端口
```

---

## 三、修改端口和进程名（对抗 frida 检测）

### 3.1 三种修改方式（忘了就翻模块目录里的 `说明.txt`）

**方式一：配置助手（推荐，手机上直接敲，改完立即生效）**

```bash
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh'
# 无参数运行 = 显示当前配置、运行中实例、用法

adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh 39527 sysmon'
# 一条命令: 写配置 → 杀旧实例 → 复制改名副本 → 启动 → 轮询验证
```

助手会做参数校验（端口 1024-65535、进程名 ≤15 字符且限安全字符），杀旧实例采用「SIGTERM → 3 秒不退 SIGKILL 兜底」，启动后轮询最长 15 秒再报告结果（改名副本 52MB 复制需数秒，避免误报）。

**方式二：手机 root 文件管理器**（MT管理器等）直接编辑模块目录下的 `config.sh`，改完重启手机或执行 `set_config.sh restart`。

**方式三：PC adb 直接改 config.sh**（见 3.2）。

### 3.2 配置格式（config.sh）

编辑设备上 `/data/adb/modules/frida_patched_server/config.sh`：

```sh
PORT=39527          # 监听端口（只绑 127.0.0.1，外部扫不到）
BIN_NAME=sysmon     # 进程名 = 磁盘文件名，≤15 字符
```

- **改进程名的原理**：Linux 进程的 comm 名取自二进制文件名，`ps -A`/`pidof frida-server`/`grep frida` 这类检测直接失效。母本 `frida-server` 文件保留在模块目录里，开机自动复制出改名副本。
- **改端口的原理**：大量检测逻辑写死探测 `127.0.0.1:27042`（frida 默认端口），换端口即失效。

### 3.3 生效方式

**方式 A：重启手机**（开机自动按新配置启动）。

**方式 B：免重启**：直接用 `set_config.sh <端口> <进程名>`（自动重启生效），或 `set_config.sh restart` 按当前配置重启。

### 3.4 验证检测是否被绕过

```bash
# 这些都应该查不到 frida 痕迹：
adb shell "ps -A | grep -i frida"        # 应无输出
adb shell "pidof frida-server"           # 应无输出
adb shell "netstat -tln | grep 27042"    # 应无输出
```

---

## 四、实测案例（2026-10-15，本机已验证）

**场景**：某 App 检测 `frida-server` 进程名和 27042 默认端口。

**操作**：

```bash
# 1. 写入伪装配置
adb shell su -c 'printf "PORT=39527\nBIN_NAME=sysmon\n" > /data/adb/modules/frida_patched_server/config.sh'

# 2. 重启 server（免重启方式）
adb shell su -c 'kill $(pidof frida-server)'
adb shell su -c 'sh /data/adb/modules/frida_patched_server/service.sh'

# 3. 验证
adb shell su -c 'pidof frida-server'   # → 无输出（旧名已死）
adb shell su -c 'pidof sysmon'         # → 13477（新名在跑）
adb shell su -c 'netstat -tln | grep 39527'  # → LISTEN
```

**结果**：PC 端用 `python run_frida.py vip_observe.js 25 39527` 成功连接、attach 目标 App、三个 hook 全部挂载、isVip 观测数据正常（w0=0x80b1=false）。注入链路在伪装配置下完全等效。

**当前设备状态**：已配置为 `sysmon:39527`。改回默认只需把 config.sh 写回 `PORT=27042` + `BIN_NAME=frida-server` 并重启 server。

---

## 五、检测对抗的边界（重要）

改名 + 换端口解决的是**初级检测**：

| 检测手段 | 是否被本方案绕过 |
|---|---|
| `ps`/`/proc` 扫进程名含 "frida" | ✅ |
| 探测 127.0.0.1:27042 默认端口 | ✅ |
| `pidof frida-server` | ✅ |
| 扫 `/proc/self/maps` 内存映射含 "frida-agent" | ❌（注入后 target 进程内存里有 frida 痕迹） |
| 检测线程名（`gum-js-loop`、`pool-frida-*`） | ❌ |
| D-Bus/portal 主动探测 frida 协议 | ❌ |

遇到强检测 App 时，本模块仍可用（server 能起、能 attach），但注入后可能被 App 自检发现——那时需要进一步手段（hook 掉检测函数本身，或改用更深的隐身方案），属于另一层对抗。

---

## 六、管理命令速查

```bash
# 禁用自启（不改文件，重启即停）
adb shell su -c 'touch /data/adb/modules/frida_patched_server/disable'
# 恢复自启
adb shell su -c 'rm /data/adb/modules/frida_patched_server/disable'

# 手动启动（不重启，立即按 config.sh 拉起）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/service.sh'

# 手动停止
adb shell su -c 'kill $(pidof sysmon)'    # 按当前进程名

# 查看当前配置
adb shell su -c 'cat /data/adb/modules/frida_patched_server/config.sh'

# 查看运行日志
adb shell su -c 'cat /data/local/tmp/frida_patched.log'

# 彻底卸载：KernelSU 管理器 App 里移除模块，或
adb shell su -c 'ksud module uninstall frida_patched_server'
```

## 七、重装 / 分发

模块 zip：`Desktop\apk_analysis\frida\frida_patched_server-17.5.2-android16.zip`（v2，含 config.sh）。

- PC 安装：`adb push <zip> /data/local/tmp/ && adb shell su -c 'ksud module install /data/local/tmp/<zip名>'`
- 或 KernelSU 管理器 App 直接选 zip 安装
- 安装后**需重启一次**落位并触发首次自启
