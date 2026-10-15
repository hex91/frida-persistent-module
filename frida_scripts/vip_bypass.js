// 黄果短剧 1.0.8 — VIP bypass v2（精确版）
// 目标包: dark.rrJCm.PeeDN   Dart包: hgdj
//
// 原理（经运行时实测 + 静态汇编双重确认）:
//   fromMap 内 0x8863f0: stur w0, [x3, #0x1f]   ; isVip -> field_1f
//     x0 = map["isVip"] 全指针 tagged bool
//     x3 = UserInfoModel 对象（tagged）
//     x22 = Dart NULL 寄存器（实测 0x7000008081）
//   Dart AOT bool 立即数: true = NULL+0x20, false = NULL+0x30
//   字段为 32 位压缩指针存储（低 32 位 = 全指针 - 4GB对齐基址），
//   因此把 x0 替换成 true 全指针后，w32 store 自动写入正确压缩值。
//
// 验证信号:
//   [isVipCoinFree]/[_isVipVideo] 仅观察。bypass 生效后，它们从 globalStore
//   读到的 userInfo.isVip 应变为 true，返回值应从 NULL+0x30 变为 NULL+0x20。

const OFF_STORE_ISVIP = 0x8863f0;
const OFF_ISVIPCOINFREE = 0x9c47b4;
const OFF_ISVIPVIDEO = 0x9b507c;

function boolName(p) {
  // bool 全指针 = NULL+0x20/0x30；用相对差值分类，不依赖绝对地址
  const low = p.and(0xff).toString(16);
  return p + "(tail=0x" + low + ")";
}

function hook() {
  const base = Process.findModuleByName("libapp.so").base;
  console.log("[*] libapp.so base = " + base);

  // 核心 bypass: 服务端下发 isVip=false 时改写为 true
  Interceptor.attach(base.add(OFF_STORE_ISVIP), {
    onEnter() {
      const orig = this.context.x0;
      const nullReg = this.context.x22;
      const truePtr = nullReg.add(0x20);
      if (!orig.equals(truePtr)) {
        console.log("[bypass] isVip 原值 " + orig + " -> 改写 true (" + truePtr + ")");
      }
      this.context.x0 = truePtr;
    }
  });
  console.log("[*] bypass hook @ " + base.add(OFF_STORE_ISVIP));

  // 观察消费函数（不改写），验证 tamper 传导
  Interceptor.attach(base.add(OFF_ISVIPCOINFREE), {
    onLeave(retval) {
      console.log("[isVipCoinFree] retval = " + boolName(retval));
    }
  });

  try {
    Interceptor.attach(base.add(OFF_ISVIPVIDEO), {
      onLeave(retval) {
        console.log("[_isVipVideo] retval = " + boolName(retval));
      }
    });
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
