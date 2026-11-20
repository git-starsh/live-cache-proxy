#!/bin/bash
# 手动触发一次订阅更新（等同代理控制台「订阅 → 立即更新订阅」）
# 用法: ./update-proxy.sh
# 控制台设置了管理密码时：ADMIN_PASSWORD=你的密码 ./update-proxy.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$DIR/proxy-settings.json"
PORT=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('consolePort',8318))" "$SETTINGS" 2>/dev/null || echo 8318)

AUTH=()
if [ -n "${ADMIN_PASSWORD:-}" ]; then
  AUTH=(-u "admin:${ADMIN_PASSWORD}")
fi

echo "触发订阅更新（代理控制台端口 $PORT）…"
curl -sS -m 300 "${AUTH[@]}" -X POST \
  -H 'Content-Type: application/json' \
  --data '{"action":"updateSubscription"}' \
  "http://127.0.0.1:${PORT}/api/proxy/action"
echo
curl -sS -m 20 "${AUTH[@]}" "http://127.0.0.1:${PORT}/api/proxy/state" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);o=d["overview"];s=o["subscription"];print("节点数",len(o["names"]),"当前:",o["now"],"上次更新:",s["lastUpdate"],"错误:",s["error"])' \
  2>/dev/null || true
