#!/system/bin/sh
# 把当前端口 / 进程名 / 修改方法写回 module.prop 的 description
# 供 SukiSU / KernelSU 管理器在模块卡片下方展示，避免忘记当前伪装配置
MODDIR=${0%/*}

PORT=27042
BIN_NAME=frida-server
if [ -f "$MODDIR/config.sh" ]; then
  . "$MODDIR/config.sh"
elif [ -f "$MODDIR/config.default.sh" ]; then
  . "$MODDIR/config.default.sh"
fi

DESC="当前端口 ${PORT} ・ 进程名 ${BIN_NAME} ｜ 修改: sh ${MODDIR}/set_config.sh <新端口> <新进程名>（立即生效）"

[ -f "$MODDIR/module.prop" ] || exit 0

# 用 awk 重写 description 行（避免 sed 分隔符与中文转义问题），原子替换
awk -v d="$DESC" 'BEGIN{FS=OFS="="} /^description=/{print "description=" d; next} {print}' \
  "$MODDIR/module.prop" > "$MODDIR/module.prop.tmp" 2>/dev/null \
  && mv "$MODDIR/module.prop.tmp" "$MODDIR/module.prop"
