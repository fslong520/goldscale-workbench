#!/usr/bin/env bash
# 金秤双进程启动：金秤主服务（默认 8787）+ agent 常驻宿主 agentd（默认 8788）
#
# 两个进程互不隶属：金秤重启杀不着 agent 会话；agentd 反过来盯着金秤，
# 三次探不通就把它拉起来。各自 nohup、各自日志（goldscale.log / agentd.log）。
#
# 用法：./start-all.sh [金秤端口]
#   agentd 端口用 GOLDSCALE_AGENTD_PORT 覆盖；只启金秤用 ./run.sh（前台）

set -u

PORT="${1:-8787}"
APORT="${GOLDSCALE_AGENTD_PORT:-8788}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 端口占用探测：ss 优先，lsof 兜底（拿不到就返回空）
port_pid() {
  local p="$1" pid
  pid=$(ss -ltnpH "sport = :$p" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)
  [ -z "$pid" ] && pid=$(lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | head -1)
  printf '%s' "$pid"
}

# 构建产物同步到项目根；被运行中的进程占着就跳过（不致命）
sync_bin() {
  local name="$1"
  [ -x "target/release/$name" ] || return 0
  if ! cp -f "target/release/$name" "./$name" 2>/dev/null; then
    echo "提示：$name 被运行中的进程占用，二进制未更新（先停进程再同步）"
  fi
}

sync_bin goldscale
sync_bin goldscale-agentd

if [ ! -x "$DIR/goldscale" ]; then
  echo "未找到可执行文件 goldscale，请先： cargo build --release"
  exit 1
fi
if [ ! -x "$DIR/goldscale-agentd" ]; then
  echo "未找到可执行文件 goldscale-agentd，请先： cargo build --release"
  exit 1
fi

# 1) 金秤主服务（端口被占则跳过，绝不擅杀别人的进程）
held="$(port_pid "$PORT")"
if [ -n "$held" ]; then
  echo "金秤端口 $PORT 已被 pid $held 占用，跳过拉起"
else
  echo "拉起金秤 http://127.0.0.1:${PORT}（日志 goldscale.log）"
  PORT="$PORT" nohup ./goldscale >> goldscale.log 2>&1 &
fi

# 等金秤起来（最多 10 秒），好让 agentd 启动日志报的是真实状态
for _ in $(seq 1 20); do
  curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

# 2) agent 常驻宿主
held="$(port_pid "$APORT")"
if [ -n "$held" ]; then
  echo "agentd 端口 $APORT 已被 pid $held 占用，跳过拉起"
else
  echo "拉起 agentd http://127.0.0.1:${APORT}（日志 agentd.log）"
  GOLDSCALE_PORT="$PORT" nohup ./goldscale-agentd >> agentd.log 2>&1 &
fi

sleep 1

echo
echo "健康检查："
echo "  金秤   http://127.0.0.1:${PORT}/api/health      $(curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" || echo 不可达)"
echo "  agentd http://127.0.0.1:${APORT}/api/agent/health $(curl -s -m 2 "http://127.0.0.1:${APORT}/api/agent/health" || echo 不可达)"
echo
echo "浏览器打开: http://127.0.0.1:${PORT}"
