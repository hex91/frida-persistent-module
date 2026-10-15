// 黄果短剧 1.0.8 — VIP 数据流观察脚本 v2（仅记录，不改写）
// 目标包: dark.rrJCm.PeeDN   Dart包: hgdj
//
// v2 变更（基于 17.5.2 补丁版 server + 静态汇编复核）:
//   - 旧 fromMap 返回值 hook（0x885394 onLeave）读到的 retval 是垃圾，弃用
//   - 改挂 fromMap 内部 isVip 的真实 store 指令:
//       0x8863f0: stur w0, [x3, #0x1f]   ; x0 = map["isVip"]（32位压缩值）, x3 = 模型对象(tagged)
//   - 首次命中时 dump x0..x28 寄存器快照（用于定位 NULL/HEAP/PP 寄存器，推导 true 编码）
//   - 消费函数返回值改为记录原始 hex（bool 全指针 = NULL+0x20/0x30，先看数据再分类）

const OFF_STORE_ISVIP = 0x8863f0;  // fromMap 内 StoreField isVip -> field_1f
const OFF_ISVIPCOINFREE = 0x9c47b4; // VideoLogic::isVipCoinFree
const OFF_ISVIPVIDEO = 0x9b507c;   // _ShortBuyMaskViewState::_isVipVideo

function regsSnapshot(ctx) {
  const lines = [];
  for (let i = 0; i <= 28; i++) {
    const r = ctx["x" + i];
    if (r !== undefined) lines.push("x" + i + "=" + r);
  }
  return lines.join(" ");
}

function hook() {
  const base = Process.findModuleByName("libapp.so").base;
  console.log("[*] libapp.so base = " + base);

  let snapped = false;

  // A) fromMap 内 isVip 写入点（函数中途指令，frida 会重定位，安全）
  Interceptor.attach(base.add(OFF_STORE_ISVIP), {
    onEnter() {
      const x0 = this.context.x0;
      const x3 = this.context.x3;
      const w0 = x0.and(0xffffffff);
      console.log("[isVip store] w0(raw) = 0x" + w0.toString(16) +
        " | model(x3) = " + x3 + " | x27 = " + this.context.x27);
      if (!snapped) {
        snapped = true;
        console.log("[regs dump] " + regsSnapshot(this.context));
      }
    }
  });
  console.log("[*] hooked isVip store @ " + base.add(OFF_STORE_ISVIP));

  // B) 消费函数返回值（全指针 bool，先记原始值）
  Interceptor.attach(base.add(OFF_ISVIPCOINFREE), {
    onLeave(retval) {
      console.log("[isVipCoinFree] retval = " + retval + " (0x" +
        retval.and(0xffffffff).toString(16) + ")");
    }
  });
  console.log("[*] hooked isVipCoinFree @ " + base.add(OFF_ISVIPCOINFREE));

  try {
    Interceptor.attach(base.add(OFF_ISVIPVIDEO), {
      onLeave(retval) {
        console.log("[_isVipVideo] retval = " + retval + " (0x" +
          retval.and(0xffffffff).toString(16) + ")");
      }
    });
    console.log("[*] hooked _isVipVideo @ " + base.add(OFF_ISVIPVIDEO));
  } catch (e) {
    console.log("[*] _isVipVideo hook 跳过: " + e);
  }
}

if (Process.findModuleByName("libapp.so")) {
  hook();
} else {
  console.log("[*] 等待 libapp.so 加载...");
  const t = setInterval(function () {
    if (Process.findModuleByName("libapp.so")) {
      clearInterval(t);
      hook();
    }
  }, 50);
}
