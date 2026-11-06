/*
 * ============================================================================
 *  04_native_advanced.js —— Frida Native 层进阶模板
 * ============================================================================
 *
 *  适配版本：Frida 17.5.2 / Android 15 / arm64（实测通过）
 *  依赖    ：无（纯 GumJS）
 *
 *  本文件覆盖：
 *     基址+偏移定位无符号函数 / 指令级 patch（arm64）/ dlopen 与 dlsym 监控
 *     JNI RegisterNatives 拦截（拿到 native 方法真实地址）
 *     Stalker 指令流 / CModule 内联 C / mprotect 改保护 / syscall 监控
 *     arm64 寄存器读写 / 模块加载监控
 *
 *  ⚠️ 指令级 patch 与 Stalker 会显著影响性能，且可能让目标崩溃，
 *     只在调试时打开，定位到问题就关掉。
 * ============================================================================
 */

'use strict';

const CONFIG = {
  targetModule: 'libnative-lib.so',
  // 目标函数的文件偏移（来自 IDA / Ghidra / objdump）
  targetOffset: '0x8f40',
  // 要 patch 的地址偏移
  patchOffset: '0x8f50',

  enable: {
    hookByOffset: false,   // 1. 基址+偏移 hook（无导出符号）
    patchByOffset: false,  // 2. 指令级 patch（arm64）
    watchDlopen: false,    // 3. 监控 so 加载（dlopen/dlsym）
    hookRegisterNatives: false, // 4. JNI 动态注册拦截
    stalker: false,        // 5. Stalker 指令流追踪
    cmodule: false,        // 6. CModule 内联 C 代码
    mprotectPatch: false,  // 7. 改内存保护后写指令
    watchSyscall: false,   // 8. 监控 openat 等 syscall
    regAccess: false,      // 9. 读写 arm64 寄存器
    watchModuleLoad: false // 10. 新模块加载通知
  }
};

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

function mod(name) {
  const m = Process.findModuleByName(name);
  if (!m) log('warn', `模块 ${name} 未加载`);
  return m;
}

/** arm64 常用指令编码，patch 时直接写 u32 */
const ARM64 = {
  NOP: 0xd503201f,        // 空指令
  RET: 0xd65f03c0,        // 返回
  MOV_W0_0: 0x52800000,   // w0 = 0
  MOV_W0_1: 0x52800020,   // w0 = 1
  MOV_X0_0: 0xd2800000    // x0 = 0
};

// ============================================================================
// 1. 基址 + 偏移：hook 没有导出符号的函数
//    这是 Android so 逆向最常用的方式（符号被 strip 掉时只能靠偏移）
//    ★ 偏移来自静态分析，必须与设备上 so 的版本完全一致，否则会 hook 到错处
// ============================================================================
function demoHookByOffset() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;

  const addr = m.base.add(ptr(CONFIG.targetOffset));
  log('addr', `${CONFIG.targetModule} base=${m.base} + ${CONFIG.targetOffset} = ${addr}`);

  // 先 dump 几条指令确认位置对不对（arm64 每条 4 字节）
  try {
    const insn = addr.readU32();
    log('insn', `该地址首指令 = 0x${insn.toString(16)}`);
  } catch (e) {
    log('warn', '读指令失败（地址可能不可读）: ' + e);
  }

  Interceptor.attach(addr, {
    onEnter: function (args) {
      log('enter', `x0=${args[0]} x1=${args[1]} x2=${args[2]}`);
      this.x0 = args[0];
    },
    onLeave: function (retval) {
      log('leave', `ret=${retval}`);
      // retval.replace(ptr(1));
    }
  });
  log('ok', '已按偏移 hook');
}

// ============================================================================
// 2. 指令级 patch（arm64）
//    把函数开头改成「直接返回固定值」，比 Interceptor 更轻、更隐蔽
//    ⚠️ 只改 4 字节，必须确认指令边界对齐
// ============================================================================
function demoPatchByOffset() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;

  const addr = m.base.add(ptr(CONFIG.patchOffset));
  const before = addr.readU32();
  log('patch', `原指令 = 0x${before.toString(16)} @ ${addr}`);

  // 方案 A：改成 ret（函数直接返回，返回值保持原 x0）
  // addr.writeU32(ARM64.RET);

  // 方案 B：改成 mov w0, #1; ret（强制返回 true）
  // addr.writeU32(ARM64.MOV_W0_1);
  // addr.add(4).writeU32(ARM64.RET);

  // 方案 C：改成 nop（跳过原逻辑，谨慎）
  // addr.writeU32(ARM64.NOP);

  log('info', '取消注释上面任一行即可 patch；恢复原值：');
  log('info', `addr.writeU32(0x${before.toString(16)})`);
}

// ============================================================================
// 3. dlopen / dlsym 监控：新 so 加载时立刻知道，并对指定函数下 hook
//    用途：加固 App 在启动后才加载核心 so，启动时 hook 会扑空
// ============================================================================
function demoWatchDlopen() {
  const libdl = Process.getModuleByName('libdl.so');

  // ---- dlopen：谁加载了什么 ----
  try {
    Interceptor.attach(libdl.getExportByName('dlopen'), {
      onEnter: function (args) {
        try { this.path = args[0].isNull() ? '(null)' : args[0].readCString(); } catch (e) { this.path = '?'; }
        log('dlopen', `加载 ${this.path}`);
      },
      onLeave: function (retval) {
        log('dlopen', `${this.path} → handle=${retval}`);
        // 如果正好是我们等的 so，在这里补挂 hook
        // if (this.path && this.path.indexOf(CONFIG.targetModule) !== -1) { demoHookByOffset(); }
      }
    });
  } catch (e) { log('warn', 'dlopen hook 失败: ' + e); }

  // ---- android_dlopen_ext：Android 上实际常走这个 ----
  try {
    const ext = Process.findModuleByName('libdl.so').findExportByName('android_dlopen_ext');
    if (ext) {
      Interceptor.attach(ext, {
        onEnter: function (args) {
          try { log('dlopen_ext', `${args[0].isNull() ? '(null)' : args[0].readCString()}`); } catch (e) {}
        }
      });
    }
  } catch (e) {}

  // ---- dlsym：谁在按名字找函数 ----
  try {
    Interceptor.attach(libdl.getExportByName('dlsym'), {
      onEnter: function (args) {
        try { this.name = args[1].readCString(); } catch (e) { this.name = '?'; }
      },
      onLeave: function (retval) {
        log('dlsym', `${this.name} → ${retval}`);
      }
    });
  } catch (e) {}

  log('ok', 'so 加载监控已挂');
}

// ============================================================================
// 4. JNI RegisterNatives 拦截 ★ 重点
//    App 用 RegisterNatives 动态注册时，native 方法名和符号对不上，
//    靠枚举导出找不到。这里能拿到 name / signature / fnPtr 三元组，
//    直接对 fnPtr 下 hook，比在 Java 层 hook 更底层。
// ============================================================================
function demoHookRegisterNatives() {
  const libart = Process.findModuleByName('libart.so');
  if (!libart) { log('warn', 'libart.so 未加载'); return; }

  // 符号名随 Android 版本变，用包含匹配更稳
  const hit = libart.enumerateSymbols().filter(function (s) {
    return s.name.indexOf('RegisterNatives') !== -1;
  });
  if (hit.length === 0) {
    log('warn', '在 libart 里找不到 RegisterNatives 符号（可能被隐藏）');
    log('info', '替代方案：hook JNI_OnLoad 后在 Java 层 hook 声明为 native 的方法');
    return;
  }
  log('sym', `找到 ${hit.length} 个候选：${hit.map(function (s) { return s.name; }).join(', ')}`);

  const addr = hit[0].address;
  Interceptor.attach(addr, {
    onEnter: function (args) {
      // RegisterNatives(JNIEnv *env, jclass clazz, const JNINativeMethod *methods, jint nMethods)
      const methodsPtr = args[2];
      const count = args[3].toInt32();
      log('jni', `注册 ${count} 个 native 方法`);
      if (count <= 0 || count > 500) return;

      // JNINativeMethod = { const char *name; const char *signature; void *fnPtr; }
      for (let i = 0; i < count; i++) {
        const base = methodsPtr.add(i * Process.pointerSize * 3);
        try {
          const name = base.readPointer().readCString();
          const sig = base.add(Process.pointerSize).readPointer().readCString();
          const fnPtr = base.add(Process.pointerSize * 2).readPointer();
          log('jni', `  ${name}${sig} → ${fnPtr}`);
          // 直接对实现地址下 hook：
          // Interceptor.attach(fnPtr, {
          //   onEnter(a) { console.log('    args:', a[0], a[1]); },
          //   onLeave(r) { console.log('    ret:', r); }
          // });
        } catch (e) { log('warn', `  第 ${i} 项读取失败: ${e}`); }
      }
    }
  });
  log('ok', `已 hook RegisterNatives @ ${addr}`);
}

// ============================================================================
// 5. Stalker：指令流追踪
//    能回答「这段代码到底执行了哪些指令」，但非常慢，只在窄范围用
// ============================================================================
function demoStalker() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  const target = m.base.add(ptr(CONFIG.targetOffset));

  Interceptor.attach(target, {
    onEnter: function () {
      const tid = Process.getCurrentThreadId();
      log('stalker', `开始追踪线程 ${tid}（从此处继续执行）`);
      Stalker.follow(tid, {
        events: { call: true, ret: true, exec: false, block: false },
        onCallSummary: function (summary) {
          Object.keys(summary).forEach(function (k) {
            log('stalker', `调用 ${k} ${summary[k]} 次`);
          });
        }
      });
      // 停止：Stalker.unfollow(tid); Stalker.flush();
    }
  });
  log('ok', 'Stalker 已就绪（命中目标函数时开始追踪）');
}

// ============================================================================
// 6. CModule：在脚本里写 C 代码并编译成机器码
//    适合写高性能处理逻辑，或替换函数实现
// ============================================================================
function demoCModule() {
  const source = `
    #include <glib.h>

    // 简单加法，验证 CModule 可用
    int my_add(int a, int b) {
      return a + b;
    }

    // 返回固定值，用来替换检测函数
    int always_true(void) {
      return 1;
    }
  `;

  try {
    const cm = new CModule(source);
    log('cmodule', `符号表：${Object.keys(cm).join(', ')}`);

    const add = new NativeFunction(cm.my_add, 'int', ['int', 'int']);
    log('cmodule', `my_add(20, 22) = ${add(20, 22)}`);

    // 用 CModule 实现替换目标函数（比 JS 回调快得多）
    // const m = mod(CONFIG.targetModule);
    // if (m) {
    //   Interceptor.replace(m.base.add(ptr(CONFIG.targetOffset)),
    //     new NativeCallback(function () { return 1; }, 'int', []));
    // }
  } catch (e) {
    log('warn', 'CModule 不可用: ' + e);
  }
}

// ============================================================================
// 7. mprotect 改内存保护后写指令
//    有些代码段是 r-x，直接 writeU32 会崩，先改成 rwx
// ============================================================================
function demoMprotectPatch() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  const addr = m.base.add(ptr(CONFIG.patchOffset));

  try {
    const before = addr.readU32();
    const pageSize = Process.pageSize;
    const pageStart = addr.and(ptr(pageSize - 1).not());

    const ok = Memory.protect(pageStart, pageSize, 'rwx');
    log('mprotect', `改保护 ${pageStart} → rwx: ${ok}`);

    addr.writeU32(ARM64.RET);
    log('mprotect', `已写入 RET（原 0x${before.toString(16)}）`);

    // 恢复可执行但不可写（更接近原状）
    Memory.protect(pageStart, pageSize, 'r-x');
    log('ok', 'patch 完成，保护已恢复 r-x');
  } catch (e) {
    log('warn', 'patch 失败: ' + e);
  }
}

// ============================================================================
// 8. 监控 syscall：openat / connect
//    绕过 libc 包装层，抓更底层的文件与网络行为
// ============================================================================
function demoWatchSyscall() {
  // openat(int dirfd, const char *pathname, int flags, mode_t mode)
  const libc = Process.getModuleByName('libc.so');
  try {
    Interceptor.attach(libc.getExportByName('openat'), {
      onEnter: function (args) {
        try {
          const path = args[1].isNull() ? '(null)' : args[1].readCString();
          log('openat', `${path} flags=0x${args[2].toInt32().toString(16)}`);
        } catch (e) {}
      }
    });
  } catch (e) { log('warn', 'openat hook 失败: ' + e); }

  try {
    Interceptor.attach(libc.getExportByName('connect'), {
      onEnter: function (args) {
        // struct sockaddr：sa_family(2B) + sa_data；AF_INET 时 port 在 +2，ip 在 +4
        try {
          const sa = args[1];
          const family = sa.readU16();
          if (family === 2) { // AF_INET
            const port = (sa.add(2).readU8() << 8) | sa.add(3).readU8();
            const ip = [sa.add(4).readU8(), sa.add(5).readU8(), sa.add(6).readU8(), sa.add(7).readU8()].join('.');
            log('connect', `${ip}:${port}`);
          } else {
            log('connect', `family=${family}（非 IPv4）`);
          }
        } catch (e) {}
      }
    });
  } catch (e) { log('warn', 'connect hook 失败: ' + e); }

  log('ok', 'syscall 监控已挂');
}

// ============================================================================
// 9. 读写 arm64 寄存器
//    context 里有 x0-x28、fp、lr、sp、pc、nzcv 等
// ============================================================================
function demoRegAccess() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  const addr = m.base.add(ptr(CONFIG.targetOffset));

  Interceptor.attach(addr, {
    onEnter: function () {
      const c = this.context;
      log('reg', `pc = ${c.pc}`);
      log('reg', `x0 = ${c.x0}  x1 = ${c.x1}  x2 = ${c.x2}`);
      log('reg', `sp = ${c.sp}  lr = ${c.lr}`);
      // 读栈上数据（注意边界，越界会崩）
      try {
        log('reg', `[sp] = ${c.sp.readPointer()}`);
        log('reg', `[sp+8] = ${c.sp.add(8).readPointer()}`);
      } catch (e) {}
    },
    onLeave: function () {
      // 直接改寄存器（比 retval.replace 更粗暴，用于特殊场景）
      // this.context.x0 = ptr(1);
    }
  });
  log('ok', '寄存器读写已挂');
}

// ============================================================================
// 10. 监控模块加载（不需要 hook dlopen，Frida 自带事件）
// ============================================================================
function demoWatchModuleLoad() {
  // 方案 A：名字快照轮询（不依赖 ModuleMap 的地址语义，最稳）
  try {
    const seen = {};
    Process.enumerateModules().forEach(function (m) { seen[m.name] = true; });

    setInterval(function () {
      Process.enumerateModules().forEach(function (m) {
        if (!seen[m.name]) {
          seen[m.name] = true;
          log('newmod', `${m.name} @ ${m.base} size=0x${m.size.toString(16)}`);
        }
      });
    }, 1000);
    log('ok', '模块加载轮询已启动（1s 间隔）');
  } catch (e) {
    log('warn', '轮询启动失败: ' + e);
  }

  // 方案 B：ModuleMap（注意 has/find 接收的是地址，不是模块名）
  // const observer = new ModuleMap();
  // setInterval(function () {
  //   Process.enumerateModules().forEach(function (m) {
  //     if (observer.findName(m.name) === null) { observer.set(m); log('newmod', m.name); }
  //   });
  // }, 1000);

  // 方案 C：平台支持时的原生事件回调
  // Process.attachModuleObserver({ onAdded(m) { log('newmod', m.name); }, onRemoved(m) {} });
}

// ============================================================================
// 入口
// ============================================================================
function main() {
  const map = {
    hookByOffset: demoHookByOffset,
    patchByOffset: demoPatchByOffset,
    watchDlopen: demoWatchDlopen,
    hookRegisterNatives: demoHookRegisterNatives,
    stalker: demoStalker,
    cmodule: demoCModule,
    mprotectPatch: demoMprotectPatch,
    watchSyscall: demoWatchSyscall,
    regAccess: demoRegAccess,
    watchModuleLoad: demoWatchModuleLoad
  };

  let started = 0;
  Object.keys(map).forEach(function (k) {
    if (CONFIG.enable[k]) {
      try { map[k](); started++; } catch (e) { log('err', `${k}: ${e}`); }
    }
  });

  if (started === 0) {
    console.log('[i] 已加载 04_native_advanced.js，未启用任何演示。');
    console.log('[i] 可用开关：' + Object.keys(map).join(', '));
    console.log('[i] 提醒：patch / stalker 会明显影响性能，定位完就关。');
  }
}

main();
