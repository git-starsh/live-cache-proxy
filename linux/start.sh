#!/bin/bash
# 启动直播源本地缓冲代理
cd "$(dirname "$0")" || exit 1
exec node proxy.js
