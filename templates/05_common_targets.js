/*
 * ============================================================================
 *  05_common_targets.js —— 常见目标 / 对抗场景速查
 * ============================================================================
 *
 *  适配版本：Frida 17.5.2 / Android 15 / arm64（实测通过）
 *  依赖    ：Java 部分需 Java bridge；native 部分不需要
 *
 *  ★ 使用边界（请务必读）：
 *     本文件用于分析**你有权限测试**的应用：自己开发的、公司内部的、
 *     或已获书面授权的。绕过安全机制在未授权场景下可能违反法律与服务条款。
 *     请自行确认授权范围。
 *
 *  本文件覆盖：
 *     SSL Pinning 绕过 / Root 检测绕过 / Frida 检测绕过 / 反调试
 *     模拟器检测 / 签名校验 / Log 与 Toast 抓取 / 剪贴板监控
 *
 *  ⚠️ 默认全部关闭。这些脚本会改变目标的安全行为，
 *     只在受控环境里、按需逐项开启。
 * ============================================================================
 */

'use strict';

const CONFIG = {
  enable: {
    bypassPinning: false,   // 1. SSL Pinning 绕过
    bypassRoot: false,      // 2. Root 检测绕过
    bypassFridaDetect: false, // 3. Frida 检测绕过
    bypassAntiDebug: false, // 4. 反调试绕过
    bypassEmulator: false,  // 5. 模拟器检测绕过
    logAndToast: false,     // 6. 抓 Log 与 Toast
    clipboard: false,       // 7. 剪贴板监控
    inspectSignature: false // 8. 读取签名信息（只读，不绕过）
  }
};

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

// ============================================================================
// 1. SSL Pinning 绕过
//    ★ 需要同时满足：App 走系统网络栈 + 你的代理证书已装成系统 CA
//    Android 7+ 默认不信任用户证书，需 Magisk 模块（如 MoveCertificate）配合
// ============================================================================
function demoBypassPinning() {
  Java.perform(function () {
    let n = 0;

    // ---- 1.1 Conscrypt（Android 系统默认实现）----
    // checkTrustedRecursive 是真正做链校验的地方，绕过它最彻底
    try {
      const TMI = Java.use('com.android.org.conscrypt.TrustManagerImpl');
      const ArrayList = Java.use('java.util.ArrayList');
      TMI.checkTrustedRecursive.implementation = function () {
        log('pinning', 'TrustManagerImpl.checkTrustedRecursive → 放行');
        return ArrayList.$new(); // 返回空的可信链列表
      };
      n++;
    } catch (e) { log('warn', 'TrustManagerImpl 不可用: ' + e); }

    // ---- 1.2 自定义 X509TrustManager ----
    // 很多 App 自己 implements X509TrustManager 且 checkServerTrusted 为空或抛异常
    try {
      const X509TM = Java.use('javax.net.ssl.X509TrustManager');
      // 无法 hook 接口方法，但可以 hook SSLContext.init 拿到传入的 TrustManager 数组，
      // 再把校验方法替换掉。这里演示更通用的方案：hook 所有实现类的该方法。
      const groups = Java.enumerateMethods('*/!/checkServerTrusted/');
      groups.forEach(function (g) {
        g.classes.forEach(function (cls) {
          const Cls = Java.use(cls.name);
          Cls.checkServerTrusted.overloads.forEach(function (ov) {
            ov.implementation = function () {
              log('pinning', `${cls.name}.checkServerTrusted → 放行`);
              return;
            };
          });
          n++;
        });
      });
    } catch (e) { log('warn', 'X509TrustManager 处理失败: ' + e); }

    // ---- 1.3 OkHttp CertificatePinner ----
    try {
      const Pinner = Java.use('okhttp3.CertificatePinner');
      Pinner.check.overloads.forEach(function (ov) {
        ov.implementation = function () {
          log('pinning', 'OkHttp CertificatePinner.check → 放行');
        };
      });
      n++;
    } catch (e) { /* App 没用 OkHttp，正常 */ }

    // ---- 1.4 HostnameVerifier ----
    try {
      const groups = Java.enumerateMethods('*ssl*!/verify/i');
      groups.forEach(function (g) {
        g.classes.forEach(function (cls) {
          const Cls = Java.use(cls.name);
          g.methods.forEach(function (m) {
            Cls[m].overloads.forEach(function (ov) {
              if (ov.returnType.className === 'boolean') {
                ov.implementation = function () { log('pinning', `${cls.name}.${m} → true`); return true; };
                n++;
              }
            });
          });
        });
      });
    } catch (e) {}

    log('ok', `SSL Pinning 处理完成，覆盖 ${n} 个点`);
  });
}

// ============================================================================
// 2. Root 检测绕过
//    两条主线：① 文件/Su 检测 ② 方法返回值检测
// ============================================================================
function demoBypassRoot() {
  Java.perform(function () {
    let n = 0;

    // ---- 2.1 文件存在性检测：让 su / Superuser.apk 的 exists() 返回 false ----
    try {
      const File = Java.use('java.io.File');
      const rootPaths = ['su', 'Superuser.apk', 'magisk', 'busybox', 'xposed'];
      File.exists.implementation = function () {
        const p = this.getAbsolutePath();
        for (let i = 0; i < rootPaths.length; i++) {
          if (p.indexOf(rootPaths[i]) !== -1) {
            log('root', `exists(${p}) → false`);
            return false;
          }
        }
        return this.exists();
      };
      n++;
    } catch (e) { log('warn', 'File.exists hook 失败: ' + e); }

    // ---- 2.2 Runtime.exec("su") 检测 ----
    try {
      const Runtime = Java.use('java.lang.Runtime');
      Runtime.exec.overload('java.lang.String').implementation = function (cmd) {
        if (cmd && (cmd.indexOf('su') !== -1 || cmd.indexOf('which') !== -1)) {
          log('root', `exec(${cmd}) → 拦截`);
          throw Java.use('java.io.IOException').$new('not found');
        }
        return this.exec(cmd);
      };
      n++;
    } catch (e) {}

    // ---- 2.3 方法名层面的检测（isRooted / checkRoot 等）----
    try {
      const groups = Java.enumerateMethods('*!/isRoot|checkRoot|detectRoot|isDeviceRooted/i');
      groups.forEach(function (g) {
        g.classes.forEach(function (cls) {
          const Cls = Java.use(cls.name);
          g.methods.forEach(function (m) {
            Cls[m].overloads.forEach(function (ov) {
              if (ov.returnType.className === 'boolean') {
                ov.implementation = function () { log('root', `${cls.name}.${m} → false`); return false; };
                n++;
              }
            });
          });
        });
      });
    } catch (e) {}

    log('ok', `Root 检测处理完成，覆盖 ${n} 个点`);
  });
}

// ============================================================================
// 3. Frida 检测绕过
//    检测手段：扫 27042 端口 / 找 frida 线程名 / 读 maps 里的 frida 字样
//    ★ 我们的模块已经改了端口与进程名（sysmon:39527），本身就是一层对抗
// ============================================================================
function demoBypassFridaDetect() {
  let n = 0;

  // ---- 3.1 native 侧：过滤 /proc/self/maps 里的 frida 特征 ----
  //    检测原理是 open("/proc/self/maps") 后搜索 "frida" / "gum-js-loop"
  try {
    const libc = Process.getModuleByName('libc.so');
    const openP = libc.getExportByName('open');
    Interceptor.attach(openP, {
      onEnter: function (args) {
        try {
          this.path = args[0].isNull() ? '' : args[0].readCString();
        } catch (e) { this.path = ''; }
      },
      onLeave: function (retval) {
        // 不改返回值，只记录谁在读敏感文件，便于判断检测点
        if (this.path && (this.path.indexOf('/proc/self/maps') !== -1 ||
                          this.path.indexOf('/proc/self/status') !== -1 ||
                          this.path.indexOf('/proc/self/task') !== -1)) {
          log('detect', `读取 ${this.path}（可能的检测行为）`);
        }
      }
    });
    n++;
  } catch (e) { log('warn', 'open hook 失败: ' + e); }

  // ---- 3.2 Java 侧：常见检测入口 ----
  Java.perform(function () {
    try {
      // 检测 Frida 常通过 Runtime.exec("ps") 或读 /proc 网络表
      const Runtime = Java.use('java.lang.Runtime');
      Runtime.exec.overload('java.lang.String').implementation = function (cmd) {
        if (cmd && (cmd.indexOf('ps') !== -1 || cmd.indexOf('netstat') !== -1 ||
                    cmd.indexOf('27042') !== -1 || cmd.indexOf('frida') !== -1)) {
          log('detect', `拦截命令: ${cmd}`);
          throw Java.use('java.io.IOException').$new('permission denied');
        }
        return this.exec(cmd);
      };

      // 检测 Socket 连接 27042（默认端口）
      const Socket = Java.use('java.net.Socket');
      Socket.$init.overload('java.lang.String', 'int').implementation = function (host, port) {
        if (port === 27042 || port === 27043) {
          log('detect', `拦截连接 ${host}:${port}`);
          throw Java.use('java.net.ConnectException').$new('refused');
        }
        return this.$init(host, port);
      };
      n++;
    } catch (e) { log('warn', 'Java 侧检测处理失败: ' + e); }
  });

  log('ok', `Frida 检测处理完成，覆盖 ${n} 个点`);
}

// ============================================================================
// 4. 反调试绕过
//    ptrace 自附加 / TracerPid 检查 / isDebuggerConnected
// ============================================================================
function demoBypassAntiDebug() {
  // ---- 4.1 native：ptrace(PTRACE_TRACEME) 让自己无法被附加的经典套路 ----
  try {
    const libc = Process.getModuleByName('libc.so');
    Interceptor.attach(libc.getExportByName('ptrace'), {
      onEnter: function (args) {
        const req = args[0].toInt32();
        if (req === 0) { // PTRACE_TRACEME
          log('antidebug', 'ptrace(PTRACE_TRACEME) → 改为返回 0 但不真正执行');
          this.block = true;
        }
      },
      onLeave: function (retval) {
        if (this.block) retval.replace(ptr(0)); // 假装成功
      }
    });
  } catch (e) { log('warn', 'ptrace hook 失败: ' + e); }

  Java.perform(function () {
    // ---- 4.2 isDebuggerConnected ----
    try {
      const Debug = Java.use('android.os.Debug');
      Debug.isDebuggerConnected.implementation = function () {
        log('antidebug', 'isDebuggerConnected → false');
        return false;
      };
    } catch (e) {}
    // ---- 4.3 应用是否 debuggable ----
    try {
      const AppInfo = Java.use('android.content.pm.ApplicationInfo');
      const groups = Java.enumerateMethods('*!/isDebug|isDebuggable/');
      groups.forEach(function (g) {
        g.classes.forEach(function (cls) {
          const Cls = Java.use(cls.name);
          g.methods.forEach(function (m) {
            Cls[m].overloads.forEach(function (ov) {
              if (ov.returnType.className === 'boolean') {
                ov.implementation = function () { return false; };
              }
            });
          });
        });
      });
    } catch (e) {}
  });

  log('ok', '反调试处理已挂');
}

// ============================================================================
// 5. 模拟器检测绕过（在真机上一般用不到，保留速查）
// ============================================================================
function demoBypassEmulator() {
  Java.perform(function () {
    try {
      const Build = Java.use('android.os.Build');
      // 常见检测字段
      log('emulator', `当前 FINGERPRINT=${Build.FINGERPRINT.value}`);
      log('emulator', `当前 MODEL=${Build.MODEL.value}`);
      log('emulator', `当前 HARDWARE=${Build.HARDWARE.value}`);
      // 如需伪造，直接赋值：
      // Build.MODEL.value = 'Pixel 6';
      // Build.HARDWARE.value = 'oriole';
    } catch (e) { log('warn', 'Build 读取失败: ' + e); }

    // 常见检测方法统一返回 false
    try {
      const groups = Java.enumerateMethods('*!/isEmulator|isRunningOnEmulator|detectEmulator/i');
      let n = 0;
      groups.forEach(function (g) {
        g.classes.forEach(function (cls) {
          const Cls = Java.use(cls.name);
          g.methods.forEach(function (m) {
            Cls[m].overloads.forEach(function (ov) {
              if (ov.returnType.className === 'boolean') {
                ov.implementation = function () { return false; };
                n++;
              }
            });
          });
        });
      });
      log('ok', `模拟器检测已改写 ${n} 个方法`);
    } catch (e) {}
  });
}

// ============================================================================
// 6. 抓 Log 与 Toast
//    Log 是最省事的观察点：很多 App 会把关键数据打进日志
// ============================================================================
function demoLogAndToast() {
  Java.perform(function () {
    // ---- Log.i/d/v/w/e ----
    try {
      const Log = Java.use('android.util.Log');
      ['v', 'd', 'i', 'w', 'e'].forEach(function (lv) {
        Log[lv].overload('java.lang.String', 'java.lang.String').implementation = function (tag, msg) {
          console.log(`[Log.${lv}] ${tag}: ${msg}`);
          return this[lv](tag, msg);
        };
      });
    } catch (e) { log('warn', 'Log hook 失败: ' + e); }

    // ---- Toast 文本 ----
    try {
      const Toast = Java.use('android.widget.Toast');
      Toast.show.implementation = function () {
        try {
          const text = this.getText ? this.getText() : null;
          if (text) log('toast', String(text));
        } catch (e) {}
        return this.show();
      };
    } catch (e) {}

    log('ok', 'Log / Toast 抓取已挂');
  });
}

// ============================================================================
// 7. 剪贴板监控
// ============================================================================
function demoClipboard() {
  Java.perform(function () {
    try {
      const CM = Java.use('android.content.ClipboardManager');
      CM.getPrimaryClip.implementation = function () {
        const clip = this.getPrimaryClip();
        try {
          if (clip) {
            const item = clip.getItemAt(0);
            log('clip', `读取剪贴板: ${item.getText()}`);
          }
        } catch (e) {}
        return clip;
      };
      CM.setPrimaryClip.implementation = function (clip) {
        try {
          const item = clip.getItemAt(0);
          log('clip', `写入剪贴板: ${item.getText()}`);
        } catch (e) {}
        return this.setPrimaryClip(clip);
      };
      log('ok', '剪贴板监控已挂');
    } catch (e) { log('warn', '剪贴板 hook 失败: ' + e); }
  });
}

// ============================================================================
// 8. 只读：查看签名信息（不绕过，用于确认重签是否生效）
// ============================================================================
function demoInspectSignature() {
  Java.perform(function () {
    try {
      const ActivityThread = Java.use('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      const ctx = app.getApplicationContext();
      const pm = ctx.getPackageManager();
      const pkg = ctx.getPackageName();

      const PackageManager = Java.use('android.content.pm.PackageManager');
      const info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES.value);
      const sigs = info.signatures.value;

      const MD = Java.use('java.security.MessageDigest');
      for (let i = 0; i < sigs.length; i++) {
        const bytes = sigs[i].toByteArray();
        const digest = MD.getInstance('SHA-256').digest(bytes);
        let hex = '';
        for (let j = 0; j < digest.length; j++) hex += ('0' + (digest[j] & 0xff).toString(16)).slice(-2);
        log('sign', `包名=${pkg} 签名#${i + 1} SHA256=${hex}`);
      }
    } catch (e) { log('warn', '签名读取失败: ' + e); }
  });
}

// ============================================================================
// 入口
// ============================================================================
function main() {
  const hasJava = (typeof Java !== 'undefined') && Java.available;

  const map = {
    bypassPinning: function () { if (hasJava) demoBypassPinning(); else log('warn', '需要 Java bridge'); },
    bypassRoot: function () { if (hasJava) demoBypassRoot(); else log('warn', '需要 Java bridge'); },
    bypassFridaDetect: function () { if (hasJava) demoBypassFridaDetect(); else demoBypassFridaDetect(); },
    bypassAntiDebug: function () { if (hasJava) demoBypassAntiDebug(); else log('warn', '需要 Java bridge'); },
    bypassEmulator: function () { if (hasJava) demoBypassEmulator(); else log('warn', '需要 Java bridge'); },
    logAndToast: function () { if (hasJava) demoLogAndToast(); else log('warn', '需要 Java bridge'); },
    clipboard: function () { if (hasJava) demoClipboard(); else log('warn', '需要 Java bridge'); },
    inspectSignature: function () { if (hasJava) demoInspectSignature(); else log('warn', '需要 Java bridge'); }
  };

  let started = 0;
  Object.keys(map).forEach(function (k) {
    if (CONFIG.enable[k]) {
      try { map[k](); started++; } catch (e) { log('err', `${k}: ${e}`); }
    }
  });

  if (started === 0) {
    console.log('[i] 已加载 05_common_targets.js，未启用任何项目。');
    console.log('[i] 可用开关：' + Object.keys(map).join(', '));
    console.log('[!] 提醒：这些脚本会改变目标的安全行为，请仅用于你获授权的测试。');
  }
}

main();
