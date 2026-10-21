#!/usr/bin/env bash
# 启动 Toonflow 服务（前台运行，Ctrl+C 停止）
# 后台运行：nohup ./start.sh > toonflow.log 2>&1 &
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export PATH="$HOME/.bun/bin:$PATH"
export NODE_ENV=production

if ! command -v bun >/dev/null 2>&1; then
  echo "未找到 Bun，请先安装 Bun 后再启动。" >&2
  exit 1
fi

if [ ! -f build/server/index.js ] || [ ! -f build/web/index.html ]; then
  echo "缺少构建产物，请先执行：BUN_OPTIONS=--bun bun run build:server" >&2
  exit 1
fi

exec bun run start:server
