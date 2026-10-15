# frida 在 Pixel 6 / Android 15 上的兼容性问题排查报告

- **设备**：Pixel 6（oriole），Android 15（SDK 35），KernelSU root（zgisksu + zygisk_lsposed 模块环境）
- **结论先行**：手机本身没有任何问题。全部故障源于 **frida 17.x 官方版本对 Android 14/15 ART 的兼容性缺陷**，最终用 **sijan2 补丁版 frida-server 17.5.2-android16** 根治。

---

## 一、故障时间线

### 阶段 1：frida 17.4.0 —— 注入目标进程即崩

- **形态**：zygiskFrida 模块（v1.9.0，内含 17.4.0）与独立 frida-server 17.4.0 两条注入路径，attach 目标 App 均立即崩溃；**attach SystemUI 却正常**。
- **报错**：`Unable to find copied methods in java/lang/Thread`
- **定位价值**：SystemUI 能被注入而目标 App 崩溃，排除 App 反调试/防护问题，把问题收敛到「frida 版本 vs 新 Android ART」。

### 阶段 2：frida 17.1.5 —— "假死机"（软重启）

- **形态**：换上 17.1.5（官方宣称恢复 Android 14/15 兼容的修复版）后，手机端运行 server 本身不崩；**一旦有客户端连接**（`frida-ps`、runner 的 `enumerate_processes`、spawn 等），手机屏幕立刻出现 Google logo + 加载进度条，表现为"重启"，但 `adb shell` 仍可正常进入。
- **三个异常全部复现**：
  1. `spawn()` → 超时（`waiting for signal from process PID xxxx`）
  2. `enumerate_processes()` → 注入 helper 崩溃
  3. 客户端连接 → system_server 死亡 → 软重启

### 阶段 3：sijan2/frida v17.5.2-android16 —— 根治

- attach 即成功、hook 全部生效、无任何崩溃；后续所有动态验证（isVip bypass、URL 探测）均在此版本上完成。

---

## 二、根因分析

### 2.1 为什么 17.4.0（及 17.2~17.5.x）不兼容

frida 在给 **Android 16（API 36）** 添加支持时改动了 ART 内部结构的偏移处理，**顺带破坏了 Android 14/15（API 34/35）的兼容性**——17.2 到 17.5.2 官方版全部中招。具体表现为 agent 注入进程、初始化 Java 桥时，对 ART `java/lang/Thread` 的 copied methods 定位失败而崩溃。

关键细节：**即使脚本只做 native hook（我们 hook 的是 libapp.so 偏移，完全不用 Java 桥），frida agent 注入时也会强制初始化 Java 桥**——所以"脚本没用 Java"并不能幸免。

### 2.2 为什么 17.1.5 也不行

17.1.5 是官方"恢复 Android 14/15 兼容"的修复版，但修复**不完整**：Java 桥偏移问题在本机（Pixel 6 / Android 15）仍存在，且暴露出更危险的行为——

**软重启的完整机制链**：

```
客户端连接 frida-server
  → frida helper 需要枚举进程/处理 spawn
  → 向 system_server 注入 helper 代码
  → 17.1.5 的 ART 偏移错误 → helper 在 system_server 内崩溃
  → system_server（AMS/WMS 等所有系统服务载体）死亡
  → Zygote 重新拉起整个 framework
  → 屏幕出现 Google logo + 进度条（= 运行时重启）
```

**为什么"重启"了 adb shell 还能用**：这不是内核重启。`adbd` 由 init 直接拉起，与 system_server 平级、互不依赖。system_server 死亡只重启 framework 层，内核、init、adbd、已建立的 adb 连接全部存活——所以 shell 能进、设备不掉线。这是 **runtime restart（软重启）**，与断电重启（adb 必断连）是两回事。

**排查要点**：`cat /proc/uptime` 可以区分两者——软重启内核 uptime 连续，真重启 uptime 归零。（本次排查中两者都出现过：软重启由 frida 引起，真重启是用户手动重启设备清 zygisk 注入。）

### 2.3 最终解法：sijan2/frida v17.5.2-android16

第三方补丁版（基于官方 17.5.2 源码打补丁构建），两个补丁正中要害：

| 补丁 | 内容 | 治好的症状 |
|---|---|---|
| **Compat Spawn**（frida-core） | API 35+ 上**默认禁用 zygote/system_server 注入**，改用 `am`/`monkey` 启动 App | 软重启/变砖/ActivityManager 挂起——helper 根本不再进 system_server |
| **Java Bridge Fix** | 修复 API 35/36 的 ART 类/方法偏移（`ToReflectedMethod` SIGSEGV） | `Java.perform()` 崩溃、注入即崩 |

可用环境变量 `FRIDA_ANDROID_ZYGOTE_INJECTION=1` 强制恢复旧注入行为（本场景不需要）。

---

## 三、最终可用配置（存档）

```
设备端：/data/local/tmp/frida-server-17.5.2-android16
        启动: su -c 'setsid /data/local/tmp/frida-server-17.5.2-android16 \
              >/data/local/tmp/frida1752.log 2>&1 </dev/null &'
下载:   https://github.com/sijan2/frida/releases/download/v17.5.2-android16/...
        （GitHub 直连 502 时用 https://gh-proxy.com/<github url> 镜像）
        sha256: bb9d13c16132068cae58946dded615fb41132e82851041adcf6b9a439fe5c909（.xz）

PC 端： frida==17.5.2（Python 核心，venv 隔离安装）
        runner: run_frida.py（am 启动 + attach + 日志采集）
转发:   adb forward tcp:27042 tcp:27042
```

**版本纪律**：客户端核心与设备端 server 必须同版本（17.1.5 客户端 + 17.5.2 server 也同样要保持对等）。

**脚本 API 迁移注意**（frida 17 破坏性变更）：
- `Module.getBaseAddress()` / `Module.findBaseAddress()` 已移除 → 用 `Process.findModuleByName("libapp.so").base`
- `NativePointer` 无 `.toNumber()` → 用 `parseInt(ptr.and(0xffffffff).toString(), 16)`
- spawn 在新 Android 上不可靠 → 统一用「am 启动 + attach 已运行进程」模式

---

## 四、经验总结

1. **Symptom ≠ 病因**：App 一注入就崩，第一反应是 App 有防护；但 SystemUI 能注入立刻排除防护——版本兼容问题要靠"对照实验"收敛。
2. **软重启 ≠ 重启**：Google logo + 进度条 + adb 存活 = system_server 崩溃（框架重启）；看到这个组合先想"谁动了 system_server"。
3. **官方版本号 ≠ 修复保证**：17.1.5 官方宣称修了 14/15 但实际没修全；社区补丁版（sijan2）明确列出补丁内容和适用 API 级别，反而更可信——选型时看 changelog 细节而非版本号大小。
4. **环境三件套留档**：server 版本、启动命令、sha256——下次换机/换版本能直接比对。
5. **zygiskFrida 模块的局限**：模块内置 frida 版本不受控（v1.9.0 捆绑 17.4.0），自管 server 才能自主选版本。删模块改用基础 frida 的思路是对的，但**必须同时换掉设备端 server 版本**，否则换汤不换药。
