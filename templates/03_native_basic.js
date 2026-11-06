/*
 * ============================================================================
 *  03_native_basic.js —— Frida Native 层 Hook 基础模板（速查版）
 * ============================================================================
 *
 *  适配版本：Frida 17.5.2 / Android 15 / arm64（Pixel 6 实测通过）
 *  依赖    ：无（纯 GumJS，frida-python create_script 可直接加载）
 *
 *  ★ 本文件与 Java 模板不同：不需要 Java bridge，任何加载方式都能用。
 *
 *  ⚠️ Frida 17 必须改的写法（旧脚本会直接报 TypeError）：
 *      旧：Module.getBaseAddress('libx.so')
 *      新：Process.getModuleByName('libx.so').base
 *
 *      旧：Module.findExportByName('libx.so', 'fn')
 *      新：Process.getModuleByName('libx.so').getExportByName('fn')
 *
 *      旧：Module.findExportByName(null, 'fn')
 *      新：Module.findGlobalExportByName('fn')
 *
 *      旧：Module.enumerateExports('libx.so')
 *      新：Process.getModuleByName('libx.so').enumerateExports()
 *
 *      旧：Memory.readU32(p) / Memory.writeU32(p, v)
 *      新：p.readU32() / p.writeU32(v)
 *
 *      旧：Process.enumerateModules({ onMatch, onComplete })
 *      新：for (const m of Process.enumerateModules())
 *
 *  使用：改 CONFIG 里的 targetModule / targetFunc，再把对应开关设为 true
 * ============================================================================
 */

'use strict';

// ============================================================================
// 配置区
// ============================================================================
const CONFIG = {
  // 目标 so 名（不带路径，例如 libnative-lib.so）
  targetModule: 'libnative-lib.so',
  // 目标导出函数名
  targetFunc: 'Java_com_example_NativeLib_check',
  // 用「基址 + 偏移」hook 时填这里（无符号函数用）
  targetOffset: '0x1234',
  // 特征码（Memory.scan 用），r2 风格
  pattern: 'ff 03 00 aa ?? ?? 40 f9',

  enable: {
    moduleInfo: false,     // 1. 打印模块基址与大小
    resolveExport: false,  // 2. 查找导出函数的几种写法
    attachBasic: false,    // 3. Interceptor.attach 基础
    readArgs: false,       // 4. 读参数（int/指针/字符串）
    modify: false,         // 5. 改参数与返回值
    callFunc: false,       // 6. NativeFunction 主动调用
    memReadWrite: false,   // 7. 内存读写（新式 API）
    readString: false,     // 8. 读 C 字符串 / 宽字符
    backtrace: false,      // 9. 打印调用栈
    hookLibc: false,       // 10. hook libc 常用函数
    listExports: false,    // 11. 遍历导出表
    scanPattern: false,    // 12. 特征码搜索
    listModules: false     // 13. 列出所有模块
  }
};

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

/** 取模块，找不到返回 null（并给出人话提示） */
function mod(name) {
  const m = Process.findModuleByName(name);
  if (m === null) {
    log('warn', `模块 ${name} 未加载。已加载的 so 里包含关键字的：`);
    Process.enumerateModules()
      .filter(function (x) { return x.name.indexOf(name.replace(/^lib|\.so$/g, '')) !== -1; })
      .slice(0, 10)
      .forEach(function (x) { console.log('  ' + x.name + '  ' + x.base); });
    return null;
  }
  return m;
}

// ============================================================================
// 1. 模块信息：基址、大小、路径
//    基址是后续所有「基址+偏移」计算的前提
// ============================================================================
function demoModuleInfo() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  log('module', `name = ${m.name}`);
  log('module', `base = ${m.base}`);
  log('module', `size = 0x${m.size.toString(16)} (${m.size} bytes)`);
  log('module', `path = ${m.path}`);
}

// ============================================================================
// 2. 查找导出函数：四种写法与取舍
//    ★ 高频调用时务必先取 module 对象，不要每次 getModuleByName
// ============================================================================
function demoResolveExport() {
  // 写法 A：知道模块名（最常用）
  const libc = Process.getModuleByName('libc.so');
  log('A', `libc.open = ${libc.getExportByName('open')}`);
  log('A', `libc.base = ${libc.base}`);

  // 写法 B：不知道在哪个模块里（全局查找，较慢）
  const p = Module.findGlobalExportByName('open');
  log('B', `findGlobalExportByName('open') = ${p}`);

  // 写法 C：可能不存在时用 find（返回 null 不抛异常）
  const maybe = Process.getModuleByName('libc.so').findExportByName('not_exist_fn');
  log('C', `findExportByName('not_exist_fn') = ${maybe}`);

  // 写法 D：按符号表找（含调试符号，比导出表更全）
  try {
    const sym = Process.getModuleByName('libc.so').findSymbolByName('open');
    log('D', `findSymbolByName('open') = ${sym ? sym.address : null}`);
  } catch (e) { log('D', '符号查找不可用: ' + e); }

  // 写法 E：目标函数在当前进程的绝对地址 = 模块基址 + 文件偏移
  const target = mod(CONFIG.targetModule);
  if (target) {
    const abs = target.base.add(ptr(CONFIG.targetOffset));
    log('E', `${CONFIG.targetModule} + ${CONFIG.targetOffset} = ${abs}`);
  }
}

// ============================================================================
// 3. Interceptor.attach 基础骨架
//    onEnter 里能拿到参数与上下文，onLeave 里能改返回值
// ============================================================================
function demoAttachBasic() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;

  let addr;
  try {
    addr = m.getExportByName(CONFIG.targetFunc);
  } catch (e) {
    log('warn', `找不到导出 ${CONFIG.targetFunc}：${e}`);
    log('info', '无导出符号时用「基址+偏移」：m.base.add(ptr("0x1234"))');
    return;
  }

  Interceptor.attach(addr, {
    onEnter: function (args) {
      // args 是指针数组，args[0] 对应第一个参数
      // this 是本回调的上下文，onLeave 里能访问
      log('enter', `${CONFIG.targetFunc} args[0]=${args[0]} args[1]=${args[1]}`);
      // 保存现场，供 onLeave 使用
      this.arg0 = args[0];
      this.t0 = Date.now();
    },
    onLeave: function (retval) {
      log('leave', `retval=${retval} 耗时=${Date.now() - this.t0}ms`);
      // retval 是 NativePointer 包装，可直接替换
      // retval.replace(ptr(1));
    }
  });
  log('ok', `已 hook ${CONFIG.targetFunc} @ ${addr}`);
}

// ============================================================================
// 4. 读参数：整数、指针、字符串、缓冲区
//    arm64 前 8 个参数走 x0-x7，Interceptor 已帮你映射到 args[]
// ============================================================================
function demoReadArgs() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  const addr = m.base.add(ptr(CONFIG.targetOffset));

  Interceptor.attach(addr, {
    onEnter: function (args) {
      // 整数参数
      log('int', `args[0] as int32  = ${args[0].toInt32()}`);
      log('int', `args[0] as uint64 = ${args[0].toUInt32()}`);

      // 指针参数（先判空再读，否则可能崩）
      if (!args[1].isNull()) {
        // 按 C 字符串读
        try { log('str', `args[1] as C string = ${args[1].readCString()}`); } catch (e) {}
        // 按 UTF-16 读
        try { log('wcs', `args[1] as UTF-16   = ${args[1].readUtf16String()}`); } catch (e) {}
        // 按结构体读：定义布局后 readStruct 更清晰
        try {
          log('mem', `args[1] +0 = 0x${args[1].readU32().toString(16)}`);
          log('mem', `args[1] +4 = 0x${args[1].add(4).readU32().toString(16)}`);
        } catch (e) {}
      }

      // 缓冲区 + 长度（常见 C 接口形态）
      if (!args[1].isNull() && args[2].toInt32() > 0) {
        const len = Math.min(args[2].toInt32(), 64);
        try {
          const buf = args[1].readByteArray(len);
          log('buf', `len=${args[2].toInt32()} 前 ${len} 字节 = ${buf ? Array.from(new Uint8Array(buf)).map(b => ('0' + b.toString(16)).slice(-2)).join(' ') : 'null'}`);
        } catch (e) {}
      }
    }
  });
  log('ok', `已挂在 ${CONFIG.targetModule}+${CONFIG.targetOffset} 读参数`);
}

// ============================================================================
// 5. 改参数与返回值
//    ★ 改参数要在调用前（onEnter），改返回值要在调用后（onLeave）
// ============================================================================
function demoModify() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  const addr = m.base.add(ptr(CONFIG.targetOffset));

  Interceptor.attach(addr, {
    onEnter: function (args) {
      // 改整数参数：直接写回内存
      // 例如把 bool 参数从 0 改成 1
      // args[2].writeU32(1);

      // 改 C 字符串参数：分配新字符串再替换指针
      // args[1] = Memory.allocUtf8String('tampered');
    },
    onLeave: function (retval) {
      // 改返回值：arm64 上 int 返回值在 x0，retval 已封装
      // retval.replace(ptr(1));         // int 1
      // retval.replace(ptr(0));         // 强制 0
      // retval.replace(ptr('0x7f0000000000')); // 伪造指针
      log('leave', `当前 retval=${retval}（取消注释上面的 replace 即可改写）`);
    }
  });
  log('ok', '改参数/返回值模板已挂载');
}

// ============================================================================
// 6. NativeFunction：主动调用 so 里的函数
//    签名必须与真实函数一致，写错会崩进程
// ============================================================================
function demoCallFunc() {
  const libc = Process.getModuleByName('libc.so');

  // 例 1：int getpid(void)
  const getpid = new NativeFunction(libc.getExportByName('getpid'), 'int', []);
  log('call', `getpid() = ${getpid()}`);

  // 例 2：int open(const char *path, int flags)
  const open = new NativeFunction(libc.getExportByName('open'), 'int', ['pointer', 'int']);
  const path = Memory.allocUtf8String('/proc/self/status');
  const fd = open(path, 0); // O_RDONLY = 0
  log('call', `open('/proc/self/status') = ${fd}`);

  // 例 3：调用目标 so 的导出函数
  const m = mod(CONFIG.targetModule);
  if (m) {
    try {
      const fn = new NativeFunction(m.getExportByName(CONFIG.targetFunc), 'int', ['pointer']);
      // log('call', `targetFunc(NULL) = ${fn(ptr(0))}`);
      log('ok', '目标函数的 NativeFunction 已就绪（取消注释即调用）');
    } catch (e) { log('warn', '目标函数调用准备失败: ' + e); }
  }
}

// ============================================================================
// 7. 内存读写（Frida 17 新式 API，旧 Memory.readU32 已移除）
// ============================================================================
function demoMemReadWrite() {
  const p = Memory.alloc(64);

  // 写：方法挂在 NativePointer 上，可链式调用
  p.writeU32(0x11223344);
  p.add(4).writeU8(0xab);
  p.add(8).writePointer(ptr('0xdeadbeef'));

  // 读
  log('mem', `+0 u32 = 0x${p.readU32().toString(16)}`);
  log('mem', `+4 u8  = 0x${p.add(4).readU8().toString(16)}`);
  log('mem', `+8 ptr = ${p.add(8).readPointer()}`);

  // 字符串读写
  const s = Memory.allocUtf8String('hello frida');
  log('mem', `cstring = ${s.readCString()}`);
  const w = Memory.allocUtf16String('宽字符');
  log('mem', `utf16 = ${w.readUtf16String()}`);

  // 字节数组
  const buf = Memory.alloc(8);
  buf.writeByteArray([0x41, 0x42, 0x43, 0x44]);
  log('mem', `byteArray = ${buf.readByteArray(4)}`);

  // 结构体：定义布局一次，之后读写按字段名
  try {
    const st = Memory.alloc(16);
    const layout = [
      { name: 'a', type: 'int' },
      { name: 'b', type: 'pointer' }
    ];
    st.writeStruct({ a: 7, b: ptr('0x1000') }, layout);
    log('mem', `struct = ${JSON.stringify(st.readStruct(layout), (k, v) => typeof v === 'object' && v !== null ? String(v) : v)}`);
  } catch (e) { log('warn', 'readStruct 演示失败: ' + e); }
}

// ============================================================================
// 8. 读字符串：readCString / readUtf16String / 指定长度
// ============================================================================
function demoReadString() {
  const libc = Process.getModuleByName('libc.so');
  const p = libc.base; // 指向 ELF 头，做演示用

  // readCString 遇到 \0 停止，适合标准 C 字符串
  try { log('str', `readCString @ libc.base = ${p.readCString(16)}`); } catch (e) {}

  // readUtf8String(长度) 适合非 \0 结尾的数据
  try { log('str', `readUtf8String(8) = ${p.readUtf8String(8)}`); } catch (e) {}

  // 从某地址按偏移读
  try {
    const elfMagic = p.readU32();
    log('str', `ELF magic = 0x${elfMagic.toString(16)}（0x464c457f 说明读对了）`);
  } catch (e) {}
}

// ============================================================================
// 9. 打印 Native 调用栈
//    定位「谁调用了这个函数」的最快手段
// ============================================================================
function demoBacktrace() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;
  const addr = m.base.add(ptr(CONFIG.targetOffset));

  Interceptor.attach(addr, {
    onEnter: function () {
      // ACCURATE 更准但更慢；FUZZY 快，适合高频调用
      const bt = Thread.backtrace(this.context, Backtracer.FUZZY);
      const syms = bt.map(function (a) {
        const s = DebugSymbol.fromAddress(a);
        return `${a}  ${s.moduleName ? s.moduleName + '!' : ''}${s.name || '?'}`;
      });
      log('trace', `\n  ${syms.join('\n  ')}`);
    }
  });
  log('ok', '调用栈打印已挂');
}

// ============================================================================
// 10. hook libc 常用函数（快速摸清进程行为）
//     open / read / write / strcmp / malloc / connect
// ============================================================================
function demoHookLibc() {
  const libc = Process.getModuleByName('libc.so');

  // 打开文件监控
  try {
    const openP = libc.getExportByName('open');
    Interceptor.attach(openP, {
      onEnter: function (args) {
        try {
          const path = args[0].isNull() ? '(null)' : args[0].readCString();
          log('open', `${path} flags=${args[1].toInt32()}`);
        } catch (e) {}
      },
      onLeave: function (retval) {
        log('open', `→ fd=${retval.toInt32()}`);
      }
    });
  } catch (e) { log('warn', 'open hook 失败: ' + e); }

  // 字符串比较（抓协议关键字）
  try {
    const strcmpP = libc.getExportByName('strcmp');
    Interceptor.attach(strcmpP, {
      onEnter: function (args) {
        try {
          this.a = args[0].readCString();
          this.b = args[1].readCString();
        } catch (e) { this.a = this.b = '?'; }
      },
      onLeave: function (retval) {
        log('strcmp', `${this.a} vs ${this.b} → ${retval.toInt32()}`);
      }
    });
  } catch (e) { log('warn', 'strcmp hook 失败: ' + e); }

  log('ok', 'libc hook 已挂（其他函数照抄这个结构即可）');
}

// ============================================================================
// 11. 遍历导出表：找可疑函数名（如 crypto、decrypt、check）
// ============================================================================
function demoListExports() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;

  const keyword = ''; // ← 填关键字过滤，空则全列
  const exports = m.enumerateExports();
  const hit = keyword
    ? exports.filter(function (e) { return e.name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1; })
    : exports;

  log('exports', `${m.name} 共 ${exports.length} 个导出，匹配 ${hit.length} 个`);
  hit.slice(0, 80).forEach(function (e) {
    console.log(`  ${e.type.padEnd(8)} ${e.address}  ${e.name}`);
  });

  // 顺带看导入表（目标依赖了哪些外部函数）
  try {
    const imports = m.enumerateImports();
    log('imports', `导入 ${imports.length} 项，前 10：`);
    imports.slice(0, 10).forEach(function (e) {
      console.log(`  ${e.type.padEnd(8)} ${e.name || ''} ← ${e.module || ''}`);
    });
  } catch (e) {}
}

// ============================================================================
// 12. 特征码搜索：Memory.scanSync
//    用途：无导出符号时定位函数、找字符串引用
// ============================================================================
function demoScanPattern() {
  const m = mod(CONFIG.targetModule);
  if (!m) return;

  const range = { base: m.base, size: m.size };
  const t0 = Date.now();
  let results = [];
  try {
    results = Memory.scanSync(range.base, range.size, CONFIG.pattern);
  } catch (e) {
    log('warn', 'scanSync 失败: ' + e);
    return;
  }
  log('scan', `模式 ${CONFIG.pattern} 命中 ${results.length} 处，耗时 ${Date.now() - t0}ms`);
  results.slice(0, 20).forEach(function (r) {
    log('scan', `  ${r.address}  offset=0x${r.address.sub(m.base).toString(16)}`);
  });
  if (results.length === 0) {
    log('info', '没命中：确认模式格式（空格分隔、?? 为通配）与目标架构');
  }

  // 异步版（扫描大范围时用，避免卡住 JS 线程）
  // Memory.scan(range.base, range.size, CONFIG.pattern, {
  //   onMatch(address, size) { console.log('match', address); },
  //   onComplete() { console.log('scan done'); }
  // });
}

// ============================================================================
// 13. 列出所有模块（找 so 名用）
// ============================================================================
function demoListModules() {
  const keyword = ''; // ← 填关键字过滤，如 'crypto'
  const mods = Process.enumerateModules();
  const hit = keyword
    ? mods.filter(function (m) { return m.name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1; })
    : mods;

  log('modules', `共 ${mods.length} 个模块，匹配 ${hit.length} 个`);
  hit.slice(0, 60).forEach(function (m) {
    console.log(`  ${m.base}  ${(m.size / 1024).toFixed(0)}KB  ${m.name}`);
  });
  if (hit.length > 60) log('modules', `... 其余 ${hit.length - 60} 个已省略`);
}

// ============================================================================
// 入口
// ============================================================================
function main() {
  const map = {
    moduleInfo: demoModuleInfo,
    resolveExport: demoResolveExport,
    attachBasic: demoAttachBasic,
    readArgs: demoReadArgs,
    modify: demoModify,
    callFunc: demoCallFunc,
    memReadWrite: demoMemReadWrite,
    readString: demoReadString,
    backtrace: demoBacktrace,
    hookLibc: demoHookLibc,
    listExports: demoListExports,
    scanPattern: demoScanPattern,
    listModules: demoListModules
  };

  let started = 0;
  Object.keys(map).forEach(function (k) {
    if (CONFIG.enable[k]) {
      try { map[k](); started++; } catch (e) { log('err', `${k}: ${e}`); }
    }
  });

  if (started === 0) {
    console.log('[i] 已加载 03_native_basic.js，未启用任何演示。');
    console.log('[i] 可用开关：' + Object.keys(map).join(', '));
    console.log('[i] 提示：先把 CONFIG.targetModule 改成真实 so 名，可先开 listModules 看看有哪些。');
  }
}

main();
