#!/bin/bash
# 安装 systemd 服务：m3u-proxy（播放）+ m3u-proxy-console（代理控制台）
# 用法：bash install-service.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
[ -z "$NODE" ] && { echo "找不到 node，请先安装 Node.js"; exit 1; }

cat > /etc/systemd/system/m3u-proxy.service <<EOF
[Unit]
Description=M3U Live Buffer Proxy (playback)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/proxy.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PROXY_CONSOLE_URL=http://127.0.0.1:8318
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/m3u-proxy-console.service <<EOF
[Unit]
Description=M3U Proxy Console (mihomo / subscription / traffic)
After=network-online.target mihomo.service
Wants=network-online.target
# mihomo 没装也能启动，只是节点/流量接口会显示不可用

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/proxy-service.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PROXY_CONSOLE_PORT=8318
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable m3u-proxy m3u-proxy-console
systemctl restart m3u-proxy m3u-proxy-console
sleep 2
systemctl --no-pager --lines=12 status m3u-proxy
echo ""
systemctl --no-pager --lines=12 status m3u-proxy-console || true
echo ""
echo "常用命令："
echo "  systemctl status m3u-proxy           # 播放服务状态"
echo "  systemctl status m3u-proxy-console   # 代理控制台状态"
echo "  systemctl restart m3u-proxy          # 重启播放服务"
echo "  systemctl restart m3u-proxy-console  # 重启代理控制台"
echo "  journalctl -u m3u-proxy -f           # 播放服务日志"
echo "  journalctl -u m3u-proxy-console -f   # 代理控制台日志"
