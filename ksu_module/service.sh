#!/system/bin/sh
# frida-server (sijan2 patched 17.5.2-android16) 开机自启 — v1.5
# 由 KernelSU / SukiSU / Magisk 在 late_start service 阶段以 root 执行
#
# 说明：
#   - 进程名伪装通过「二进制文件名」实现（进程 comm = 文件名，≤15 字符）
#   - 改名副本用硬链接生成：与母本共用同一份数据，不额外占用 52MB，启动也更快
#   - 关闭开机自启：在模块目录创建 noautostart 文件（不要用 disable，那是模块禁用标记）

MODDIR=${0%/*}

# 默认值（可被 config.sh 覆盖）
PORT=27042
BIN_NAME=frida-server
MOD_NAME="System Monitor"
MOD_VERSION="1.6.0"
MOD_VERSION_CODE=10600

# 用户配置不随模块升级丢失：config.sh 不在 zip 内，缺失时依次从
#   1) 持久化备份 /data/adb/frida_module.conf（模块目录被重装清空也能恢复）
#   2) 出厂模板 config.default.sh
# 播种
PERSIST=/data/adb/frida_module.conf
if [ ! -f "$MODDIR/config.sh" ]; then
  if [ -f "$PERSIST" ]; then
    cp "$PERSIST" "$MODDIR/config.sh" 2>/dev/null
  elif [ -f "$MODDIR/config.default.sh" ]; then
    cp "$MODDIR/config.default.sh" "$MODDIR/config.sh" 2>/dev/null
  fi
  chmod 600 "$MODDIR/config.sh" 2>/dev/null
fi
[ -f "$MODDIR/config.sh" ] && . "$MODDIR/config.sh"

# 备份一份到模块目录之外，重装/清目录后可恢复
[ -f "$MODDIR/config.sh" ] && [ ! -f "$PERSIST" ] && { cp "$MODDIR/config.sh" "$PERSIST" 2>/dev/null; chmod 600 "$PERSIST" 2>/dev/null; }

# 开机先把当前进程名/端口写进 module.prop，模块列表里直接可见
[ -f "$MODDIR/sync_prop.sh" ] && sh "$MODDIR/sync_prop.sh" >/dev/null 2>&1

(
  # FRIDA_START_NOW=1 表示"现在就要用"（WebUI/命令行 手动重启），跳过开机等待，秒起
  if [ "$FRIDA_START_NOW" != "1" ]; then
    # wait for boot complete
    until [ "$(getprop sys.boot_completed)" = "1" ]; do
      sleep 5
    done
    sleep 10
  fi

  # 自启开关：存在 noautostart 则跳过启动（不影响模块启用状态）
  # 手动重启（FRIDA_START_NOW=1）不受自启开关影响，否则关了自启就没法手动拉起了
  [ "$FRIDA_START_NOW" != "1" ] && [ -f "$MODDIR/noautostart" ] && exit 0

  MOTHER="$MODDIR/frida-server"
  LOG=/data/local/tmp/frida_patched.log

  # 进程名伪装：准备改名副本
  if [ "$BIN_NAME" != "frida-server" ]; then
    TARGET="$MODDIR/$BIN_NAME"
    need=1
    if [ -f "$TARGET" ]; then
      # 体积与母本一致即视为可用；母本被升级替换过则重建
      if [ "$(stat -c %s "$TARGET" 2>/dev/null)" = "$(stat -c %s "$MOTHER" 2>/dev/null)" ]; then
        need=0
      else
        rm -f "$TARGET"
      fi
    fi
    if [ "$need" = "1" ]; then
      ln "$MOTHER" "$TARGET" 2>/dev/null || cp "$MOTHER" "$TARGET" || exit 1
      chmod 755 "$TARGET" 2>/dev/null
    fi
  fi

  chmod 755 "$MOTHER" 2>/dev/null

  # avoid double-start
  # 注意：不能用 pidof 直接判定 —— 进程名可能和系统守护进程重名（netd/logd/vold…），
  # pidof 会命中系统那个，导致误判"已在运行"而永远不启动。
  # 这里先用 pidof 拿到同名候选（很快），再按 cmdline 里的完整路径确认是不是自己。
  TARGET_PATH="$MODDIR/$BIN_NAME"
  for cpid in $(pidof "$BIN_NAME" 2>/dev/null); do
    ccmd=$(cat "/proc/$cpid/cmdline" 2>/dev/null | tr '\0' ' ')
    case "$ccmd" in
      "$TARGET_PATH"|"$TARGET_PATH "*) exit 0 ;;
    esac
  done

  setsid "$MODDIR/$BIN_NAME" -l "127.0.0.1:$PORT" > "$LOG" 2>&1 < /dev/null &
) &
