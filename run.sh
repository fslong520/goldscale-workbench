#!/usr/bin/env bash
# 金秤启动脚本
# 用法：./run.sh [端口]

set -e

PORT="${1:-8787}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -x "$DIR/goldscale" ]; then
  echo "未找到可执行文件 goldscale"
  echo "请先构建： cargo build --release && cp target/release/goldscale ."
  exit 1
fi

cd "$DIR"

echo "金秤启动中..."
echo "浏览器打开: http://127.0.0.1:${PORT}"
echo "按 Ctrl+C 停止"
echo

PORT="$PORT" "$DIR/goldscale"