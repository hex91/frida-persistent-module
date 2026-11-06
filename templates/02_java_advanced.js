/*
 * ============================================================================
 *  02_java_advanced.js —— Frida Java 层 Hook 进阶模板（实战高频场景）
 * ============================================================================
 *
 *  适配版本：Frida 17.5.2 / Android 15 / arm64（实测通过）
 *  依赖    ：Java bridge（frida CLI 自带；Python 请用 run_template.py）
 *
 *  本文件覆盖：
 *     registerClass / 动态加载 dex / RPC 导出 / 批量 hook
 *     加密入口（MessageDigest、Cipher、Base64）/ SharedPreferences
 *     OkHttp 与 HttpURLConnection / SSL pinning 绕过
 *     Root 与反调试检测绕过 / Java native 方法 hook
 *
 *  ⚠️ 所有演示默认关闭。抓加密、绕 pinning 这类操作会改变目标行为，
 *     仅限你有权限测试的 App（自己的、或书面授权的）。
 *
 *  开关在文件末尾 CONFIG.enable，不再单独标「配置区」，因为本文件
 *  的类名多数写死在演示里（通用类，不需要改）。
 * ============================================================================
 */

'use strict';

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

function safeStr(v) {
  try {
    if (v === null || v === undefined) return String(v);
    if (v.$className !== undefined) return `<${v.$className}> ${v.toString()}`;
    return String(v);
  } catch (e) { return `<unprintable: ${e}>`; }
}

function bytesToHex(javaBytes) {
  try {
    const arr = Java.array('byte', javaBytes);
    let s = '';
    for (let i = 0; i < arr.length; i++) s += ('0' + (arr[i] & 0xff).toString(16)).slice(-2);
    return s;
  } catch (e) { return `<byte[] err: ${e}>`; }
}

function bytesToUtf8(javaBytes) {
  try {
    const S = Java.use('java.lang.String');
    return S.$new(Java.array('byte', javaBytes)).toString();
  } catch (e) { return `<decode err: ${e}>`; }
}

function hexDump(s, max) {
  return s.length > max ? s.slice(0, max) + `...(${s.length} bytes 共)` : s;
}

// ============================================================================
// 1. Java.registerClass：用 JS 造一个 Java 类
//    用途：实现接口当回调（Runnable / Comparator / OkHttp Interceptor）
// ============================================================================
function demoRegisterClass() {
  Java.perform(function () {
    const Runnable = Java.use('java.lang.Runnable');
    const MyRunnable = Java.registerClass({
      name: 'com.frida.MyRunnable',
      implements: [Runnable],
      methods: {
        run: function () { log('runnable', 'run() 被调用，来自 JS 实现'); }
      }
    });

    const obj = MyRunnable.$new();
    obj.run();               // 直接调
    Java.use('android.os.Handler').$new().post(obj); // 交给 Android 调度
    log('ok', 'registerClass 演示完成');
  });
}

// ============================================================================
// 2. 动态加载外部 dex（把工具类塞进目标进程用）
//    把 dex 推到 /data/local/tmp/ 再改路径
// ============================================================================
function demoLoadDex() {
  Java.perform(function () {
    const DexClassLoader = Java.use('dalvik.system.DexClassLoader');
    const File = Java.use('java.io.File');
    const paths = [
      '/data/local/tmp/frida_tools.dex',
      '/data/local/tmp/tools.dex'
    ];
    let loader = null;
    for (let i = 0; i < paths.length; i++) {
      if (File.$new(paths[i]).exists()) {
        loader = DexClassLoader.$new(
          paths[i], null, null,
          Java.use('java.lang.ClassLoader').getSystemClassLoader()
        );
        log('dex', `已从 ${paths[i]} 创建 DexClassLoader`);
        break;
      }
    }
    if (!loader) { log('warn', '没找到 dex 文件，跳过'); return; }
    Java.classFactory.loader = loader;
    log('ok', '后续 Java.use 会从该 dex 找类');
  });
}

// ============================================================================
// 3. RPC 导出：让 Python 主动调用 JS 函数（比 console.log 更适合自动化）
//    调用：script.exports_sync.<name>(...)
//    ⚠️ 名字会被下划线化：getInfo → get_info
// ============================================================================
function demoRpc() {
  rpc.exports = {
    /** Python 侧：script.exports_sync.ping() */
    ping: function () {
      return { ok: true, android: Java.androidVersion, ts: Date.now() };
    },

    /** 主动调用目标方法（示例：读一个静态字段） */
    readStatic: function (className, fieldName) {
      let out = null;
      Java.perform(function () {
        try { out = safeStr(Java.use(className)[fieldName].value); }
        catch (e) { out = 'ERR ' + e; }
      });
      return out;
    },

    /** 通知 JS 侧执行一次动作，再由 JS 侧 send 结果回来 */
    trigger: function (methodName) {
      Java.perform(function () {
        try {
          const m = Java.use('com.example.app.TargetClass')[methodName];
          m.call(Java.use('com.example.app.TargetClass').$new());
          send({ type: 'trigger-done', methodName: methodName });
        } catch (e) {
          send({ type: 'trigger-error', err: String(e) });
        }
      });
      return true;
    }
  };
  log('ok', 'RPC 已导出：ping / readStatic / trigger');
}

// ============================================================================
// 4. 批量 hook：Java.enumerateMethods（frida 17 可用）
//    语法：'类名通配!方法名通配'  例：'*crypto*!/encrypt|decrypt/'
//    比自己写循环找类快得多
// ============================================================================
function demoBatchHook() {
  const pattern = '*crypto*!/encrypt|decrypt|digest/'; // ← 按需改
  Java.perform(function () {
    let n = 0;
    const groups = Java.enumerateMethods(pattern);
    groups.forEach(function (g) {
      g.classes.forEach(function (cls) {
        try {
          const Cls = Java.use(cls.name);
          g.methods.forEach(function (m) {
            Cls[m].overloads.forEach(function (ov) {
              ov.implementation = function () {
                const args = Array.prototype.slice.call(arguments).map(function (a) {
                  try {
                    if (a && a.$className === '[B') return 'bytes:' + hexDump(bytesToHex(a), 64);
                  } catch (e) {}
                  return safeStr(a);
                });
                log('hook', `${cls.name}.${m}(${args.join(', ')})`);
                const ret = ov.call(this, ...arguments);
                try {
                  if (ret && ret.$className === '[B') log('ret', 'bytes:' + hexDump(bytesToHex(ret), 64));
                } catch (e) {}
                return ret;
              };
              n++;
            });
          });
        } catch (e) { /* 某些类 hook 失败不影响其他 */ }
      });
    });
    log('ok', `批量 hook 完成，共 ${n} 个方法（匹配 ${pattern}）`);
  });
}

// ============================================================================
// 5. 加密入口：MessageDigest / Cipher / Base64
//    这三处能覆盖绝大多数「明文 → 密文」的抓取需求
// ============================================================================
function demoCrypto() {
  Java.perform(function () {
    // ---- 5.1 摘要：MD5 / SHA1 / SHA256 ----
    try {
      const MD = Java.use('java.security.MessageDigest');
      // 无参 digest()：输入已通过 update() 缓存，这里只能拿到结果
      MD.digest.overload().implementation = function () {
        const ret = this.digest();
        log('digest', `${this.getAlgorithm()} 输出=${hexDump(bytesToHex(ret), 64)}`);
        return ret;
      };
      MD.digest.overload('[B').implementation = function (buf) {
        log('digest', `${this.getAlgorithm()} 输入=${hexDump(bytesToHex(buf), 64)}`);
        const ret = this.digest(buf);
        log('digest', `输出=${hexDump(bytesToHex(ret), 64)}`);
        return ret;
      };
      MD.update.overload('[B').implementation = function (buf) {
        log('digest', `update 输入=${hexDump(bytesToHex(buf), 64)}`);
        return this.update(buf);
      };
    } catch (e) { log('warn', 'MessageDigest hook 失败: ' + e); }

    // ---- 5.2 对称加解密：Cipher.doFinal ----
    try {
      const Cipher = Java.use('javax.crypto.Cipher');
      Cipher.doFinal.overload('[B').implementation = function (buf) {
        const mode = this.getOpmode ? this.getOpmode() : -1; // 1=ENCRYPT 2=DECRYPT
        log('cipher', `${this.getAlgorithm()} mode=${mode} in=${hexDump(bytesToHex(buf), 64)}`);
        const ret = this.doFinal(buf);
        log('cipher', `out=${hexDump(bytesToHex(ret), 64)} utf8=${bytesToUtf8(ret)}`);
        return ret;
      };
    } catch (e) { log('warn', 'Cipher hook 失败: ' + e); }

    // ---- 5.3 Base64 ----
    try {
      const B64 = Java.use('android.util.Base64');
      B64.encodeToString.overload('[B', 'int').implementation = function (buf, flags) {
        const ret = this.encodeToString(buf, flags);
        log('base64', `in=${hexDump(bytesToHex(buf), 48)} → out=${ret}`);
        return ret;
      };
      B64.decode.overload('java.lang.String', 'int').implementation = function (s, flags) {
        const ret = this.decode(s, flags);
        log('base64', `decode ${s} → ${hexDump(bytesToHex(ret), 48)} utf8=${bytesToUtf8(ret)}`);
        return ret;
      };
    } catch (e) { log('warn', 'Base64 hook 失败: ' + e); }

    log('ok', '加密入口已挂（digest/cipher/base64）');
  });
}

// ============================================================================
// 6. SharedPreferences：抓本地存储的 token / 配置
// ============================================================================
function demoSharedPrefs() {
  Java.perform(function () {
    try {
      const Impl = Java.use('android.app.SharedPreferencesImpl');
      // 读：getString/getInt/getBoolean/getAll
      ['getString', 'getInt', 'getBoolean', 'getLong'].forEach(function (fn) {
        try {
          Impl[fn].overloads.forEach(function (ov) {
            ov.implementation = function () {
              const ret = ov.call(this, ...arguments);
              log('sp', `${fn}(${arguments[0]}) = ${safeStr(ret)}`);
              return ret;
            };
          });
        } catch (e) {}
      });
      // 写：EditorImpl.putXxx
      const Editor = Java.use('android.app.SharedPreferencesImpl$EditorImpl');
      ['putString', 'putInt', 'putBoolean'].forEach(function (fn) {
        try {
          Editor[fn].overloads.forEach(function (ov) {
            ov.implementation = function () {
              log('sp-write', `${fn}(${arguments[0]}, ${safeStr(arguments[1])})`);
              return ov.call(this, ...arguments);
            };
          });
        } catch (e) {}
      });
      log('ok', 'SharedPreferences 读写已挂');
    } catch (e) { log('warn', 'SharedPreferences hook 失败: ' + e); }
  });
}

// ============================================================================
// 7. 网络请求：OkHttp 与 HttpURLConnection
// ============================================================================
function demoNetwork() {
  Java.perform(function () {
    // ---- OkHttp3 ----
    try {
      const Builder = Java.use('okhttp3.Request$Builder');
      Builder.build.implementation = function () {
        const req = this.build();
        log('okhttp', `${req.method()} ${req.url()}`);
        return req;
      };
      const RespBuilder = Java.use('okhttp3.Response$Builder');
      RespBuilder.build.implementation = function () {
        const r = this.build();
        log('okhttp', `← ${r.code()} ${r.message()}`);
        return r;
      };
      log('ok', 'OkHttp 已挂');
    } catch (e) { log('warn', 'OkHttp 不可用（App 未用或版本差异）'); }

    // ---- HttpURLConnection：抓 header 与 URL ----
    try {
      const Conn = Java.use('java.net.HttpURLConnection');
      Conn.setRequestProperty.implementation = function (k, v) {
        log('http', `${k}: ${v}`);
        return this.setRequestProperty(k, v);
      };
    } catch (e) {}
  });
}

// ============================================================================
// 8. SSL Pinning 绕过（三种常见实现）
//    ⚠️ 仅限授权测试。绕过后 App 的网络流量可被代理查看。
// ============================================================================
function demoBypassPinning() {
  Java.perform(function () {
    // ---- 8.1 自定义 X509TrustManager 的 checkServerTrusted ----
    try {
      const TM = Java.use('javax.net.ssl.X509TrustManager');
      const TrustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
      TrustManagerImpl.checkTrustedRecursive.implementation = function () {
        log('pinning', 'checkTrustedRecursive 已放行');
        return Java.use('java.util.ArrayList').$new();
      };
    } catch (e) { log('warn', 'TrustManagerImpl 不可用: ' + e); }

    // ---- 8.2 OkHttp CertificatePinner ----
    try {
      const Pinner = Java.use('okhttp3.CertificatePinner');
      Pinner.check.overload('java.lang.String', 'java.util.List').implementation = function () {
        log('pinning', 'OkHttp CertificatePinner 已放行');
        return;
      };
      if (Pinner.check.overloads.length > 0) {
        Pinner.check.overloads.forEach(function (ov) {
          try { ov.implementation = function () { log('pinning', 'CertificatePinner.check 已放行'); }; } catch (e) {}
        });
      }
    } catch (e) { log('warn', 'OkHttp CertificatePinner 不可用'); }

    // ---- 8.3 HostnameVerifier ----
    try {
      const Hv = Java.use('javax.net.ssl.HostnameVerifier');
      // 用 proxy 替换所有实现代价高，通常改 OkHttpClient 的 hostnameVerifier 即可
    } catch (e) {}

    log('ok', 'pinning 绕过脚本已挂载（按需注释掉不用的分支）');
  });
}

// ============================================================================
// 9. Root / 反调试检测绕过（把检测函数的返回值改掉）
//    思路：先枚举可疑方法名，再统一返回「干净」的值
// ============================================================================
function demoBypassDetect() {
  Java.perform(function () {
    const suspicious = ['isRooted', 'checkRoot', 'isRoot', 'detectRoot',
                        'isDebuggerConnected', 'isDebuggable', 'isEmulator'];
    let n = 0;
    try {
      const groups = Java.enumerateMethods('*!/' + suspicious.join('|') + '/i');
      groups.forEach(function (g) {
        g.classes.forEach(function (cls) {
          const Cls = Java.use(cls.name);
          g.methods.forEach(function (m) {
            Cls[m].overloads.forEach(function (ov) {
              if (ov.returnType.className === 'boolean') {
                ov.implementation = function () {
                  log('bypass', `${cls.name}.${m}() → false`);
                  return false;
                };
                n++;
              }
            });
          });
        });
      });
    } catch (e) { log('warn', 'enumerateMethods 失败: ' + e); }
    log('ok', `已改写 ${n} 个检测方法的返回值`);
  });
}

// ============================================================================
// 10. hook Java native 方法
//    声明是 Java 的，实现在 so 里。在 Java 层 hook 一样有效（走 JNI 调用）
// ============================================================================
function demoHookJavaNative() {
  Java.perform(function () {
    const Cls = Java.use('com.example.app.NativeLib'); // ← 改类名
    const m = Cls.nativeMethod;                        // ← 改方法名
    m.implementation = function () {
      log('jni', `nativeMethod 入参=${Array.prototype.slice.call(arguments).map(safeStr).join(', ')}`);
      const ret = m.call(this, ...arguments);
      log('jni', `返回值=${safeStr(ret)}`);
      return ret;
    };
    log('ok', 'Java 层 native 方法已 hook');
  });
}

// ============================================================================
// 入口
// ============================================================================
const CONFIG = {
  enable: {
    registerClass: false,
    loadDex: false,
    rpc: false,
    batchHook: false,
    crypto: false,
    sharedPrefs: false,
    network: false,
    bypassPinning: false,
    bypassDetect: false,
    hookJavaNative: false
  }
};

function main() {
  if (typeof Java === 'undefined') {
    console.log('[!] 没有 Java bridge → 用 frida CLI 或 run_template.py 加载');
    return;
  }
  if (!Java.available) {
    console.log('[!] 非 Java 进程，本文件不适用');
    return;
  }

  const map = {
    registerClass: demoRegisterClass,
    loadDex: demoLoadDex,
    rpc: demoRpc,
    batchHook: demoBatchHook,
    crypto: demoCrypto,
    sharedPrefs: demoSharedPrefs,
    network: demoNetwork,
    bypassPinning: demoBypassPinning,
    bypassDetect: demoBypassDetect,
    hookJavaNative: demoHookJavaNative
  };

  Java.perform(function () {
    let started = 0;
    Object.keys(map).forEach(function (k) {
      if (CONFIG.enable[k]) { try { map[k](); started++; } catch (e) { log('err', k + ': ' + e); } }
    });
    if (started === 0) {
      console.log('[i] 已加载 02_java_advanced.js，未启用任何演示。');
      console.log('[i] 可用开关：' + Object.keys(map).join(', '));
    }
  });
}

main();
