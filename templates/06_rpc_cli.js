/*
 * ============================================================================
 *  06_rpc_cli.js —— RPC 导出 + 命令行/自动化调用速查
 * ============================================================================
 *
 *  适配版本：Frida 17.5.2 / Android 15（实测通过）
 *
 *  为什么需要 RPC：
 *      hook 只能「观察」，RPC 能让你**主动驱动**目标进程：
 *      Python 里调一个函数，就能让 App 执行某个方法、读某个字段、导出内存。
 *
 *  三种用法：
 *     A) Python 脚本（推荐做自动化）
 *          import frida
 *          dev = frida.get_device_manager().add_remote_device('127.0.0.1:39527')
 *          sess = dev.attach('com.example.app')
 *          script = sess.create_script(open('06_rpc_cli.js').read())
 *          script.on('message', lambda m, d: print(m))
 *          script.load()
 *          print(script.exports_sync.ping())
 *          # 注意：JS 里的 camelCase 会变成 Python 的 snake_case
 *          #       getInfo → get_info
 *
 *     B) frida CLI 交互
 *          frida -H 127.0.0.1:39527 -n com.example.app -l 06_rpc_cli.js
 *          然后在 REPL 里： rpc.exports.ping()
 *
 *     C) 配合 run_template.py（本项目自带，自动注入 Java bridge）
 *          python run_template.py --js 06_rpc_cli.js -n com.example.app
 *
 *  ⚠️ 本脚本会立即导出 RPC（不需要开关），但不会主动改变目标行为。
 * ============================================================================
 */

'use strict';

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

// ============================================================================
// 1. 基础通信：send / recv
//    send 是单向上报（JS → Python），recv 是等待 Python 回话
// ============================================================================
function demoSendRecv() {
  // 普通上报
  send({ type: 'hello', ts: Date.now() });

  // 带二进制数据：第二个参数是 ArrayBuffer
  const buf = Memory.alloc(8);
  buf.writeByteArray([0x01, 0x02, 0x03, 0x04]);
  send({ type: 'binary' }, buf.readByteArray(4));

  // 等待 Python 侧 script.post({type: 'cmd'}) 回话
  // recv('cmd', function (msg) {
  //   log('recv', '收到指令: ' + JSON.stringify(msg));
  // });
}

// ============================================================================
// 2. RPC 导出：核心能力都在这里
//    命名注意：Python 侧访问时 camelCase → snake_case
// ============================================================================
rpc.exports = {

  /** 健康检查：确认脚本活着、Java 是否可用 */
  ping: function () {
    return {
      ok: true,
      frida: Frida.version,
      arch: Process.arch,
      pid: Process.id,
      hasJava: (typeof Java !== 'undefined') && Java.available,
      android: (typeof Java !== 'undefined' && Java.available) ? Java.androidVersion : null
    };
  },

  /** 枚举模块，返回名字+基址（Python 里做过滤很方便） */
  listModules: function (keyword) {
    const mods = Process.enumerateModules();
    const kw = (keyword || '').toLowerCase();
    const out = [];
    for (let i = 0; i < mods.length; i++) {
      if (!kw || mods[i].name.toLowerCase().indexOf(kw) !== -1) {
        out.push({ name: mods[i].name, base: mods[i].base.toString(), size: mods[i].size });
      }
    }
    return out;
  },

  /** 查一个导出函数的绝对地址 */
  resolveExport: function (moduleName, symbol) {
    try {
      if (moduleName) {
        return Process.getModuleByName(moduleName).getExportByName(symbol).toString();
      }
      const p = Module.findGlobalExportByName(symbol);
      return p ? p.toString() : null;
    } catch (e) {
      return { error: String(e) };
    }
  },

  /** 内存读取：返回 hex 字符串，避免二进制跨语言传输麻烦 */
  readMemory: function (address, length) {
    try {
      const data = ptr(address).readByteArray(length);
      if (!data) return null;
      const arr = new Uint8Array(data);
      let s = '';
      for (let i = 0; i < arr.length; i++) s += ('0' + arr[i].toString(16)).slice(-2);
      return s;
    } catch (e) {
      return { error: String(e) };
    }
  },

  /** 内存写入：hex 字符串 → 字节 */
  writeMemory: function (address, hex) {
    try {
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
      ptr(address).writeByteArray(bytes);
      return true;
    } catch (e) {
      return { error: String(e) };
    }
  },

  /** Java：读静态字段 */
  readStaticField: function (className, fieldName) {
    if (typeof Java === 'undefined' || !Java.available) return { error: 'Java bridge 不可用' };
    let out = null;
    Java.perform(function () {
      try {
        const v = Java.use(className)[fieldName].value;
        out = (v === null || v === undefined) ? String(v) : String(v);
      } catch (e) {
        out = { error: String(e) };
      }
    });
    return out;
  },

  /** Java：写静态字段（类型必须匹配，写错会抛异常） */
  writeStaticField: function (className, fieldName, value) {
    if (typeof Java === 'undefined' || !Java.available) return { error: 'Java bridge 不可用' };
    let out = false;
    Java.perform(function () {
      try {
        Java.use(className)[fieldName].value = value;
        out = true;
      } catch (e) {
        out = { error: String(e) };
      }
    });
    return out;
  },

  /** Java：调用无参静态方法并返回字符串结果 */
  callStatic: function (className, methodName) {
    if (typeof Java === 'undefined' || !Java.available) return { error: 'Java bridge 不可用' };
    let out = null;
    Java.perform(function () {
      try {
        const Cls = Java.use(className);
        out = String(Cls[methodName]());
      } catch (e) {
        out = { error: String(e) };
      }
    });
    return out;
  },

  /** Java：枚举已加载类，按关键字过滤 */
  findClasses: function (keyword) {
    if (typeof Java === 'undefined' || !Java.available) return { error: 'Java bridge 不可用' };
    const hits = [];
    const kw = (keyword || '').toLowerCase();
    Java.perform(function () {
      Java.enumerateLoadedClasses({
        onMatch: function (name) {
          if (!kw || name.toLowerCase().indexOf(kw) !== -1) hits.push(name);
        },
        onComplete: function () {}
      });
    });
    return hits.slice(0, 500); // 防止返回过大
  },

  /** 执行一段 JS（调试用：Python 里可以随时试代码，不用重载脚本） */
  evalJs: function (code) {
    try {
      // 注意：eval 在脚本作用域内执行，能拿到全局变量但不一定能改局部闭包
      return String(eval(code));
    } catch (e) {
      return { error: String(e) };
    }
  }
};

log('ok', 'RPC 已导出：' + Object.keys(rpc.exports).join(', '));
log('info', 'Python 侧用 script.exports_sync.<snake_case> 调用，例如 ping() / list_modules("libc")');

// ============================================================================
// 附：frida CLI 常用命令速查（复制即用）
// ============================================================================
// ---------------------------------------------------------------------------
// 附：frida CLI 常用命令速查（复制即用）
// ---------------------------------------------------------------------------
//  ── 连接 ──────────────────────────────────────────────────────────
//  frida-ps -H 127.0.0.1:39527                列出进程
//  frida-ps -H 127.0.0.1:39527 -a             列出已安装应用
//  frida-ps -H 127.0.0.1:39527 -U             等价 -H，走 USB 设备
//
//  ── 注入 ──────────────────────────────────────────────────────────
//  frida -H 127.0.0.1:39527 -n com.example.app -l script.js
//  frida -H 127.0.0.1:39527 -f com.example.app -l script.js --no-pause
//      -n 附到已在运行的进程（按名字）
//      -f 启动新进程并注入（spawn，能抓到启动早期逻辑）
//      --no-pause 注入后立即放行（不加会停在断点处，需在 REPL 里敲 %resume）
//
//  ── 追踪（不写脚本也能用）────────────────────────────────────────
//  frida-trace -H 127.0.0.1:39527 -n com.example.app -j "*!*/isRoot/"
//  frida-trace -H 127.0.0.1:39527 -n com.example.app -i "open*"
//      -j  按 Java 方法名通配追踪（格式：类通配!方法正则）
//      -i  按 native 导出函数名追踪
//
//  ── REPL 内常用 ──────────────────────────────────────────────────
//  %resume                     放行被暂停的进程
//  %reload                     重新加载脚本
//  Java.available              检查 Java bridge
//  Process.enumerateModules()  看模块
//  rpc.exports.ping()          调本脚本导出的 RPC
//
//  ── 端口转发（PC 侧，连之前必须先执行）──────────────────────────
//  adb forward tcp:39527 tcp:39527
//  adb forward --list          查看已有转发
//  adb forward --remove-all    清理
