# 直播源本地缓冲代理

把不稳定的远程 HLS 直播源，变成「本机磁盘直读」的稳定播放源。

播放器直连上游时，每个切片都要自己去拉一次；上游一慢、一抖、一返回 5xx，播放器就卡住甚至断开。本代理在中间加一层**预取 + 落盘缓存**：后台持续把最新切片下载到本地，播放器只从本机读，抗抖动能力大幅提升。

只依赖 Node.js，无需 `npm install`。

---

## 特性

- **切片本地缓冲**：后台预取 HLS 切片，播放器只读本机
- **缓冲池**：最新一段切片先扣在本地，播放器稳定落后直播一小段，上游抖动时用池子顶住
- **多源容错**：请求超时、重试、`curl` 兜底、自动跳过演示视频
- **播放管理页**：改配置、看频道状态、缓存与日志
- **独立代理控制台**：mihomo / 订阅 / 节点 / 策略组 / 测速 / 流量 / 规则，与播放服务互不影响
- **自定义走代理域名**：播放服务和代理控制台都可以单独配置
- **局域网共享**：播放列表和代理端口都可共享给同网段设备

---

## 环境要求

- Node.js **18 以上**
- 可选：mihomo（Clash.Meta）——只有使用代理控制台和节点功能时才需要
- 可选：Linux 下用 systemd 常驻运行

---

## 快速开始

1. 下载或克隆本项目。
2. 准备配置：

   ```powershell
   copy config.example.json config.json
   ```

3. 启动播放服务：

   ```powershell
   node proxy.js
   ```

   也可以直接双击 `start.cmd`（Windows）或执行 `bash start.sh`（Linux）。

4. 终端会打印地址，例如：

   ```
   本机播放列表:       http://127.0.0.1:8317/list.m3u
   局域网播放列表:     http://192.168.1.10:8317/list.m3u
   管理页面:           http://127.0.0.1:8317/admin
   ```

5. 在播放器（PotPlayer / VLC / 电视端影视仓 / TiviMate 等）里添加：

   ```
   http://<本机IP>:8317/list.m3u
   ```

6. 浏览器打开 `http://<本机IP>:8317/admin` 可以修改配置、查看频道状态。

仓库里的 `config.json` 默认 **`proxyEnabled: false`（直连）**，不装 mihomo 也能启动。需要走代理时再启动代理控制台，或把 `proxyEnabled` 改成 `true`。

`config.json` 的 `source` 默认是示例地址，请换成你自己的 m3u 地址。仓库里的 `tv.m3u` 签名已打码，只作格式示例，**不能直接播放**。

手机或电视播放时必须使用**局域网地址**（不能用 `127.0.0.1`），并保证防火墙放行 8317 端口。

---

## 目录说明

| 文件 | 说明 |
| --- | --- |
| `proxy.js` | 播放服务主程序（默认 8317） |
| `proxy-service.js` | 代理控制台后端（默认 8318） |
| `admin.html` | 播放管理页面 |
| `proxy-console.html` | 代理控制台页面 |
| `check.js` | 源体检工具，逐条检测频道可用性 |
| `config.json` / `config.example.json` | 播放服务配置 |
| `proxy-settings.json` | 代理控制台配置（首次启动自动生成） |
| `proxy-runtime.json` | 控制台推给播放服务的运行时状态（自动生成） |
| `start.cmd` / `start-console.cmd` | Windows 启动脚本 |
| `start.sh` / `start-console.sh` | Linux 启动脚本 |
| `linux/` | Linux 部署脚本（systemd、启动、更新） |

运行时生成的数据（`proxy-runtime.json`、`proxy-nodes.json`、`proxy-traffic.json`、`cache/` 等）已加入 `.gitignore`，不要提交。

---

## 配置项（`config.json`）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8317` | 播放服务监听端口 |
| `host` | `0.0.0.0` | 允许局域网访问；只想本机用可改 `127.0.0.1` |
| `source` | 示例地址 | 源清单，支持 http(s) 地址或本地 `.m3u` 路径 |
| `sourceRefreshMinutes` | `30` | 定时重拉源清单（更新签名）。`0` = 关闭 |
| `defaultUserAgent` | `qqlive` | 默认上游 UA；单个频道带 `http-user-agent` 时优先用它 |
| `forceUserAgent` | 空 | 非空时覆盖所有频道 |
| `variantPreference` | `highest` | 多码率选择：`highest` / `lowest` / `720` 等 |
| `segmentsEnabled` | `true` | 切片本地缓冲总开关。关 = 清单和切片都直连上游 |
| `bufferPoolSeconds` | `30` | 缓冲池秒数，越大越稳、延迟越高；`0` = 关闭 |
| `bufferSeconds` | `60` | 本地窗口大小（秒，含缓冲池） |
| `preloadChannels` | `3` | 同时预热几个频道：`0` = 只当前；`N` = 当前 + 最近 N 个；`-1` = 全部 |
| `playlistRefreshSeconds` | `auto` | 上游清单刷新间隔，`0` = 自动 |
| `idleStopMinutes` | `5` | 多久没请求就停止后台拉流 |
| `requestTimeoutMs` | `10000` | 清单请求超时 |
| `segmentTimeoutMs` | `30000` | 切片请求超时 |
| `retries` / `playlistRetries` | `3` / `2` | 切片 / 清单重试次数 |
| `forceIPv4` | `true` | 强制 IPv4，避免 IPv6 半通时卡超时 |
| `curlFallback` | `true` | Node 解析失败时改用系统 `curl` |
| `autoFailover` | `false` | 当前源失败时是否换同名频道的其它源 |
| `rejectDemoSources` | `true` | 把上游返回的演示/广告片判为失败 |
| `debug` | `false` | 打印每个上游请求的状态与耗时 |
| `cacheDir` / `maxCacheMB` | `cache` / `4096` | 缓存目录与上限 |
| `adminPassword` | 空 | 管理页密码；空 = 局域网免密 |
| `proxyEnabled` | `false` | 播放服务是否走上游代理 |
| `proxy` | 空 | 上游代理地址，如 `http://127.0.0.1:7890` |
| `proxyHosts` | `[]` | 走代理的域名，支持后缀匹配；留空跟随代理控制台 |

### 走代理的域名

- 在播放管理页「配置 → 代理域名」修改 `config.json` 的 `proxyHosts`
- 非空时优先于代理控制台的 `proxy-settings.json`
- 留空 = 跟随控制台
- 支持后缀匹配：填 `example.com` 会匹配 `a.example.com`、`b.example.com`

---

## 代理控制台（可选）

启动方式：

```powershell
node proxy-service.js
```

或双击 `start-console.cmd` / 执行 `bash start-console.sh`。页面地址：

```
http://<本机IP>:8318/admin
```

使用前需要本机已安装并运行 mihomo：

- 一个可用的订阅地址
- mihomo 的 `mixed-port`（默认 `7890`）
- mihomo 的 `external-controller`（默认 `127.0.0.1:9090`）

控制台主要功能：

- 订阅管理：多个订阅地址合并、去重、定时更新、手动更新
- 节点与策略组：自动地区分组、自定义分组、延迟测速、下载测速选点
- 规则管理：可视化编辑 `rules`，或直接编辑完整 YAML
- 流量统计：累计上传 / 下载、按节点统计
- 日志与连接：当前连接、历史连接、出口节点
- 局域网共享代理：把 mihomo 端口共享给同网段设备

没有 mihomo 时，控制台页面仍能打开，但节点、订阅、测速、流量等功能不可用。播放服务本身不受影响。

代理控制台的配置保存在 `proxy-settings.json`（首次启动自动生成）。其中有订阅 token 等敏感信息，**不要提交到公开仓库**。

---

## Linux 部署（可选）

以下路径仅为示例，可换成任意目录。

1. 安装 Node.js 18+。
2. 把项目放到目标目录，例如 `/opt/live-cache-proxy`。
3. 准备配置：

   ```bash
   cd /opt/live-cache-proxy
   cp config.example.json config.json
   ```

4. 前台启动测试：

   ```bash
   ./start.sh          # 播放服务 8317
   ./start-console.sh  # 代理控制台 8318
   ```

5. 安装为 systemd 服务：

   ```bash
   bash install-service.sh
   ```

   会创建 `m3u-proxy` 和 `m3u-proxy-console` 两个服务，工作目录就是脚本所在目录。

6. 查看日志：

   ```bash
   journalctl -u m3u-proxy -f
   journalctl -u m3u-proxy-console -f
   ```

7. 更新订阅后重载 mihomo：

   ```bash
   ./update-proxy.sh
   ```

---

## 使用提示

- 首次播放某个频道时会立即出画面，之后后台继续攒缓冲池，播放器稳定落后直播约 N 秒。
- 缓存目录占用过大会自动清理最旧的切片；也可以手动清缓存。
- 管理页密码留空表示局域网免密。放到公网或不可信网络前，请设置 `adminPassword`。
- 仓库里的示例 `tv.m3u` 只用于展示格式，签名已打码；实际播放请使用自己的源。
- 订阅地址、token、管理密码、节点信息都属于敏感数据，不要提交到公开仓库。

---

## 常见问题

**能启动，但播放没有画面？**

先确认 `source` 里的地址仍有效、签名没有过期；再用 `check.js` 体检。上游返回演示视频、403、503 时也会表现为无法播放。

**不装 mihomo 能用吗？**

可以。播放服务默认直连，不依赖 mihomo。代理控制台的节点、订阅、测速功能需要 mihomo。

**局域网设备访问不了？**

播放器里要用本机局域网 IP，不能用 `127.0.0.1`；同时检查防火墙是否放行 8317（控制台为 8318）。

**缓存增长很慢？**

正常。上游通常每几秒才发布一片新切片，本地窗口按这个节奏增长；下载本身很快。

**想降低延迟？**

把 `bufferPoolSeconds` 调到 `0` 或较小值，代价是抗抖动能力下降。
