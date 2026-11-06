#!/system/bin/sh
# frida 模块配置助手 — 端口 / 进程名 / 模块显示名 / 显示版本
#
# 用法（无参数 = 查看当前配置和用法）：
#   su -c 'sh /data/adb/modules/frida_patched_server/set_config.sh'
#
#   su -c 'sh .../set_config.sh 39527 sysmon'          改端口 + 进程名（立即生效）
#   su -c 'sh .../set_config.sh name "System Monitor"'  改模块列表显示名
#   su -c 'sh .../set_config.sh version "1.6.0" 10600'  改模块列表显示版本（第二个参数可省）
#   su -c 'sh .../set_config.sh restart'                按当前配置重启 frida-server
#   su -c 'sh .../set_config.sh status'                 只看运行状态（多行，给人看）
#   su -c 'sh .../set_config.sh off'                    关闭开机自启（保留模块）
#   su -c 'sh .../set_config.sh on'                     重新开启开机自启
#
# 供 WebUI 调用的机器接口（输出恒为一行 key=value，见 README）：
#   .../set_config.sh status1                           当前状态，一行
#   .../set_config.sh apply <端口> <进程名>              异步应用（立即返回，结果写 job 文件）
#   .../set_config.sh job                               读取 apply 的进度/结果（一行）
#   .../set_config.sh on | off                          自启开关，末行为结果
#
# 为什么要有 status1 / apply：
#   SukiSU / KernelSU 的 WebUI 桥接 ksu.exec(cmd) 是「同步返回 stdout 的最后一行」，
#   多行输出只有最后一行能拿到，且命令执行期间 WebView 主线程被阻塞。
#   所以 WebUI 侧的命令必须：① 单行输出 ② 足够快；耗时操作丢到后台任务再轮询。

MODDIR=${0%/*}
CONFIG="$MODDIR/config.sh"
PERSIST=/data/adb/frida_module.conf
LOG=/data/local/tmp/frida_patched.log
JOBFILE=/data/local/tmp/frida_webui_job.status

# config.sh 缺失时：优先用模块目录外的持久化备份，其次出厂模板
# （模块被重装/目录被清空后仍能恢复原来的端口与进程名）
if [ ! -f "$CONFIG" ]; then
  if [ -f "$PERSIST" ]; then
    cp "$PERSIST" "$CONFIG" 2>/dev/null
  elif [ -f "$MODDIR/config.default.sh" ]; then
    cp "$MODDIR/config.default.sh" "$CONFIG" 2>/dev/null
  fi
  chmod 600 "$CONFIG" 2>/dev/null
fi

[ -f "$CONFIG" ] && . "$CONFIG"
# 首次运行且还没有备份时补一份
[ -f "$CONFIG" ] && [ ! -f "$PERSIST" ] && { cp "$CONFIG" "$PERSIST" 2>/dev/null; chmod 600 "$PERSIST" 2>/dev/null; }
[ -z "$PORT" ]             && PORT=27042
[ -z "$BIN_NAME" ]         && BIN_NAME=frida-server
[ -z "$MOD_NAME" ]         && MOD_NAME="System Monitor"
[ -z "$MOD_VERSION" ]      && MOD_VERSION="1.6.0"
[ -z "$MOD_VERSION_CODE" ] && MOD_VERSION_CODE=10600

# ---------- 工具函数 ----------
# 写后台任务状态（永远只保留一行，WebUI 用 cat 读最后一行）
job() {
  printf '%s\n' "$1" > "$JOBFILE" 2>/dev/null
}

# 写进单行协议的字段值里不能有 ; 和换行
one() {
  printf '%s' "$1" | tr ';\r\n' ',,,'
}

# 安全地改 config.sh 里的一个 key（保留其它行和注释）
set_kv() {
  _k="$1"
  _v=$(printf '%s' "$2" | tr -d '"')
  _tmp="$CONFIG.tmp.$$"
  if [ -f "$CONFIG" ]; then
    grep -v "^$_k=" "$CONFIG" > "$_tmp" 2>/dev/null
  else
    : > "$_tmp"
  fi
  printf '%s="%s"\n' "$_k" "$_v" >> "$_tmp"
  # 用 cat > 覆盖，保留 SELinux 上下文
  cat "$_tmp" > "$CONFIG"
  rm -f "$_tmp"
  # 同步到模块目录之外的备份，重装模块后可从备份恢复
  cp "$CONFIG" "$PERSIST" 2>/dev/null && chmod 600 "$PERSIST" 2>/dev/null
}

# 本模块自己拉起的 server 的 pid。
# 关键：不能只用 pidof —— 进程名可能和系统守护进程重名（如 netd / logd / vold），
# pidof 会先返回系统那个，导致"误判已在运行"而根本不启动。这里用 cmdline 路径精确判定。
server_pid() {
  _target="$MODDIR/$BIN_NAME"
  for _cpid in $(pidof "$BIN_NAME" 2>/dev/null); do
    _cc=$(tr '\0' ' ' < "/proc/$_cpid/cmdline" 2>/dev/null)
    case "$_cc" in
      "$_target"|"$_target "*) printf '%s' "$_cpid"; return 0 ;;
    esac
  done
  return 1
}

# 端口是否在监听（$1 缺省用当前 PORT）
is_listen() {
  _lp="$1"
  [ -z "$_lp" ] && _lp="$PORT"
  netstat -tln 2>/dev/null | grep -q ":$_lp "
}

# 进程名是否与系统程序重名（重名会让 ps 里出现两个同名进程，反而更可疑）
name_collides() {
  [ -x "/system/bin/$1" ] || [ -x "/system/xbin/$1" ]
}

# 杀掉本模块拉起的所有 server 实例
# 实现要点：不要 for /proc/N/cmdline 逐个 cat —— 700+ 进程每个都要 fork 一次
# cat + tr，实测要 15 秒。改成一条 `ls -l /proc/*/exe` 由 ls 自己 readlink，
# 再一次 awk 过滤，约 100ms。
kill_all_servers() {
  _pids=$(ls -l /proc/[0-9]*/exe 2>/dev/null | awk -v pre="$MODDIR/" '
    {
      if ($0 !~ / -> /) next
      t = $0; sub(/^.* -> /, "", t)
      if (index(t, pre) != 1) next
      p = $0; sub(/^.*\/proc\//, "", p); sub(/\/exe.*$/, "", p)
      if (p ~ /^[0-9]+$/) print p
    }')
  _pids=$(printf '%s' "$_pids" | tr '\n' ' ')
  [ -z "$_pids" ] && return 0
  kill $_pids 2>/dev/null
  # 快速轮询退出（0.2s × 10 = 2s），不要一上来就 sleep 1 干等
  _i=0
  while [ "$_i" -lt 10 ]; do
    _dead=1
    for _p in $_pids; do
      [ -d "/proc/$_p" ] && _dead=0
    done
    [ "$_dead" = "1" ] && return 0
    sleep 0.2
    _i=$((_i + 1))
  done
  kill -9 $_pids 2>/dev/null
  sleep 0.3
}

# 等新 server 就绪：进程存在且端口监听，最长 20 秒
# （52MB 补丁版二进制冷启动 + 校验需要几秒，窗口给小了会误报"未监听"）
wait_ready() {
  _wp="$1"
  _i=0
  while [ "$_i" -lt 40 ]; do
    if [ -n "$(server_pid)" ] && is_listen "$_wp"; then
      return 0
    fi
    sleep 0.5
    _i=$((_i + 1))
  done
  return 1
}

# 立即启动（跳过开机的 boot_completed 等待与 sleep 10）
start_server() {
  FRIDA_START_NOW=1 sh "$MODDIR/service.sh" >/dev/null 2>&1
}

restart_server() {
  echo "[*] 停止旧实例..."
  kill_all_servers
  echo "[*] 按配置启动: $BIN_NAME @ 127.0.0.1:$PORT"
  start_server
  if wait_ready "$PORT"; then
    PID=$(server_pid)
    echo ""
    echo "=== 生效 ==="
    echo "进程: $BIN_NAME (pid ${PID:-?})"
    echo "端口: 127.0.0.1:$PORT 监听中"
    echo "PC 端: adb forward tcp:$PORT tcp:$PORT"
    echo "OK;rc=0;bin=$BIN_NAME;port=$PORT;pid=${PID:-0};listen=1"
  else
    echo ""
    echo "=== 未就绪，查日志: cat $LOG ==="
    tail -5 "$LOG" 2>/dev/null
    echo "ERR;rc=1;msg=启动后未监听，请查看日志"
  fi
}

show() {
  echo "=== 当前配置（config.sh）==="
  cat "$CONFIG" 2>/dev/null || echo "(config.sh 不存在，使用默认值)"
  echo ""
  echo "=== 模块列表显示（module.prop）==="
  grep -E '^(id|name|version|versionCode|description)=' "$MODDIR/module.prop" 2>/dev/null
  echo ""
  echo "=== 运行中的实例 ==="
  for p in $(ls -l /proc/[0-9]*/exe 2>/dev/null | awk -v pre="$MODDIR/" '
      {
        if ($0 !~ / -> /) next
        t = $0; sub(/^.* -> /, "", t)
        if (index(t, pre) != 1) next
        q = $0; sub(/^.*\/proc\//, "", q); sub(/\/exe.*$/, "", q)
        if (q ~ /^[0-9]+$/) print q
      }'); do
    echo "  pid $p: $(cat /proc/$p/cmdline 2>/dev/null | tr '\0' ' ')"
  done
  echo ""
  echo "=== 用法 ==="
  echo "图形化      : 管理器模块页 → WebUI（推荐，无需命令）"
  echo "改端口/进程名: su -c 'sh $MODDIR/set_config.sh <端口> <进程名>'"
  echo "              例: su -c 'sh $MODDIR/set_config.sh 39527 sysmon'"
  echo "改显示名    : su -c 'sh $MODDIR/set_config.sh name \"System Monitor\"'"
  echo "改显示版本  : su -c 'sh $MODDIR/set_config.sh version \"1.5.0\" 10500'"
  echo "仅重启      : su -c 'sh $MODDIR/set_config.sh restart'"
  echo "开机自启    : su -c 'sh $MODDIR/set_config.sh on|off'"
  echo ""
  echo "提示: 改完若模块列表没刷新，下拉刷新或退出重进管理器。"
}

# 一行状态（WebUI 用）：OK;bin=..;port=..;pid=..;listen=..;auto=..;...
status_line() {
  PID=$(server_pid)
  LISTEN=0
  is_listen "$PORT" && LISTEN=1
  AUTO=1
  [ -f "$MODDIR/noautostart" ] && AUTO=0
  COLL=0
  name_collides "$BIN_NAME" && COLL=1
  UP=0
  if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then
    _ux=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
    _sx=$(awk '{print int($22/100)}' "/proc/$PID/stat" 2>/dev/null)
    if [ -n "$_ux" ] && [ -n "$_sx" ]; then
      UP=$((_ux - _sx))
      [ "$UP" -lt 0 ] && UP=0
    fi
  fi
  echo "OK;bin=$(one "$BIN_NAME");port=$(one "$PORT");pid=${PID:-0};listen=$LISTEN;auto=$AUTO;coll=$COLL;name=$(one "$MOD_NAME");ver=$(one "$MOD_VERSION");code=$(one "$MOD_VERSION_CODE");up=$UP"
}

# 多行状态（给人看 / 脚本 grep）
status_compact() {
  PID=$(server_pid)
  LISTEN=0
  is_listen "$PORT" && LISTEN=1
  AUTO=1
  [ -f "$MODDIR/noautostart" ] && AUTO=0
  echo "BIN_NAME=$BIN_NAME"
  echo "PORT=$PORT"
  echo "PID=${PID:-0}"
  echo "LISTEN=$LISTEN"
  echo "AUTOSTART=$AUTO"
  echo "MOD_NAME=$MOD_NAME"
  echo "MOD_VERSION=$MOD_VERSION"
  echo "MOD_VERSION_CODE=$MOD_VERSION_CODE"
  if [ -n "$PID" ] && [ -r "/proc/$PID/stat" ]; then
    UP=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)
    ST=$(awk '{print int($22/100)}' "/proc/$PID/stat" 2>/dev/null)
    [ -n "$UP" ] && [ -n "$ST" ] && echo "UPTIME=$((UP - ST))"
  fi
}

# ---------- 无参数：查看 ----------
if [ $# -eq 0 ]; then
  show
  exit 0
fi

# ---------- 子命令 ----------
case "$1" in
  restart)
    restart_server
    exit 0
    ;;

  name)
    shift
    NEW_NAME=$(printf '%s' "$*" | tr -d '"')
    if [ -z "$NEW_NAME" ]; then
      echo "错误: 名字不能为空。例: set_config.sh name \"System Monitor\""
      echo "ERR;rc=1;msg=显示名不能为空"
      exit 1
    fi
    set_kv MOD_NAME "$NEW_NAME"
    echo "[*] 模块显示名 -> $NEW_NAME"
    sh "$MODDIR/sync_prop.sh" >/dev/null 2>&1
    echo "[!] 管理器里下拉刷新（或退出重进）即可看到新名字。"
    echo "OK;rc=0;name=$(one "$NEW_NAME");ver=$(one "$MOD_VERSION");code=$(one "$MOD_VERSION_CODE")"
    exit 0
    ;;

  version)
    shift
    NEW_VER=$(printf '%s' "$1" | tr -d '"')
    NEW_CODE="$2"
    if [ -z "$NEW_VER" ]; then
      echo "错误: 版本号不能为空。例: set_config.sh version \"1.4.2\" 10402"
      echo "ERR;rc=1;msg=版本号不能为空"
      exit 1
    fi
    if [ -n "$NEW_CODE" ]; then
      case "$NEW_CODE" in
        *[!0-9]*) echo "错误: versionCode 必须是纯数字"; echo "ERR;rc=1;msg=versionCode 必须是纯数字"; exit 1 ;;
      esac
    fi
    set_kv MOD_VERSION "$NEW_VER"
    [ -n "$NEW_CODE" ] && set_kv MOD_VERSION_CODE "$NEW_CODE"
    echo "[*] 模块版本 -> $NEW_VER ${NEW_CODE:+($NEW_CODE)}"
    sh "$MODDIR/sync_prop.sh" >/dev/null 2>&1
    echo "[!] 管理器里下拉刷新（或退出重进）即可看到新版本。"
    echo "OK;rc=0;name=$(one "$MOD_NAME");ver=$(one "$NEW_VER");code=$(one "${NEW_CODE:-$MOD_VERSION_CODE}")"
    exit 0
    ;;

  status)
    status_compact
    exit 0
    ;;

  status1)
    status_line
    exit 0
    ;;

  job)
    if [ -f "$JOBFILE" ]; then
      tail -1 "$JOBFILE" 2>/dev/null
    else
      echo "NONE"
    fi
    exit 0
    ;;

  off)
    : > "$MODDIR/noautostart"
    chmod 644 "$MODDIR/noautostart"
    PID=$(server_pid)
    echo "[*] 已关闭开机自启（当前实例仍在运行，重启后不会再自动启动）"
    echo "    重新开启: sh $MODDIR/set_config.sh on"
    echo "OK;rc=0;auto=0;run=$([ -n "$PID" ] && echo 1 || echo 0)"
    exit 0
    ;;

  on)
    rm -f "$MODDIR/noautostart"
    PID=$(server_pid)
    echo "[*] 已开启开机自启（下次开机自动启动）"
    [ -z "$PID" ] && echo "    当前未运行，执行 set_config.sh restart 或点 WebUI 的「应用并重启」立即启动"
    echo "OK;rc=0;auto=1;run=$([ -n "$PID" ] && echo 1 || echo 0)"
    exit 0
    ;;

  apply)
    # WebUI 用的异步入口：校验 → 写配置 → 后台任务执行重启 → 立即返回
    A_PORT="$2"
    A_BIN="$3"
    case "$A_PORT" in
      ''|*[!0-9]*) echo "ERR;rc=1;msg=端口必须是纯数字"; exit 1 ;;
    esac
    if [ "$A_PORT" -lt 1024 ] || [ "$A_PORT" -gt 65535 ]; then
      echo "ERR;rc=1;msg=端口需在 1024-65535 之间"; exit 1
    fi
    A_LEN=$(printf '%s' "$A_BIN" | wc -c)
    if [ -z "$A_BIN" ] || [ "$A_LEN" -gt 15 ]; then
      echo "ERR;rc=1;msg=进程名不能为空且不超过 15 字符"; exit 1
    fi
    case "$A_BIN" in
      *[!a-zA-Z0-9._-]*) echo "ERR;rc=1;msg=进程名只允许字母/数字/._-"; exit 1 ;;
    esac
    if [ "$A_PORT" != "$PORT" ] && is_listen "$A_PORT"; then
      echo "ERR;rc=1;msg=端口 $A_PORT 已被占用"; exit 1
    fi
    A_OLD="$BIN_NAME"
    echo "[*] 写入配置: PORT=$A_PORT BIN_NAME=$A_BIN"
    set_kv PORT "$A_PORT"
    set_kv BIN_NAME "$A_BIN"
    sh "$MODDIR/sync_prop.sh" >/dev/null 2>&1
    job "RUN;msg=已接收，准备重启"
    setsid sh "$MODDIR/set_config.sh" __apply "$A_PORT" "$A_BIN" "$A_OLD" >/dev/null 2>&1 < /dev/null &
    echo "OK;rc=0;msg=已开始应用"
    exit 0
    ;;

  __apply)
    # 后台任务：真正重启，把进度写进 job 文件
    B_PORT="$2"
    B_BIN="$3"
    B_OLD="$4"
    PORT="$B_PORT"
    BIN_NAME="$B_BIN"
    job "RUN;msg=停止旧实例"
    kill_all_servers
    job "RUN;msg=启动 $BIN_NAME @ 127.0.0.1:$PORT"
    start_server
    if wait_ready "$PORT"; then
      PID=$(server_pid)
      job "READY;msg=已生效;bin=$BIN_NAME;port=$PORT;pid=${PID:-0}"
      # 清理旧进程名留下的副本（母本 frida-server 永不删除）
      if [ -n "$B_OLD" ] && [ "$B_OLD" != "$B_BIN" ] && [ "$B_OLD" != "frida-server" ] && [ -f "$MODDIR/$B_OLD" ]; then
        rm -f "$MODDIR/$B_OLD"
      fi
      job "DONE;rc=0;bin=$BIN_NAME;port=$PORT;pid=${PID:-0}"
    else
      job "FAIL;rc=1;msg=启动后 $PORT 未监听，请查看 $LOG"
    fi
    exit 0
    ;;
esac

# ---------- 位置参数：<端口> <进程名> ----------
if [ $# -lt 2 ]; then
  echo "参数不足。无参数运行可查看用法。"
  echo "ERR;rc=1;msg=参数不足"
  exit 1
fi

NEW_PORT="$1"
NEW_BIN="$2"

# 端口校验
case "$NEW_PORT" in
  ''|*[!0-9]*) echo "错误: 端口必须是纯数字，收到 '$NEW_PORT'"; echo "ERR;rc=1;msg=端口必须是纯数字"; exit 1 ;;
esac
if [ "$NEW_PORT" -lt 1024 ] || [ "$NEW_PORT" -gt 65535 ]; then
  echo "错误: 端口需在 1024-65535 之间"
  echo "ERR;rc=1;msg=端口需在 1024-65535 之间"
  exit 1
fi

# 进程名校验（Linux comm 上限 15 字符）
NAMELEN=$(printf '%s' "$NEW_BIN" | wc -c)
if [ "$NAMELEN" -gt 15 ]; then
  echo "错误: 进程名超过 15 字符（当前 $NAMELEN，Linux 上限 15）"
  echo "ERR;rc=1;msg=进程名超过 15 字符"
  exit 1
fi
case "$NEW_BIN" in
  *[!a-zA-Z0-9._-]*) echo "错误: 进程名只允许字母/数字/._- ，收到 '$NEW_BIN'"; echo "ERR;rc=1;msg=进程名含非法字符"; exit 1 ;;
esac

# 与系统程序重名时警告（不阻止，但 pidof/ps 里会出现两个同名进程，更容易被注意到）
name_collides "$NEW_BIN" && echo "[!] 警告: 系统里已有 /system/bin/$NEW_BIN，重名进程可能更容易被检测。"

# 端口占用检查：新端口已被别的进程占用时直接拒绝（同端口即重启场景，跳过）
if [ "$NEW_PORT" != "$PORT" ] && is_listen "$NEW_PORT"; then
  echo "错误: 端口 $NEW_PORT 已被占用"
  netstat -tlnp 2>/dev/null | grep ":$NEW_PORT " | head -2
  echo "     换一个端口，或先停掉占用该端口的进程"
  echo "ERR;rc=1;msg=端口 $NEW_PORT 已被占用"
  exit 1
fi

# 记住旧进程名，切换成功后清理旧副本（否则每改一次名就多占 52MB）
OLD_BIN="$BIN_NAME"

echo "[*] 写入配置: PORT=$NEW_PORT BIN_NAME=$NEW_BIN"
set_kv PORT "$NEW_PORT"
set_kv BIN_NAME "$NEW_BIN"

echo "[*] 同步模块列表说明..."
sh "$MODDIR/sync_prop.sh" >/dev/null 2>&1

echo "[*] 停止所有旧实例..."
kill_all_servers

echo "[*] 按新配置启动..."
start_server

if wait_ready "$NEW_PORT"; then
  PID=$(server_pid)
  echo ""
  echo "=== 生效 ==="
  echo "进程: $NEW_BIN (pid ${PID:-?})"
  echo "端口: 127.0.0.1:$NEW_PORT 监听中"
  echo "PC 端: adb forward tcp:$NEW_PORT tcp:$NEW_PORT"
  echo ""
  echo "（模块列表里的说明已同步，下拉刷新可见）"
  RESULT="OK;rc=0;bin=$NEW_BIN;port=$NEW_PORT;pid=${PID:-0};listen=1"
else
  echo ""
  echo "=== 未就绪，查日志: cat $LOG ==="
  tail -5 "$LOG" 2>/dev/null
  RESULT="ERR;rc=1;msg=启动后未监听，请查看日志"
fi

# 清理旧进程名留下的副本（母本 frida-server 永不删除）
if [ -n "$OLD_BIN" ] && [ "$OLD_BIN" != "$NEW_BIN" ] && [ "$OLD_BIN" != "frida-server" ]; then
  if [ -f "$MODDIR/$OLD_BIN" ]; then
    rm -f "$MODDIR/$OLD_BIN"
    echo "（已删除旧进程名副本: $OLD_BIN）"
  fi
fi

echo "$RESULT"
