#!/usr/bin/env node
'use strict';

/**
 * 直播源本地缓冲代理（HLS Cache Proxy）
 * ------------------------------------------------------------
 * 作用：
 *   1. 把远端 m3u8 里的切片地址改写成指向本机；
 *   2. 后台提前把切片下载并落盘缓存（预取），播放器只读本机磁盘；
 *   3. 播放点故意落后直播边缘若干秒，保证永远读到已缓存的切片；
 *   4. 上游偶发 5xx / 超时自动重试，签名过期自动重拉源清单。
 *
 * 只依赖 Node.js 内置模块，无需 npm install。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile, spawn } = require('child_process');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const ROOT = __dirname;

const DEFAULT_CONFIG = {
  port: 8317,
  host: '0.0.0.0',

  // 源清单：可以是 http(s) 地址，也可以是本地 .m3u 文件路径
  source: 'https://gist.githubusercontent.com/git-starsh/c935f1184c0a01fca21abce9e0b2546d/raw/f1aa18e17765140156150207b2f53dcc6055c110/tv.m3u',
  // 源清单自动刷新间隔（分钟）。0 = 不自动刷新
  sourceRefreshMinutes: 30,

  // 上游默认 UA（EXTINF 里带 http-user-agent 时以它为准）
  defaultUserAgent: 'qqlive',
  // 强制覆盖所有频道的 UA（源站换 UA 要求时用这个，不用改 m3u）
  forceUserAgent: '',

  // 多码率清单的选择策略：highest | lowest | 数字(如 720 表示优先接近 720p)
  variantPreference: 'highest',

  // 播放点落后直播边缘多少由「缓冲池 bufferPoolSeconds」决定（见下方）

  // 切片本地缓冲开关。关掉后清单直接指向上游切片地址：
  // 省盒子带宽/磁盘，但上游限速或清单抖动时更容易卡。
  segmentsEnabled: true,

  // 只拉当前观看的频道：换台时上一个频道立即停止后台拉流
  onlyCurrentChannel: true,

  // 每个频道预取“最新 N 个切片”
  prefetchAhead: 10,
  // 预取并发连接数
  prefetchConcurrency: 3,
  // 多久没人看就停止后台预取（分钟）
  idleStopMinutes: 10,
  // 按“秒”设缓冲深度（更直观）。填 >0 时自动按当前切片时长换算缓存片数，
  // 覆盖 prefetchAhead / playlistWindow；0 = 关闭，用下面的片数配置
  bufferSeconds: 0,

  // 本地清单最多保留多少个历史切片（上游通常只给 3~6 个，太短容易播空）
  playlistWindow: 18,

  // 上游清单刷新间隔（秒）。0 = 自动（按切片时长，约 1.2~3 秒一次）
  playlistRefreshSeconds: 0,

  // 缓冲池：最新这么多秒的切片只留在盒子本地、不下发给播放器。
  // 播放器因此始终落后直播边缘 N 秒，上游抖动/短暂断流时本地池子能顶住，
  // 不会把播放器缓冲吃空导致卡顿。0 = 关闭（贴直播边缘，延迟最低）。
  // 依附于 segmentsEnabled：切片本地缓冲关掉后，切片直连上游，池子不再缓存任何切片。
  bufferPoolSeconds: 30,
  // 同时预热几个频道：0 = 只当前频道；N = 当前 + 最近看过的 N 个；-1 = 全部（请求量大）
  preloadChannels: 3,

  // 请求超时
  requestTimeoutMs: 10000,
  segmentTimeoutMs: 30000,
  retries: 3,
  playlistRetries: 2,

  // 强制 IPv4。盒子的 IPv6 经常半通，Node 会先试 IPv6 然后卡满超时
  forceIPv4: true,

  // 上游代理（可选）。例如 "http://127.0.0.1:7890" 或 "socks5://127.0.0.1:1080"
  // 只让部分域名走代理时配合 proxyHosts 使用
  proxy: '',
  // 总开关：关掉后所有上游请求一律直连（订阅更新和测速不受影响）
  proxyEnabled: true,
  proxyHosts: [],
  // 把 mihomo 的 7890 端口共享给局域网：开启后监听 0.0.0.0，同网段设备可当 HTTP/SOCKS5 代理用
  proxyAllowLan: false,

  // 缓存目录与容量上限（MB），超过后自动清理最旧的切片
  cacheDir: 'cache',
  maxCacheMB: 4096,
  // 自动切换到同名频道的其它源（如 mcp 挂了换 mg）
  autoFailover: true,
  // 把上游返回的「演示/广告片」（jsdelivr testvideo）判定为失败，继续找真源
  rejectDemoSources: true,
  // 已知返回演示片的条目从播放列表里剔除（默认关：有些源探测时误判为演示、但实际能播）
  skipDemoSources: false,
  // 每隔多少分钟探测一遍「演示源」（0 = 默认关闭，不主动探测）
  demoProbeMinutes: 0,
  // Node 解析上游响应失败时，自动改用系统 curl 重新请求（对畸形响应更宽容）
  curlFallback: true,

  // ---- 代理节点（Clash / mihomo）----
  // 订阅地址：可以填多个，节点会合并去重后一起测速；定时拉取
  subscriptionUrls: [],
  // 旧版单订阅字段，仅用于迁移旧配置（新配置请用 subscriptionUrls）
  subscriptionUrl:
    '',
  // 每隔几小时拉一次订阅。0 = 不自动更新（仍可在页面上手动更新）
  subscriptionUpdateHours: 12,
  // 节点自动测速间隔（秒），mihomo 会按这个间隔选最快的节点
  nodeTestIntervalSeconds: 600,
  // 测速目标地址（返回 204 的小文件，越小越准）
  nodeTestUrl: 'https://www.google.com/generate_204',
  // 节点延迟差在这个范围内视为一样快，不来回切换（毫秒）
  nodeTestToleranceMs: 80,
  // 固定使用某个节点；留空 = 自动选择（AUTO）
  proxySelectedNode: '',
  // mihomo 本地接口与配置文件、服务名
  mihomoApi: 'http://127.0.0.1:9090',
  mihomoSecret: '',
  mihomoConfigPath: '/etc/mihomo/config.yaml',
  mihomoService: 'mihomo',
  mihomoBinary: '/usr/local/bin/mihomo',

  // 管理页面密码（空 = 局域网内免密进入 /admin）
  adminPassword: '',

  // 调试模式：打印每个上游请求的状态与耗时
  debug: false
};

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let user = {};
  try {
    if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[config] config.json 解析失败，使用默认配置:', e.message);
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, user);
  // 旧版单订阅字段迁移成多订阅数组
  const urls = Array.isArray(cfg.subscriptionUrls)
    ? cfg.subscriptionUrls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  if (!urls.length && String(cfg.subscriptionUrl || '').trim()) {
    urls.push(String(cfg.subscriptionUrl).trim());
  }
  cfg.subscriptionUrls = [...new Set(urls)];
  if (!path.isAbsolute(cfg.cacheDir)) cfg.cacheDir = path.join(ROOT, cfg.cacheDir);
  if (!/^https?:/i.test(cfg.source) && !path.isAbsolute(cfg.source)) {
    cfg.source = path.join(ROOT, cfg.source);
  }
  return cfg;
}

const config = loadConfig();
const CONFIG_PATH = path.join(ROOT, 'config.json');

// 管理页面的字段定义（所有可配置项都在这里，新增配置项记得同步）
const CONFIG_SCHEMA = [
  {
    group: '服务',
    desc: '端口 / 监听地址修改后需要重启服务才生效。',
    fields: [
      { key: 'port', label: '监听端口', type: 'number', min: 1, max: 65535, unit: '端口' },
      { key: 'host', label: '监听地址', type: 'text', desc: '0.0.0.0 = 局域网可访问；127.0.0.1 = 只允许本机' },
      {
        key: 'source',
        label: '源清单地址',
        type: 'text',
        wide: true,
        desc: 'm3u 地址或本地文件路径。留空会回落到本地 tv.m3u'
      },
      {
        key: 'sourceRefreshMinutes',
        label: '源清单刷新间隔',
        type: 'number',
        min: 0,
        max: 1440,
        unit: '分钟',
        desc: '0 = 不自动刷新'
      },
      {
        key: 'adminPassword',
        label: '管理页面密码',
        type: 'password',
        desc: '留空 = 局域网免密；填了之后打开 /admin 需要输入（用户名随意）'
      }
    ]
  },
  {
    group: '播放与缓冲',
    desc: '「缓冲池」是抗抖动的核心：最新一段切片只在盒子本地攒着，播放器始终落后直播一小段，上游抖一下也不会卡。'
      + '「缓冲深度」是本地总共保留多少秒切片（要大于池子）。关闭「切片本地缓冲」后切片全部直连上游，缓冲池随之停用。',
    fields: [
      {
        key: 'segmentsEnabled',
        label: '开启切片本地缓冲',
        type: 'boolean',
        desc: '开 = 提前把切片下载到盒子，播放器只读本机（推荐）；关 = 清单和切片都直连上游，不落盘、不缓存，缓冲池同时停用'
      },
      {
        key: 'bufferPoolSeconds',
        label: '缓冲池',
        type: 'number',
        min: 0,
        max: 300,
        unit: '秒',
        desc: '最新这么多秒的切片先扣在盒子本地不给播放器，用来吸收上游抖动和短暂断流。越大越不会卡，但直播延迟也越大。建议 20~40 秒；0 = 关闭（贴直播边缘）；关闭切片本地缓冲时此项不生效'
      },
      {
        key: 'bufferSeconds',
        label: '缓冲深度',
        type: 'number',
        min: 0,
        max: 600,
        unit: '秒',
        desc: '本地一共保留多少秒切片（包含上面的缓冲池）。建议 = 缓冲池 + 20 秒以上；0 = 用「播放列表窗口」的默认值'
      },
      {
        key: 'preloadChannels',
        label: '预热频道数',
        type: 'number',
        min: -1,
        max: 200,
        unit: '个',
        desc: '同时保持预存的频道数：0 = 只当前频道；N = 当前 + 最近看过的；-1 = 全部（请求量大，不建议）'
      },
      {
        key: 'playlistRefreshSeconds',
        label: '回源刷新间隔',
        type: 'number',
        min: 0,
        max: 60,
        unit: '秒',
        desc: '每隔多久向上游拉一次清单。0 = 自动（约 1~3 秒）。调大 = 回源更少，但新切片到手更晚'
      },
      {
        key: 'idleStopMinutes',
        label: '空闲停流时间',
        type: 'number',
        min: 1,
        max: 1440,
        unit: '分钟',
        desc: '多久没收到该频道请求就停止后台拉流'
      }
    ]
  },
  {
    group: '上游请求',
    desc: 'UA、超时、重试与容错。',
    fields: [
      { key: 'defaultUserAgent', label: '默认 User-Agent', type: 'text', desc: 'mcp 源需要 qqlive' },
      { key: 'forceUserAgent', label: '强制 User-Agent', type: 'text', desc: '非空时覆盖所有频道' },
      {
        key: 'variantPreference',
        label: '多码率选择',
        type: 'select',
        options: [
          { value: 'highest', label: '最高画质' },
          { value: 'lowest', label: '最低画质' },
          { value: '1080', label: '优先 1080p' },
          { value: '720', label: '优先 720p' },
          { value: '480', label: '优先 480p' }
        ]
      },
      { key: 'requestTimeoutMs', label: '清单请求超时', type: 'number', min: 1000, max: 120000, unit: 'ms' },
      { key: 'segmentTimeoutMs', label: '切片请求超时', type: 'number', min: 1000, max: 300000, unit: 'ms' },
      { key: 'retries', label: '切片重试次数', type: 'number', min: 0, max: 10 },
      { key: 'playlistRetries', label: '清单重试次数', type: 'number', min: 0, max: 10 },
      {
        key: 'forceIPv4',
        label: '强制 IPv4',
        type: 'boolean',
        desc: '盒子的 IPv6 不通时打开，避免每次请求先卡 IPv6 超时'
      },
      { key: 'autoFailover', label: '自动切换同名源', type: 'boolean', desc: '关 = 点哪条源就用哪条，绝不跨源' },
      { key: 'rejectDemoSources', label: '拒收演示/广告片', type: 'boolean' },
      { key: 'curlFallback', label: 'curl 兜底', type: 'boolean', desc: 'Node 请求失败时改用系统 curl' },
      { key: 'debug', label: '调试日志', type: 'boolean' }
    ]
  },
  {
    group: '代理域名',
    desc: '决定播放服务哪些上游请求走本地代理（订阅更新和节点测速不受影响）。留空 = 跟随代理控制台里的设置。',
    fields: [
      {
        key: 'proxyHosts',
        label: '走代理的域名',
        type: 'urls',
        rows: 4,
        desc: '每行一个域名，子域名自动包含（例如 live.example.com 也会匹配 a.live.example.com）。填了之后播放服务只让这些域名走代理，不再使用默认的 live.ottiptv.cc；留空则沿用代理控制台的设置。'
      }
    ]
  },
  {
    group: '缓存',
    desc: '缓存目录修改后需要重启。容量为 0 表示不限制。',
    fields: [
      { key: 'cacheDir', label: '缓存目录', type: 'text', desc: '相对路径基于程序目录' },
      { key: 'maxCacheMB', label: '缓存上限', type: 'number', min: 0, max: 102400, unit: 'MB' }
    ]
  }
];

const CONFIG_FIELDS = CONFIG_SCHEMA.reduce((acc, g) => acc.concat(g.fields), []);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function log(...args) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  pushLog('info', formatLogArgs(args));
  rawConsoleLog(`[${ts}]`, ...args);
}

// ---- 运行日志（内存环形缓冲，供 /admin 日志页查看） ----
const LOG_LIMIT = 1000;
const logLines = [];
let logSeq = 0;
// 进程启动时刻（用于概览的「服务运行时长」）
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);

function formatLogArgs(args) {
  const parts = [];
  for (const a of args) {
    let s;
    if (typeof a === 'string') s = a;
    else if (a instanceof Error) s = a.stack || a.message;
    else {
      try {
        s = JSON.stringify(a);
      } catch (_) {
        s = String(a);
      }
    }
    if (s && s.length > 4000) s = s.slice(0, 4000) + '…';
    parts.push(s == null ? String(a) : s);
  }
  return parts.join(' ');
}

function pushLog(level, text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return; // 忽略启动横幅里的空行
  logSeq++;
  logLines.push({ id: logSeq, time: Date.now(), level, text: s });
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
}

// 接管 console.log / error，这样启动横幅、未捕获异常也会出现在日志页
const rawConsoleLog = console.log.bind(console);
const rawConsoleError = console.error.bind(console);
console.log = (...args) => {
  pushLog('info', formatLogArgs(args));
  rawConsoleLog(...args);
};
console.error = (...args) => {
  pushLog('error', formatLogArgs(args));
  rawConsoleError(...args);
};

/**
 * 判断上游清单是不是「演示/广告片」而非真实直播。
 * 这类地址是 mcp 入口在拿不到真流时返回的占位内容：
 *   cdn.jsdelivr.net/gh/feiyang666999/testvideo/...
 * 特征是点播（#EXT-X-ENDLIST）、切片名 playad*.ts、总时长仅 2 分钟。
 */
const DEMO_PATTERNS = [/feiyang666999\/testvideo/i, /sdr1080pvideo/i, /jsdelivr\.net\/gh\/[^/]+\/testvideo/i];
function isDemoUrl(urlStr) {
  return !!urlStr && DEMO_PATTERNS.some((re) => re.test(urlStr));
}
function isDemoPlaylist(text) {
  return /playad\d+\.ts/i.test(text) || (/#EXT-X-ENDLIST/i.test(text) && /playad/i.test(text));
}

/** 取清单里的 MEDIA-SEQUENCE，用来判断上游到底有没有往前走 */
function seqOf(text) {
  const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// 演示源标记：把返回演示/广告片的条目记下来，生成播放列表时跳过
// 状态按「频道名 + 上游路径」保存，签名换了也不会丢（签名在 query 里）
// ---------------------------------------------------------------------------
const DEMO_STATE_FILE = () => path.join(ROOT, 'proxy-demo.json');
let demoStates = new Map(); // key -> { demo: boolean, at: number }
let demoProbeRunning = null;
let demoProbeTimer = null;
let demoProbeFirstTimer = null;

function demoKeyFor(name, urlStr) {
  try {
    const u = new URL(urlStr);
    return `${name}|${u.pathname.replace(/\/+$/, '')}`;
  } catch (_) {
    return `${name}|${String(urlStr || '')}`;
  }
}

function demoStateOf(ch) {
  return demoStates.get(demoKeyFor(ch.name, ch.url)) || null;
}

/** 这个条目是否已被判定为演示源（并应从播放列表剔除） */
function channelIsDemo(ch) {
  if (config.skipDemoSources === false) return false;
  const st = demoStateOf(ch);
  return !!(st && st.demo);
}

function loadDemoState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEMO_STATE_FILE(), 'utf8'));
    const src = (raw && raw.sources) || raw || {};
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object') demoStates.set(k, { demo: !!v.demo, at: Number(v.at) || 0 });
    }
  } catch (_) {}
}

function saveDemoState() {
  try {
    const sources = {};
    for (const [k, v] of demoStates) sources[k] = { demo: !!v.demo, at: v.at };
    fs.writeFileSync(DEMO_STATE_FILE(), JSON.stringify({ updatedAt: Date.now(), sources }, null, 2));
  } catch (_) {}
}

/** 记录一个条目的探测结果；状态有变化时返回 true 并写日志 */
function setDemoState(name, urlStr, demo) {
  const key = demoKeyFor(name, urlStr);
  const old = demoStates.get(key);
  if (old && old.demo === demo) {
    old.at = Date.now();
    return false;
  }
  demoStates.set(key, { demo, at: Date.now() });
  saveDemoState();
  if (demo) log(`⛔ 演示源，已从播放列表剔除：${name}`);
  else if (old && old.demo) log(`✅ 恢复真实源，重新加入播放列表：${name}`);
  return true;
}

function probeHeaders(ch) {
  return {
    'User-Agent': config.forceUserAgent || ch.ua || config.defaultUserAgent,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Connection: 'close'
  };
}

/** 探测单个条目的上游入口，判断是不是演示片。网络失败不算演示源 */
async function probeChannelDemo(ch) {
  try {
    const r = await getWithRetry(
      ch.url,
      { headers: probeHeaders(ch), timeout: Math.min(Number(config.requestTimeoutMs) || 10000, 15000) },
      0
    );
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const body = r.body.toString('utf8');
    const demo = isDemoUrl(r.url) || isDemoPlaylist(body);
    return setDemoState(ch.name, ch.url, demo);
  } catch (_) {
    return null;
  }
}

/** 全量探测一遍（正在拉流的频道跳过，正常播放本身就是最好的探测） */
async function probeAllDemo() {
  if (demoProbeRunning) return demoProbeRunning;
  demoProbeRunning = (async () => {
    const targets = channels.filter((ch) => {
      const st = streams.get(ch.id);
      return !st || !st.started;
    });
    let changed = 0;
    const conc = 3;
    for (let i = 0; i < targets.length; i += conc) {
      const batch = targets.slice(i, i + conc);
      const res = await Promise.all(batch.map((ch) => probeChannelDemo(ch).catch(() => null)));
      changed += res.filter(Boolean).length;
      await sleep(120);
    }
    log(`🔍 演示源探测完成：检查 ${targets.length} 个频道，标记变化 ${changed} 个`);
    saveDemoState();
    return { checked: targets.length, changed, demoCount: channels.filter((ch) => channelIsDemo(ch)).length };
  })()
    .catch((e) => {
      log(`演示源探测失败：${e.message}`);
      return { checked: 0, changed: 0 };
    })
    .finally(() => {
      demoProbeRunning = null;
    });
  return demoProbeRunning;
}

function scheduleDemoProbe(firstDelayMs) {
  clearTimeout(demoProbeFirstTimer);
  clearInterval(demoProbeTimer);
  demoProbeFirstTimer = null;
  demoProbeTimer = null;
  const minutes = Number(config.demoProbeMinutes) || 0;
  if (minutes <= 0) return;
  if (firstDelayMs != null) {
    demoProbeFirstTimer = setTimeout(() => probeAllDemo().catch(() => {}), Math.max(0, firstDelayMs));
    if (demoProbeFirstTimer.unref) demoProbeFirstTimer.unref();
  }
  demoProbeTimer = setInterval(() => probeAllDemo().catch(() => {}), minutes * 60 * 1000);
  if (demoProbeTimer.unref) demoProbeTimer.unref();
}

function extOf(urlStr, fallback = '.ts') {
  try {
    const ext = path.extname(new URL(urlStr).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
  } catch (_) {}
  return fallback;
}

function contentTypeFor(name) {
  const map = {
    '.ts': 'video/mp2t',
    '.m4s': 'video/mp4',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.mp3': 'audio/mpeg',
    '.vtt': 'text/vtt',
    '.key': 'application/octet-stream',
    '.m3u8': 'application/vnd.apple.mpegurl'
  };
  return map[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// 上游代理（HTTP CONNECT / SOCKS5）
// ---------------------------------------------------------------------------

// 代理控制台通过 proxy-runtime.json 把「开关 / 地址 / 域名 / 节点」推给本进程。
// 读文件而不是调 HTTP：控制台没启动时播放照样能用（退回 config.json 里的旧设置）。
const PROXY_RUNTIME_FILE = path.join(ROOT, 'proxy-runtime.json');
const PROXY_CONSOLE_URL = process.env.PROXY_CONSOLE_URL || 'http://127.0.0.1:8318';
let proxyRuntimeCache = { at: 0, mtimeMs: -1, data: null };

function loadProxyRuntime(force = false) {
  const now = Date.now();
  if (!force && now - proxyRuntimeCache.at < 800 && proxyRuntimeCache.data) return proxyRuntimeCache.data;
  proxyRuntimeCache.at = now;
  let data = null;
  try {
    const st = fs.statSync(PROXY_RUNTIME_FILE);
    if (force || st.mtimeMs !== proxyRuntimeCache.mtimeMs) {
      proxyRuntimeCache.mtimeMs = st.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(PROXY_RUNTIME_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        data = {
          enabled: raw.enabled !== false,
          url: String(raw.url || ''),
          hosts: Array.isArray(raw.hosts) ? raw.hosts.map((h) => String(h || '').trim()).filter(Boolean) : [],
          selected: String(raw.selected || 'AUTO'),
          selectedGroup: String(raw.selectedGroup || ''),
          selectedNode: String(raw.selectedNode || ''),
          selectedGroupExit: String(raw.selectedGroupExit || ''),
          hostTargets: raw.hostTargets && typeof raw.hostTargets === 'object' && !Array.isArray(raw.hostTargets)
            ? raw.hostTargets
            : {},
          consolePort: Number(raw.consolePort) || 8318,
          updatedAt: Number(raw.updatedAt) || 0
        };
      }
      proxyRuntimeCache.data = data;
    } else {
      data = proxyRuntimeCache.data;
    }
  } catch (_) {
    proxyRuntimeCache.data = null;
  }
  if (!data) {
    data = {
      enabled: config.proxyEnabled !== false,
      url: String(config.proxy || ''),
      hosts: Array.isArray(config.proxyHosts) ? config.proxyHosts : [],
      selected: String(config.proxySelectedNode || 'AUTO'),
      selectedGroup: String(config.proxySelectedGroup || ''),
      selectedNode: String(config.proxySelectedNode || ''),
      selectedGroupExit: '',
      hostTargets: {},
      consolePort: 8318,
      updatedAt: 0
    };
  }
  // 控制台未安装 / 还没生成 proxy-runtime.json 时也要缓存兜底值，
  // 否则 800ms 内的下一次读取会拿到 null，直接报 “reading 'enabled'”。
  proxyRuntimeCache.data = data;
  return data;
}

/**
 * 本播放服务自己配置的走代理域名（config.json 的 proxyHosts）。
 * 非空时优先于代理控制台推下来的 hosts：这样控制台规则里改了域名，
 * 播放服务也能单独指定，不再被控制台里的旧域名（如 live.ottiptv.cc）带着走。
 * 留空 = 跟随代理控制台。
 */
function playbackProxyHosts() {
  const raw = Array.isArray(config.proxyHosts) ? config.proxyHosts : [];
  return raw.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
}

/** 实际生效的走代理域名：本服务配置优先，其次代理控制台 */
function effectiveProxyHosts(rt) {
  const own = playbackProxyHosts();
  if (own.length) return own;
  return Array.isArray(rt && rt.hosts) ? rt.hosts : [];
}

const PROXY_SCHEMES = { 'http:': 'http', 'https:': 'http', 'socks5:': 'socks5', 'socks5h:': 'socks5' };

function parseProxy(str) {
  let u;
  try {
    u = new URL(str);
  } catch (_) {
    return null;
  }
  const kind = PROXY_SCHEMES[u.protocol];
  if (!kind) return null;
  return {
    kind,
    raw: str,
    host: u.hostname,
    port: Number(u.port) || (kind === 'http' ? 8080 : 1080),
    auth: u.username
      ? Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`
        ).toString('base64')
      : null
  };
}

/** 当前 URL 是否要走代理（走代理域名为空 = 全部走代理） */
function proxyFor(urlStr) {
  const rt = loadProxyRuntime();
  if (!rt || !rt.enabled) return null;
  const p = rt.url;
  if (!p) return null;
  let host = '';
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
  const hosts = effectiveProxyHosts(rt);
  if (hosts.length) {
    const hit = hosts.some((h) => {
      const rule = String(h || '').trim().toLowerCase();
      return !!rule && (host === rule || host.endsWith('.' + rule));
    });
    if (!hit) return null;
  }
  return parseProxy(p);
}

// 日志里标注“这次请求走代理还是直连”。按 host 去重（60 秒），避免切片请求刷屏。
const PROXY_ROUTE_LOG = new Map();

function proxyRouteLabel(urlStr) {
  let host = '';
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
  const rt = loadProxyRuntime();
  if (!rt || !rt.enabled || !rt.url) return { host, mode: 'direct' };
  if (proxyFor(urlStr)) return { host, mode: 'proxy' };
  return { host, mode: 'direct' };
}

// 节点名可能很长（带国旗 / 倍率 / 地区后缀），日志里截断一下
function shortExitNode(name) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 30 ? s.slice(0, 29) + '…' : s;
}

function proxyRouteTarget(rt, host) {
  const hosts = effectiveProxyHosts(rt);
  const key = String(host || '').toLowerCase();
  const hostRule = hosts.some((h) => {
    const rule = String(h || '').trim().toLowerCase();
    return !!rule && (key === rule || key.endsWith('.' + rule));
  });
  if (hostRule) {
    // 规则目标由控制台 YAML 决定：可能是 AUTO、某个策略组或固定节点
    const map = rt.hostTargets && typeof rt.hostTargets === 'object' ? rt.hostTargets : {};
    let hit = map[host] || map[key] || null;
    if (!hit) {
      const mapKey = Object.keys(map).find((h) => {
        const rule = String(h || '').toLowerCase();
        return !!rule && (key === rule || key.endsWith('.' + rule));
      });
      if (mapKey) hit = map[mapKey];
    }
    const target = hit && String(hit.target || '');
    const node = shortExitNode(hit && hit.node);
    if (target) {
      if (String(hit.kind) === 'node') {
        return '固定节点 ' + target + (node && node !== target ? '（' + node + '）' : '');
      }
      if (target.toUpperCase() !== 'AUTO') {
        return '规则组 ' + target + (node ? '（' + node + '）' : '');
      }
      return '规则组 AUTO（自动选择' + (node ? ' · ' + node : '') + '）';
    }
    return '规则组 AUTO（自动选择）';
  }
  if (rt.selectedGroup) {
    const node = shortExitNode(rt.selectedGroupExit);
    return '策略组 ' + rt.selectedGroup + (node ? '（' + node + '）' : '');
  }
  if (rt.selectedNode && rt.selectedNode !== 'AUTO') return '固定节点 ' + rt.selectedNode;
  if (rt.selected && rt.selected !== 'AUTO') return '固定节点 ' + rt.selected;
  return 'AUTO 自动选择';
}

function logProxyRoute(urlStr, mode) {
  const route = proxyRouteLabel(urlStr);
  if (!route) return;
  const m = mode || route.mode;
  const now = Date.now();
  const rt = loadProxyRuntime();
  const target = m === 'proxy' ? proxyRouteTarget(rt, route.host) : '';
  const prev = PROXY_ROUTE_LOG.get(route.host);
  // 规则目标切换（如 YAML 里从 AUTO 改成日本节点）时立即重新记一条
  if (prev && prev.mode === m && prev.target === target && now - prev.at < 60000) return;
  PROXY_ROUTE_LOG.set(route.host, { host: route.host, mode: m, target, at: now });
  if (m === 'proxy') {
    log(`🌐 走代理：${route.host}（${target}）`);
  } else {
    log(`🔌 直连：${route.host}${!rt.enabled ? '（代理总开关已关闭）' : ''}`);
  }
}

/**
 * 日志后缀：这次连接是直连还是走代理，走代理时带上规则命中的节点。
 * 返回空串或形如 “ · 直连”“ · 走代理：规则组 订阅 xx（🇹🇼台湾Hinet）”。
 */
function routeLogTag(urlStr) {
  const u = String(urlStr || '').trim();
  if (!u) return '';
  const rt = loadProxyRuntime();
  if (!rt || !rt.enabled || !rt.url) return ' · 直连';
  if (!proxyFor(u)) return ' · 直连';
  let host = '';
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch (_) {
    return ' · 走代理';
  }
  return ' · 走代理：' + proxyRouteTarget(rt, host);
}

/** 通过代理建立到 host:port 的 TCP 连接 */
function connectViaProxy(proxy, host, port, timeout, cb) {
  let done = false;
  const finish = (err, sock) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (err) {
      if (sock) sock.destroy();
      return cb(err);
    }
    cb(null, sock);
  };

  const sock = net.connect(proxy.port, proxy.host);
  const timer = setTimeout(() => finish(new Error('代理连接超时')), timeout);

  sock.once('error', (e) => finish(new Error(`代理连接失败: ${e.code || e.message}`)));
  sock.once('connect', () => {
    if (proxy.kind === 'http') {
      // HTTP CONNECT 隧道
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${proxy.auth}\r\n` : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let buf = '';
      const onData = (d) => {
        buf += d.toString('latin1');
        const idx = buf.indexOf('\r\n');
        if (idx < 0) return;
        sock.removeListener('data', onData);
        const line = buf.slice(0, idx);
        const code = parseInt(line.split(' ')[1], 10);
        if (code !== 200) return finish(new Error(`代理拒绝 CONNECT: ${code}`));
        finish(null, sock);
      };
      sock.on('data', onData);
      return;
    }

    // SOCKS5（socks5h 由代理侧解析域名，这里统一发域名）
    const useName = !/^\d+\.\d+\.\d+\.\d+$/.test(host);
    const methods = proxy.auth ? Buffer.from([0x00, 0x02]) : Buffer.from([0x00]);
    sock.write(Buffer.concat([Buffer.from([0x05, methods.length]), methods]));

    let stage = 'greet';
    const onData = (d) => {
      if (stage === 'greet') {
        if (d[0] !== 0x05) return finish(new Error('SOCKS5 握手失败'));
        if (d[1] === 0x02) {
          if (!proxy.auth) return finish(new Error('SOCKS5 需要认证但未配置用户名密码'));
          const [user, pass] = Buffer.from(proxy.auth, 'base64').toString().split(':');
          stage = 'auth';
          const u = Buffer.from(user || '');
          const p = Buffer.from(pass || '');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        if (d[1] !== 0x00) return finish(new Error('SOCKS5 无可用的认证方式'));
        sendConnect();
        return;
      }
      if (stage === 'auth') {
        if (d[1] !== 0x00) return finish(new Error('SOCKS5 用户名密码错误'));
        sendConnect();
        return;
      }
      if (stage === 'connect') {
        if (d[1] !== 0x00) return finish(new Error(`SOCKS5 连接失败: ${d[1]}`));
        sock.removeListener('data', onData);
        finish(null, sock);
      }
    };

    const sendConnect = () => {
      stage = 'connect';
      let addr;
      if (useName) {
        const h = Buffer.from(host);
        addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
      } else {
        addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
    };

    sock.on('data', onData);
  });
}

/** 给 http.request 用的 Agent：先走代理建连，https 再套一层 TLS */
function proxyCreateConnection(options, cb) {
  connectViaProxy(this.proxy, options.host, options.port, this.timeout, (err, sock) => {
    if (err) return cb(err);
    if (!this.secure) return cb(null, sock);
    const t = tls.connect(
      {
        socket: sock,
        servername: options.servername || options.host,
        rejectUnauthorized: false
      },
      () => cb(null, t)
    );
    t.once('error', (e) => cb(e));
  });
  // 异步返回
  return undefined;
}

// https.request 要求 agent 的协议开头与 URL 一致，所以 http/https 各用一个类
class ProxyAgent extends http.Agent {
  constructor(proxy, secure, timeout) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.secure = secure;
    this.timeout = timeout;
  }
}
ProxyAgent.prototype.createConnection = proxyCreateConnection;

class ProxyAgentTls extends https.Agent {
  constructor(proxy, secure, timeout) {
    super({ keepAlive: false });
    this.proxy = proxy;
    this.secure = secure;
    this.timeout = timeout;
  }
}
ProxyAgentTls.prototype.createConnection = proxyCreateConnection;

// 直连（不走代理）时复用连接。切片是同一个 CDN 上的连续请求，
// 开 keep-alive 后握手只做一次，窗口铺满能明显快一截。
let httpAgent = null;
let httpsAgent = null;
function getHttpAgent() {
  if (!httpAgent) {
    httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 16,
      maxFreeSockets: 8,
      timeout: 30000,
      scheduling: 'lifo'
    });
  }
  return httpAgent;
}
function getHttpsAgent() {
  if (!httpsAgent) {
    httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 16,
      maxFreeSockets: 8,
      timeout: 30000,
      scheduling: 'lifo'
    });
  }
  return httpsAgent;
}

// ---------------------------------------------------------------------------
// HTTP 客户端（带重定向 / 重试 / 超时）
// ---------------------------------------------------------------------------

function rawRequest(urlStr, { headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const proxy = proxyFor(urlStr);
    const reqOpts = { method: 'GET', headers, insecureHTTPParser: true };
    if (config.forceIPv4) reqOpts.family = 4;
    if (proxy) {
      const Agent = u.protocol === 'https:' ? ProxyAgentTls : ProxyAgent;
      reqOpts.agent = new Agent(proxy, u.protocol === 'https:', timeout);
    } else {
      // 复用连接：切片动辄 2~4MB，每片都新建连接等于白送一次握手，
      // 一次窗口十几片时能省下几百毫秒到几秒。
      reqOpts.agent = u.protocol === 'https:' ? getHttpsAgent() : getHttpAgent();
    }
    const req = mod.request(u, reqOpts, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 128 * 1024 * 1024) {
            req.destroy(new Error('响应体过大'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            url: urlStr
          })
        );
        res.on('error', reject);
      });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    // 硬性超时：DNS 卡住 / 建连卡住时 socket timeout 不一定生效
    const hardTimer = setTimeout(() => req.destroy(new Error('请求超时')), timeout);
    req.on('close', () => clearTimeout(hardTimer));
    req.on('error', reject);
    req.end();
  });
}

async function httpGet(urlStr, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 6;
  let cur = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    const r = await rawRequest(cur, opts);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      cur = new URL(r.headers.location, cur).toString();
      continue;
    }
    r.url = cur;
    return r;
  }
  throw new Error('重定向次数过多');
}

/**
 * 用系统 curl 兜底请求。
 * 一些国内 CDN 返回的响应不合 HTTP 规范，Node 的 llhttp 会直接报
 * "Parse Error: Expected HTTP/" / "Data after Connection: close"，而 curl 能正常处理。
 */
function execFileP(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr ? String(stderr) : '';
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

let curlOk = null;
const curlPreferredHosts = new Set(); // 已经确认 Node 解析不了的域名
async function curlAvailable() {
  if (curlOk !== null) return curlOk;
  try {
    await execFileP('curl', ['--version'], { timeout: 5000, windowsHide: true });
    curlOk = true;
  } catch (_) {
    curlOk = false;
  }
  return curlOk;
}

async function curlFetch(urlStr, headers = {}, timeoutMs = 15000, useProxy = false) {
  const args = ['-sS', '-L', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
  if (config.forceIPv4) args.push('-4');
  for (const [k, v] of Object.entries(headers)) {
    if (/^user-agent$/i.test(k)) args.push('-A', String(v));
    else args.push('-H', `${k}: ${v}`);
  }
  args.push('-w', '\n%{http_code}\n%{url_effective}', urlStr);
  const px = proxyFor(urlStr);
  if (px) args.push('-x', px.raw);
  else if (useProxy && config.proxy) args.push('-x', String(config.proxy));

  const { stdout } = await execFileP('curl', args, {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: 'buffer'
  }).catch((e) => {
    // 只保留 curl 的第一行错误，避免整段命令行和 stderr 灌进日志
    const line = (e.stderr || e.message || '').toString().split(/\r?\n/).filter(Boolean);
    const msg = (line.find((l) => /^curl:/.test(l)) || line[0] || 'curl 请求失败').trim();
    const err = new Error(msg);
    err.code = 'ECURL';
    throw err;
  });

  // 末尾两行分别是 状态码 和 最终地址
  const end2 = stdout.lastIndexOf(0x0a);
  const effective = stdout.slice(end2 + 1).toString();
  const end1 = stdout.lastIndexOf(0x0a, end2 - 1);
  const status = parseInt(stdout.slice(end1 + 1, end2).toString(), 10);
  const body = stdout.slice(0, end1);

  return { status, headers: {}, body, url: effective || urlStr, viaCurl: true };
}

/**
 * 带重试的 GET。网络错误 / 5xx / 429 会重试，4xx 直接返回给调用方判断。
 */
async function getWithRetry(urlStr, opts = {}, retries = config.retries) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    // 按 host 往日志里记一条“走代理/直连”
    const route = proxyRouteLabel(urlStr);
    if (route) logProxyRoute(urlStr, route.mode);
    try {
      let r;
      const host = (() => {
        try {
          return new URL(urlStr).host;
        } catch (_) {
          return '';
        }
      })();
      try {
        if (config.curlFallback && host && curlPreferredHosts.has(host) && (await curlAvailable())) {
          r = await curlFetch(urlStr, opts.headers, opts.timeout || 15000);
        } else {
          r = await httpGet(urlStr, opts);
        }
      } catch (e) {
        // Node 解析不了的上游响应，交给 curl
        const parseLike = /Parse Error|HPE_|ECONNRESET|socket hang up/i.test(e.message || e.code || '');
        if (parseLike && config.curlFallback && (await curlAvailable())) {
          if (host) curlPreferredHosts.add(host);
          r = await curlFetch(urlStr, opts.headers, opts.timeout || 15000);
          if (config.debug) log(`↗ curl 兜底 ${r.status} ${Date.now() - t0}ms`);
        } else {
          throw e;
        }
      }
      if (config.debug) {
        log(`↗ ${r.status} ${Date.now() - t0}ms ${urlStr.slice(0, 110)}${routeLogTag(urlStr)}`);
      }
      if (r.status >= 200 && r.status < 300) {
        return r;
      }
      if ([403, 404, 410, 451].includes(r.status)) return r;
      lastErr = new Error(`HTTP ${r.status}`);
      if (r.status === 503 || r.status === 403) requestSourceRefresh();
    } catch (e) {
      lastErr = e;
      if (config.debug) log(`↗ ERR ${Date.now() - t0}ms ${e.message} ${urlStr.slice(0, 90)}${routeLogTag(urlStr)}`);
    }
    if (attempt < retries) await sleep(300 * Math.pow(2, attempt));
  }
  throw lastErr || new Error('请求失败');
}

// ---------------------------------------------------------------------------
// 源清单（tv.m3u）解析与频道管理
// ---------------------------------------------------------------------------

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let group = '';
  let pending = null;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (/^#EXTGRP:/i.test(t)) {
      group = t.slice(8).trim();
      continue;
    }
    if (/^#EXTINF:/i.test(t)) {
      pending = { inf: t, group };
      continue;
    }
    if (t.startsWith('#')) continue;
    if (pending) {
      const m =
        pending.inf.match(/http-user-agent="([^"]*)"/i) ||
        pending.inf.match(/http-user-agent=([^\s,]+)/i);
      entries.push({
        inf: pending.inf,
        group: pending.group || group,
        url: t,
        ua: m ? m[1] : null,
        name: pending.inf.split(',').pop().trim()
      });
      pending = null;
    }
  }
  return entries;
}

let channels = [];
let channelGroups = new Map();
let sourceText = '';
let sourceHash = '';
let lastSourceLoad = 0;
let sourceLoading = null;
let lastRefreshAsk = 0;

// 常见汉字的拼音首字母。纯中文频道名用它生成 ID：
// 北京卫视 → bjws、新疆卫视 → xjws、中国教育电视台 → zgjydst。
// 只收频道名里常见的字，查不到的字直接跳过（整串都查不到时回退 c<序号>）。
const PINYIN_INITIAL = (() => {
  const groups = {
    a: '奥安',
    b: '北兵播博版百包备本滨毕',
    c: '财村超重川场城产船创潮车彩长成春初',
    d: '电东典第道都动大地党点短导读定冬',
    e: '儿二鄂',
    f: '防法方风肥房佛福服妇丰富番飞',
    g: '国高古甘购歌港光公工规感赣桂贵广',
    h: '合会徽黑河海湖怀华化画婚欢环汇惠航黄衡红呼和哈',
    j: '经际军剧纪教京江津吉疆旧家集交健节精景嘉建简金晋冀九济锦焦',
    k: '科克开康快卡客昆空喀',
    l: '录林乐辽龙旅丽联莲凉洛兰拉聆',
    m: '蒙民美明木门闽漫贸媒梦牡眉绵茂',
    n: '农南宁内年女能男纳嫩',
    o: '欧',
    p: '匹频品片普平屏鹏',
    q: '曲清庆青球全汽情旗齐强黔泉秦沁衢',
    r: '人日热融荣瑞榕',
    s: '赛事视社少苏山深四陕肃数商时尚生盛世书水摄色丝汕韶顺三松绥上神石双遂',
    t: '体天团台通同图特太唐铁桃铜泰头潭',
    w: '文卫温五舞网无武物外湾潍芜万吴巫威渭乌翁闻',
    x: '戏新西夏星学兴乡湘襄巡休小系心厦徐咸孝邢许宣仙祥香锡',
    y: '艺育影与音乐业一云演游娱婴幼医饮有阳燕粤豫渝翼银亚英语阅优鹰宜营榆盐益',
    z: '综中浙州圳藏最资字子自治政知之珠展战郑漳湛肇镇周株枣遵淄张章昭竹筑准'
  };
  const map = Object.create(null);
  for (const letter of Object.keys(groups)) {
    for (const ch of groups[letter]) map[ch] = letter;
  }
  return map;
})();

/** 频道名 → URL/目录用的短 ID：CCTV-1 综合 → cctv1，CCTV-5+ 体育赛事 → cctv5p，北京卫视 → bjws */
function channelIdBase(name) {
  // 只用第一个词（空格/全角空格之前），中文名的副标题直接丢掉
  const first = String(name || '').trim().split(/[\s\u3000]+/)[0] || '';
  // 拉丁名（CCTV-1、CGTN、CCTV-5+ 等）
  if (/^[\x20-\x7e]+$/.test(first)) {
    const s = first
      .toLowerCase()
      .replace(/\+/g, 'p')
      .replace(/[^a-z0-9]/g, '');
    return /[a-z]/.test(s) ? s : '';
  }
  // 纯中文名：每个字取拼音首字母
  let out = '';
  for (const ch of first) {
    if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
    else if (ch === '+') out += 'p';
    else out += PINYIN_INITIAL[ch] || '';
  }
  return /[a-z]/.test(out) ? out : '';
}

function buildChannels(text) {
  const entries = parseM3U(text);
  const used = new Set();
  const list = entries.map((e, i) => {
    // 非拉丁名（比如纯中文频道）没有可用的缩写，退回 c<序号>
    const base = channelIdBase(e.name) || 'c' + (i + 1);
    let id = base;
    let n = 1;
    while (used.has(id)) id = `${base}-${++n}`; // 重名频道自动加 -2、-3
    used.add(id);
    return {
      id,
      index: i,
      name: e.name,
      group: e.group,
      inf: e.inf,
      url: e.url,
      ua: e.ua
    };
  });
  // 同名频道的备用地址（通常同一个台有 mcp / mg 多个源）
  channelGroups = new Map();
  for (const ch of list) {
    if (!channelGroups.has(ch.name)) channelGroups.set(ch.name, []);
    channelGroups.get(ch.name).push(ch);
  }
  return list;
}

async function loadSource(force = false) {
  if (sourceLoading) return sourceLoading;

  sourceLoading = (async () => {
    let text = null;

    if (/^https?:/i.test(config.source)) {
      try {
        const r = await getWithRetry(
          config.source,
          { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }, timeout: 20000 },
          1
        );
        if (r.status === 200) text = r.body.toString('utf8');
        else log(`源清单 HTTP ${r.status}${routeLogTag(config.source)}`);
      } catch (e) {
        log(`源清单拉取失败：${e.message}${routeLogTag(config.source)}`);
      }
      // 拉不到就用上一次的缓存副本
      const local = path.join(ROOT, 'tv.m3u');
      if (!text && fs.existsSync(local)) {
        text = fs.readFileSync(local, 'utf8');
        log('使用本地 tv.m3u 副本');
      } else if (text) {
        try {
          fs.writeFileSync(local, text);
        } catch (_) {}
      }
    } else {
      try {
        text = await fsp.readFile(config.source, 'utf8');
      } catch (e) {
        log('读取本地源清单失败:', e.message);
      }
    }

    if (!text) {
      if (sourceText) return;
      return;
    }

    const h = md5(text);
    if (h === sourceHash) {
      lastSourceLoad = Date.now();
      return;
    }

    sourceHash = h;
    sourceText = text;
    channels = buildChannels(text);
    lastSourceLoad = Date.now();

    // 频道 ID 变了（比如从 c1/c2 换成 cctv1/cctv2）：停掉旧 id 的流并清掉旧缓存目录，
    // 否则它们会继续在后台跑，白占内存和磁盘。
    const keepIds = new Set(channels.map((c) => c.id));
    for (const [id, st] of streams) {
      if (keepIds.has(id)) continue;
      try {
        st.stop();
      } catch (_) {}
      streams.delete(id);
    }
    if (keepIds.size) {
      fsp
        .readdir(config.cacheDir, { withFileTypes: true })
        .then((list) => {
          const stale = list.filter((d) => d.isDirectory() && !keepIds.has(d.name));
          return Promise.all(
            stale.map((d) =>
              fsp.rm(path.join(config.cacheDir, d.name), { recursive: true, force: true }).catch(() => {})
            )
          ).then(() => {
            if (stale.length) log(`已清理 ${stale.length} 个不再使用的缓存目录`);
          });
        })
        .catch(() => {});
    }

    // 已存在的频道流，更新其上游地址
    for (const ch of channels) {
      const st = streams.get(ch.id);
      if (st) {
        if (st.ch.url !== ch.url) {
          st.resolvedUrl = null; // 签名变了，重新解析
          st.activeUrl = ch.url;
          st.activeUa = ch.ua;
        }
        st.ch = ch;
      }
    }
    log(`已加载源清单：${channels.length} 个频道${/^https?:/i.test(config.source) ? routeLogTag(config.source) : ''}`);

    // 签名换新后，之前判定为演示源的条目要尽快复核（签名过期也会返回演示片）
    setTimeout(() => {
      const targets = channels.filter((ch) => {
        const ds = demoStateOf(ch);
        if (!ds || !ds.demo) return false;
        const st = streams.get(ch.id);
        return !st || !st.started;
      });
      if (targets.length) {
        Promise.all(targets.map((ch) => probeChannelDemo(ch).catch(() => null))).catch(() => {});
      }
    }, 5000).unref();
  })().finally(() => {
    sourceLoading = null;
  });

  return sourceLoading;
}

/** 签名失效时调用：节流后强制刷新源清单 */
function requestSourceRefresh() {
  const now = Date.now();
  if (now - lastRefreshAsk < 30000) return;
  lastRefreshAsk = now;
  log('上游疑似签名失效/被拒，尝试刷新源清单…');
  loadSource(true).catch(() => {});
}

// ---------------------------------------------------------------------------
// 单频道流：刷新清单 + 预取切片
// ---------------------------------------------------------------------------

function pickVariant(masterText, baseUrl) {
  // 解析 #EXT-X-STREAM-INF 的带宽/分辨率，按配置挑选
  const lines = masterText.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!/^#EXT-X-STREAM-INF:/i.test(t)) continue;
    const attr = t.slice(t.indexOf(':') + 1);
    const bw = parseInt((attr.match(/BANDWIDTH=(\d+)/i) || [])[1] || '0', 10);
    const res = (attr.match(/RESOLUTION=(\d+)x(\d+)/i) || [])[1] || '';
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
    if (j >= lines.length) break;
    let abs;
    try {
      abs = new URL(lines[j].trim(), baseUrl).toString();
    } catch (_) {
      continue;
    }
    variants.push({ url: abs, bandwidth: bw, height: res ? parseInt(res[1], 10) : 0 });
    i = j;
  }
  if (!variants.length) return null;

  const pref = config.variantPreference;
  if (pref === 'lowest') {
    return variants.sort((a, b) => a.bandwidth - b.bandwidth)[0].url;
  }
  if (typeof pref === 'number' || /^\d+$/.test(String(pref))) {
    const target = parseInt(pref, 10);
    return variants.sort(
      (a, b) => Math.abs(a.height - target) - Math.abs(b.height - target) || b.bandwidth - a.bandwidth
    )[0].url;
  }
  return variants.sort((a, b) => b.bandwidth - a.bandwidth)[0].url;
}

class Stream {
  constructor(channel) {
    this.ch = channel;
    this.id = channel.id;
    this.dir = path.join(config.cacheDir, this.id);

    this.blocks = []; // [{ tags: [], uri, url, name, dur }]
    this.files = new Map(); // name -> { url, kind }
    this.lastSeen = new Map(); // name -> ts
    this.segments = [];

    this.targetDuration = 6;
    this.mediaSequence = 0;
    this.vod = false;

    this.started = false;
    this.ticking = false;
    this.pumping = false;
    this.inflight = new Map();
    this.timer = null;
    this.runToken = 0; // 用来让停止后的旧循环不再继续调度
    this.playlistUrl = channel.url;
    // 解析后的最终媒体清单地址（通常是 CDN 直连地址）。
    // 优先复用它，避免频繁打到会限速/签名的 /mcp/ 入口。
    this.resolvedUrl = null;
    this.sourceBackoff = 0; // 源入口被限速时的退避时间
    this.activeUrl = channel.url;
    this.activeUa = channel.ua;
    this.errorStreak = 0;
    this.upstreamSeq = null; // 上游清单的 MEDIA-SEQUENCE
    this.staleTicks = 0; // 复用的 CDN 地址连续几次没更新
    this.needReresolve = false; // 清单长时间不更新，下一轮顺带回源换地址
    this.lastSeqChangeAt = 0; // 清单序列号最后一次变化的时刻
    this.lastAccess = Date.now();
    // 播放器来要清单的时间点（滚动保留 60 秒）。切片直连模式下代理看不到切片请求，
    // 只能靠“短时间内反复来要清单”判断这个频道真的在被播放。
    this.indexHits = [];
    this.lastFetchAt = 0; // 上次成功拉到上游清单的时间
    this.lastDirectListLog = 0; // 直连模式日志节流（清单）
    this.lastDirectSegLog = 0; // 直连模式日志节流（切片）
    // 播放进度：servedSeq 是播放器最后要的切片序号，playedTotal 是本次播放累计已播片数
    this.servedSeq = null;
    this.servedName = null;
    this.servedAt = 0;
    this.playedTotal = 0;
    this.playedDuration = 0;
    this.lastServedSeq = null;
    this.playbackStartedAt = 0;
    this.saveTimer = null;
    // 缓冲池：poolReleased = 已经“放水”给播放器的片数；poolClock = 上游最后一次出新片的时间
    this.poolReleased = 0;
    this.poolClock = 0;
    this.poolCadence = 0;
    this.poolDrainedLogged = false;
    // 切片直连模式：看不到切片请求，用清单滑动估算播放进度（directSeq = 上次清单开头的序号）
    this.directSeq = null;
    this.restoreWindow();
  }

  /** 重启后恢复上次的本地窗口：不用再从 3 片慢慢攒起 */
  restoreWindow() {
    if (!this.localMode()) return;
    try {
      const raw = fs.readFileSync(path.join(this.dir, 'window.json'), 'utf8');
      const d = JSON.parse(raw);
      if (!d || Date.now() - (d.savedAt || 0) > 5 * 60 * 1000) return;
      if (!Array.isArray(d.blocks) || !d.blocks.length) return;
      this.targetDuration = d.targetDuration || this.targetDuration;
      this.mediaSequence = d.mediaSequence || 0;
      this.blocks = d.blocks.map((b) => ({ ...b, tags: b.tags || [] }));
      this.segments = this.blocks;
      for (const b of this.blocks) if (b.url) this.files.set(b.name, { url: b.url, kind: 'seg' });
      log(`↺ 恢复本地窗口：${this.ch.name} ${this.blocks.length} 片`);
    } catch (_) {
      /* 没有旧窗口就算了 */
    }
  }

  /** 把当前窗口写到磁盘（节流 3 秒），重启后可秒恢复 */
  saveWindowSoon() {
    // 切片本地缓冲关闭时整条链路都是直连，不往磁盘写任何东西
    if (!this.localMode()) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // 计时器可能在“关闭切片缓冲”之前就排好了，触发时再确认一次
      if (!this.localMode()) return;
      const data = {
        savedAt: Date.now(),
        targetDuration: this.targetDuration,
        mediaSequence: this.mediaSequence,
        blocks: this.blocks.map((b) => ({
          name: b.name,
          url: b.url,
          uri: b.uri,
          dur: b.dur,
          seq: b.seq,
          tags: b.tags
        }))
      };
      fsp
        .mkdir(this.dir, { recursive: true })
        .then(() => fsp.writeFile(path.join(this.dir, 'window.json'), JSON.stringify(data)))
        .catch(() => {});
    }, 3000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  headers(ua) {
    // forceUserAgent 优先级最高：源站换了 UA 要求时，不用改 m3u 列表
    const finalUa = config.forceUserAgent || ua || this.ch.ua || config.defaultUserAgent;
    return {
      'User-Agent': finalUa,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Connection: 'close'
    };
  }

  ensureStarted() {
    // 纯直连模式（没开切片缓冲、也没开缓冲池）：不后台拉流、不预取、不落盘
    if (!this.localMode()) return;
    if (this.started) return;
    this.started = true;
    // 新一轮观看：把缓冲池重新蓄满（上一轮为了抗卡顿可能已经把池子放空了）
    if (this.poolReleased) {
      log(`🧺 缓冲池重新蓄水：${this.ch.name}`);
    }
    this.poolReleased = 0;
    // 从这里开始计时：即使上游一直不出新片，放水逻辑也能按时间启动
    this.poolClock = this.poolTargetSegments() ? Date.now() : 0;
    this.poolCadence = 0;
    this.poolDrainedLogged = false;
    this.runToken++;
    this.firstSegLogged = false;
    const token = this.runToken;
    fsp.mkdir(this.dir, { recursive: true }).catch(() => {});
    log(`▶ 开始本地缓存：${this.ch.name} (${this.id})${this.poolTargetSegments() ? ` · 缓冲池 ${Number(config.bufferPoolSeconds) || 0}s` : ''}${routeLogTag(this.playlistUrl || this.resolvedUrl || this.ch.url)}`);
    this.loop(token);
  }

  /** 停止后台拉流（不删除已解析的清单，可按需再启动） */
  stop() {
    this.started = false;
    this.runToken++;
    clearTimeout(this.timer);
    clearTimeout(this.stopTimer);
    this.timer = null;
    this.stopTimer = null;
  }

  schedule(delay, token) {
    clearTimeout(this.timer);
    // 刷新间隔必须短于切片时长，否则播放器播完手上的切片时清单还没更新，会卡住等。
    // 默认自动：目标时长 5s → 约 2s 刷一次；6s → 2.4s；9s → 3s（上限）。下限 1.2s。
    // 也可以用 playlistRefreshSeconds 固定间隔（想少回源就调大）。
    const custom = Number(config.playlistRefreshSeconds) || 0;
    let base =
      custom > 0
        ? Math.min(Math.max(custom * 1000, 1000), 60000)
        : Math.min(Math.max(this.targetDuration * 400, 1200), 3000);
    // 本地窗口还没铺满时，用更短的间隔去探上游：上游每 5~6 秒才发一片，
    // 采样间隔越粗，新片到本地就越晚。窗口铺满后再回到正常间隔，少回源。
    const need = this.windowTarget();
    const starving = this.blocks.length < need && !this.vod;
    if (starving) base = Math.min(base, 1200);
    // 源入口被限速时指数退避，避免越请求越被拒。
    // 但窗口还没铺满时不能用长退避：一次超时退 6~15 秒，缓冲直接就饿死了，
    // 这种情况下最多等 2 秒再试。
    const backoff = this.sourceBackoff || 0;
    const wait = Math.max(delay != null ? delay : base, starving ? Math.min(backoff, 2000) : backoff);
    this.timer = setTimeout(() => {
      if (token != null && token !== this.runToken) return;
      this.loop(token);
    }, wait);
  }

  async loop(token) {
    try {
      await this.tick();
    } catch (e) {
      log(`[${this.ch.name}] 刷新失败: ${e.message}`);
    }
    // 已被停止（换台/关闭切片/空闲）或已切到纯直连模式：不再继续调度
    if (token != null && token !== this.runToken) return;
    if (!this.started || !this.localMode()) {
      this.stop();
      return;
    }
    if (this.vod) return;

    const idle = Math.max(1, Number(config.idleStopMinutes) || 10) * 60 * 1000;
    if (Date.now() - this.lastAccess > idle) {
      this.stop();
      log(`⏸ 停止空闲频道：${this.ch.name}`);
      return;
    }
    this.schedule(null, token);
  }

  /** 拉一次上游清单并解析（并发调用会复用同一个请求） */
  tick() {
    if (this.ticking) return this.tickingPromise;
    this.ticking = true;
    this.tickingPromise = this.doFetch().finally(() => {
      this.ticking = false;
      this.tickingPromise = null;
    });
    return this.tickingPromise;
  }

  /** 多源并发尝试，返回第一个成功的 */
  raceSources(candidates) {
    return new Promise((resolve, reject) => {
      let remaining = candidates.length;
      let settled = false;
      let lastErr = null;

      candidates.forEach((c, i) => {
        setTimeout(async () => {
          if (settled) return;
          try {
            const r = await getWithRetry(
              c.url,
              { headers: this.headers(c.ua), timeout: config.requestTimeoutMs },
              0
            );
            if (settled) return;
            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
            const body = r.body.toString('utf8');
            // mcp 拿不到真流时会 302 到一段 2 分钟的演示/广告片，必须当成失败
            if (config.rejectDemoSources !== false && (isDemoUrl(r.url) || isDemoPlaylist(body))) {
              setDemoState(this.ch.name, c.url, true);
              throw new Error('上游返回演示视频');
            }
            setDemoState(this.ch.name, c.url, false);
            settled = true;
            resolve({ c, r });
          } catch (e) {
            lastErr = e;
            if (--remaining === 0 && !settled) reject(lastErr);
          }
        }, i === 0 ? 0 : 600 * i);
      });
    });
  }

  async doFetch() {
    try {
      let text = null;
      let base = null;

      // ① 先复用上次解析出的 CDN 媒体清单地址
      //    但 QQ / 咪咕这些 CDN 有时会把清单缓存住，序列号 20 秒不动就强制回源换新地址
      if (this.resolvedUrl) {
        try {
          const r0 = await getWithRetry(
            this.resolvedUrl,
            { headers: this.headers(this.activeUa), timeout: config.requestTimeoutMs },
            1
          );
          if (r0.status === 200 && !/#EXT-X-STREAM-INF/i.test(r0.body.toString('utf8'))) {
            const b0 = r0.body.toString('utf8');
            if (config.rejectDemoSources !== false && (isDemoUrl(r0.url) || isDemoPlaylist(b0))) {
              this.resolvedUrl = null;
              setDemoState(this.ch.name, this.ch.url, true);
              throw new Error('演示视频');
            }
            const seq0 = seqOf(b0);
            if (seq0 !== null && seq0 === this.upstreamSeq) {
              this.staleTicks++;
              // CDN 清单被缓存时序列号会连续多次不变。这里按“多久没变”判断，
              // 而不是按次数：窗口没铺满时刷新间隔很短，按次数会 5 秒就误判回源。
              if (!this.lastSeqChangeAt) this.lastSeqChangeAt = Date.now();
              if (Date.now() - this.lastSeqChangeAt > 20000) {
                if (config.debug) log(`→ 清单 ${Math.round((Date.now() - this.lastSeqChangeAt) / 1000)}s 未更新，回源换地址 ${this.ch.name}`);
                // 只标记“该回源了”，不清掉 CDN 地址：回源经常超时，
                // 清掉就彻底没清单可用了，窗口当场饿死。下一轮继续拿旧地址探。
                this.needReresolve = true;
              }
            } else {
              this.staleTicks = 0;
              this.lastSeqChangeAt = Date.now();
            }
            text = b0;
            base = r0.url || this.resolvedUrl;
            if (config.debug) log(`→ 复用 CDN 清单 ${this.ch.name}`);
          }
        } catch (_) {
          /* 过期就回落到源地址 */
        }
      }

      // ② 回落到源清单（/mcp/ 或 /mg/ 入口），失败时自动换同名备用源
      //    已经拿到（哪怕过期的）CDN 清单时，回源失败不算这次失败，继续用旧清单。
      if (!text || this.needReresolve) {
        if (config.debug) log(`→ 回源解析（${text ? '清单长时间未更新' : '无可用清单'}）${this.ch.name}`);
        const candidates = [];
        const push = (url, ua) => {
          if (url && !candidates.some((c) => c.url === url)) candidates.push({ url, ua });
        };
        if (config.autoFailover && this.activeUrl) push(this.activeUrl, this.activeUa);
        push(this.ch.url, this.ch.ua);
        if (config.autoFailover) {
          for (const alt of channelGroups.get(this.ch.name) || []) {
            if (alt.id !== this.ch.id) push(alt.url, alt.ua);
          }
        }

        // 多源并赛：主源先起跑，备用源依次错开 600ms，谁先成功用谁
        let win;
        try {
          win = await this.raceSources(candidates);
        } catch (e) {
          if (text) {
            if (config.debug) log(`→ 回源失败，继续用旧清单 ${this.ch.name}（${e.message}）`);
          } else {
            throw new Error(`所有源均不可用（${e.message}）`);
          }
        }
        if (win) {
          text = win.r.body.toString('utf8');
          base = win.r.url || win.c.url;
          if (win.c.url !== this.ch.url) log(`↪ ${this.ch.name} 已切换到备用源`);
          this.activeUrl = win.c.url;
          this.activeUa = win.c.ua;
          this.needReresolve = false;
        }
      }

      // ③ 多码率主清单 → 取子清单
      if (/#EXT-X-STREAM-INF/i.test(text)) {
        const variant = pickVariant(text, base);
        if (!variant) throw new Error('主清单无可用码率');
        const rs = await getWithRetry(
          variant,
          { headers: this.headers(), timeout: config.requestTimeoutMs },
          config.playlistRetries
        );
        if (rs.status !== 200) throw new Error(`子清单 HTTP ${rs.status}`);
        text = rs.body.toString('utf8');
        base = rs.url || variant;
      }

      this.resolvedUrl = base;
      this.applyPlaylist(text, base);
      this.lastFetchAt = Date.now();
      this.sourceBackoff = 0;
      this.errorStreak = 0;
      // 能正常解析出真流，说明源是好的（演示源恢复后会自动回到播放列表）
      setDemoState(this.ch.name, this.ch.url, false);
      this.pump().catch(() => {});
    } catch (e) {
      this.errorStreak++;
      this.lastError = e.message;
      this.sourceBackoff = Math.min(this.sourceBackoff ? this.sourceBackoff * 2 : 3000, 15000);
      if (this.errorStreak === 1 || this.errorStreak % 10 === 0) {
        log(`[${this.ch.name}] ${e.message}`);
      }
      if (/40[13]|503/.test(e.message)) requestSourceRefresh();
      // 连续失败时丢弃缓存的 CDN 地址，下次回到源入口重新解析
      if (this.errorStreak > 0 && this.errorStreak % 5 === 0) this.resolvedUrl = null;
      throw e;
    }
  }

  applyPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);

    const td = parseFloat((text.match(/#EXT-X-TARGETDURATION:([\d.]+)/i) || [])[1] || '');
    if (td > 0) this.targetDuration = td;

    const ms = parseInt((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i) || [])[1] || '');
    const prevSeq = this.upstreamSeq;
    if (!Number.isNaN(ms)) {
      this.mediaSequence = ms;
      this.upstreamSeq = ms;
    }

    this.vod = /#EXT-X-ENDLIST/i.test(text);

    const blocks = [];
    const files = this.files; // 累积而非重建，避免窗口滑走后旧切片查不到地址
    let tags = [];

    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;

      if (t.startsWith('#')) {
        // 清单头由我们自己重新生成
        if (/^#EXTM3U/i.test(t)) continue;
        // LL-HLS 的 PART/PRELOAD-HINT 不支持，直接丢弃
        if (/^#EXT-X-(PART|PRELOAD-HINT|RENDITION-REPORT|SERVER-CONTROL|PART-INF)/i.test(t)) continue;
        // 这些由我们自己重写
        if (/^#EXT-X-(ENDLIST|MEDIA-SEQUENCE|TARGETDURATION|VERSION)/i.test(t)) continue;
        tags.push(t);
        continue;
      }

      // 切片 URI 行
      let abs;
      try {
        abs = new URL(t, baseUrl).toString();
      } catch (_) {
        tags = [];
        continue;
      }
      const name = sha(abs) + extOf(abs);
      const dur = parseFloat((tags.find((x) => /^#EXTINF:/i.test(x)) || '').slice(8)) || this.targetDuration;
      blocks.push({ tags, uri: t, url: abs, name, dur });
      files.set(name, { url: abs, kind: 'seg' });
      this.lastSeen.set(name, Date.now());
      tags = [];
    }

    // 补齐 KEY / MAP 等外链
    const localize = this.localMode();
    const rewrittenTags = [];
    for (const b of blocks) {
      const newTags = b.tags.map((tag) =>
        localize ? this.rewriteTagUris(tag, baseUrl, files) : this.absoluteTagUris(tag, baseUrl)
      );
      rewrittenTags.push(newTags);
    }

    const fresh = blocks.map((b, i) => ({ ...b, tags: rewrittenTags[i] }));

    // 累积窗口：上游清单往往只有 3~6 个切片（腾讯直播只有 15~30 秒），
    // 而且源站限速时会整段卡住几十秒再跳一大截。
    // 这里把抓过的切片都接在前面，保证播放器手上始终有足够长的清单。
    const prev = this.blocks || [];
    // 缓冲池需要把窗口攒起来才有“垫底”的片；纯直连模式（池子 0）不累积，
    // 因为上游切片地址是带签名的临时链接，放久了会失效。
    const canAccumulate = this.localMode();
    // 窗口 = 缓冲池 + 给播放器的历史片；windowTarget 里已经算好上限
    const keep = this.windowTarget();
    const prevNames = new Set(prev.map((b) => b.name));
    const freshNames = new Set(fresh.map((b) => b.name));
    const overlap = fresh.some((b) => prevNames.has(b.name));
    // 回源换 CDN 时域名/路径会变，但媒体序列号是接着走的，
    // 只要编号连续就认为还是同一个流，不能因此把累积窗口清零。
    const seqNum = Number.isNaN(ms) ? null : ms;
    const seqOk =
      prevSeq != null && seqNum != null && seqNum >= prevSeq && seqNum - prevSeq <= keep * 3;

    // 每个切片自带单调递增序号。上游换 CDN/换码率时 MEDIA-SEQUENCE 会整体跳变，
    // 有时甚至倒退几十万，直接透传给播放器会被判定为时间线断裂 → 定格重连。
    const prevSeqOf = new Map(prev.map((b) => [b.name, b.seq]));
    let nextSeq = prev.length && prev[prev.length - 1].seq != null
      ? prev[prev.length - 1].seq + 1
      : seqNum != null
        ? seqNum
        : 0;
    const freshSeq = fresh.map((b) => {
      const s = prevSeqOf.get(b.name);
      return s != null ? { ...b, seq: s } : { ...b, seq: nextSeq++ };
    });

    let merged;
    if (canAccumulate && prev.length && (overlap || seqOk)) {
      merged = prev.filter((b) => !freshNames.has(b.name)).concat(freshSeq);
    } else {
      merged = freshSeq; // 换源/换台/直连模式，不能把上一个流的切片拼进来
    }

    // 缓冲池：先用新窗口判断“播放器前方还有多少片”，再决定要从池子里放水还是蓄水
    this.blocks = merged;
    this.notePoolProgress(freshSeq.filter((b) => !prevNames.has(b.name)).length);

    if (merged.length > keep) {
      let start = merged.length - keep;
      // 播放器正在播（或即将播）的切片不能被裁掉，否则它请求到 404 就定格重连。
      const last = merged[merged.length - 1].seq;
      if (this.servedSeq != null && last - this.servedSeq <= keep * 2) {
        const idx = merged.findIndex((b) => b.seq >= this.servedSeq);
        if (idx >= 0 && idx - 2 < start) start = Math.max(0, idx - 2);
      }
      // 保护范围有上限，避免播放器长期停在某处时窗口无限增长
      start = Math.max(start, merged.length - keep * 3);
      merged = merged.slice(start);
    }

    this.mediaSequence = merged.length ? merged[0].seq : this.mediaSequence;

    this.blocks = merged;
    this.segments = merged;
    this.files = files;
    this.playlistUrl = baseUrl;
    this.saveWindowSoon();

    // 地址表只保留最近 10 分钟见过的：直连模式下长时间运行也不会无限涨内存
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [name, seenAt] of this.lastSeen) {
      if (seenAt < cutoff) {
        this.lastSeen.delete(name);
        this.files.delete(name);
      }
    }
  }

  /** 把标签里的 URI="..." 改写成绝对地址（不经过本地缓存时用） */
  absoluteTagUris(tag, baseUrl) {
    if (!/URI="/i.test(tag)) return tag;
    return tag.replace(/URI="([^"]+)"/gi, (m, uri) => {
      try {
        return `URI="${new URL(uri, baseUrl).toString()}"`;
      } catch (_) {
        return m;
      }
    });
  }

  /** 把标签里的 URI="..." 改写成 /s/<id>/aux/<name> */
  rewriteTagUris(tag, baseUrl, files) {
    if (!/URI="/i.test(tag)) return tag;
    if (!/^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF)/i.test(tag)) return tag;
    return tag.replace(/URI="([^"]+)"/gi, (m, uri) => {
      let abs;
      try {
        abs = new URL(uri, baseUrl).toString();
      } catch (_) {
        return m;
      }
      const name = 'aux-' + sha(abs) + extOf(abs, '.bin');
      files.set(name, { url: abs, kind: 'aux' });
      this.lastSeen.set(name, Date.now());
      return `URI="/s/${this.id}/aux/${name}"`;
    });
  }

  /** 生成给播放器的本地清单 */
  buildPlaylist(origin, publicUrlFor) {
    // 缓冲池：末尾 hold 片只留在本地、不下发，播放器因此始终落后直播 N 秒。
    // 上游抖动/短暂断流时，播放器还在吃已下发的那段，本地池子 meanwhile 继续补齐，
    // 所以不会把播放器缓冲吃空。窗口没铺满时 poolPlan 会自动少扣，保证立刻有画面。
    const plan = this.poolPlan();
    const blocks = plan.hold > 0 ? this.blocks.slice(0, plan.exposed) : this.blocks;
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(this.targetDuration)}`];
    if (this.mediaSequence) out.push(`#EXT-X-MEDIA-SEQUENCE:${this.mediaSequence}`);

    // 起播策略：立即从清单最新处开始播（不写 #EXT-X-START 强行倒退，
    // 也不让播放器等预存），latency 由缓冲池决定，起播速度不受影响。
    const localize = plan.local;
    for (const b of blocks) {
      for (const tag of b.tags) out.push(tag);
      if (!b.tags.some((x) => /^#EXTINF:/i.test(x))) {
        out.push(`#EXTINF:${b.dur.toFixed(3)},`);
      }
      // 纯直连模式（没开缓冲池）时直接给上游地址
      out.push(localize && publicUrlFor ? publicUrlFor(b.name) : b.url || `seg/${b.name}`);
    }
    if (this.vod) out.push('#EXT-X-ENDLIST');
    return out.join('\n') + '\n';
  }

  // --- 预取 ---------------------------------------------------------------

  async pump() {
    if (!this.localMode()) return; // 纯直连且没开缓冲池：不落盘、不预取
    if (this.pumping) return;
    this.pumping = true;
    try {
      // 播放器最需要“接下来要播的几片”和池子里的新片，先下这些；
      // 最后再补更老的历史片（播放器从窗口开头起播时会用到）。
      const exposed = this.poolPlan().exposed;
      const tail = this.segments.slice(Math.max(0, exposed - 4), exposed);
      const held = this.segments.slice(exposed).slice().reverse();
      const rest = this.segments.slice(0, Math.max(0, exposed - 4));
      const queue = tail.concat(held, rest);
      const conc = Math.max(1, Number(config.prefetchConcurrency) || 1);
      let next = 0;
      const worker = async () => {
        while (next < queue.length) {
          const b = queue[next++];
          if (!b || !b.name || this.inflight.has(b.name)) continue;
          // 预取用短超时、不重试：拿不到就算了，下一次刷新再补，绝不阻塞后面的新片
          await this.prefetchFile(b.name).catch(() => null);
        }
      };
      await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, worker));
    } finally {
      this.pumping = false;
    }
  }

  /**
   * 首次起播前，先把对外清单开头和末尾的几片拉到本地。
   * 播放器一般从清单末尾（贴近直播）或开头起播，提前下好可避免起播时干等。
   */
  async prepareStartup(count = 3, waitMs = 1500) {
    if (!this.localMode() || this.vod) return;
    if (this.servedSeq != null) return; // 已经在播，靠常驻预取维护
    const exposed = this.playbackStat().total;
    if (exposed <= 0) return;
    const first = this.blocks.slice(0, Math.min(count, exposed));
    const tail = this.blocks.slice(Math.max(0, exposed - count), exposed);
    const seen = new Set();
    const targets = [];
    for (const b of first.concat(tail)) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      targets.push(b);
    }
    const job = Promise.all(targets.map((b) => this.ensureFile(b.name).catch(() => null)));
    await Promise.race([job, sleep(waitMs)]);
  }

  /** 后台预取：短超时、单次尝试，失败不重试（播放器真来要时会走带重试的 ensureFile） */
  async prefetchFile(name) {
    const file = this.filePath(name);
    if (await this.isCached(name)) return file;
    if (this.inflight.has(name)) return this.inflight.get(name);

    const job = (async () => {
      const meta = this.files.get(name);
      if (!meta || !meta.url) throw new Error(`未知切片 ${name}`);
      const timeout = Math.min(Number(config.segmentTimeoutMs) || 8000, 8000);
      const r = await getWithRetry(meta.url, { headers: this.headers(), timeout }, 0);
      if (r.status !== 200) throw new Error(`切片 HTTP ${r.status}`);
      // 预取期间可能刚好关掉了切片本地缓冲：不再落盘
      if (!this.localMode()) throw new Error('切片本地缓冲已关闭，跳过落盘');
      await fsp.mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
      await fsp.writeFile(tmp, r.body);
      await fsp.rename(tmp, file);
      if (!this.localMode()) {
        await fsp.unlink(file).catch(() => {});
        throw new Error('切片本地缓冲已关闭，已丢弃切片');
      }
      return file;
    })().finally(() => this.inflight.delete(name));

    this.inflight.set(name, job);
    return job;
  }

  filePath(name) {
    return path.join(this.dir, name);
  }

  /** 按 bufferSeconds 换算成本地应缓存多少片；0 = 用片数配置 */
  bufferSegments() {
    const secs = Number(config.bufferSeconds) || 0;
    if (secs <= 0) return null;
    const dur = this.targetDuration || 5;
    return Math.max(4, Math.ceil(secs / dur));
  }

  /** 缓冲池目标片数（按配置的秒数换算）；0 = 关闭 */
  poolTargetSegments() {
    if (this.vod) return 0;
    // 缓冲池靠“切片攒在盒子本地”实现；切片本地缓冲关掉后切片直接透传上游，
    // 没有可攒的东西，池子一并停用（不再缓存任何切片）。
    if (config.segmentsEnabled === false) return 0;
    const secs = Number(config.bufferPoolSeconds) || 0;
    if (secs <= 0) return 0;
    const dur = this.targetDuration || 5;
    // 至少 2 片：池子太薄等于没开
    return Math.max(2, Math.ceil(secs / dur));
  }

  /**
   * 当前实际扣在末尾的片数（= 池子里还剩多少没放给播放器）。
   *
   * 池子不是死的：上游一直不出新片时，播放器迟早会把自带缓冲吃空。
   * 所以这里按“上游已经停滞多久”从池子里放片出来（每秒约一片），
   * 让播放器一直有新片可播；上游恢复后再慢慢蓄回去。
   * 放出去的片数记在 poolReleased 里，只增不减（除了蓄水时收回），
   * 保证对外清单的结尾只前进不后退 —— 清单倒退会让播放器定格重连。
   */
  holdSegments() {
    const full = this.poolTargetSegments();
    if (!full) return 0;
    const td = Math.max(1, this.targetDuration || 5);
    // 上游的实际出片节奏（有些台 10 秒才出一片），按它判断“卡住”才准
    const cadence = Math.max(td, Math.min(this.poolCadence || td, td * 4));
    // 只有真的有人在播、且频道正在运行时才放水，避免闲置后一开播池子是空的
    const playingRecently = this.servedAt && Date.now() - this.servedAt < 60000;
    if (playingRecently && this.poolClock) {
      const staleSec = (Date.now() - this.poolClock) / 1000;
      // 先给上游 1.8 个出片周期的容忍，小抖动不动池子
      const grace = cadence * 1.8;
      if (staleSec > grace) {
        const want = Math.min(full, Math.ceil((staleSec - grace * 0.5) / cadence));
        if (want > (this.poolReleased || 0)) {
          this.poolReleased = want;
          if (!this.poolDrainedLogged) {
            this.poolDrainedLogged = true;
            log(`🧺 缓冲池开始放水：${this.ch.name}（上游约 ${Math.round(staleSec)}s 未出新片）`);
          }
        }
      }
    }
    return Math.max(0, full - (this.poolReleased || 0));
  }

  /** 是否要把切片落到盒子本地：只看「切片本地缓冲」开关，缓冲池依附于它 */
  localMode() {
    return config.segmentsEnabled !== false;
  }

  /** 本地窗口目标片数（含池子），applyPlaylist 与调度都用这个 */
  windowTarget() {
    const bufSegs = this.bufferSegments();
    const hold = this.poolTargetSegments();
    let keep = Math.max(
      bufSegs != null ? bufSegs : Math.max(4, Number(config.playlistWindow) || 18),
      hold + 6,
      10
    );
    // 直连模式下切片地址是带签名的临时链接，窗口不能拉太长，避免放久了签名过期
    if (config.segmentsEnabled === false) keep = Math.min(keep, hold + 12);
    return keep;
  }

  /**
   * 窗口切分：末尾扣住多少片（池子）、对外清单发多少片。
   * 池子最多占 full 片；窗口刚起步时最多只扣到“还给播放器 6 片”为止，
   * 保证换台立刻有画面，而且对外清单的长度只增不减（不会突然缩回去）。
   */
  poolPlan() {
    const total = this.blocks ? this.blocks.length : 0;
    const hold = Math.min(this.holdSegments(), Math.max(0, total - 6));
    return { total, hold, exposed: Math.max(0, total - hold), local: this.localMode() };
  }

  /** 播放器前方还有几片没播（判断能不能把池子再蓄回去，别把播放器饿着） */
  playaheadSegments() {
    const idx = this.blocks.findIndex((b) => b.seq === this.servedSeq);
    if (idx < 0) return Infinity; // 还没开始播，放心蓄水
    return Math.max(0, this.poolPlan().exposed - idx - 1);
  }

  /**
   * 每次拉到新清单时调用：
   *  - 上游出新片 → 记下时间（池子不用放水），并视播放器余量把放出去的片收回来；
   *  - 上游没动 → 什么都不做，放水由 holdSegments() 按时间判断。
   */
  notePoolProgress(newSegs) {
    if (!this.poolTargetSegments()) {
      this.poolReleased = 0;
      this.poolClock = 0;
      return;
    }
    if (newSegs > 0) {
      const now = Date.now();
      // 记录实际出片节奏（指数平滑），供 holdSegments 判断“是不是真卡了”
      const gap = this.poolClock ? (now - this.poolClock) / 1000 : 0;
      if (gap > 0.5 && gap < 120) {
        const td = Math.max(1, this.targetDuration || 5);
        const sample = Math.max(td, Math.min(gap, td * 4));
        this.poolCadence = this.poolCadence ? this.poolCadence * 0.7 + sample * 0.3 : sample;
      }
      this.poolClock = now;
      this.poolDrainedLogged = false;
      const released = this.poolReleased || 0;
      // 慢慢把放出去的片收回来（重新蓄水）。每次最多收 1 片：
      // 上游恢复时可能一次冒出一大串新片，一口气全扣回池子会让对外清单的结尾
      // 突然往回缩，播放器正在等的那片就 404 了。一次收一片时，新片往前走一片、
      // 池子多扣一片，对外清单的结尾原地不动或继续前进，绝不会倒退。
      // 另外播放器前方至少还剩 2 片才收，别把它正在等的下一片关进池子。
      const absorb = Math.min(newSegs, 1);
      if (released > 0 && this.playaheadSegments() >= absorb + 1) {
        this.poolReleased = Math.max(0, released - absorb);
      }
    }
  }

  /**
   * 切片直连模式下看不到切片请求：用清单开头的序号滑动估算播放进度。
   * 清单往前滑走一片，就当播放器播完了一片；换源/换台（序号大幅回退）时从头算。
   */
  noteDirectPlayback() {
    const blocks = this.blocks || [];
    if (!blocks.length) return;
    const head = blocks[0].seq;
    if (head == null) return;
    // 用上游清单的 MEDIA-SEQUENCE 估进度：内部序号是代理自己编的，换源时也只会递增
    const up = Number.isFinite(this.upstreamSeq) ? this.upstreamSeq : head;
    const td = this.targetDuration || 5;
    if (this.directSeq != null && (up < this.directSeq - 3 || up > this.directSeq + 300)) {
      // 上游时间线断开（换源/回看跳变）：进度从头算
      this.playedTotal = 0;
      this.playedDuration = 0;
      this.playbackStartedAt = Date.now();
      this.lastServedSeq = null;
    }
    this.markPlayed(up, td);
    this.directSeq = up;
    // 进度落在清单开头：剩余/未播按“清单里还没播的片”估算
    this.servedSeq = head;
    this.servedName = blocks[0].name;
  }

  /** 记录播放器请求的切片，累计“已播切片”数（只增不减，和窗口滑动无关） */
  markPlayed(seq, dur) {
    if (seq == null) return;
    const d = Number(dur) || this.targetDuration || 5;
    if (this.lastServedSeq == null) {
      this.lastServedSeq = seq;
      this.playedTotal = 1;
      this.playedDuration = d;
      this.playbackStartedAt = Date.now();
      return;
    }
    if (seq > this.lastServedSeq) {
      const skipped = Math.max(0, seq - this.lastServedSeq - 1);
      this.playedTotal += seq - this.lastServedSeq;
      this.playedDuration += d + skipped * d;
      this.lastServedSeq = seq;
      return;
    }
    // 播放器重复取同一片、或回退一两片很常见，忽略；
    // 大幅回退（换台/跳转/重新起播）则从 1 重新算。
    if (this.lastServedSeq - seq > 3) {
      this.lastServedSeq = seq;
      this.playedTotal = 1;
      this.playedDuration = d;
      this.playbackStartedAt = Date.now();
    }
  }

  /** 播放进度：播放器播到第几片、窗口还缓存多少片、后面还有多少秒没播 */
  playbackStat() {
    const blocks = this.blocks || [];
    const td = this.targetDuration || 5;
    const total = blocks.length;
    // 和 buildPlaylist 共用同一套窗口切分，避免两边算的不一样
    const plan = this.poolPlan();
    const effHold = plan.hold;
    // 对外清单只暴露前 exposed 片，扣住的部分算“已缓存但还没下发”的缓冲池
    const exposed = plan.exposed;
    let idx = -1;
    if (this.servedSeq != null) idx = blocks.findIndex((b) => b.seq === this.servedSeq);
    if (idx < 0 && this.servedName) idx = blocks.findIndex((b) => b.name === this.servedName);
    const durOf = (b) => b.dur || td;
    // 剩余 = 播放器当前位置到直播边缘（含被扣住的池子），这就是它真正的缓冲深度
    const remaining = idx >= 0 ? blocks.slice(idx + 1).reduce((a, b) => a + durOf(b), 0) : 0;
    // 拆成两段：播放器现在就能取的（已下发部分）+ 末尾的缓冲池
    const exposedEnd = Math.min(blocks.length, exposed);
    const safeIdx = idx >= 0 ? Math.min(idx, exposedEnd - 1) : -1;
    const playable = safeIdx >= 0 ? blocks.slice(safeIdx + 1, exposedEnd).reduce((a, b) => a + durOf(b), 0) : 0;
    const buffered = blocks.reduce((a, b) => a + durOf(b), 0);
    // 未播切片 = 本地窗口里播放器还没取过的片（已下发和扣住的都算，它迟早要播）
    const unplayedIdx = idx >= 0 ? idx + 1 : 0;
    const unplayedBlocks = blocks.slice(unplayedIdx);
    const unplayed = unplayedBlocks.length;
    const unplayedSeconds = unplayedBlocks.reduce((a, b) => a + durOf(b), 0);
    // 池子实际有多长（秒）：给管理页显示“抗抖动余量”
    const holdSeconds = blocks.slice(exposedEnd).reduce((a, b) => a + durOf(b), 0);
    return {
      total: exposed,
      cached: total,
      played: idx >= 0 ? Math.min(idx + 1, exposed) : 0,
      playedTotal: this.playedTotal || 0,
      playedSeconds: Math.round(this.playedDuration || 0),
      unplayed: unplayed,
      unplayedSeconds: Math.round(unplayedSeconds),
      remaining: Math.round(remaining),
      playableSeconds: Math.round(playable),
      holdRemainingSeconds: Math.max(0, Math.round(remaining - playable)),
      bufferedSeconds: Math.round(buffered),
      holdSeconds: Math.round(holdSeconds),
      holdSegments: effHold,
      // 切片模式下看播放器有没有取过切片；切片直连模式下看不到切片请求，
      // 就用最近 60 秒内是否反复来要清单来判断“正在播放”。
      playing:
        Date.now() - (this.lastAccess || 0) < 30000 &&
        (idx >= 0 ||
          (Array.isArray(this.indexHits) &&
            this.indexHits.filter((t) => Date.now() - t < 60000).length >= 2))
    };
  }

  async isCached(name) {
    try {
      await fsp.access(this.filePath(name));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 确保切片在本地；不存在就下载（去重 + 重试） */
  async ensureFile(name) {
    const file = this.filePath(name);
    if (await this.isCached(name)) return file;

    if (this.inflight.has(name)) return this.inflight.get(name);

    const job = (async () => {
      let meta = this.files.get(name);
      if (!meta) {
        // 未知切片：刷新一次清单再试
        await this.tick();
        meta = this.files.get(name);
        if (!meta) throw new Error(`未知切片 ${name}`);
      }

      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await getWithRetry(
            meta.url,
            { headers: this.headers(), timeout: config.segmentTimeoutMs },
            attempt === 0 ? 2 : 0
          );
          if (r.status !== 200) throw new Error(`切片 HTTP ${r.status}`);
          // 下载期间可能刚好关掉了切片本地缓冲：不再落盘
          if (!this.localMode()) throw new Error('切片本地缓冲已关闭，跳过落盘');
          await fsp.mkdir(this.dir, { recursive: true });
          const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
          await fsp.writeFile(tmp, r.body);
          await fsp.rename(tmp, file);
          // 落盘瞬间刚关掉切片缓冲：把这一个文件删掉，别留残留
          if (!this.localMode()) {
            await fsp.unlink(file).catch(() => {});
            throw new Error('切片本地缓冲已关闭，已丢弃切片');
          }
          return file;
        } catch (e) {
          lastErr = e;
          // 地址可能已过期，刷新清单换新地址再试一次
          if (attempt === 0) {
            try {
              await this.tick();
              const fresh = this.files.get(name);
              if (fresh) meta = fresh;
            } catch (_) {}
            await sleep(200);
          }
        }
      }
      throw lastErr || new Error('切片下载失败');
    })().finally(() => this.inflight.delete(name));

    this.inflight.set(name, job);
    return job;
  }

  /** 清理过期切片（不在当前窗口且超过 5 分钟未出现） */
  async prune() {
    if (this.vod) return;
    const now = Date.now();
    const windowNames = new Set(this.segments.map((b) => b.name));

    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (!/\.(ts|m4s|mp4|m4v|m4a|aac|mp3|bin|vtt)$/i.test(name)) continue;
      if (windowNames.has(name)) continue;
      const seen = this.lastSeen.get(name) || 0;
      if (now - seen < 300000) continue;
      fsp.unlink(path.join(this.dir, name)).catch(() => {});
      this.files.delete(name);
      this.lastSeen.delete(name);
    }

    // 地址表也跟着窗口收敛，避免长时间运行后无限增长
    for (const [name] of this.files) {
      if (windowNames.has(name)) continue;
      if (now - (this.lastSeen.get(name) || 0) < 900000) continue;
      this.files.delete(name);
      this.lastSeen.delete(name);
    }
  }
}

const streams = new Map();

// 播放器最后请求的频道。开启“只拉当前频道”时，只有它允许后台拉流。
let currentChannelId = null;

function switchCurrentChannel(st) {
  const prevId = currentChannelId;
  currentChannelId = st.id;
  st.lastUsedAt = Date.now();
  clearTimeout(st.stopTimer); // 又被切回来：取消待执行的停止
  // 配了预热频道数时，由 warmSweep 统一决定谁停谁继续，这里不急着停
  if (!config.onlyCurrentChannel || Number(config.preloadChannels) !== 0 || prevId === st.id) return;

  for (const [id, other] of streams) {
    if (id === st.id) continue;
    if (!other.started) continue;
    // 电视切台时偶尔会在两个频道之间来回试探，立刻停掉会导致两边都反复重启拉流。
    // 这里给 20 秒宽限：期间又切回去就取消，避免窗口被打断。
    clearTimeout(other.stopTimer);
    other.stopTimer = setTimeout(() => {
      if (currentChannelId === other.id || !other.started) return;
      other.stop();
      log(`⏹ 换台停止旧频道：${other.ch.name} (${id})`);
    }, 20000);
  }
}

/**
 * 预热频道：让“当前频道 + 最近看过的 N 个频道”保持本地预存。
 * preloadChannels = 0 只要当前频道；N=同时预热 N 个；-1 = 全部频道（请求量大，慎用）。
 */
let lastWarmSweep = 0;
function warmSweep() {
  // 切片本地缓冲关闭时切片全部直连上游，不预热、不落盘
  if (config.segmentsEnabled === false) return;
  const n = Number(config.preloadChannels);
  if (!Number.isFinite(n) || n === 0) return;
  if (Date.now() - lastWarmSweep < 10000) return;
  lastWarmSweep = Date.now();

  const keep = new Set();
  if (n < 0) {
    for (const ch of channels) keep.add(ch.id);
  } else {
    if (currentChannelId) keep.add(currentChannelId);
    const recent = [...streams.values()].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    for (const s of recent) {
      if (keep.size >= n) break;
      keep.add(s.id);
    }
  }

  for (const id of keep) {
    const st = getStream(id);
    if (st) {
      st.lastUsedAt = st.lastUsedAt || 0;
      // 预热中的频道由 warmSweep 统一管理，不参与 loop 里的“空闲停流”判断，
      // 否则刚启动的预热频道会因为 lastAccess 太旧，1 秒后又被停掉，反复重启。
      st.lastAccess = Date.now();
      st.ensureStarted();
    }
  }
  // 停掉既不在预热名单、也超过 2 分钟没人看的频道
  const idleMs = Math.max(2 * 60 * 1000, (Number(config.idleStopMinutes) || 10) * 60000);
  for (const [id, st] of streams) {
    if (keep.has(id)) continue;
    if (!st.started) continue;
    if (Date.now() - (st.lastUsedAt || 0) < idleMs) continue;
    st.stop();
    log(`⏸ 停止闲置预热：${st.ch.name}`);
  }
}

function getStream(id) {
  const ch = channels.find((c) => c.id === id);
  if (!ch) return null;
  let st = streams.get(id);
  if (!st) {
    st = new Stream(ch);
    streams.set(id, st);
  } else {
    st.ch = ch;
  }
  return st;
}

let sourceTimer = null;

function scheduleSource() {
  clearInterval(sourceTimer);
  sourceTimer = null;
  const minutes = Number(config.sourceRefreshMinutes) || 0;
  if (minutes <= 0) return;
  sourceTimer = setInterval(() => loadSource(true).catch(() => {}), minutes * 60 * 1000);
  if (sourceTimer.unref) sourceTimer.unref();
}

// ---------------------------------------------------------------------------
// 管理页面：配置读写 / 操作
// ---------------------------------------------------------------------------

function checkAdminAuth(req, res) {
  const pass = String(config.adminPassword || '');
  if (!pass) return true;
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Basic\s+(.+)$/i);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const given = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (given === pass) return true;
    } catch (_) {}
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="m3u-proxy", charset="UTF-8"' });
  res.end('需要管理密码');
  return false;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function coerceField(field, value) {
  if (field.type === 'boolean') {
    if (typeof value === 'string') return value === 'true' || value === '1' || value === 'on';
    return !!value;
  }
  if (field.type === 'number') {
    let n = Number(value);
    if (!Number.isFinite(n)) n = Number(DEFAULT_CONFIG[field.key]) || 0;
    // 所有数字配置项都是整数（端口、秒数、毫秒、MB），避免出现小数
    n = Math.round(n);
    if (field.min != null) n = Math.max(field.min, n);
    if (field.max != null) n = Math.min(field.max, n);
    return n;
  }
  if (field.type === 'tags') {
    const arr = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,，\s]+/);
    return arr.map((s) => String(s).trim()).filter(Boolean);
  }
  if (field.type === 'urls') {
    const arr = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\r\n,，\s]+/);
    const out = [];
    for (const a of arr) {
      const s = String(a || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  }
  return value == null ? '' : String(value);
}

function persistConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

async function saveConfigFromBody(input) {
  const before = Object.assign({}, config);
  const next = Object.assign({}, config);
  for (const f of CONFIG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, f.key)) next[f.key] = coerceField(f, input[f.key]);
  }

  if (!path.isAbsolute(next.cacheDir)) next.cacheDir = path.join(ROOT, next.cacheDir);
  if (next.source && !/^https?:/i.test(next.source) && !path.isAbsolute(next.source)) {
    next.source = path.join(ROOT, next.source);
  }

  const restartKeys = ['port', 'host', 'cacheDir'];
  const restartRequired = restartKeys.some((k) => String(next[k]) !== String(before[k]));

  persistConfig(next);
  Object.assign(config, next);

  // 缓存模式 / 缓冲池变化：旧的本地窗口已经按原来的池子大小切分过，直接重置，
  // 让下一次拉清单按新设置重新攒窗口。
  const poolChanged = Number(before.bufferPoolSeconds) !== Number(next.bufferPoolSeconds);
  const turnOffLocalCache = before.segmentsEnabled !== false && next.segmentsEnabled === false;
  const turnOnLocalCache = before.segmentsEnabled === false && next.segmentsEnabled !== false;
  const poolChangedLive = poolChanged && next.segmentsEnabled !== false;
  if (turnOffLocalCache || turnOnLocalCache || poolChangedLive) {
    // 切片本地缓冲关掉后缓冲池跟着停用，所以只剩下“全直连”一种状态
    const stillLocal = next.segmentsEnabled !== false;
    await stopAllStreams(!stillLocal);
    for (const st of streams.values()) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
      st.blocks = [];
      st.segments = [];
      st.mediaSequence = 0;
      st.servedSeq = null;
      st.servedName = null;
    }
    if (!stillLocal) log('已关闭切片本地缓冲：切片改为直连上游，不再缓存，缓冲池同时停用');
    else if (poolChangedLive) log(`缓冲池已设为 ${Number(next.bufferPoolSeconds) || 0} 秒：本地窗口已重置`);
    else log('已开启切片本地缓冲：本地窗口已重置');
  }

  // 打开“只拉当前频道”时，立即停掉其它频道
  if (before.onlyCurrentChannel === false && next.onlyCurrentChannel !== false) {
    for (const [id, st] of streams) {
      if (id !== currentChannelId && st.started) st.stop();
    }
    log('已开启“只拉当前频道”，其它频道已停止');
  }

  // 运行时应用
  if (String(next.source) !== String(before.source) || Number(next.sourceRefreshMinutes) !== Number(before.sourceRefreshMinutes)) {
    scheduleSource();
    loadSource(true).catch(() => {});
  }
  if (Number(next.demoProbeMinutes) !== Number(before.demoProbeMinutes)) {
    scheduleDemoProbe(5000);
  }
  log('配置已保存');
  return { ok: true, restartRequired };
}

async function clearCacheDir(dir) {
  let list = [];
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const d of list) {
    const p = path.join(dir, d.name);
    try {
      if (d.isDirectory()) {
        await clearCacheDir(p);
        await fsp.rmdir(p).catch(() => {});
      } else {
        await fsp.unlink(p);
      }
    } catch (_) {}
  }
}

/**
 * 停止所有频道的后台拉流。
 * 保留已解析的清单/地址表（只是内存里的 URL 映射），这样：
 *  - 关闭切片缓冲后，旧的本地切片地址还能 302 到上游，播放器不会立刻断；
 *  - 重新打开或清空缓存后，播放器下次要切片时能按需重新下载。
 */
async function stopAllStreams(clearFiles) {
  for (const st of streams.values()) {
    st.stop();
    st.lastFetchAt = 0;
  }
  if (clearFiles) {
    await clearCacheDir(config.cacheDir);
    await fsp.mkdir(config.cacheDir, { recursive: true });
  }
}

function restartSelf() {
  if (process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID) {
    // 由 systemd 的 Restart=always 拉起来
    setTimeout(() => process.exit(0), 300);
    return;
  }
  const child = spawn(process.execPath, [__filename], { cwd: ROOT, detached: true, stdio: 'inherit' });
  child.unref();
  setTimeout(() => process.exit(0), 300);
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function originOf(req) {
  const host = req.headers.host || `127.0.0.1:${config.port}`;
  return `http://${host}`;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, Object.assign({ 'Content-Length': buf.length }, headers));
  res.end(buf);
}

function sendJson(res, obj, status = 200) {
  return send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

let lastSkipDemoLog = 0;
function localList() {
  let out = ['#EXTM3U'];
  let lastGroup = null;
  let skipped = 0;
  for (const ch of channels) {
    // 已知返回演示/广告片的条目直接跳过，电视就不会选到假源
    if (channelIsDemo(ch)) {
      skipped++;
      continue;
    }
    if (ch.group !== lastGroup) {
      out.push(`#EXTGRP:${ch.group}`);
      lastGroup = ch.group;
    }
    out.push(ch.inf);
    out.push(`/s/${ch.id}/index.m3u8`);
  }
  if (skipped && channels.length) {
    const now = Date.now();
    if (now - lastSkipDemoLog > 60000) {
      lastSkipDemoLog = now;
      log(`🚫 播放列表已跳过 ${skipped} 个演示源条目`);
    }
  }
  return out.join('\n') + '\n';
}

async function handle(req, res) {
  const url = new URL(req.url, originOf(req));
  const parts = url.pathname.split('/').filter(Boolean);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  // ---- 首页 ----
  if (parts.length === 0) {
    return send(res, 200, homePage(originOf(req)), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // ---- 总清单 ----
  if (parts[0] === 'list.m3u' || parts[0] === 'tv.m3u' || parts[0] === 'playlist.m3u') {
    const origin = originOf(req);
    const text = localList().replace(/(^|\n)\/s\//g, `$1${origin}/s/`);
    return send(res, 200, text, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  // ---- /s/<id>/index.m3u8 ----
  if (parts[0] === 's' && parts[1] && parts[2] === 'index.m3u8') {
    const st = getStream(parts[1]);
    if (!st) return send(res, 404, '未知频道');

    st.lastAccess = Date.now();
    st.indexHits.push(Date.now());
    st.indexHits = st.indexHits.filter((t) => Date.now() - t < 60000);
    switchCurrentChannel(st);
    warmSweep();
    // 纯直连模式（既没开切片缓冲、也没开缓冲池）：不落盘、不后台拉流
    const passthrough = !st.localMode();

    if (passthrough) {
      // 直连模式：不启动后台循环，只在播放器来要清单时按需回源一次。
      // 2.5 秒内的重复请求直接复用，避免播放器重试把上游打爆。
      if (Date.now() - st.lastFetchAt > 2500 || !st.blocks.length) {
        const p = st.tick()
          .then(() => {
            // 每个频道最多每分钟记一条，避免播放器轮询刷屏
            if (Date.now() - st.lastDirectListLog > 60000) {
              st.lastDirectListLog = Date.now();
              log(`📡 拉取清单：${st.ch.name} (${st.id})（切片本地缓存已关）${routeLogTag(st.playlistUrl || st.resolvedUrl || st.ch.url)}`);
            }
          })
          .catch((e) => {
            st.lastError = e.message;
            if (st.errorStreak === 1 || st.errorStreak % 10 === 0) {
              log(`[${st.ch.name}] 拉取清单失败: ${e.message}${routeLogTag(st.playlistUrl || st.resolvedUrl || st.ch.url)}`);
            }
          });
        // 播放器来要清单不能等太久：最多阻塞 2 秒，刷新继续在后台跑，
        // 这次先返回现有清单，避免入口慢把播放器拖到超时。
        await Promise.race([p, sleep(2000)]);
      }
      if (!st.blocks.length) {
        return send(res, 503, '上游暂时不可用，请稍后重试', { 'Retry-After': '2' });
      }
      // 直连模式看不到切片请求，用清单滑动估算播放进度（频道状态才能继续更新）
      st.noteDirectPlayback();
    } else {
      st.ensureStarted();
      if (!st.blocks.length) {
        const p = st.tick().catch((e) => {
          st.lastError = e.message;
          log(`[${st.ch.name}] 拉流失败: ${e.message}${routeLogTag(st.playlistUrl || st.resolvedUrl || st.ch.url)}`);
        });
        await Promise.race([p, sleep(12000)]);
        if (!st.blocks.length) {
          return send(res, 503, '上游暂时不可用，请稍后重试', { 'Retry-After': '2' });
        }
      }
      // 立即起播：不再为了攒历史切片而阻塞播放器请求。
      // 只额外等最多 1 秒，把清单开头/末尾几片先拉到本地，避免刚开始就等下载。
      await st.prepareStartup(3, 1000);
    }

    const origin = originOf(req);
    const text = st.buildPlaylist(origin, (name) => `${origin}/s/${st.id}/seg/${name}`);
    return send(res, 200, text, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  // ---- /s/<id>/seg|aux/<name> ----
  if (parts[0] === 's' && parts[1] && (parts[2] === 'seg' || parts[2] === 'aux') && parts[3]) {
    const st = getStream(parts[1]);
    if (!st) return send(res, 404, '未知频道');
    const name = parts[3];

    st.lastAccess = Date.now();
    st.lastUsedAt = Date.now();

    // 纯直连模式：旧的本地切片地址直接 302 到上游，不下载/落盘
    if (!st.localMode()) {
      let meta = st.files.get(name);
      if (!meta) {
        try {
          await st.tick();
        } catch (e) {
          st.lastError = e.message;
          if (st.errorStreak === 1 || st.errorStreak % 10 === 0) {
            log(`[${st.ch.name}] 拉取清单失败: ${e.message}${routeLogTag(st.playlistUrl || st.resolvedUrl || st.ch.url)}`);
          }
        }
        meta = st.files.get(name);
      }
      if (!meta || !meta.url) return send(res, 404, '切片不存在（切片缓存已关闭）');
      if (Date.now() - st.lastDirectSegLog > 60000) {
        st.lastDirectSegLog = Date.now();
        log(`📡 切片跳转上游：${st.ch.name} (${st.id})${routeLogTag(meta.url)}`);
      }
      res.writeHead(302, { Location: meta.url, 'Cache-Control': 'no-store' });
      return res.end();
    }

    // 多台电视同时看不同频道时，不能因为“不是最后请求的频道”就 404，
    // 否则播放器拿到的切片会被拒，表现就是定格几秒再跳。
    const isCurrent = !config.onlyCurrentChannel || !currentChannelId || st.id === currentChannelId;
    st.ensureStarted();
    // 诊断：记录播放器起播位置（判断它认不认 EXT-X-START）
    const blk = st.blocks.find((b) => b.name === name);
    if (blk) {
      st.servedName = name;
      if (blk.seq != null) {
        st.markPlayed(blk.seq, blk.dur);
        st.servedSeq = blk.seq; // 保护播放器正在读的切片不被窗口裁掉
      }
      st.servedAt = Date.now();
      // 实时播报播放进度：累计播了多少片、窗口里播到第几片、还有多少秒没播
      const stat = st.playbackStat();
      if (isCurrent && stat.playedTotal > 0) {
        if (stat.playedTotal !== st.lastPlayedLogged) {
          st.lastPlayedLogged = stat.playedTotal;
          st.lastProgressLog = Date.now();
          log(
            `▶ ${st.ch.name} 已播 ${stat.playedTotal} 片（约 ${Math.round(stat.playedSeconds)}s）· 剩余 ${stat.remaining}s` +
              (stat.holdRemainingSeconds ? `（池内 ${stat.holdRemainingSeconds}s）` : '')
          );
        } else if (Date.now() - (st.lastProgressLog || 0) > 30000) {
          st.lastProgressLog = Date.now();
          log(
            `⚠ ${st.ch.name} 播放停在 ${stat.playedTotal} 片 · 剩余 ${stat.remaining}s` +
              (stat.holdRemainingSeconds ? `（池内 ${stat.holdRemainingSeconds}s）` : '')
          );
        }
      }
    }
    if (isCurrent && !st.firstSegLogged && st.blocks.length) {
      const idx = st.blocks.indexOf(blk);
      if (idx >= 0) {
        st.firstSegLogged = true;
        const behind = st.blocks.slice(idx + 1).reduce((a, b) => a + (b.dur || 0), 0);
        log(
          `▶ ${st.ch.name} 播放器起播：第 ${idx + 1}/${st.blocks.length} 片，后方还有约 ${Math.round(behind)}s`
        );
      }
    }
    try {
      const file = await st.ensureFile(name);
      const data = await fsp.readFile(file);
      const isPlaylist = /\.m3u8$/i.test(name);
      return send(res, 200, data, {
        'Content-Type': isPlaylist ? 'application/vnd.apple.mpegurl' : contentTypeFor(name),
        'Cache-Control': 'public, max-age=60',
        'Accept-Ranges': 'none'
      });
    } catch (e) {
      // 切片暂时拿不到：让播放器稍后重试（HLS 客户端会自动重试）
      return send(res, 502, `切片不可用: ${e.message}`, { 'Retry-After': '1' });
    }
  }

  // ---- /api/status ----
  if (parts[0] === 'api' && parts[1] === 'status') {
    const list = [];
    for (const ch of channels) {
      const st = streams.get(ch.id);
      list.push({
        id: ch.id,
        name: ch.name,
        group: ch.group,
        active: st ? !!st.started : false,
        cached: st ? (st.localMode() ? st.files.size : 0) : 0,
        vod: st ? st.vod : false,
        demo: channelIsDemo(ch), // 仅当开启 skipDemoSources 时才会真被跳过
        targetDuration: st ? st.targetDuration : null,
        upstream: st ? st.resolvedUrl : null,
        staleTicks: st ? st.staleTicks : 0,
        backoffMs: st ? st.sourceBackoff || 0 : 0,
        lastError: st ? st.lastError || null : null
      });
    }
    return send(res, 200, JSON.stringify({ channels: list, cacheDir: config.cacheDir }, null, 2), {
      'Content-Type': 'application/json; charset=utf-8'
    });
  }

  // ---- /admin 管理页面 ----
  if (parts[0] === 'admin') {
    if (!checkAdminAuth(req, res)) return;
    try {
      const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
      return send(res, 200, html, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
    } catch (_) {
      return send(res, 500, '缺少 admin.html，请把它和 proxy.js 放在同一目录');
    }
  }

  // ---- /api/admin/* ----
  if (parts[0] === 'api' && parts[1] === 'admin') {
    if (!checkAdminAuth(req, res)) return;
    const action = parts[2] || '';
    try {
      if (action === 'config' && req.method === 'GET') {
        return sendJson(res, { config, schema: CONFIG_SCHEMA, defaults: DEFAULT_CONFIG });
      }
      if (action === 'config' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await saveConfigFromBody(body && body.config ? body.config : body);
        return sendJson(res, r);
      }
      if (action === 'logs' && req.method === 'GET') {
        const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 300));
        const lines = logLines.filter((l) => l.id > since).slice(-limit);
        return sendJson(res, { lines, lastId: logSeq, buffered: logLines.length });
      }
      if (action === 'status' && req.method === 'GET') {
        const list = [];
        for (const ch of channels) {
          const st = streams.get(ch.id);
          const pstat = st ? st.playbackStat() : null;
          list.push({
            id: ch.id,
            name: ch.name,
            group: ch.group,
            active: st ? !!st.started : false,
            cached: st ? (st.localMode() ? st.files.size : 0) : 0,
            cachedSegments: pstat ? pstat.cached : 0,
            playedSegments: pstat ? pstat.played : 0,
            playedTotal: pstat ? pstat.playedTotal : 0,
            playedSeconds: pstat ? pstat.playedSeconds : 0,
            unplayedSegments: pstat ? pstat.unplayed : 0,
            unplayedSeconds: pstat ? pstat.unplayedSeconds : 0,
            remainingSeconds: pstat ? pstat.remaining : null,
            playableSeconds: pstat ? pstat.playableSeconds : 0,
            holdRemainingSeconds: pstat ? pstat.holdRemainingSeconds : 0,
            bufferedSeconds: pstat ? pstat.bufferedSeconds : 0,
            playing: pstat ? pstat.playing : false,
            vod: st ? st.vod : false,
            demo: channelIsDemo(ch),
            targetDuration: st ? st.targetDuration : null,
            segments: pstat ? pstat.total : 0,
            holdSeconds: pstat ? pstat.holdSeconds : 0,
            staleTicks: st ? st.staleTicks : 0,
            backoffMs: st ? st.sourceBackoff || 0 : 0,
            lastError: st ? st.lastError || null : null
          });
        }
        return sendJson(res, {
          channels: list,
          service: serviceInfo(),
          proxyConsolePort: loadProxyRuntime().consolePort || 8318,
          disk: Object.assign(await diskInfo(), {
            cacheBytes: await cacheUsageBytes(),
            maxCacheMB: Number(config.maxCacheMB) || 0
          }),
          config: {
            segmentsEnabled: config.segmentsEnabled,
            bufferPoolSeconds: Number(config.bufferPoolSeconds) || 0,
            bufferSeconds: Number(config.bufferSeconds) || 0,
            onlyCurrentChannel: config.onlyCurrentChannel !== false,
            cacheDir: config.cacheDir,
            currentChannelId,
            currentChannel: currentChannelId
              ? (channels.find((c) => c.id === currentChannelId) || {}).name || currentChannelId
              : null
          }
        });
      }
      if (action === 'action' && req.method === 'POST') {
        const body = await readBody(req);
        switch (body.action) {
          case 'refreshSource': {
            await loadSource(true);
            return sendJson(res, { ok: true, channels: channels.length });
          }
          case 'probeDemo': {
            const r = await probeAllDemo();
            return sendJson(res, Object.assign({ ok: true }, r));
          }
          case 'clearCache': {
            await stopAllStreams(true);
            return sendJson(res, { ok: true });
          }
          case 'restart': {
            sendJson(res, { ok: true, restarting: true });
            restartSelf();
            return;
          }
          default:
            return sendJson(res, { error: '未知操作' }, 400);
        }
      }
      return sendJson(res, { error: '未知接口' }, 404);
    } catch (e) {
      return sendJson(res, { error: e.message }, 400);
    }
  }

  return send(res, 404, 'Not Found');
}

function homePage(origin) {
  const rows = channels
    .map(
      (ch) => `<tr><td>${escapeHtml(ch.name)}</td><td>${escapeHtml(ch.group)}</td>
      <td><a href="/s/${ch.id}/index.m3u8" target="_blank">/s/${ch.id}/index.m3u8</a></td></tr>`
    )
    .join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>直播源本地缓冲代理</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:1000px;margin:32px auto;padding:0 16px;line-height:1.6;color:#222}
code,pre{background:#f4f4f5;padding:2px 6px;border-radius:4px}
pre{padding:12px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border-bottom:1px solid #e4e4e7;padding:6px 8px;text-align:left}
th{background:#fafafa}
</style></head><body>
<h1>直播源本地缓冲代理</h1>
<p><a href="/admin">⚙ 打开管理页面</a>　·　<a href="/api/status">JSON 状态</a>　·　缓冲池：
<b>${config.segmentsEnabled === false ? '已停用（切片直连）' : (Number(config.bufferPoolSeconds) || 0) > 0 ? `${Number(config.bufferPoolSeconds)} 秒` : '未开启'}</b>　·　切片本地缓冲：
<b>${config.segmentsEnabled !== false ? '已开启' : '已关闭'}</b></p>
<p>在播放器里添加这个地址即可：</p>
<pre>${origin}/list.m3u</pre>
<p>盒子会提前把切片下载到本地并留出一段缓冲池，播放器只读本机；上游抖动或短暂断流时，池子里的切片顶上去，画面不会卡。</p>
<table><thead><tr><th>频道</th><th>分组</th><th>本地播放列表</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function lanAddresses() {
  const out = [];
  let nis = {};
  try {
    nis = os.networkInterfaces() || {};
  } catch (_) {}
  for (const list of Object.values(nis)) {
    for (const ni of list || []) {
      if (!ni || ni.internal) continue;
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      if (!ni.address) continue;
      out.push(ni.address);
    }
  }
  // 常见私网段排前面，Tailscale 之类的放后面
  const score = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  out.sort((a, b) => score(a) - score(b));
  return out;
}

// 概览「服务运行时长 / 内存占用」用的进程信息
function serviceInfo() {
  const m = process.memoryUsage();
  return {
    startedAt: processStartedAt,
    uptimeSeconds: Math.round(process.uptime()),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    peakRss: process.resourceUsage ? process.resourceUsage().maxRSS * 1024 : null,
    lanIps: lanAddresses()
  };
}

async function main() {
  await fsp.mkdir(config.cacheDir, { recursive: true });
  // 切片本地缓冲关闭时切片全程直连、不落盘：清掉上次留下的旧切片和窗口，
  // 避免关掉后缓存目录还占着空间（重新打开会重新下载）。
  if (config.segmentsEnabled === false) {
    try {
      const left = await fsp.readdir(config.cacheDir);
      if (left.length) {
        await clearCacheDir(config.cacheDir);
        await fsp.mkdir(config.cacheDir, { recursive: true });
        log('切片本地缓冲已关闭：已清理旧的切片缓存');
      }
    } catch (_) {}
  }
  // 代理控制台通过 proxy-runtime.json 提供上游代理参数；这里只预热一次，播放不依赖控制台在线
  loadProxyRuntime(true);
  loadDemoState();
  await loadSource(true);

  if (!channels.length) {
    console.error('没有加载到任何频道，请检查 config.json 里的 source。');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('请求处理异常:', e.message);
      try {
        send(res, 500, 'Internal Error');
      } catch (_) {}
    });
  });

  server.on('error', (e) => {
    console.error('服务启动失败:', e.message);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const base = `http://127.0.0.1:${config.port}`;
    console.log('');
    console.log('  直播源本地缓冲代理已启动');
    console.log('  ----------------------------------------');
    console.log(`  本机播放列表: ${base}/list.m3u`);
    for (const ip of lanAddresses()) {
      console.log(`  局域网播放列表: http://${ip}:${config.port}/list.m3u`);
    }
    console.log(`  状态页面: ${base}/`);
    console.log(`  管理页面: ${base}/admin`);
    console.log(`  缓存目录: ${config.cacheDir}`);
    console.log('');
    console.log('  按 Ctrl+C 退出');
    console.log('');
  });

  // 定时刷新源清单
  scheduleSource();

  // 预热频道：按配置让当前/最近看过的频道保持本地预存
  setInterval(warmSweep, 15000).unref();

  // 演示源探测：启动 45 秒后先跑一次，之后按配置间隔运行
  scheduleDemoProbe(45000);

  // 定时清理缓存
  setInterval(() => {
    for (const st of streams.values()) st.prune().catch(() => {});
  }, 60000).unref();

  // 容量控制
  setInterval(() => enforceCacheLimit().catch(() => {}), 120000).unref();

  const shutdown = () => {
    console.log('\n正在退出…');
    for (const st of streams.values()) clearTimeout(st.timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 缓存目录当前占用（字节）：遍历切片文件求和，带 30 秒缓存避免频繁扫盘 */
let cacheUsageCache = { at: 0, bytes: 0 };

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (n < 0 ? '-' : '') + (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + u[i];
}

async function walkCacheSize(dir) {
  let total = 0;
  let list;
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      total += await walkCacheSize(p);
    } else {
      try {
        total += (await fsp.stat(p)).size;
      } catch (_) {}
    }
  }
  return total;
}

async function cacheUsageBytes() {
  if (Date.now() - cacheUsageCache.at < 30000) return cacheUsageCache.bytes;
  const bytes = await walkCacheSize(config.cacheDir);
  cacheUsageCache = { at: Date.now(), bytes };
  return bytes;
}

/** 磁盘使用情况：statfs 不可用时用 df 兜底 */
async function diskInfo() {
  const dir = config.cacheDir;
  try {
    const s = await fsp.statfs(dir);
    if (s && s.bsize) {
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      return {
        path: dir,
        totalBytes: total,
        freeBytes: free,
        usedBytes: total - free,
        percent: total ? Math.round(((total - free) / total) * 1000) / 10 : 0,
        source: 'statfs'
      };
    }
  } catch (_) {}
  try {
    const out = await execFileP('df', ['-kP', dir], { timeout: 5000 });
    const line = String(out.stdout).trim().split(/\r?\n/)[1] || '';
    const p = line.split(/\s+/);
    if (p.length >= 5) {
      const total = Number(p[1]) * 1024;
      const used = Number(p[2]) * 1024;
      const free = Number(p[3]) * 1024;
      return {
        path: dir,
        totalBytes: total,
        freeBytes: free,
        usedBytes: used,
        percent: total ? Math.round((used / total) * 1000) / 10 : 0,
        source: 'df'
      };
    }
  } catch (_) {}
  return { path: dir, totalBytes: null, freeBytes: null, usedBytes: null, percent: null, source: 'unknown' };
}

async function enforceCacheLimit() {
  const limit = Number(config.maxCacheMB) * 1024 * 1024;
  if (!limit) return;
  const files = [];
  let total = 0;

  async function walk(dir) {
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (/\.(ts|m4s|mp4|m4v|m4a|aac|mp3|bin|vtt)$/i.test(d.name)) {
        try {
          const s = await fsp.stat(p);
          files.push({ p, size: s.size, mtime: s.mtimeMs });
          total += s.size;
        } catch (_) {}
      }
    }
  }

  await walk(config.cacheDir);
  if (total <= limit) return;

  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= limit) break;
    try {
      await fsp.unlink(f.p);
      total -= f.size;
    } catch (_) {}
  }
  log(`缓存超过 ${config.maxCacheMB}MB，已清理旧切片`);
}

process.on('unhandledRejection', (e) => log('未处理的异常:', e && e.message ? e.message : e));

main();
