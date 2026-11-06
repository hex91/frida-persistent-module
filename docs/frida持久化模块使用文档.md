# frida 持久化模块使用文档（可配置端口/进程名版）

> 设备：Pixel 6 / Android 15 / KernelSU
> server：sijan2 补丁版 frida 17.5.2-android16（Android 14/15/16 兼容）
> 模块 ID：`frida_patched_server`，安装位置 `/data/adb/modules/frida_patched_server/`

---

## 一、模块构成

| 文件 | 作用 |
|---|---|
| `module.prop` | 模块信息（由 `sync_prop.sh` 按配置重写，含显示名/版本/说明） |
| `service.sh` | 开机自启脚本（播种 config.sh → 复制改名副本 → 启动 server） |
| `config.default.sh` | 出厂默认配置（升级会覆盖，勿存个人配置） |
| `config.sh` | **个人配置：端口 / 进程名 / 显示名 / 显示版本**（不在 zip 内，升级不丢失；首次启动自动生成） |
| `set_config.sh` | 配置助手（改端口/进程名/显示名/版本并立即生效） |
| `sync_prop.sh` | 把当前配置写回 `module.prop`（保留 SELinux 上下文） |
| `action.sh` | 管理器「执行/操作」按钮脚本（显示当前状态） |
| `webroot/index.html` | 模块页 WebUI：图形化改端口/进程名、自启开关（v1.5 新增） |
| `frida-server` | server 母本二进制（保留原名，作为改名副本的来源） |

工作流程：开机 → 等 boot_completed → 检查 `noautostart` 开关 → 若配置了 `BIN_NAME` 且改名副本不可用则用硬链接生成 → 按配置的进程名防重复启动 → 以 `-l 127.0.0.1:PORT` 启动。

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

### 3.1 四种修改方式（忘了就翻模块目录里的 `说明.txt`）

**方式一：模块页 WebUI（图形化，v1.5 新增，推荐）**

管理器模块列表 → 本模块卡片 → 「打开」。页面里直接填端口、进程名，点「应用并重启」即可；还带随机端口/随机进程名、开机自启开关、PC 连接命令一键复制。

**方式二：配置助手（命令行，改完立即生效）**

```bash
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh'
# 无参数运行 = 显示当前配置、运行中实例、用法

adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh 39527 sysmon'
# 一条命令: 写配置 → 杀旧实例 → 建改名副本 → 启动 → 轮询验证
```

助手会做参数校验（端口 1024-65535、进程名 ≤15 字符且限安全字符），杀旧实例采用「SIGTERM → 3 秒不退 SIGKILL 兜底」，启动后轮询最长 15 秒再报告结果。改名副本改为**硬链接**生成，秒级完成、不额外占空间。

**方式三：手机 root 文件管理器**（MT管理器等）直接编辑模块目录下的 `config.sh`，改完重启手机或执行 `set_config.sh restart`。

**方式四：PC adb 直接改 config.sh**（见 3.2）。

### 3.2 配置格式（config.sh）

编辑设备上 `/data/adb/modules/frida_patched_server/config.sh`：

```sh
PORT=39527          # 监听端口（只绑 127.0.0.1，外部扫不到）
BIN_NAME=sysmon     # 进程名 = 磁盘文件名，≤15 字符
```

- **改进程名的原理**：Linux 进程的 comm 名取自二进制文件名，`ps -A`/`pidof frida-server`/`grep frida` 这类检测直接失效。母本 `frida-server` 文件保留在模块目录里，改名副本用**硬链接**生成（同一份数据，不额外占 52MB，启动也是秒级）。
- **换名会自动清理旧副本**：`set_config.sh` 切换进程名成功后删除上一份改名副本，避免每换一次就多占 52MB。
- **改端口的原理**：大量检测逻辑写死探测 `127.0.0.1:27042`（frida 默认端口），换端口即失效。
- **端口冲突保护**：新端口已被别的进程占用时直接报错并打印占用者，不会盲改后连不上。

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

### 3.5 在管理器里直接看到当前配置（不用记）

SukiSU / KernelSU 模块卡片下方（`module.prop` 的 `description`）会显示：

```
进程: sysmon | 端口: 127.0.0.1:39527 | PC: adb forward tcp:39527 tcp:39527 | 修改: 打开本模块 WebUI
```

- 开机时 `service.sh`、每次改配置时 `set_config.sh` 都会调用 `sync_prop.sh` 自动刷新
- 手动改过 `config.sh` 后，执行 `sync_prop.sh` 即可刷新提示（不必重启 server）
- 管理器若缓存旧值：退出重进模块页 / 下拉刷新 / 杀掉管理器重开
- 模块页「执行 / 操作」按钮（`action.sh`）会弹出进程名、pid、已运行时长、端口监听状态、自启状态与最近日志

### 3.6 伪装模块名 / 显示版本

模块列表里的名字、版本、说明都来自 `module.prop`。不要手改，用命令改 `config.sh` 后由 `sync_prop.sh` 重写：

```bash
# 改显示名（可含空格，用引号）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh name "System Monitor"'

# 改显示版本（第一参数是版本字符串，第二参数是纯数字 versionCode，可省略）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh version "1.6.0" 10600'
```

> `description` 里的端口/进程名随配置自动同步；`id` 必须保持 `frida_patched_server`，否则管理器会当成另一个模块。

### 3.7 开机自启开关（v1.5 新增）

```bash
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh off'   # 关
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh on'    # 开
```

- `off` 只是在模块目录创建 `noautostart` 文件：重启后不自动启动，**模块本身仍是启用状态**
- 不要用 `disable` 文件——那是管理器的「模块已禁用」标记，会让整个模块停用
- WebUI 里也有对应开关，改完立即写入

> 升级提示：`config.sh` 不在模块 zip 内（zip 只有 `config.default.sh`），升级模块不会覆盖你的端口/进程名。

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
# 关闭 / 开启开机自启（重启即停，模块仍启用）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh off'
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh on'

# 看运行状态（key=value，脚本可解析）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh status'

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

模块 zip：仓库 `dist/frida_patched_server-17.5.2-android16.zip`（v1.5，含 WebUI，不含个人 `config.sh`）。

- PC 安装：`adb push <zip> /data/local/tmp/ && adb shell su -c 'ksud module install /data/local/tmp/<zip名>'`
- 或 KernelSU 管理器 App 直接选 zip 安装
- 安装后**需重启一次**落位并触发首次自启
- 升级不会覆盖 `config.sh`（端口/进程名保留）；若模块目录被管理器清空，`service.sh` 会从 `config.default.sh` 播种
