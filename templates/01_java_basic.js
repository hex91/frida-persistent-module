/*
 * ============================================================================
 *  01_java_basic.js —— Frida Java 层 Hook 基础模板（速查版）
 * ============================================================================
 *
 *  适配版本：Frida 17.5.2 / Android 15 / arm64（Pixel 6 实测通过）
 *  依赖    ：需要 Java bridge。frida CLI 自带；用 Python 加载请配合 run_template.py
 *
 *  加载方式（三种任选）：
 *    1) 推荐  python run_template.py --js 01_java_basic.js -f com.example.app
 *    2) CLI   frida -H 127.0.0.1:39527 -f com.example.app -l 01_java_basic.js
 *    3) 已附加 frida -H 127.0.0.1:39527 -n com.example.app -l 01_java_basic.js
 *
 *  ⚠️ Frida 17 破坏性变更（旧脚本会报错的点）：
 *      Module.getBaseAddress('libx.so')        → Process.getModuleByName('libx.so').base
 *      Module.findExportByName('libx.so','fn') → Process.getModuleByName('libx.so').findExportByName('fn')
 *      Module.findExportByName(null,'fn')      → Module.findGlobalExportByName('fn')
 *      Memory.readU32(p)                       → p.readU32()
 *      Process.enumerateModules({onMatch})     → for (const m of Process.enumerateModules())
 *
 *  使用步骤：
 *     ① 改 CONFIG 里的「目标类 / 方法名」
 *     ② 把 CONFIG.enable 下对应演示改成 true
 *     ③ 重新加载脚本
 *
 *  说明：本文件所有演示默认关闭，加载后不会 hook 任何东西，只会打印提示。
 * ============================================================================
 */

'use strict';

// ============================================================================
// 配置区：只改这里
// ============================================================================
const CONFIG = {
  // 目标类名（全限定名，内部类用 $，例如 com.x.Y$1）
  className: 'com.example.app.LoginActivity',
  // 目标方法名（构造方法写 $init）
  methodName: 'checkPassword',
  // 方法重载参数类型（不知道就留空数组 []，会 hook 全部重载）
  argTypes: [],

  // 逐项开关：改 true 即启用
  enable: {
    hookMethod: false,      // 1. 最简 hook：打印入参与返回值
    changeReturn: false,    // 2. 改返回值
    changeArgs: false,      // 3. 改入参
    hookCtor: false,        // 4. hook 构造方法
    readWriteField: false,  // 5. 读写字段
    findInstances: false,   // 6. 找内存中存活实例
    printStack: false,      // 7. 打印 Java 调用栈
    hookAllOverloads: false,// 8. 一次性 hook 所有重载
    callOrigin: false,      // 9. 调用原方法（不破坏逻辑）
    arrayAndCast: false,    // 10. 数组与类型转换
    enumClasses: false,     // 11. 枚举已加载的类（找类名用）
    multiClassLoader: false // 12. 多 ClassLoader 场景
  }
};

// ============================================================================
// 公共工具
// ============================================================================

/** 统一日志前缀，方便过滤 */
function log(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

/** 安全的 toString：对象/字节数组都能打印，不抛异常 */
function safeStr(v) {
  try {
    if (v === null || v === undefined) return String(v);
    if (v.$className !== undefined) return `<${v.$className}> ${v.toString()}`;
    return String(v);
  } catch (e) {
    return `<unprintable: ${e}>`;
  }
}

/** byte[] → hex，抓加解密数据必用 */
function bytesToHex(javaBytes) {
  try {
    const arr = Java.array('byte', javaBytes);
    let s = '';
    for (let i = 0; i < arr.length; i++) {
      s += ('0' + (arr[i] & 0xff).toString(16)).slice(-2);
    }
    return s;
  } catch (e) {
    return `<byte[] err: ${e}>`;
  }
}

// ============================================================================
// 1. 最简 hook：use → 定位重载 → implementation
//    这是 90% 场景的骨架，其他演示都是它的变体
// ============================================================================
function demoHookMethod() {
  Java.perform(function () {
    const Cls = Java.use(CONFIG.className);
    const m = CONFIG.argTypes.length
      ? Cls[CONFIG.methodName].overload.apply(Cls[CONFIG.methodName], CONFIG.argTypes)
      : Cls[CONFIG.methodName];

    m.implementation = function () {
      // arguments 就是调用方传入的原始参数
      const args = Array.prototype.slice.call(arguments).map(safeStr);
      log('call', `${CONFIG.methodName}(${args.join(', ')})`);

      // 调用原实现，拿到返回值
      const ret = m.call(this, ...arguments);

      log('ret', safeStr(ret));
      return ret; // 不返回会变成 undefined，业务可能崩
    };
    log('ok', `已 hook ${CONFIG.className}.${CONFIG.methodName}`);
  });
}

// ============================================================================
// 2. 改返回值：直接返回伪造值
//    典型用途：isVip() / isRooted() / checkSign() 恒真或恒假
//    ⚠️ 注意返回类型必须匹配，boolean 用 true，int 用 1，对象要返回合法实例
// ============================================================================
function demoChangeReturn() {
  Java.perform(function () {
    const Cls = Java.use(CONFIG.className);
    const m = Cls[CONFIG.methodName];

    m.implementation = function () {
      const origin = m.call(this, ...arguments);
      log('origin', safeStr(origin));
      // 按原类型伪造返回值
      if (typeof origin === 'boolean') return true;   // 恒真
      if (typeof origin === 'number') return 1;       // 恒 1
      if (typeof origin === 'string') return 'ok';    // 替换字符串
      return origin;                                   // 其他类型先透传
    };
    log('ok', `已接管 ${CONFIG.methodName} 的返回值`);
  });
}

// ============================================================================
// 3. 改入参：args[i].value 赋值
//    注意：Java 层基本类型会装箱，改值直接赋 JS 原生值即可
// ============================================================================
function demoChangeArgs() {
  Java.perform(function () {
    const Cls = Java.use(CONFIG.className);
    const m = Cls[CONFIG.methodName];

    m.implementation = function () {
      // 例：把第 1 个字符串参数替换掉
      if (arguments.length > 0 && typeof arguments[0] === 'string') {
        log('arg0', `原值=${arguments[0]}`);
        arguments[0] = 'tampered';   // 直接改 arguments 即可生效
      }
      return m.call(this, ...arguments);
    };
    log('ok', '已 hook 入参');
  });
}

// ============================================================================
// 4. hook 构造方法：名字固定为 $init
//    常见于抓「某个对象被创建时带了什么参数」
// ============================================================================
function demoHookCtor() {
  Java.perform(function () {
    const Cls = Java.use(CONFIG.className);
    Cls.$init.overloads.forEach(function (ctor) {
      ctor.implementation = function () {
        const args = Array.prototype.slice.call(arguments).map(safeStr);
        // 在构造前打印，此时对象还没初始化完，不要读字段
        log('new', `${CONFIG.className}(${args.join(', ')})`);
        return ctor.call(this, ...arguments);
      };
    });
    log('ok', `已 hook 构造方法（${Cls.$init.overloads.length} 个重载）`);
  });
}

// ============================================================================
// 5. 读写字段
//    实例字段：this.field.value；静态字段：Cls.field.value
// ============================================================================
function demoReadWriteField() {
  Java.perform(function () {
    const Cls = Java.use(CONFIG.className);
    const F = 'mFieldName'; // ← 改成真实字段名

    // 静态字段：直接读写
    try {
      log('static', `原值=${safeStr(Cls[F].value)}`);
      Cls[F].value = 1; // 按真实类型赋
      log('static', `新值=${safeStr(Cls[F].value)}`);
    } catch (e) {
      log('warn', `静态字段读取失败（可能不是静态）: ${e}`);
    }

    // 实例字段：任意方法里通过 this 读写
    const m = Cls[CONFIG.methodName];
    m.implementation = function () {
      try {
        log('field', `this.${F} = ${safeStr(this[F].value)}`);
        // this[F].value = <新值>;
      } catch (e) {}
      return m.call(this, ...arguments);
    };
    log('ok', '已挂字段读取');
  });
}

// ============================================================================
// 6. 找内存中存活实例：Java.choose
//    适合「没有现成调用可 hook，但对象已经存在」的场景
// ============================================================================
function demoFindInstances() {
  Java.perform(function () {
    let count = 0;
    Java.choose(CONFIG.className, {
      onMatch: function (instance) {
        count++;
        log('found', `#${count} ${safeStr(instance)}`);
        // 这里可以直接调实例方法、读字段
      },
      onComplete: function () {
        log('done', `共找到 ${count} 个实例`);
      }
    });
  });
}

// ============================================================================
// 7. 打印 Java 调用栈
//    定位「这个方法是谁调的」最快的手段
// ============================================================================
function demoPrintStack() {
  Java.perform(function () {
    const Throwable = Java.use('java.lang.Throwable');
    const Log = Java.use('android.util.Log');

    const m = Java.use(CONFIG.className)[CONFIG.methodName];
    m.implementation = function () {
      // getStackTraceString 比自己拼 StackTraceElement 干净
      const stack = Log.getStackTraceString(Throwable.$new());
      log('stack', `\n${stack}`);
      return m.call(this, ...arguments);
    };
    log('ok', '已挂调用栈打印');
  });
}

// ============================================================================
// 8. 一次性 hook 某个类的所有重载
//    overloads 是数组，每个元素都要单独设置 implementation
// ============================================================================
function demoHookAllOverloads() {
  Java.perform(function () {
    const Cls = Java.use(CONFIG.className);
    const fn = Cls[CONFIG.methodName];
    if (!fn || !fn.overloads) {
      log('warn', `${CONFIG.methodName} 不是方法或不存在`);
      return;
    }
    fn.overloads.forEach(function (ov) {
      ov.implementation = function () {
        log('call', `${CONFIG.methodName} args=${arguments.length}`);
        return ov.call(this, ...arguments);
      };
    });
    log('ok', `已 hook ${fn.overloads.length} 个重载`);
  });
}

// ============================================================================
// 9. 不破坏原逻辑地观察（透传）
//    关键点：一定要 return 原方法结果，否则调用链断裂
// ============================================================================
function demoCallOrigin() {
  Java.perform(function () {
    const m = Java.use(CONFIG.className)[CONFIG.methodName];
    m.implementation = function () {
      const t0 = Date.now();
      const ret = m.call(this, ...arguments); // 先执行原逻辑
      const cost = Date.now() - t0;
      log('perf', `${CONFIG.methodName} 耗时 ${cost}ms, ret=${safeStr(ret)}`);
      return ret;
    };
    log('ok', '已挂耗时统计');
  });
}

// ============================================================================
// 10. 数组与类型转换
//    Java.array 造数组；Java.cast 做向上/向下转型
// ============================================================================
function demoArrayAndCast() {
  Java.perform(function () {
    // 造一个 byte 数组
    const b = Java.array('byte', [0x41, 0x42, 0x43]);
    log('array', `byte[] len=${b.length} hex=${bytesToHex(b)}`);

    // 造一个字符串数组
    const s = Java.array('java.lang.String', ['a', 'b']);
    log('array', `String[] len=${s.length}`);

    // 类型转换：把 Object 转成具体类型再调方法
    try {
      const Context = Java.use('android.content.Context');
      const ActivityThread = Java.use('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      const ctx = Java.cast(app.getApplicationContext(), Context);
      log('cast', `packageName=${ctx.getPackageName()}`);
    } catch (e) {
      log('warn', `cast 演示失败: ${e}`);
    }
  });
}

// ============================================================================
// 11. 枚举已加载的类（不知道类名时用来搜）
//    按关键字过滤，避免刷屏
// ============================================================================
function demoEnumClasses() {
  const keyword = 'login'; // ← 改成你要搜的关键字（不区分大小写）
  Java.perform(function () {
    const hits = [];
    Java.enumerateLoadedClasses({
      onMatch: function (name) {
        if (name.toLowerCase().indexOf(keyword.toLowerCase()) !== -1) hits.push(name);
      },
      onComplete: function () {
        log('enum', `匹配 "${keyword}" 的类共 ${hits.length} 个`);
        hits.slice(0, 50).forEach(function (n) { console.log('  ' + n); });
        if (hits.length > 50) log('enum', `... 其余 ${hits.length - 50} 个已省略`);
      }
    });
  });
}

// ============================================================================
// 12. 多 ClassLoader 场景
//    现象：Java.use 报 ClassNotFoundException，但类确实存在
//    原因：类被动态加载在别的 DexClassLoader 里
// ============================================================================
function demoMultiClassLoader() {
  Java.perform(function () {
    const loaders = Java.enumerateClassLoadersSync();
    log('loader', `共 ${loaders.length} 个 ClassLoader`);

    // 方式一：枚举所有 loader 逐个尝试（frida 17 仍支持 loadClass）
    let found = null;
    for (let i = 0; i < loaders.length; i++) {
      try {
        const c = loaders[i].loadClass(CONFIG.className);
        if (c) { found = loaders[i]; break; }
      } catch (e) {}
    }
    if (found) {
      // 关键：用 ClassFactory 绑定该 loader，之后 Java.use 才认识这个类
      Java.classFactory.loader = found;
      log('loader', `已切换到命中 loader，现在可以 Java.use('${CONFIG.className}')`);
    } else {
      log('warn', `所有 loader 都找不到 ${CONFIG.className}`);
    }
  });
}

// ============================================================================
// 入口
// ============================================================================
function main() {
  if (typeof Java === 'undefined') {
    console.log('[!] 当前环境没有 Java bridge。');
    console.log('    → 用 frida CLI 加载，或用 run_template.py（会自动注入 bridge）');
    return;
  }
  if (!Java.available) {
    console.log('[!] 目标进程不是 Java 进程（Java.available=false），本文件不适用');
    return;
  }

  const c = CONFIG.enable;
  const map = {
    hookMethod: demoHookMethod,
    changeReturn: demoChangeReturn,
    changeArgs: demoChangeArgs,
    hookCtor: demoHookCtor,
    readWriteField: demoReadWriteField,
    findInstances: demoFindInstances,
    printStack: demoPrintStack,
    hookAllOverloads: demoHookAllOverloads,
    callOrigin: demoCallOrigin,
    arrayAndCast: demoArrayAndCast,
    enumClasses: demoEnumClasses,
    multiClassLoader: demoMultiClassLoader
  };

  Java.perform(function () {
    let started = 0;
    Object.keys(map).forEach(function (k) {
      if (c[k]) { map[k](); started++; }
    });
    if (started === 0) {
      console.log('[i] 已加载 01_java_basic.js，但未启用任何演示。');
      console.log('[i] 可用开关：' + Object.keys(map).join(', '));
      console.log('[i] 把 CONFIG.enable 里对应项改成 true 即可生效。');
    }
  });
}

main();
