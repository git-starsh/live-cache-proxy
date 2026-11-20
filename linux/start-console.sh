#!/bin/bash
# 启动独立代理控制台（默认 8318）
cd "$(dirname "$0")" || exit 1
exec node proxy-service.js
