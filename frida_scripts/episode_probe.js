// 黄果短剧 1.0.8 — 剧集解锁数据探测脚本（纯观察，不改写任何值）
// 目的：验证锁定剧集的 videoUrl 是否已随列表/详情下发到客户端
//   - 情况 A（URL 已下发）→ 服务端内容分发闸门缺失（安全漏洞结论成立）
//   - 情况 B（URL 为空/NULL）→ 服务端流级把守，客户端改动无意义
//
// 挂点（VideoModel::fromMap 内部 store 指令，静态汇编定位）:
//   0x677c00: stur w0, [x3, #0x87]  ; payType  (Smi int)
//   0x680f5c: stur w0, [x3, #0x2f]  ; videoUrl (String tagged ptr 或 NULL)

const OFF_STORE_PAYTYPE = 0x677c00;
const OFF_STORE_VIDEOURL = 0x680f58; // 0x680f5c 的 stur 无法被 frida 重定位，前移两条指令（x0/x3 语义相同）
const MAX_LOGS = 60;

function smiToInt(p) {
  const raw = parseInt(p.and(0xffffffff).toString(), 16); // frida 17 无 toNumber()，用 parseInt
  if ((raw & 1) === 0) return raw >> 1; // Smi: 值<<1
  return null; // 非 Smi
}

// Dart String 内部布局不精确解码，直接从对象头后读字节提取可打印 ASCII（URL 均为 ASCII）
function dumpAscii(p) {
  try {
    const buf = p.add(0x10).readByteArray(0x70);
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
      else if (out.length >= 4) break; // 连续可打印段结束
      else out = "";
    }
    return out;
  } catch (e) {
    return "(unreadable)";
  }
}

function hook() {
  const base = Process.findModuleByName("libapp.so").base;
  console.log("[*] libapp.so base = " + base);
  let payLogs = 0, urlLogs = 0;

  Interceptor.attach(base.add(OFF_STORE_PAYTYPE), {
    onEnter() {
      if (payLogs >= MAX_LOGS) return;
      const v = smiToInt(this.context.x0);
      if (v !== null && v !== 0) {
        payLogs++;
        console.log("[payType] = " + v + "  (model " + this.context.x3 + ")");
      }
    }
  });
  console.log("[*] hooked payType store @ " + base.add(OFF_STORE_PAYTYPE));

  Interceptor.attach(base.add(OFF_STORE_VIDEOURL), {
    onEnter() {
      if (urlLogs >= MAX_LOGS) return;
      const p = this.context.x0;
      const nullReg = this.context.x22;
      if (p.equals(nullReg)) {
        urlLogs++;
        console.log("[videoUrl] = NULL  (model " + this.context.x3 + ")");
      } else {
        urlLogs++;
        const s = dumpAscii(p);
        console.log("[videoUrl] = " + (s.length > 0 ? s : "(non-ascii/empty obj " + p + ")"));
      }
    }
  });
  console.log("[*] hooked videoUrl store @ " + base.add(OFF_STORE_VIDEOURL));
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
