# Frida Hook 模板集（Java + Native）

一套可直接用的 Frida hook 模板，**按当前设备环境实测过**（Frida 17.5.2 / Android 15 / arm64）。
每个文件都能独立加载，勾一个开关就能跑，不用从零写样板代码。

配套的持久化 frida-server 模块见仓库根目录（`ksu_module/`），本目录只放**脚本模板与加载器**。

---

## 一、文件清单

| 文件 | 内容 | 需要 Java bridge |
|---|---|---|
| [`00_速查表.md`](00_速查表.md) | API 对照表、常用片段、命令、常见坑 | — |
| [`01_java_basic.js`](01_java_basic.js) | Java 基础：方法/构造/字段/重载/实例查找/调用栈/多 ClassLoader | 是 |
| [`02_java_advanced.js`](02_java_advanced.js) | Java 进阶：加密入口、SharedPreferences、OkHttp、SSL pinning、批量 hook、RPC | 是 |
| [`03_native_basic.js`](03_native_basic.js) | Native 基础：基址、导出查找、Interceptor、内存读写、NativeFunction、特征码 | 否 |
| [`04_native_advanced.js`](04_native_advanced.js) | Native 进阶：偏移 hook、指令 patch、dlopen 监控、JNI RegisterNatives、Stalker、CModule | 否 |
| [`05_common_targets.js`](05_common_targets.js) | 常见场景：pinning、root 检测、frida 检测、反调试、Log/Toast、剪贴板 | 部分 |
| [`06_rpc_cli.js`](06_rpc_cli.js) | RPC 导出模板 + CLI 命令速查 | 否 |
| [`run_template.py`](run_template.py) | 加载器：自动注入 bridge + 端口转发 + spawn/attach | — |

---

## 二、先搞懂一件事：Java bridge 在 Frida 17 里变了

从 Frida 17.0 起，`Java` 不再内置在 GumJS 运行时中。

| 加载方式 | `Java.use()` 能用吗 | 原因 |
|---|---|---|
| `frida` CLI | ✅ 可以 | frida-tools 14+ 把 bridge 打包进 REPL |
| Python `session.create_script()` | ❌ 报 `Java is not defined` | 运行时里没有 bridge |
| `run_template.py`（本目录） | ✅ 可以 | 加载前自动把 bridge 拼进去 |

所以：**纯 native 脚本随便怎么加载；Java 脚本要么用 CLI，要么用本目录的加载器。**

---

## 三、快速开始

### 3.1 准备

```bash
# PC 端客户端，版本要与设备上的 frida-server 一致
pip install frida==17.5.2
# 只为拿到它的 bridges/java.js（Java 脚本需要）
pip install "frida-tools==14.5.2"

# 端口转发（模块默认端口 39527）
adb forward tcp:39527 tcp:39527
```

### 3.2 确认识别到设备

```bash
python run_template.py --list
```

能看到进程列表就说明链路通了。

### 3.3 跑第一个 hook

```bash
# 附到已运行的应用，加载 Java 基础模板
python run_template.py --js 01_java_basic.js -n com.example.app

# 或启动新进程再注入（能抓到启动早期逻辑）
python run_template.py --js 01_java_basic.js -f com.example.app
```

此时只会打印：

```
[i] 已加载 01_java_basic.js，但未启用任何演示。
[i] 可用开关：hookMethod, changeReturn, ...
```

### 3.4 启用某个演示

打开 `01_java_basic.js`，改两处：

```javascript
const CONFIG = {
  className: 'com.example.app.LoginActivity',  // ← 你的目标类
  methodName: 'checkPassword',                  // ← 你的目标方法
  enable: {
    hookMethod: true,                           // ← 改成 true
  }
};
```

重新加载即可看到调用日志。

### 3.5 用 frida CLI（不想装 Python 依赖时）

```bash
frida -H 127.0.0.1:39527 -n com.example.app -l 01_java_basic.js
frida -H 127.0.0.1:39527 -f com.example.app -l 03_native_basic.js --no-pause
```

---

## 四、各文件怎么用

### 01_java_basic.js —— 先看这个

12 个开关，覆盖日常 90% 的 Java hook 需求：

```javascript
enable: {
  hookMethod: true,      // 打印入参 + 返回值（从这开始）
  changeReturn: false,   // 改返回值
  changeArgs: false,     // 改入参
  hookCtor: false,       // hook 构造方法 $init
  readWriteField: false, // 读写字段
  findInstances: false,  // Java.choose 找存活实例
  printStack: false,     // 打印调用栈（定位「谁调的」）
  hookAllOverloads: false,
  callOrigin: false,     // 耗时统计
  arrayAndCast: false,   // Java.array / Java.cast
  enumClasses: false,    // 按关键字搜类名（不知道类名时用）
  multiClassLoader: false // ClassNotFoundException 时用
}
```

**卡住了先开 `enumClasses`**：把 `keyword` 改成 `'login'` 之类的词，能列出所有相关类名。

### 02_java_advanced.js —— 抓数据

| 开关 | 用途 |
|---|---|
| `crypto` | 一把抓 MD5/SHA、AES、Base64 的输入输出 |
| `sharedPrefs` | 抓本地存储的 token、配置 |
| `network` | 打印 OkHttp / HttpURLConnection 的 URL 与 header |
| `batchHook` | 按正则批量 hook 一类方法（如 `*crypto*!/encrypt\|decrypt/`） |
| `bypassPinning` | SSL pinning 绕过（授权测试用） |
| `bypassDetect` | root / 调试检测返回值改写 |
| `rpc` | 导出 RPC 给 Python 调用 |

### 03_native_basic.js —— so 层入门

先开 `listModules`：

```javascript
enable: { listModules: true }
```

找到目标 so 名，填进 `CONFIG.targetModule`，再开其他开关。

常用顺序：`listModules` → `listExports` → `attachBasic` → `readArgs`。

### 04_native_advanced.js —— 硬骨头

- **无导出符号**：`hookByOffset`，偏移从 IDA/Ghidra 拿
- **App 动态注册 JNI**：`hookRegisterNatives`，能拿到 `name / signature / fnPtr` 三元组
- **so 启动后才加载**：`watchDlopen`，在 `onLeave` 里补挂 hook
- **改指令**：`patchByOffset` / `mprotectPatch`，注意 4 字节对齐

### 05_common_targets.js —— 对抗速查

按需逐项开。文件头部有使用边界说明，请只用于你有权限测试的应用。

### 06_rpc_cli.js —— 自动化

```python
import frida

dev = frida.get_device_manager().add_remote_device('127.0.0.1:39527')
sess = dev.attach('com.example.app')
script = sess.create_script(open('06_rpc_cli.js', encoding='utf-8').read())
script.load()

print(script.exports_sync.ping())
print(script.exports_sync.list_modules('libc')[:5])
print(script.exports_sync.find_classes('crypto')[:10])
```

> JS 里的 `listModules` 在 Python 侧是 `list_modules`（camelCase → snake_case）。

---

## 五、几条来自实战的经验

**1. 不要 hook 系统进程**

对着 `com.android.systemui` 做 Java hook 可能拖垮系统进程并牵连 zygote，表现为整机重启。
验证脚本请用普通 App（本项目的测试用的是 `com.android.settings`）。
我们踩过这个坑：设备连续重启了两次。

**2. 忘了 `return` 是最高频的翻车点**

```javascript
m.implementation = function () {
  console.log('called');
  // ← 忘了 return，调用链断掉，业务逻辑直接坏
};
```

**3. 改返回值类型必须匹配**

`boolean` 返 `true`、`int` 返 `1`、对象返合法实例。返 `null` 给非空返回值的方法通常引发 NPE。

**4. 首次 `Java.perform` 有初始化开销**

脚本加载后立刻 `detach` 会看到超时。给 2–4 秒缓冲，或用 `--seconds` 参数。

**5. 读指针前先判空**

```javascript
if (!args[1].isNull()) { args[1].readCString(); }
```

---

## 六、实测记录

| 项 | 结果 |
|---|---|
| 环境 | Pixel 6 / Android 15 / arm64 |
| frida-server | 17.5.2（sijanon 补丁版，伪装 `sysmon`，监听 39527） |
| PC 客户端 | frida-python 17.5.2 + frida-tools 14.5.2 |
| `Java.use('android.util.Log')` | ✅ 成功，`Java.androidVersion = 15` |
| `Java.enumerateLoadedClasses` | ✅ 24209 个类 |
| `Java.enumerateClassLoadersSync` | ✅ 3 个 loader |
| native API（scan/stalker/cmodule/replace） | ✅ 全部可用 |
| `Process.getModuleByName('libc.so')` | ✅ base 可读，1454 个导出 |

---

## 七、和模块的关系

本目录依赖仓库里的持久化模块提供 frida-server：

- 模块把 sijan2 补丁版 frida-server 开机自启，伪装成 `sysmon`，监听自定义端口
- 模块页 WebUI 可改端口与进程名
- 改完端口后，同步改 `run_template.py --host`（默认 `127.0.0.1:39527`）

安装与配置见：[frida持久化模块使用文档](../docs/frida持久化模块使用文档.md)
