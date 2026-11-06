# frida-persistent-module

[![Release](https://img.shields.io/github/v/release/hex91/frida-persistent-module?label=Release)](https://github.com/hex91/frida-persistent-module/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/hex91/frida-persistent-module/total?label=Downloads)](https://github.com/hex91/frida-persistent-module/releases)

KernelSU / Magisk / SukiSU 通用模块：开机自启 **sijan2 补丁版 frida-server 17.5.2-android16**，支持**自定义端口与进程名**（对抗初级 frida 检测）。

> 适用设备：Android 14 / 15 / 16（已实测 Pixel 6 + Android 15 + KernelSU）
>
> 背景：frida 官方 17.2~17.5.x 在 Android 14/15 上存在 ART 兼容 bug（注入即崩 / 拖垮 system_server），本模块内置 [sijan2/frida](https://github.com/sijan2/frida) v17.5.2-android16 补丁版（禁用 zygote/system_server 注入 + 修复 ART 偏移），详见 [兼容性排查报告](docs/frida兼容性问题排查报告_Pixel6_Android15.md)。

## frida 二进制来源与署名

本模块**不修改 frida 本体**，只做「开机持久化 + 进程名/端口伪装 + WebUI 配置」的封装。内置的 `frida-server` 是社区的 Android 15/16 兼容补丁版，出处如下，请一并尊重原作者：

| 项 | 内容 |
|---|---|
| 二进制 | `frida-server 17.5.2-android16`（arm64） |
| 打包 / 补丁作者 | **sijan2** |
| 补丁仓库 | https://github.com/sijan2/frida |
| 该构建发布页 | https://github.com/sijan2/frida/releases/tag/v17.5.2-android16 |
| 上游项目（原作者） | [frida/frida](https://github.com/frida/frida) — Ole André V. Ravnås（[@oleavr](https://github.com/oleavr)） |
| 许可 | wxWindows Library Licence（补丁部分版权归 sijan2） |

补丁解决的问题（引自上游 Release 说明）：

1. **Compat Spawn（frida-core）**：API 35+ 默认关闭 zygote / system_server 注入，改用 `am` / `monkey` 拉起目标 App，避免注入系统进程导致整机卡死或重启；要恢复旧行为可设 `FRIDA_ANDROID_ZYGOTE_INJECTION=1`。
2. **Java Bridge Fix（frida-tools）**：修正 API 36 的 ART 类 / 方法偏移，解决 `Java.perform()` 触发 `ToReflectedMethod` SIGSEGV。

### 校验你手上的二进制

```bash
# 上游 release 资产（.xz 压缩包）
sha256sum frida-server-17.5.2-android16-arm64.xz
# bb9d13c16132068cae58946dded615fb41132e82851041adcf6b9a439fe5c909

# 解压后的裸二进制（模块目录里的 frida-server）
sha256sum frida-server
# 4935431b8df061e43941f41913a60df009688ebdd59bd9defe29d7c5120ad4b8  (52,035,728 字节)
```

设备端直接读实际值（版本号是二进制自己 `--version` 报的，不是写死的）：

```bash
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh info'
# OK;fv=17.5.2;fb=android16;arch=arm64;flavor=sijan2 补丁版;author=sijan2;size=52035728;sha=4935431b8df061e4;repo=...;release=...;up=...;lic=...
```

WebUI 的「**关于 frida**」卡片显示同一份信息（版本 / 来源 / 上游 / 许可 / 二进制大小与 sha256 前 16 位），点仓库或发布页可直接跳系统浏览器。

> 版本与链接集中在 [`ksu_module/frida_info.sh`](ksu_module/frida_info.sh) 一个文件里。以后换 frida 版本，只改这里，模块说明、`action.sh`、WebUI 会同步跟着变，不会出现「页面写着旧版本」的情况。

## PC 端环境（版本必须对上）

设备端是 **frida-server 17.5.2**，PC 端 `frida` 版本必须与它**完全一致**；`frida-tools` 只是 CLI 外壳，但装新版会顺带把 `frida` 升上去，所以两个都要锁版本：

```bash
python -m pip install -r requirements.txt
# 等价于
python -m pip install frida==17.5.2 frida-tools==14.5.2
```

| 包 | 版本 | 说明 |
|---|---|---|
| `frida` | **17.5.2** | 与设备端 server 严格一致，不一致会报 `ServerNotRunningError` / 连上即断 |
| `frida-tools` | **14.5.2** | 最后一个只要求 `frida>=17.5.0` 的版本；14.11+ 会拉 `frida 17.26` 把环境搞坏 |

> 已验证组合：Python 3.11+ / `frida 17.5.2` / `frida-tools 14.5.2` / Pixel 6 + Android 15。
>
> 如果已经装过头了，回滚：
> ```bash
> python -m pip install --force-reinstall frida==17.5.2 frida-tools==14.5.2
> python -m pip list | grep frida   # 两行都应是上面的版本
> ```

## 仓库内容

```
├── requirements.txt             # ★ PC 端固定版本依赖（frida 17.5.2 + frida-tools 14.5.2）
├── ksu_module/                  # 模块源文件
│   ├── module.prop              # 模块信息（由 sync_prop.sh 按配置重写）
│   ├── frida_info.sh            # ★ frida 版本 / 来源 / 校验值（唯一事实来源，署名）
│   ├── service.sh               # 开机自启（播种 config.sh → 改名副本 → 启动）
│   ├── config.default.sh        # 出厂默认配置（升级会覆盖，勿存个人配置）
│   ├── config.sh                # 个人配置（不在 zip 内，升级不丢失；首次启动生成）
│   ├── set_config.sh            # 配置助手：改端口/进程名/显示名/版本/自启开关
│   ├── sync_prop.sh             # 把当前配置写回 module.prop（保留 SELinux 上下文）
│   ├── action.sh                # 管理器「执行/操作」按钮：显示当前状态
│   ├── webroot/index.html       # 模块页 WebUI：图形化改端口/进程名（无需命令）
│   ├── 说明.txt                 # 放在手机里的速查说明
│   └── frida-server             # server 母本（仅打进 zip，不入库，见下）
├── dist/
│   └── frida_patched_server-17.5.2-android16.zip   # 可直接安装的模块包
├── frida_scripts/               # PC 端注入脚本（配套 run_frida.py runner）
├── templates/                   # ★ Hook 模板集（Java + Native，适配 frida 17）
│   ├── 00_速查表.md             # API 对照、常用片段、命令、常见坑
│   ├── 01_java_basic.js         # Java 基础：方法/构造/字段/重载/调用栈/多 ClassLoader
│   ├── 02_java_advanced.js      # Java 进阶：加密入口/SP/OkHttp/pinning/批量 hook/RPC
│   ├── 03_native_basic.js       # Native 基础：基址/导出/Interceptor/内存/特征码
│   ├── 04_native_advanced.js    # Native 进阶：偏移 hook/指令 patch/RegisterNatives/Stalker
│   ├── 05_common_targets.js     # 常见场景：pinning/root 检测/反调试/Log/剪贴板
│   ├── 06_rpc_cli.js            # RPC 导出 + CLI 命令速查
│   └── run_template.py          # 加载器：自动注入 Java bridge + 端口转发
└── docs/                        # 使用文档 + 兼容性排查报告
```

> 说明：52MB 的 `frida-server` 裸二进制不直接入库（GitHub 对 >50MB 文件告警），已完整包含在 `dist/` 的模块 zip 中，安装/打包以 zip 为准。

## Hook 模板集（Java + Native）

`templates/` 是一套**开箱即用**的 hook 模板，每个文件独立可加载，改一个开关就生效，不用从零写样板代码。

```bash
cd templates

# 1) 看设备上有什么
python run_template.py --list

# 2) 加载 Java 基础模板（附到已运行应用）
python run_template.py --js 01_java_basic.js -n com.example.app

# 3) 或启动新进程注入（能抓启动早期逻辑）
python run_template.py --js 03_native_basic.js -f com.example.app
```

**为什么需要 `run_template.py`**：从 Frida 17.0 起 Java bridge 不再内置在 GumJS 中，用 Python `create_script()` 加载含 `Java.use` 的脚本会报 `Java is not defined`。加载器会在脚本前自动拼上 bridge，所以用 `frida-python` 也能跑 Java 模板。

| 想做的事 | 看哪个文件 |
|---|---|
| 查 API 怎么变、报错怎么修 | [`templates/00_速查表.md`](templates/00_速查表.md) |
| 第一次写 Java hook | [`templates/01_java_basic.js`](templates/01_java_basic.js) |
| 抓加密/参数/token | [`templates/02_java_advanced.js`](templates/02_java_advanced.js) |
| 分析 so、找函数地址 | [`templates/03_native_basic.js`](templates/03_native_basic.js) |
| 无符号函数、JNI 动态注册 | [`templates/04_native_advanced.js`](templates/04_native_advanced.js) |
| 绕 pinning / 检测 | [`templates/05_common_targets.js`](templates/05_common_targets.js) |
| 用 Python 自动化驱动 | [`templates/06_rpc_cli.js`](templates/06_rpc_cli.js) |

> ⚠️ 别对 `systemui` / `system_server` 做 Java hook：系统进程被 hook 后崩溃会牵连 zygote，表现为整机重启。验证脚本请用普通 App。

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

### 方式一：模块页 WebUI（图形化，无需命令）

装好后在 SukiSU / KernelSU 模块列表里，本模块卡片上会多一个「**打开**」按钮（WebUI），点进去可以：

- 看到当前**进程名 / 端口 / 运行状态（含已运行时长）/ 开机自启 / 模块版本 / frida 版本**
- 「**关于 frida**」卡片：版本、补丁作者仓库、构建发布页、上游项目、许可、二进制 sha256，可点击直接跳浏览器（尊重开源出处）
- 直接填**端口**和**进程名**，点「应用并重启」立即生效（后台执行 + 实时进度，**不会卡住界面**）
- 「**仅重启**」按当前配置重启，不改配置；「**查看日志**」直接看最后几行启动日志
- 一键「随机端口 / 随机进程名」，改完自动写回模块列表说明
- 开关**开机自启**（关闭后重启手机不自动运行，模块仍保留；开关状态会持久保存）
- 进程名和系统自带程序重名时会给出黄色提示（`ps` 里会出现两个同名进程，反而更显眼）
- 复制 PC 端 `adb forward` + `frida` 连接命令

> 关于「卡死 / 状态空白 / 点应用提示命令超时」：v1.6.0 已修复。原因是 SukiSU 的 WebUI 桥接
> `ksu.exec(cmd)` 是**同步返回 stdout 的最后一行**（第二个参数是 options，不是回调），
> 旧页面按「多行输出 + 回调」写，必然拿不到状态、回调不触发而 20 秒超时。
> 现在脚本改为**单行 `key=value` 协议**，耗时操作丢后台任务再轮询，详见下方「WebUI 实现说明」。

### 方式二：命令行

```bash
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh 39527 sysmon'
```

- 无参数运行 `set_config.sh` 可查看当前配置、运行中实例与用法
- 进程名规则：即磁盘文件名，≤15 字符（Linux comm 名上限），母本保留、副本自动生成
- 改名副本用**硬链接**生成：与母本共用同一份数据，不额外占 52MB，启动更快
- 换进程名会**自动删除旧副本**，不会越换越占空间
- 端口被占用会直接报错并显示占用者，不会盲改
- 完整说明：[使用文档](docs/frida持久化模块使用文档.md)

### 管理器里直接看当前配置（不用记）

安装后，SukiSU / KernelSU 模块卡片下方（`module.prop` 的 `description`）会自动显示：

```
frida 17.5.2-android16 (sijan2 补丁版) | 进程: sysmon | 端口: 127.0.0.1:39527 | PC: adb forward tcp:39527 tcp:39527 | 修改: WebUI
```

- 开头就是 **frida 版本 + 补丁来源**，一眼能对上「这台机器上跑的是哪个版本的 frida、谁打的补丁」
- 开机时 `service.sh`、每次改配置时 `set_config.sh` 都会调用 `sync_prop.sh` 自动刷新
- 改完重进模块页或下拉刷新即可看到最新值；管理器若缓存旧值，杀掉管理器重开
- 模块页的「执行 / 操作」按钮会弹出当前进程名、pid、端口与 PC 连接命令（`action.sh`）
- 个人配置 `config.sh` **不在 zip 内**（zip 只带 `config.default.sh`），升级模块不会覆盖，端口/进程名不会丢

### 伪装模块名 / 显示版本

模块列表里显示的名字和版本来自 `module.prop`，不要手改，用命令改 `config.sh` 后自动重写：

```bash
# 改显示名（示例：伪装成系统监控）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh name "System Monitor"'

# 改显示版本（第一个是版本字符串，第二个是纯数字 versionCode，可省略）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh version "1.6.0" 10600'
```

> `description` 里的端口/进程名会随配置自动同步；`id` 必须保持 `frida_patched_server` 不变，否则管理器会当成另一个模块。

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
# 关闭 / 开启开机自启（重启后不自动运行，模块仍启用）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh off'
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh on'
# 只看运行状态（key=value，适合脚本解析）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh status'
# 看内置 frida 的版本 / 来源 / 校验值（一行 key=value）
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh info'
# 手动按当前配置启动 / 重启
adb shell su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh restart'
# 查看运行日志
adb shell su -c 'cat /data/local/tmp/frida_patched.log'
```

> 关闭自启用的是模块目录下的 `noautostart` 文件；不要用 `disable`，那是管理器的「模块已禁用」标记，会让整个模块停用。

## WebUI 实现说明（维护者看）

### 1. `ksu.exec` 的真实契约

在 Pixel 6 + SukiSU 4.1.0 上实测（模块 WebUI 就是跑在这个桥接上）：

| 行为 | 实测结果 |
|---|---|
| 返回值 | **stdout 的最后一行**（`echo a; echo b` → 只拿到 `b`） |
| 第二参数 | 是 options，**不是回调**；传回调会返回 `undefined` 且永远不回调 |
| stderr / 退出码 | 拿不到（`echo err >&2; exit 3` → 返回 `out`） |
| 阻塞 | 同步执行，执行期间 WebView 主线程卡住（`sleep 3` = 卡 3 秒） |

推论：**WebUI 里执行的命令必须只输出一行，且必须很快**。所以脚本额外提供了机器接口：

```bash
set_config.sh status1            # OK;bin=sysmon;port=39527;pid=1234;listen=1;auto=1;coll=0;...;fv=17.5.2
set_config.sh info               # frida 版本/来源/校验：OK;fv=17.5.2;fb=android16;...;repo=...;release=...
set_config.sh apply <端口> <名字>  # 校验后立即返回 OK;rc=0，真正重启丢到后台
set_config.sh job                # 读后台任务进度：RUN;msg=... / DONE;rc=0;... / FAIL;...
```

页面拿 `status1` 的结果直接 `split(";")` 解析；`apply` 之后每 0.5s 轮询 `job`，把 `RUN;msg=` 显示成进度条文字，`DONE`/`FAIL` 收尾。整个过程单次命令耗时 50~200ms，界面不会卡。

### 2. 进程名可能和系统守护进程重名

伪装成 `netd` / `logd` 这类真实守护进程时，`pidof netd` 会先返回**系统那个**，于是 `service.sh` 误判「已在运行」直接退出，`frida-server` 永远起不来（状态显示「进程在但未监听」）。

现在所有判断都改成**按 `/proc/<pid>/exe` 指向的完整路径**确认是不是自己，`pidof` 只用来缩小候选范围。WebUI 的随机进程名也换成了 `sysmon` / `statd` / `netmon` 这类不会撞车的名字。

### 3. 不要遍历 `/proc/*/cmdline`

700+ 进程逐个 `cat` 要 **15 秒**（每个都是一次 fork+exec）。改成一条 `ls -l /proc/*/exe` 加 `awk` 过滤，约 100ms —— 这也是早期「点应用要等十几秒」的元凶之一。

## 声明

本项目仅用于**个人设备上的安全研究与调试**（动态分析、协议验证、逆向学习）。请勿用于未授权访问他人设备或绕过他人系统的防护。使用本模块产生的一切后果由使用者自行承担。
