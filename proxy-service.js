#!/usr/bin/env node
/**
 * 独立代理控制台
 * ---------------------------------------------------------------------------
 * 把原本混在 m3u-proxy 里的「mihomo / 订阅 / 节点 / 测速 / 流量统计 / 局域网共享」
 * 全部剥离到这里，作为独立进程、独立端口、独立前端运行。
 *
 *   m3u-proxy (8317)  只负责播放：清单、切片缓冲、频道、缓存、日志
 *   proxy-service(8318) 只负责代理：节点、订阅、mihomo、流量、共享
 *
 * 两个进程之间只通过一个约定通信：
 *   proxy-service --写--> proxy-runtime.json --读--> m3u-proxy    （代理开关/地址/域名/节点）
 *
 * 零依赖，只需 Node.js。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = __dirname;
const SETTINGS_PATH = path.join(ROOT, 'proxy-settings.json');
const RUNTIME_PATH = path.join(ROOT, 'proxy-runtime.json');
const STATE_PATH = path.join(ROOT, 'proxy-nodes.json');
const TRAFFIC_PATH = path.join(ROOT, 'proxy-traffic.json');
const CONN_HISTORY_PATH = path.join(ROOT, 'proxy-connections.json');
const MAIN_CONFIG_PATH = path.join(ROOT, 'config.json');
const CONSOLE_HTML_PATH = path.join(ROOT, 'proxy-console.html');

const DEFAULT_SETTINGS = {
  // 控制台自身
  consolePort: 8318,
  consoleHost: '0.0.0.0',
  adminPassword: '',

  // 给 m3u-proxy 用的运行参数
  proxy: 'http://127.0.0.1:7890',
  proxyEnabled: true,
  // 走代理域名白名单：留空 = 全部走代理。播放服务也可以在 config.json 里单独指定
  proxyHosts: [],
  proxyAllowLan: false,

  // 订阅
  subscriptionUrls: [],
  subscriptionUrl: '',
  subscriptionUpdateHours: 12,

  // 节点测速
  nodeTestIntervalSeconds: 600,
  nodeTestUrl: 'https://www.google.com/generate_204',
  nodeTestToleranceMs: 80,
  proxySelectedNode: '',
  proxySelectedGroup: '',
  // 自定义策略组：按节点名正则自动分组，写进内置 mihomo 配置
  // [{ name: '倍率0.1', type: 'url-test', filter: '0\\.1倍' }]
  proxyGroupFilters: [],
  // 自带地区策略组的正则覆盖：{ '香港节点': '港|HK|Hong' }；留空 = 用默认正则
  proxyRegionFilters: {},
  // 删除掉的自带策略组名：不再生成，自定义配置里也会移除
  proxyRegionDisabled: [],
  // 订阅源合并组：把多个订阅源的节点合并进同一个策略组
  // [{ name: '全部订阅', type: 'url-test', sources: ['https://...'] }]；sources 留空 = 合并全部订阅
  proxySubGroupMerges: [],
  // rules 可视化：开启后整段 rules 由 proxyRules 生成（MATCH 固定最后指向 PROXY）
  // [{ type: 'DOMAIN-SUFFIX', value: 'live.ottiptv.cc', target: '直播源', params: '' }]
  proxyRulesEnabled: false,
  proxyRules: [],
  // 点「使用」时先按延迟筛候选、再实测下载速度选节点的策略组名；其余组仍只按延迟
  proxySpeedTestGroups: [],
  proxySpeedTestCandidates: 4,
  proxySpeedTestUrl: 'https://proof.ovh.net/files/10Mb.dat',
  proxySpeedTestSeconds: 6,
  // 定时重测下载速度的间隔（秒），只对上面开启的组生效
  proxySpeedTestIntervalSeconds: 600,
  // 最近一次下载测速选点：{ group, node, speed, at }；用于定时复测和界面展示
  proxySpeedPick: null,

  // mihomo
  mihomoApi: 'http://127.0.0.1:9090',
  mihomoSecret: '',
  mihomoConfigPath: '/etc/mihomo/config.yaml',
  mihomoService: 'mihomo',
  mihomoBinary: '/usr/local/bin/mihomo',
  // 自定义配置：订阅更新时只替换 proxies: 段，其它组 / 规则保持不变
  mihomoConfigCustom: false,
  mihomoConfigText: ''
};

const LOG_LIMIT = 600;
const logLines = [];
let logSeq = 0;

const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);

function log(...args) {
  const text = args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  const line = { id: ++logSeq, time: Date.now(), text };
  logLines.push(line);
  if (logLines.length > LOG_LIMIT) logLines.shift();
  console.log(new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false }), text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 设置 / 运行时文件
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 首次启动：从旧的 config.json 里把代理相关设置迁过来，避免升级后配置丢失 */
function bootstrapFromMainConfig() {
  const c = readJson(MAIN_CONFIG_PATH);
  if (!c || typeof c !== 'object') return {};
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k === 'consolePort' || k === 'consoleHost') continue;
    if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
  }
  if (!Array.isArray(out.subscriptionUrls) || !out.subscriptionUrls.length) {
    if (c.subscriptionUrl) out.subscriptionUrls = [String(c.subscriptionUrl)];
  }
  return out;
}

function loadSettings() {
  const raw = readJson(SETTINGS_PATH);
  const base = Object.assign({}, DEFAULT_SETTINGS, bootstrapFromMainConfig());
  if (!raw || typeof raw !== 'object') {
    persistSettings(base);
    log('已从 config.json 导入代理设置：' + SETTINGS_PATH);
    return base;
  }
  return Object.assign(base, raw);
}

/** 旧版默认测速地址（Cloudflare 在部分节点不可达），读取时自动换成新的 */
const LEGACY_SPEED_TEST_URL = 'https://speed.cloudflare.com/__down?bytes=5000000';
function migrateLegacySpeedUrl(s) {
  if (s && s.proxySpeedTestUrl === LEGACY_SPEED_TEST_URL) {
    s.proxySpeedTestUrl = DEFAULT_SETTINGS.proxySpeedTestUrl;
  }
  return s;
}

let settings = migrateLegacySpeedUrl(loadSettings());

function persistSettings(next) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (e) {
    log('保存设置失败: ' + e.message);
  }
}

let activeConsolePort = 0;
function effectiveConsolePort() {
  // 启动后以实际监听端口为准；改了设置里的端口要重启才生效
  return activeConsolePort || Number(process.env.PROXY_CONSOLE_PORT) || Number(settings.consolePort) || 8318;
}

/** 写给 m3u-proxy 的运行时快照（它只读这个文件，不依赖代理控制台是否在线） */
function writeRuntime() {
  const payload = {
    rev: Date.now(),
    updatedAt: Date.now(),
    enabled: settings.proxyEnabled !== false,
    url: String(settings.proxy || ''),
    hosts: (Array.isArray(settings.proxyHosts) ? settings.proxyHosts : [])
      .map((h) => String(h || '').trim())
      .filter(Boolean),
    selected: settings.proxySelectedGroup || settings.proxySelectedNode || 'AUTO',
    selectedGroup: String(settings.proxySelectedGroup || ''),
    selectedNode: String(settings.proxySelectedNode || ''),
    selectedGroupExit,
    hostTargets: runtimeHostTargets(),
    proxyAllowLan: settings.proxyAllowLan === true,
    consolePort: effectiveConsolePort()
  };
  try {
    const tmp = RUNTIME_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    fs.renameSync(tmp, RUNTIME_PATH);
  } catch (e) {
    log('写入 proxy-runtime.json 失败: ' + e.message);
  }
}

function cleanList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\r\n,]/);
  const out = [];
  for (const x of arr) {
    const s = String(x || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const CUSTOM_GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance']);
const CUSTOM_GROUP_MAX = 50;

/** 校验并规范化「正则策略组」配置；支持对象数组或 `名称 | 类型 | 正则` 字符串 */
function normalizeGroupFilters(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  const reserved = new Set(['AUTO', 'PROXY', '其它节点', ...REGION_GROUPS.map((g) => g.name), ...META_GROUP_NAMES]);
  for (const item of input.slice(0, CUSTOM_GROUP_MAX)) {
    let name = '';
    let type = '';
    let filter = '';
    if (typeof item === 'string') {
      const a = item.indexOf('|');
      const b = a >= 0 ? item.indexOf('|', a + 1) : -1;
      if (a < 0 || b < 0) continue;
      name = item.slice(0, a).trim();
      type = item.slice(a + 1, b).trim();
      filter = item.slice(b + 1).trim();
    } else if (item && typeof item === 'object') {
      name = String(item.name == null ? '' : item.name).trim();
      type = String(item.type == null ? '' : item.type).trim();
      filter = String(item.filter == null ? '' : item.filter).trim();
    } else {
      continue;
    }
    if (!name || !filter) continue;
    type = type || 'url-test';
    if (name.length > 40) throw new Error('策略组名称过长（上限 40 字）：' + name.slice(0, 20) + '…');
    if (filter.length > 500) throw new Error('策略组「' + name + '」正则过长（上限 500 字）');
    if (!CUSTOM_GROUP_TYPES.has(type)) {
      throw new Error('策略组「' + name + '」类型不支持：' + type + '（可选 url-test / select / fallback / load-balance）');
    }
    if (seen.has(name)) throw new Error('策略组名称重复：' + name);
    if (reserved.has(name)) throw new Error('策略组名称与内置组冲突：' + name);
    try {
      new RegExp(filter);
    } catch (e) {
      throw new Error('策略组「' + name + '」正则无效：' + e.message);
    }
    seen.add(name);
    out.push({ name, type, filter });
  }
  return out;
}

/** 校验自带地区组的正则覆盖；只接受已有地区组名 */
function normalizeRegionFilters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const known = new Set(REGION_GROUPS.map((r) => r.name).concat(['其它节点']));
  const out = {};
  for (const key of Object.keys(input)) {
    const name = String(key || '').trim();
    if (!known.has(name)) continue;
    const filter = String(input[key] == null ? '' : input[key]).trim();
    if (!filter) continue;
    if (filter.length > 500) throw new Error('策略组「' + name + '」正则过长（上限 500 字）');
    try {
      new RegExp(filter);
    } catch (e) {
      throw new Error('策略组「' + name + '」正则无效：' + e.message);
    }
    out[name] = filter;
  }
  return out;
}

/** 校验被删除的自带策略组名 */
function normalizeRegionDisabled(input) {
  if (!Array.isArray(input)) return [];
  const known = new Set(REGION_GROUPS.map((r) => r.name).concat(['其它节点']));
  const out = [];
  for (const raw of input) {
    const name = String(raw || '').trim();
    if (name && known.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 校验「订阅源合并组」：来源按订阅 URL 记录，留空表示合并全部订阅 */
function normalizeSubGroupMerges(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  const reserved = new Set(['AUTO', 'PROXY', '其它节点', ...REGION_GROUPS.map((g) => g.name), ...META_GROUP_NAMES]);
  for (const item of input.slice(0, CUSTOM_GROUP_MAX)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = String(item.name == null ? '' : item.name).trim();
    if (!name) continue;
    if (name.length > 40) throw new Error('订阅合并组名称过长（上限 40 字）：' + name.slice(0, 20) + '…');
    if (seen.has(name)) throw new Error('订阅合并组名称重复：' + name);
    if (reserved.has(name)) throw new Error('订阅合并组名称与内置组冲突：' + name);
    let type = String(item.type == null ? '' : item.type).trim() || 'url-test';
    if (!CUSTOM_GROUP_TYPES.has(type)) {
      throw new Error('订阅合并组「' + name + '」类型不支持：' + type + '（可选 url-test / select / fallback / load-balance）');
    }
    const sources = [];
    const rawSources = Array.isArray(item.sources) ? item.sources : [];
    if (rawSources.length > CUSTOM_GROUP_MAX) throw new Error('订阅合并组「' + name + '」选择的订阅源过多');
    for (const raw of rawSources) {
      const url = String(raw == null ? '' : raw).trim();
      if (url && !sources.includes(url)) sources.push(url);
    }
    seen.add(name);
    out.push({ name, type, sources });
  }
  return out;
}

/** 校验 rules 可视化配置：类型、内容、出口、可选参数（如 no-resolve） */
function normalizeProxyRules(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input.slice(0, 500)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = String(item.type == null ? '' : item.type).trim().toUpperCase();
    const value = String(item.value == null ? '' : item.value).trim();
    const target = String(item.target == null ? '' : item.target).trim();
    const params = String(item.params == null ? '' : item.params).trim();
    if (!type && !value && !target) continue;
    if (!type) throw new Error('规则类型不能为空');
    if (!/^[A-Z][A-Z0-9-]{0,30}$/.test(type)) throw new Error('规则类型无效：' + type);
    if (type === 'MATCH' || type === 'FINAL') throw new Error('MATCH 规则由控制台自动追加，不需要手动添加');
    if (!value) throw new Error('规则「' + type + '」的内容不能为空');
    if (!target) throw new Error('规则「' + type + ',' + value + '」缺少出口');
    if (value.length > 500) throw new Error('规则内容过长（上限 500 字）');
    if (target.length > 200) throw new Error('规则出口过长（上限 200 字）');
    if (splitRuleFields(value).length > 1) throw new Error('规则内容不能包含逗号：' + value);
    if (/[,\n]/.test(target)) throw new Error('规则出口不能包含逗号或换行：' + target);
    if (params.length > 500 || /[\n]/.test(params)) throw new Error('规则选项无效：' + params);
    out.push({ type, value, target, params });
  }
  return out;
}

/** 校验「下载测速选点」的策略组名列表 */
function normalizeSpeedTestGroups(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input.slice(0, 100)) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name || out.includes(name)) continue;
    if (name === 'PROXY') throw new Error('PROXY 是统一入口，不能对 PROXY 做测速选点');
    out.push(name);
  }
  return out;
}

/** 最近一次下载测速选点（内部状态，允许为空） */
function normalizeSpeedPick(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const group = String(input.group || '').trim();
  const node = String(input.node || '').trim();
  if (!group || !node) return null;
  return {
    group,
    node,
    speed: Number(input.speed) || 0,
    at: Number(input.at) || 0
  };
}

/** 从 mihomo 配置文本里解析 rules 段，供「从当前配置导入」使用 */
function splitRuleFields(raw) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  const text = String(raw || '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < text.length) {
        cur += text[++i];
        continue;
      }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out;
}

function parseRulesFromText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sec = findTopLevelSection(lines, 'rules');
  if (!sec) return [];
  const out = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    let raw = m[1];
    if (raw.startsWith('#')) continue;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = unquoteYaml(raw);
    }
    const fields = splitRuleFields(raw).map((f) => unquoteYaml(f));
    if (!fields.length) continue;
    const type = String(fields[0] || '').trim().toUpperCase();
    if (!type || type === 'MATCH' || type === 'FINAL') continue;
    if (fields.length < 3) {
      out.push({ type: fields[0] || '', value: fields[1] || '', target: '', params: '' });
      continue;
    }
    out.push({
      type,
      value: fields[1],
      target: fields[2],
      params: fields.slice(3).join(',')
    });
  }
  return out;
}

/** 只接受白名单字段，避免前端误传把设置写坏 */
function normalizeSettings(input) {
  const next = Object.assign({}, settings);
  if (!input || typeof input !== 'object') return next;
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('proxy')) next.proxy = String(input.proxy || '').trim();
  if (has('proxyEnabled')) next.proxyEnabled = !!input.proxyEnabled;
  // proxyHosts 只从 proxy-settings.json 读取，网页与接口不再修改。
  if (has('proxyAllowLan')) next.proxyAllowLan = !!input.proxyAllowLan;
  if (has('subscriptionUrls')) next.subscriptionUrls = cleanList(input.subscriptionUrls);
  if (has('subscriptionUpdateHours')) {
    next.subscriptionUpdateHours = clampNum(input.subscriptionUpdateHours, 0, 168, 12);
  }
  if (has('nodeTestIntervalSeconds')) {
    next.nodeTestIntervalSeconds = clampNum(input.nodeTestIntervalSeconds, 30, 86400, 600);
  }
  if (has('nodeTestUrl')) next.nodeTestUrl = String(input.nodeTestUrl || '').trim();
  if (has('nodeTestToleranceMs')) {
    next.nodeTestToleranceMs = clampNum(input.nodeTestToleranceMs, 0, 5000, 80);
  }
  if (has('mihomoApi')) next.mihomoApi = String(input.mihomoApi || '').trim();
  if (has('mihomoSecret')) next.mihomoSecret = String(input.mihomoSecret || '');
  if (has('mihomoConfigPath')) next.mihomoConfigPath = String(input.mihomoConfigPath || '').trim();
  if (has('mihomoService')) next.mihomoService = String(input.mihomoService || '').trim();
  if (has('mihomoBinary')) next.mihomoBinary = String(input.mihomoBinary || '').trim();
  if (has('adminPassword')) next.adminPassword = String(input.adminPassword || '');
  if (has('consolePort')) next.consolePort = clampNum(input.consolePort, 1, 65535, 8318);
  if (has('consoleHost')) next.consoleHost = String(input.consoleHost || '').trim();
  if (has('proxySelectedNode')) next.proxySelectedNode = String(input.proxySelectedNode || '');
  if (has('proxySelectedGroup')) next.proxySelectedGroup = String(input.proxySelectedGroup || '');
  if (has('proxyGroupFilters')) next.proxyGroupFilters = normalizeGroupFilters(input.proxyGroupFilters);
  if (has('proxyRegionFilters')) next.proxyRegionFilters = normalizeRegionFilters(input.proxyRegionFilters);
  if (has('proxyRegionDisabled')) next.proxyRegionDisabled = normalizeRegionDisabled(input.proxyRegionDisabled);
  if (has('proxySubGroupMerges')) next.proxySubGroupMerges = normalizeSubGroupMerges(input.proxySubGroupMerges);
  if (has('proxyRulesEnabled')) next.proxyRulesEnabled = !!input.proxyRulesEnabled;
  if (has('proxyRules')) next.proxyRules = normalizeProxyRules(input.proxyRules);
  if (has('proxySpeedTestGroups')) next.proxySpeedTestGroups = normalizeSpeedTestGroups(input.proxySpeedTestGroups);
  if (has('proxySpeedTestCandidates')) next.proxySpeedTestCandidates = clampNum(input.proxySpeedTestCandidates, 1, 10, 4);
  if (has('proxySpeedTestSeconds')) next.proxySpeedTestSeconds = clampNum(input.proxySpeedTestSeconds, 1, 30, 6);
  if (has('proxySpeedTestIntervalSeconds')) next.proxySpeedTestIntervalSeconds = clampNum(input.proxySpeedTestIntervalSeconds, 60, 86400, 600);
  if (has('proxySpeedPick')) next.proxySpeedPick = normalizeSpeedPick(input.proxySpeedPick);
  if (has('proxySpeedTestUrl')) {
    const u = String(input.proxySpeedTestUrl || '').trim();
    if (u && !/^https?:\/\/\S+$/i.test(u)) throw new Error('下载测速地址必须以 http:// 或 https:// 开头');
    next.proxySpeedTestUrl = u || 'https://proof.ovh.net/files/10Mb.dat';
  }

  // 旧版单订阅字段始终同步成第一个地址
  next.subscriptionUrl = (Array.isArray(next.subscriptionUrls) && next.subscriptionUrls[0]) || '';
  return next;
}

function subscriptionUrlList() {
  const list = cleanList(settings.subscriptionUrls);
  if (!list.length && settings.subscriptionUrl) list.push(String(settings.subscriptionUrl));
  return list;
}

function subscriptionUrlKey(s) {
  const list = cleanList(s.subscriptionUrls);
  if (!list.length && s.subscriptionUrl) list.push(String(s.subscriptionUrl));
  return list.join('\n');
}

// ---------------------------------------------------------------------------
// proxies: 段解析 / 多订阅合并
// ---------------------------------------------------------------------------

function extractProxyBlock(text) {
  const s = String(text).replace(/\r\n/g, '\n');
  const m = /^proxies:[ \t]*(.*)$/m.exec(s);
  if (!m) return '';
  const inline = m[1].trim();
  if (inline) {
    const body = inline + s.slice(m.index + m[0].length);
    const open = body[0];
    if (open === '[' || open === '{') {
      const close = open === '[' ? ']' : '}';
      let depth = 0;
      let inQ = false;
      let q = '';
      let i = 0;
      for (; i < body.length; i++) {
        const c = body[i];
        if (inQ) {
          if (c === '\\') {
            i++;
            continue;
          }
          if (c === q) inQ = false;
          continue;
        }
        if (c === '"' || c === "'") {
          inQ = true;
          q = c;
          continue;
        }
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (!depth) {
            i++;
            break;
          }
        }
      }
      return 'proxies: ' + body.slice(0, i) + '\n';
    }
    return 'proxies: ' + inline + '\n';
  }
  const lines = s.split('\n');
  const start = lines.indexOf('proxies:');
  if (start < 0) return '';
  const out = ['proxies:'];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && !/^#/.test(l) && !/^-/.test(l)) break;
    out.push(l);
  }
  return out.join('\n') + '\n';
}

const INFO_NODE_PATTERNS =
  /(剩余流量|套餐到期|距离下次重置|距离下次|到期时间|过期时间|已用流量|总流量|官网地址|官方网址|客服|重置时间|订阅到期|流量重置)/;

function isInfoNodeName(name) {
  const s = String(name || '').replace(/\s+/g, '');
  if (!s) return false;
  return INFO_NODE_PATTERNS.test(s) || /^(剩余|套餐|到期|过期|官网|客服|重置|流量|已用)/.test(s);
}

function filterProxyBlock(block) {
  const text = String(block || '');
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  let indent = null;
  for (const line of lines) {
    const m = /^([ \t]*)-\s/.exec(line);
    if (m) {
      indent = m[1];
      break;
    }
  }
  if (indent == null) {
    const open = text.indexOf('[');
    const close = text.lastIndexOf(']');
    if (open < 0 || close <= open) return text;
    const inner = text.slice(open + 1, close);
    const parts = [];
    let depth = 0;
    let quote = '';
    let cur = '';
    for (const ch of inner) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const kept = parts.filter((part) => {
      const t = part.trim();
      if (!t) return false;
      return nodeNamesFromBlock('proxies:\n    - ' + t).length > 0;
    });
    return text.slice(0, open + 1) + kept.join(',') + text.slice(close);
  }
  const out = [];
  let entry = null;
  const flush = () => {
    if (!entry) return;
    const names = nodeNamesFromBlock('proxies:\n' + entry.join('\n'));
    if (names.length) out.push(...entry);
    entry = null;
  };
  for (const line of lines) {
    const m = /^([ \t]*)-\s/.exec(line);
    if (m && m[1] === indent) {
      flush();
      entry = [line];
      continue;
    }
    if (entry) entry.push(line);
    else out.push(line);
  }
  flush();
  return out.join('\n');
}

function nodeNamesFromBlock(block) {
  const names = [];
  const pick = (s) => {
    let v = String(s || '').trim();
    const q = v.match(/^"([^"]*)"|^'([^']*)'/);
    if (q) return (q[1] != null ? q[1] : q[2] || '').trim();
    v = v.replace(/\s+#.*$/, '').replace(/[,}]+\s*$/, '').trim();
    return v;
  };
  const add = (n) => {
    if (n && !isInfoNodeName(n) && !names.includes(n)) names.push(n);
  };
  const lines = block.split(/\r?\n/);
  let waitName = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || /^proxies:\s*$/.test(t)) continue;
    if (/^-\s*$/.test(t)) {
      waitName = true;
      continue;
    }
    let m = t.match(/^-\s*\{\s*name:\s*(.+)$/);
    if (m) {
      const rest = m[1].trim();
      add(rest.startsWith('"') || rest.startsWith("'") ? pick(rest) : rest.split(/[,}]/)[0]);
      waitName = false;
      continue;
    }
    m = t.match(/^-\s*name:\s*(.+)$/);
    if (m) {
      add(pick(m[1]));
      waitName = false;
      continue;
    }
    if (waitName) {
      m = t.match(/^name:\s*(.+)$/);
      if (m) {
        add(pick(m[1]));
        waitName = false;
      }
    }
  }
  if (!names.length) {
    const re = /[{,]\s*name:\s*("([^"]*)"|'([^']*)'|([^,}\]]+))/g;
    let g;
    while ((g = re.exec(block))) {
      add((g[2] != null ? g[2] : g[3] != null ? g[3] : g[4] || '').trim());
    }
  }
  return names;
}

function splitProxyEntries(block) {
  const text = String(block || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  if (/^proxies:\s*\[/m.test(text)) {
    const open = text.indexOf('[');
    const close = text.lastIndexOf(']');
    if (open < 0 || close <= open) return [];
    const inner = text.slice(open + 1, close);
    const items = [];
    let depth = 0;
    let quote = '';
    let cur = '';
    for (const ch of inner) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        if (cur.trim()) items.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) items.push(cur.trim());
    return items.map((it) => '  - ' + it.replace(/^\s+/, ''));
  }
  const lines = text.split('\n');
  const entries = [];
  let indent = null;
  let cur = null;
  for (const line of lines) {
    if (/^proxies:\s*(#.*)?$/.test(line)) continue;
    const m = /^([ \t]*)-\s/.exec(line);
    if (m) {
      if (indent == null) indent = m[1];
      if (m[1] === indent) {
        if (cur) entries.push(cur);
        cur = [line];
        continue;
      }
    }
    if (cur) cur.push(line);
  }
  if (cur) entries.push(cur);
  return entries.map((lines2) => reindentEntry(lines2.join('\n'), indent || '  '));
}

function reindentEntry(text, indent) {
  return String(text)
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '';
      if (line.startsWith(indent)) return '  ' + line.slice(indent.length);
      return '  ' + line.replace(/^[ \t]+/, '');
    })
    .join('\n');
}

function renameEntry(entry, newName) {
  const q = JSON.stringify(String(newName));
  if (/^\s*-\s*\{/.test(entry)) {
    return entry.replace(/(\bname\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,}\n]+)/, (m, p1) => p1 + q);
  }
  return entry.replace(
    /^(\s*(?:-\s*)?name\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\n#]+)/m,
    (m, p1) => p1 + q
  );
}

function mergeProxyBlocks(blocks) {
  const entries = [];
  for (const b of blocks) for (const e of splitProxyEntries(b)) entries.push(e);
  const used = new Set();
  const out = [];
  let renamed = 0;
  for (let e of entries) {
    let name = nodeNamesFromBlock('proxies:\n' + e)[0] || '';
    if (!name) continue;
    if (used.has(name)) {
      let i = 2;
      let candidate = `${name} · ${i}`;
      while (used.has(candidate)) candidate = `${name} · ${++i}`;
      e = renameEntry(e, candidate);
      name = candidate;
      renamed++;
    }
    used.add(name);
    out.push(e);
  }
  return { block: 'proxies:\n' + out.join('\n') + '\n', renamed, nodeCount: out.length };
}

/** 从订阅 URL 派生的策略组名（稳定、可读） */
function sourceGroupName(url, index) {
  const host = hostOfUrl(url).replace(/[^0-9A-Za-z\u4e00-\u9fff.·_-]/g, '');
  const base = '订阅 ' + (host || '源' + (index + 1));
  return base.slice(0, 40);
}

/** 多订阅合并：合并节点并为每个订阅记录最终节点名；不读取订阅自带的 proxy-groups */
function mergeSubscriptionSources(sources) {
  const used = new Set();
  let renamed = 0;
  const allEntries = [];
  const sourceNodes = sources.map(() => []);
  for (let si = 0; si < sources.length; si++) {
    const entries = splitProxyEntries(sources[si].block || '');
    for (let e of entries) {
      let name = nodeNamesFromBlock('proxies:\n' + e)[0] || '';
      if (!name) continue;
      let final = name;
      if (used.has(name)) {
        let i = 2;
        let candidate = `${name} · ${i}`;
        while (used.has(candidate)) candidate = `${name} · ${++i}`;
        final = candidate;
        renamed++;
        e = renameEntry(e, candidate);
      }
      used.add(final);
      sourceNodes[si].push(final);
      allEntries.push(e);
    }
  }
  return { block: 'proxies:\n' + allEntries.join('\n') + '\n', renamed, nodeCount: allEntries.length, sourceNodes };
}

/** 已合并的自带地区组 + 自定义组之外，还要注入的「每订阅一组」 */
function subscriptionSourceGroupDefs(names) {
  const out = [];
  const reserved = new Set(['AUTO', 'PROXY', '其它节点', ...REGION_GROUPS.map((g) => g.name), ...META_GROUP_NAMES]);
  const seen = new Set();
  for (let i = 0; i < subscriptionSourceNodes.length; i++) {
    const item = subscriptionSourceNodes[i];
    const srcNames = (item && Array.isArray(item.names) ? item.names : []).filter((n) => names.includes(n));
    if (!srcNames.length) continue;
    let name = (item && item.name) || sourceGroupName((item && item.url) || '', i);
    let base = name;
    let k = 2;
    while (reserved.has(name) || seen.has(name)) name = `${base} ${k++}`;
    seen.add(name);
    out.push({ name, type: 'url-test', proxies: srcNames.length ? srcNames : ['DIRECT'] });
  }
  return out;
}

/** 订阅自带的策略组只用于展示的旧逻辑已移除：控制台只为每个订阅生成一个「订阅 <域名>」组 */
function subscriptionManagedGroups(names) {
  return subscriptionSourceGroupDefs(names);
}

/** 用户配置的订阅源合并组：把选中的订阅节点合并到一个策略组 */
function subscriptionMergeGroupDefs(names, otherNames) {
  const reserved = new Set(['AUTO', 'PROXY', '其它节点', ...REGION_GROUPS.map((g) => g.name), ...META_GROUP_NAMES]);
  for (const n of otherNames || []) reserved.add(String(n));
  const out = [];
  for (const g of Array.isArray(settings.proxySubGroupMerges) ? settings.proxySubGroupMerges : []) {
    const name = String((g && g.name) || '').trim();
    if (!name || reserved.has(name)) continue;
    const sel = Array.isArray(g && g.sources) ? g.sources : [];
    const merged = [];
    for (const item of subscriptionSourceNodes) {
      if (!item) continue;
      if (sel.length && !sel.includes(item.url) && !sel.includes(item.name)) continue;
      for (const n of item.names || []) {
        if (names.includes(n) && !merged.includes(n)) merged.push(n);
      }
    }
    reserved.add(name);
    out.push({ name, type: (g && g.type) || 'url-test', proxies: merged.length ? merged : ['DIRECT'] });
  }
  return out;
}

/** 控制台当前托管的策略组名（用于在自定义配置里删除已经取消的旧组） */
function currentManagedGroupNames(names) {
  const out = ['AUTO', 'PROXY', OTHER_GROUP_NAME];
  for (const r of REGION_GROUPS) out.push(r.name);
  for (const g of customGroupDefs(names)) out.push(g.name);
  for (const g of subscriptionManagedGroups(names)) out.push(g.name);
  for (const g of subscriptionMergeGroupDefs(names, out)) out.push(g.name);
  return Array.from(new Set(out.filter(Boolean)));
}

// ---------------------------------------------------------------------------
// mihomo 配置 / 接口
// ---------------------------------------------------------------------------

function mihomoControllerAddr() {
  try {
    const u = new URL(settings.mihomoApi);
    return u.host;
  } catch (_) {
    return '127.0.0.1:9090';
  }
}

const DIRECT_DOMAINS = [
  'hlsliveali-cdn.ysp.cctv.cn',
  'live-dtocnc-cdn.ysp.cctv.cn',
  'livealiplay.cdn.cctv.cn',
  'cctv.cn',
  'ysp.cctv.cn',
  'miguvideo.com',
  'jsdelivr.net'
];

const REGION_GROUPS = [
  { name: '香港节点', source: '港|HK|Hong' },
  { name: '日本节点', source: '日|东京|JP|Japan' },
  { name: '美国节点', source: '美|\\bUS\\b|States|American' },
  { name: '台湾节点', source: '台|\\bTW\\b|Taiwan' },
  { name: '狮城节点', source: '新|狮|\\bSG\\b|Singapore' },
  { name: '韩国节点', source: '韩|\\bKR\\b|Korea' }
].map((r) => Object.assign(r, { re: new RegExp(r.source, 'i') }));

function yamlQuote(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function unquoteYaml(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch (_) {}
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t.replace(/\s+#.*$/, '').trim();
}

function splitTopLevelCommas(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  let q = '';
  for (const ch of String(s || '')) {
    if (q) {
      cur += ch;
      if (ch === q) q = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitInlineYamlList(text) {
  const s = String(text || '');
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open < 0 || close <= open) return [];
  return splitTopLevelCommas(s.slice(open + 1, close))
    .map((x) => unquoteYaml(x))
    .filter(Boolean);
}

function inlineYamlMap(obj) {
  const map = {};
  for (const part of splitTopLevelCommas(obj)) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    map[unquoteYaml(part.slice(0, i))] = part.slice(i + 1).trim();
  }
  return map;
}

/** 解析配置文本里的 proxy-groups，兼容块状和 `- {name: ...}` 内联写法 */
function parseProxyGroups(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sec = findTopLevelSection(lines, 'proxy-groups');
  if (!sec) return [];
  const groups = [];
  let baseIndent = null;
  let cur = null;
  const flush = () => {
    if (!cur || !cur.length) {
      cur = null;
      return;
    }
    const head = cur[0].replace(/\t/g, '  ');
    const inline = /^\s*-\s*\{(.*)\}\s*$/.exec(head);
    if (inline) {
      const map = inlineYamlMap(inline[1]);
      const name = unquoteYaml(map.name || '');
      if (name) {
        groups.push({
          name,
          type: unquoteYaml(map.type || ''),
          proxies: map.proxies ? splitInlineYamlList(map.proxies) : [],
          filter: map.filter ? unquoteYaml(map.filter) : ''
        });
      }
    } else {
      const joined = cur.join('\n');
      const nameM = joined.match(/^\s*-\s*name\s*:\s*(.+)$/m);
      const typeM = joined.match(/^\s*type\s*:\s*(.+)$/m);
      const filterM = joined.match(/^\s*filter\s*:\s*(.+)$/m);
      const rows = joined.split('\n');
      let proxies = [];
      const pi = rows.findIndex((l) => /^\s*proxies\s*:/.test(l));
      if (pi >= 0) {
        const rest = rows[pi].replace(/^\s*proxies\s*:\s*/, '').trim();
        if (rest.startsWith('[')) proxies = splitInlineYamlList(rest);
        else {
          for (let j = pi + 1; j < rows.length; j++) {
            const lm = /^\s*-\s*(.+)$/.exec(rows[j]);
            if (!lm) break;
            proxies.push(unquoteYaml(lm[1]));
          }
        }
      }
      const name = nameM ? unquoteYaml(nameM[1]) : '';
      if (name) {
        groups.push({
          name,
          type: typeM ? unquoteYaml(typeM[1]) : '',
          proxies,
          filter: filterM ? unquoteYaml(filterM[1]) : ''
        });
      }
    }
    cur = null;
  };
  for (let i = sec.start + 1; i < sec.end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) {
      if (cur) cur.push(raw);
      continue;
    }
    const m = /^(\s*)-\s/.exec(raw);
    if (m) {
      if (baseIndent == null) baseIndent = m[1].length;
      if (m[1].length === baseIndent) {
        flush();
        cur = [raw];
        continue;
      }
    }
    if (cur) cur.push(raw);
  }
  flush();
  return groups;
}

function findTopLevelSection(lines, key) {
  const re = new RegExp('^' + key + '\\s*:');
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function replaceProxiesSection(text, block) {
  const body = String(block || '').replace(/\r\n?/g, '\n').trim();
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sec = findTopLevelSection(lines, 'proxies');
  if (!sec) return (String(text || '').replace(/\s+$/, '') + '\n' + body + '\n').replace(/^\n+/, '');
  const after = lines.slice(sec.end);
  const merged = lines.slice(0, sec.start).concat(body.split('\n'));
  if (after.length) merged.push('');
  return merged.concat(after).join('\n');
}

/** 从 proxy-groups 段按名称移除策略组块，返回剩余行 */
function removeProxyGroups(lines, names) {
  const sec = findTopLevelSection(lines, 'proxy-groups');
  if (!sec || !names.size) return lines;
  const ranges = [];
  let baseIndent = null;
  let start = -1;
  let cur = [];
  const flush = (end) => {
    if (start >= 0) {
      const joined = cur.join('\n');
      const m = joined.match(/^\s*-\s*name\s*:\s*(.+)$/m);
      const name = m ? unquoteYaml(m[1].trim()) : '';
      if (name && names.has(name)) ranges.push([start, end]);
    }
    start = -1;
    cur = [];
  };
  for (let i = sec.start + 1; i < sec.end; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) {
      if (start >= 0) cur.push(raw);
      continue;
    }
    const m = /^(\s*)-\s/.exec(raw);
    if (m) {
      if (baseIndent == null) baseIndent = m[1].length;
      if (m[1].length === baseIndent) {
        flush(i);
        start = i;
        cur = [raw];
        continue;
      }
    }
    if (start >= 0) cur.push(raw);
  }
  flush(sec.end);
  if (!ranges.length) return lines;
  return lines.filter((_, i) => !ranges.some(([a, b]) => i >= a && i < b));
}

/**
 * 自定义配置模式：把设置页的正则策略组写入 proxy-groups，
 * 并重建托管的 PROXY 入口，保证新增组可以直接被「使用」切换。
 */
function upsertManagedGroups(text, customs, nodeNames, dropNames) {
  let lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const drop = new Set(['PROXY']);
  for (const d of customs) drop.add(d.name);
  for (const n of dropNames || []) drop.add(n);
  lines = removeProxyGroups(lines, drop);

  const defs = parseProxyGroups(lines.join('\n'));
  const members = [];
  const add = (n) => {
    if (n && n !== 'PROXY' && !members.includes(n)) members.push(n);
  };
  if (defs.some((g) => g.name === 'AUTO')) add('AUTO');
  for (const d of customs) add(d.name);
  for (const g of defs) add(g.name);
  for (const n of nodeNames) add(n);
  if (!members.length) members.push('DIRECT');

  const extra = groupTestParams();
  const entry = [];
  for (const d of customs) pushGroupDef(entry, Object.assign({}, d, extra));
  entry.push('  - name: "PROXY"');
  entry.push('    type: select');
  entry.push('    proxies:');
  for (const m of members) entry.push('      - ' + yamlQuote(m));

  const sec = findTopLevelSection(lines, 'proxy-groups');
  if (!sec) {
    return lines.join('\n').replace(/\s+$/, '') + '\nproxy-groups:\n' + entry.join('\n') + '\n';
  }
  let at = sec.end;
  while (at > sec.start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, ...entry);
  return lines.join('\n');
}

/** 走代理的域名（proxyHosts）对应的规则目标：默认 AUTO，可被 YAML 里的策略组 / 节点覆盖 */
function proxyHostRules() {
  const out = [];
  for (const raw of cleanList(settings.proxyHosts)) {
    const h = String(raw || '').trim();
    if (!h || /[,\s]/.test(h)) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * 解析当前生效配置里每个走代理域名命中的规则目标，写给 m3u-proxy 记日志用。
 * kind: auto = AUTO 自动选择，group = 策略组，node = 固定节点
 */
function hostRuleTargets() {
  const out = {};
  const text = currentConfigText();
  if (!text) return out;
  let groupNames = new Set();
  try {
    groupNames = new Set(parseProxyGroups(text).map((g) => g.name));
  } catch (_) {}
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sec = findTopLevelSection(lines, 'rules');
  if (sec) {
    // 记录所有 DOMAIN-SUFFIX 规则，而不只是 proxyHosts 里的域名：
    // 播放服务可以单独配置走代理域名（config.json → proxyHosts），
    // 这样日志里也能显示该域名在 YAML 中命中的策略组/节点。
    for (let i = sec.start + 1; i < sec.end; i++) {
      const m = /^\s*-\s*DOMAIN-SUFFIX\s*,\s*([^,\s]+)\s*,\s*(.+?)\s*$/i.exec(lines[i]);
      if (!m) continue;
      const host = m[1].toLowerCase();
      const target = unquoteYaml(m[2]);
      if (!target || /^(DIRECT|REJECT|REJECT-DROP)$/i.test(target)) continue;
      if (!out[host]) {
        const kind = target.toUpperCase() === 'AUTO' ? 'auto' : (groupNames.has(target) ? 'group' : 'node');
        out[host] = { target, kind };
      }
    }
  }
  return out;
}

// 每个走代理域名当前实际落地的节点（由 mihomo 实时数据刷新），供播放日志展示
let hostExitCache = {};
let selectedGroupExit = '';

function resolveProxyExit(all, name, guard) {
  if (!name || guard > 8) return '';
  const p = all[name];
  if (!p) return '';
  // 真正的节点没有 all 成员列表；策略组沿着 now 一直往下找
  if (!Array.isArray(p.all) || !p.all.length) return name;
  if (!p.now) return '';
  return resolveProxyExit(all, p.now, guard + 1);
}

/** 从 mihomo 拉一次实时出口节点；有变化时重写 runtime，播放日志立刻能看到 */
async function refreshHostExitNodes() {
  let all = null;
  try {
    const data = await mihomoApi('GET', '/proxies');
    all = (data && data.proxies) || {};
  } catch (_) {
    return;
  }
  const targets = hostRuleTargets();
  const next = {};
  for (const host of Object.keys(targets)) {
    const t = targets[host];
    if (!t || !t.target) continue;
    const node = t.kind === 'node' ? t.target : resolveProxyExit(all, t.target, 0);
    next[host] = { target: t.target, node: node || '' };
  }
  const group = String(settings.proxySelectedGroup || '').trim();
  const nextGroupExit = group && group !== 'PROXY' ? resolveProxyExit(all, group, 0) : '';
  if (JSON.stringify(next) === JSON.stringify(hostExitCache) && nextGroupExit === selectedGroupExit) return;
  hostExitCache = next;
  selectedGroupExit = nextGroupExit;
  writeRuntime();
}

/** 合并静态规则目标与最近一次抓到的实时出口 */
function runtimeHostTargets() {
  const targets = hostRuleTargets();
  for (const host of Object.keys(targets)) {
    const c = hostExitCache[host];
    if (c && c.target === targets[host].target && c.node) targets[host].node = c.node;
  }
  return targets;
}

function rewriteMatchRule(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let sec = findTopLevelSection(lines, 'rules');
  if (!sec) {
    const extra = ['rules:'];
    for (const h of proxyHostRules()) extra.push(`  - DOMAIN-SUFFIX,${h},AUTO`);
    for (const d of DIRECT_DOMAINS) extra.push(`  - DOMAIN-SUFFIX,${d},DIRECT`);
    extra.push('  - MATCH,PROXY');
    return String(text || '').replace(/\s+$/, '') + '\n' + extra.join('\n') + '\n';
  }

  // 走代理的域名必须命中代理：缺失的补 AUTO；已有但指向直连 / 拒绝的改成 AUTO。
  // 指向策略组或固定节点的规则保持不变，方便在 YAML 里把直播源固定到某个组。
  const missing = [];
  for (const h of proxyHostRules()) {
    let found = -1;
    let foundTarget = '';
    for (let i = sec.start + 1; i < sec.end; i++) {
      const m = /^\s*-\s*DOMAIN-SUFFIX\s*,\s*([^,\s]+)\s*,\s*(.+?)\s*$/i.exec(lines[i]);
      if (m && m[1].toLowerCase() === h.toLowerCase()) {
        found = i;
        foundTarget = unquoteYaml(m[2]);
        break;
      }
    }
    if (found >= 0) {
      if (/^(DIRECT|REJECT|REJECT-DROP)$/i.test(foundTarget)) {
        const indent = (/^(\s*)/.exec(lines[found]) || [null, '  '])[1];
        lines[found] = indent + '- DOMAIN-SUFFIX,' + h + ',AUTO';
      }
    } else {
      missing.push(h);
    }
  }
  if (missing.length) {
    lines.splice(sec.start + 1, 0, ...missing.map((h) => '  - DOMAIN-SUFFIX,' + h + ',AUTO'));
    sec = findTopLevelSection(lines, 'rules');
  }

  // 同一个域名可能因为历史保存被写入多条 DOMAIN-SUFFIX：优先保留用户指定的目标，
  // 删掉自动补的 AUTO，避免 AUTO 排在前面把自定义策略组规则顶掉。
  const lineTarget = (line) => {
    const m = /^\s*-\s*DOMAIN-SUFFIX\s*,\s*([^,\s]+)\s*,\s*(.+?)\s*$/i.exec(line);
    return m ? unquoteYaml(m[2]) : '';
  };
  let changed = false;
  for (const h of proxyHostRules()) {
    const idxs = [];
    for (let i = sec.start + 1; i < sec.end; i++) {
      const m = /^\s*-\s*DOMAIN-SUFFIX\s*,\s*([^,\s]+)\s*,/i.exec(lines[i]);
      if (m && m[1].toLowerCase() === h.toLowerCase()) idxs.push(i);
    }
    if (idxs.length <= 1) continue;
    let keeper = idxs.find((i) => !/^(AUTO|DIRECT|REJECT|REJECT-DROP)$/i.test(lineTarget(lines[i])));
    if (keeper == null) keeper = idxs[0];
    for (let k = idxs.length - 1; k >= 0; k--) {
      if (idxs[k] === keeper) continue;
      lines.splice(idxs[k], 1);
      changed = true;
    }
  }
  if (changed) sec = findTopLevelSection(lines, 'rules');

  let at = -1;
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*-\s*MATCH\s*,/i.test(lines[i])) at = i;
  }
  if (at >= 0) {
    const indent = (/^(\s*)/.exec(lines[at]) || [null, '  '])[1];
    lines[at] = indent + '- MATCH,PROXY';
  } else {
    let insertAt = sec.end;
    while (insertAt > sec.start + 1 && !lines[insertAt - 1].trim()) insertAt--;
    lines.splice(insertAt, 0, '  - MATCH,PROXY');
  }
  return lines.join('\n');
}

/** rules 可视化：把配置里的规则渲染成 YAML 行 */
function managedRuleLines() {
  return (Array.isArray(settings.proxyRules) ? settings.proxyRules : []).map((r) => {
    const fields = [r.type, r.value, r.target];
    if (r.params) fields.push(r.params);
    return fields.join(',');
  });
}

/** rules 可视化：用代理规则整段替换 rules 段，MATCH 固定最后指向 PROXY */
function replaceRulesSection(text, ruleLines) {
  const block = ['rules:'].concat((ruleLines || []).map((line) => '  - ' + line), ['  - MATCH,PROXY']);
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sec = findTopLevelSection(lines, 'rules');
  if (!sec) return String(text || '').replace(/\s+$/, '') + '\n' + block.join('\n') + '\n';
  lines.splice(sec.start, sec.end - sec.start, ...block);
  return lines.join('\n');
}

function applyManagedTopLevel(text, entries) {
  const keys = new Set(entries.map((e) => e[0]));
  const kept = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (m && keys.has(m[1])) continue;
    kept.push(line);
  }
  const header = entries.filter((e) => e[1] != null).map((e) => e[0] + ': ' + e[1]);
  return (header.join('\n') + '\n\n' + kept.join('\n')).replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function managedYamlEntries() {
  let mixedPort = 7890;
  try {
    const p = new URL(settings.proxy);
    if (p.port) mixedPort = Number(p.port);
  } catch (_) {}
  const allowLan = settings.proxyAllowLan === true;
  const entries = [
    ['mixed-port', String(Number(mixedPort) || 7890)],
    ['allow-lan', allowLan ? 'true' : 'false'],
    ['bind-address', allowLan ? '0.0.0.0' : '127.0.0.1'],
    ['lan-allowed-ips', allowLan ? '["0.0.0.0/0", "::/0"]' : '["127.0.0.1/32"]'],
    ['mode', 'rule'],
    ['log-level', 'warning'],
    // 同时解析 A/AAAA 并发建连，减少多 IP 站点的首包等待
    ['tcp-concurrent', 'true'],
    ['external-controller', mihomoControllerAddr()]
  ];
  entries.push(['secret', settings.mihomoSecret ? yamlQuote(String(settings.mihomoSecret)) : null]);
  return entries;
}

function pushGroupDef(lines, def) {
  lines.push('  - name: ' + yamlQuote(def.name));
  lines.push('    type: ' + def.type);
  if (def.url) lines.push('    url: ' + yamlQuote(def.url));
  if (def.interval != null) lines.push('    interval: ' + def.interval);
  if (def.timeout != null) lines.push('    timeout: ' + def.timeout);
  if (def.tolerance != null) lines.push('    tolerance: ' + def.tolerance);
  if (def.filter && !(def.proxies && def.proxies.length)) {
    lines.push('    filter: ' + yamlQuote(def.filter));
    return;
  }
  lines.push('    proxies:');
  for (const p of def.proxies) lines.push('      - ' + yamlQuote(p));
}

const META_GROUP_NAMES = new Set([
  'GLOBAL',
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'PASS-RULE',
  'COMPATIBLE'
]);

const OTHER_GROUP_NAME = '其它节点';

function regionFilterMap() {
  const out = {};
  const raw = settings.proxyRegionFilters;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const r of REGION_GROUPS.concat([{ name: OTHER_GROUP_NAME }])) {
    const v = String(raw[r.name] == null ? '' : raw[r.name]).trim();
    if (v) out[r.name] = v;
  }
  return out;
}

function disabledRegionSet() {
  const raw = settings.proxyRegionDisabled;
  return new Set(Array.isArray(raw) ? raw.map((n) => String(n || '').trim()) : []);
}

function regionSource(region) {
  const custom = regionFilterMap()[region.name];
  return custom || region.source;
}

function regionRegex(region) {
  try {
    return new RegExp(regionSource(region), 'i');
  } catch (_) {
    return region.re;
  }
}

/** 未被删除的地区组 */
function activeRegions() {
  const off = disabledRegionSet();
  return REGION_GROUPS.filter((r) => !off.has(r.name));
}

/** 「其它节点」留空时的自动正则：取反所有仍启用的地区组 */
function otherAutoFilter() {
  const active = activeRegions();
  if (!active.length) return '.*';
  return '^(?!.*(?:' + active.map((r) => '(?:' + regionSource(r) + ')').join('|') + ')).*$';
}

function otherGroupMatches(names) {
  const map = regionFilterMap();
  const ov = map[OTHER_GROUP_NAME];
  if (ov) {
    try {
      const re = new RegExp(ov, 'i');
      return names.filter((n) => re.test(n));
    } catch (_) {
      return [];
    }
  }
  let re;
  try {
    re = new RegExp(otherAutoFilter(), 'i');
  } catch (_) {
    return [];
  }
  return names.filter((n) => re.test(n));
}

/** 自定义配置模式下，只接管用户明确改过正则的地区组；但已存在的列表型地区组要跟着节点重算 */
function overriddenRegionDefs(names) {
  const map = regionFilterMap();
  const off = disabledRegionSet();
  const out = [];
  let textDefs = null;
  const configDef = (name) => {
    if (!textDefs) {
      try {
        textDefs = parseProxyGroups(String(settings.mihomoConfigText || ''));
      } catch (_) {
        textDefs = [];
      }
    }
    return textDefs.find((g) => g.name === name) || null;
  };
  for (const region of REGION_GROUPS) {
    if (off.has(region.name)) continue;
    if (!map[region.name]) {
      // 用户没有单独配正则：只有在配置里是列表型时才接管（filter/subscription 形式交给 mihomo）
      const def = configDef(region.name);
      if (!def || def.filter) continue;
    }
    let matched = names.filter((n) => regionRegex(region).test(n));
    if (!matched.length) matched = ['DIRECT'];
    out.push({ name: region.name, type: 'url-test', proxies: matched });
  }
  // 「其它节点」是其它地区组的取反集合：只要它由控制台托管（存在且不是手写 filter），
  // 或者用户显式填了正则，就必须跟着地区组正则一起重算，否则改完正则它还是旧成员。
  let otherManaged = !!map[OTHER_GROUP_NAME];
  if (!otherManaged && !off.has(OTHER_GROUP_NAME)) {
    const def = configDef(OTHER_GROUP_NAME);
    otherManaged = !!(def && !def.filter);
  }
  if (!off.has(OTHER_GROUP_NAME) && otherManaged) {
    let matched = otherGroupMatches(names);
    if (!matched.length) matched = ['DIRECT'];
    out.push({ name: OTHER_GROUP_NAME, type: 'url-test', proxies: matched });
  }
  // AUTO 也按当前节点重算，避免自定义配置里残留已下线的节点引用
  const autoDef = configDef('AUTO');
  if (autoDef && !autoDef.filter) {
    out.unshift({ name: 'AUTO', type: autoDef.type || 'url-test', proxies: names.length ? names : ['DIRECT'] });
  }
  return out;
}

function regionGroupDefs(names) {
  const defs = [];
  const off = disabledRegionSet();
  for (const region of REGION_GROUPS) {
    if (off.has(region.name)) continue;
    let matched = names.filter((n) => regionRegex(region).test(n));
    if (!matched.length) matched = ['DIRECT'];
    defs.push({ name: region.name, type: 'url-test', proxies: matched });
  }
  if (!off.has(OTHER_GROUP_NAME)) {
    let other = otherGroupMatches(names);
    if (!other.length) other = ['DIRECT'];
    defs.push({ name: OTHER_GROUP_NAME, type: 'url-test', proxies: other });
  }
  return defs;
}

/** 自定义正则策略组：把用户配置的正则解析成当前节点列表 */
function customGroupDefs(names) {
  const reserved = new Set(['AUTO', 'PROXY', '其它节点', ...REGION_GROUPS.map((g) => g.name), ...META_GROUP_NAMES]);
  const out = [];
  for (const g of Array.isArray(settings.proxyGroupFilters) ? settings.proxyGroupFilters : []) {
    const name = String((g && g.name) || '').trim();
    const filter = String((g && g.filter) || '').trim();
    if (!name || !filter || reserved.has(name)) continue;
    let matched = [];
    try {
      const re = new RegExp(filter);
      matched = names.filter((n) => re.test(n));
    } catch (_) {
      continue;
    }
    if (!matched.length) matched = ['DIRECT'];
    out.push({ name, type: (g && g.type) || 'url-test', proxies: matched });
    reserved.add(name);
  }
  return out;
}

/** 解析一个策略组的成员；自定义 YAML 里的 filter 也能在 mihomo 离线时展示 */
function groupDefMembers(def, names) {
  if (!def) return [];
  if (Array.isArray(def.proxies) && def.proxies.length) return def.proxies.filter(Boolean);
  if (def.filter) {
    try {
      const re = new RegExp(def.filter);
      return (names || []).filter((n) => re.test(n));
    } catch (_) {}
  }
  return [];
}

function groupTestParams() {
  return {
    url: String(settings.nodeTestUrl || 'https://www.gstatic.com/generate_204'),
    interval: Math.max(30, Number(settings.nodeTestIntervalSeconds) || 600),
    timeout: 5000,
    tolerance: Math.max(0, Number(settings.nodeTestToleranceMs) || 0)
  };
}

/** 自定义配置整体兜底：把各组 proxies 里已不存在的节点/组引用剔除，避免订阅换节点后校验失败 */
function sanitizeGroupMembers(text, nodeNames) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sec = findTopLevelSection(lines, 'proxy-groups');
  if (!sec) return lines.join('\n');
  const valid = new Set(nodeNames || []);
  try {
    for (const g of parseProxyGroups(text)) valid.add(g.name);
  } catch (_) {}
  const starts = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*-\s*name\s*:/.test(lines[i])) starts.push(i);
  }
  for (let bi = starts.length - 1; bi >= 0; bi--) {
    const start = starts[bi];
    const end = bi + 1 < starts.length ? starts[bi + 1] : sec.end;
    let p = -1;
    for (let i = start; i < end; i++) {
      if (/^\s*proxies\s*:/.test(lines[i])) {
        p = i;
        break;
      }
    }
    if (p < 0 || /proxies\s*:\s*\[/.test(lines[p])) continue;
    const items = [];
    for (let i = p + 1; i < end; i++) {
      if (!/^\s{2,}-\s+/.test(lines[i])) break;
      items.push({ idx: i, val: unquoteYaml(lines[i].replace(/^\s*-\s+/, '').trim()) });
    }
    if (!items.length) continue;
    const kept = items.filter((it) => valid.has(it.val));
    if (kept.length === items.length) continue;
    if (!kept.length) {
      const indent = (lines[p].match(/^\s*/) || [''])[0] + '  ';
      lines.splice(items[0].idx, items.length, indent + '- "DIRECT"');
    } else {
      for (let k = items.length - 1; k >= 0; k--) {
        if (!valid.has(items[k].val)) lines.splice(items[k].idx, 1);
      }
    }
  }
  return lines.join('\n');
}

function buildBuiltinConfigText(block) {
  const names = nodeNamesFromBlock(block);
  const extra = groupTestParams();
  const regions = regionGroupDefs(names).map((g) => Object.assign({}, g, extra));
  const customs = customGroupDefs(names).map((g) => Object.assign({}, g, extra));
  const subs = subscriptionManagedGroups(names).map((g) => Object.assign({}, g, extra));
  const merges = subscriptionMergeGroupDefs(names, subs.map((g) => g.name).concat(customs.map((g) => g.name)))
    .map((g) => Object.assign({}, g, extra));
  const lines = managedYamlEntries()
    .filter((e) => e[1] != null)
    .map((e) => e[0] + ': ' + e[1]);
  lines.push('');
  lines.push(String(block || '').replace(/\s+$/, ''));
  lines.push('proxy-groups:');
  pushGroupDef(lines, Object.assign({ name: 'AUTO', type: 'url-test', proxies: names.length ? names : ['DIRECT'] }, extra));
  for (const g of regions) pushGroupDef(lines, g);
  for (const g of subs) pushGroupDef(lines, g);
  for (const g of merges) pushGroupDef(lines, g);
  for (const g of customs) pushGroupDef(lines, g);
  pushGroupDef(lines, {
    name: 'PROXY',
    type: 'select',
    proxies: ['AUTO'].concat(
      regions.map((g) => g.name),
      subs.map((g) => g.name),
      merges.map((g) => g.name),
      customs.map((g) => g.name),
      names
    )
  });
  lines.push('rules:');
  if (settings.proxyRulesEnabled) {
    for (const r of managedRuleLines()) lines.push('  - ' + r);
  } else {
    for (const h of proxyHostRules()) lines.push(`  - DOMAIN-SUFFIX,${h},AUTO`);
    for (const d of DIRECT_DOMAINS) lines.push(`  - DOMAIN-SUFFIX,${d},DIRECT`);
  }
  lines.push('  - MATCH,PROXY');
  return lines.join('\n') + '\n';
}

function buildCustomConfigText(block) {
  const names = nodeNamesFromBlock(block);
  let text = String(settings.mihomoConfigText || '').replace(/\r\n?/g, '\n').trim();
  text = applyManagedTopLevel(text, managedYamlEntries());
  text = replaceProxiesSection(text, block);
  const customs = overriddenRegionDefs(names).concat(customGroupDefs(names));
  const subs = subscriptionManagedGroups(names);
  const merges = subscriptionMergeGroupDefs(names, subs.map((g) => g.name).concat(customs.map((g) => g.name)));
  // 记录控制台曾经托管过的所有组名：已经从设置里删掉的（策略组 / 地区组 / 旧订阅组）
  // 每次生成自定义配置时都从 YAML 里剔除，保证总览、节点、配置页不再出现。
  const managed = currentManagedGroupNames(names);
  const history = Array.isArray(settings.managedGroupNames) ? settings.managedGroupNames : [];
  const known = Array.from(new Set([...history, ...managed]));
  const stale = known.filter((n) => !managed.includes(n));
  text = upsertManagedGroups(text, subs.concat(merges, customs), names, Array.from(new Set([...disabledRegionSet(), ...stale])));
  text = sanitizeGroupMembers(text, names);
  if (settings.proxyRulesEnabled) {
    text = replaceRulesSection(text, managedRuleLines());
  } else {
    text = rewriteMatchRule(text);
  }
  if (history.length !== known.length) {
    settings.managedGroupNames = known;
    persistSettings(settings);
  }
  return text.replace(/\s+$/, '') + '\n';
}

function buildMihomoConfigText(block) {
  if (settings.mihomoConfigCustom === true && String(settings.mihomoConfigText || '').trim()) {
    return buildCustomConfigText(block);
  }
  return buildBuiltinConfigText(block);
}

function currentConfigText() {
  try {
    return buildMihomoConfigText(mihomoProxiesBlock);
  } catch (_) {
    return '';
  }
}

function execFileP(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr ? String(stderr) : '';
        err.stdout = stdout ? String(stdout) : '';
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function mihomoApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    let base;
    try {
      base = new URL(settings.mihomoApi);
    } catch (_) {
      return reject(new Error('mihomoApi 地址无效'));
    }
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (settings.mihomoSecret) headers.Authorization = 'Bearer ' + settings.mihomoSecret;
    const req = http.request(
      {
        host: base.hostname,
        port: base.port || 9090,
        path: apiPath,
        method,
        headers,
        agent: false,
        insecureHTTPParser: true
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            return reject(new Error('mihomo ' + res.statusCode + ': ' + text.slice(0, 200)));
          }
          if (!text) return resolve({});
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            resolve({ text });
          }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error('mihomo 接口超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 串行化配置写入：订阅更新和设置保存可能同时触发，避免 mihomo -t 读到写了一半的文件
let mihomoWriteQueue = Promise.resolve();

function writeMihomoConfig(block, force = false) {
  const run = () => writeMihomoConfigNow(block, force);
  const next = mihomoWriteQueue.then(run, run);
  mihomoWriteQueue = next.catch(() => {});
  return next;
}

async function writeMihomoConfigNow(block, force = false) {
  const conf = buildMihomoConfigText(block);
  const file = settings.mihomoConfigPath;
  if (!file) throw new Error('还没有配置 mihomo 配置文件路径');
  const dir = path.dirname(file);
  let old = '';
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch (_) {}
  if (!force && old === conf) return { changed: false };

  await fsp.mkdir(dir, { recursive: true });
  if (old) await fsp.writeFile(file + '.bak', old).catch(() => {});
  await fsp.writeFile(file, conf);

  // 配置了 mihomo 程序路径就先做一次语法校验；留空则跳过（例如程序不在本机）
  if (settings.mihomoBinary) {
    try {
      await execFileP(settings.mihomoBinary, ['-d', dir, '-t'], { timeout: 30000 });
    } catch (e) {
      if (old) await fsp.writeFile(file, old).catch(() => {});
      const msg = String((e && (e.stderr || e.message)) || e)
        .split('\n')
        .filter(Boolean)
        .pop();
      throw new Error('mihomo 配置校验失败: ' + msg);
    }
  }

  try {
    await mihomoApi('PUT', '/configs?force=true', { path: file });
  } catch (_) {
    await execFileP('systemctl', ['restart', settings.mihomoService], { timeout: 30000 });
  }
  return { changed: true };
}

async function proxyGroupsFromApi() {
  const data = await mihomoApi('GET', '/proxies');
  const all = (data && data.proxies) || {};
  const map = new Map();
  for (const [name, p] of Object.entries(all)) {
    if (!p || !Array.isArray(p.all)) continue;
    map.set(name, { name, type: p.type || '', now: p.now || '', members: p.all.slice() });
  }
  return map;
}

function currentGroupDefs() {
  return parseProxyGroups(currentConfigText());
}

function groupExists(name, apiGroups) {
  if (!name) return false;
  if (apiGroups && apiGroups.has(name)) return true;
  return currentGroupDefs().some((g) => g.name === name);
}

async function testGroupDelay(name, timeoutMs = 5000) {
  const q = new URLSearchParams({
    url: String(settings.nodeTestUrl || 'https://www.gstatic.com/generate_204'),
    timeout: String(timeoutMs)
  });
  const r = await mihomoApi('GET', '/group/' + encodeURIComponent(name) + '/delay?' + q.toString());
  const out = {};
  if (r && typeof r === 'object') {
    for (const [n, d] of Object.entries(r)) if (typeof d === 'number') out[n] = d;
  }
  return out;
}

function fastestFromDelayMap(map) {
  let name = '';
  let delay = null;
  for (const [n, d] of Object.entries(map || {})) {
    if (typeof d !== 'number' || d <= 0) continue;
    if (delay == null || d < delay) {
      delay = d;
      name = n;
    }
  }
  return { name, delay };
}

/** 当前配置里的 mixed-port，用于让测速流量真的走一遍代理 */
function mixedPortForSpeedTest() {
  const m = /^\s*mixed-port\s*:\s*(\d+)/m.exec(currentConfigText() || '');
  return m ? Number(m[1]) || 7890 : 7890;
}

/**
 * 通过本机代理端口下载一段数据，返回实际速率（字节/秒）。
 * 调用前需要先把 PROXY 指向被测节点。
 */
async function measureProxySpeed(label, timeoutMs) {
  const url = String(settings.proxySpeedTestUrl || 'https://proof.ovh.net/files/10Mb.dat');
  const port = mixedPortForSpeedTest();
  const args = [
    '-sS', '-L', '-4',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '-x', 'http://127.0.0.1:' + port,
    '-o', os.devNull,
    '-w', '%{http_code} %{size_download} %{time_total}',
    url
  ];
  let stdout = '';
  try {
    const r = await execFileP('curl', args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    });
    stdout = String(r.stdout || '');
  } catch (e) {
    // 超时 / 断流时 curl 返回非 0，但 -w 统计照样会输出，按已下载字节算速率
    stdout = String((e && e.stdout) || '');
    if (!stdout.trim()) return { speed: 0, bytes: 0, status: 0, label };
  }
  const parts = stdout.trim().split(/\s+/);
  const status = Number(parts[0]) || 0;
  const bytes = Number(parts[1]) || 0;
  const secs = Number(parts[2]) || 0;
  if (status >= 400 || bytes <= 0) return { speed: 0, bytes, status, label };
  return { speed: bytes / Math.max(0.2, secs), bytes, status, label };
}

let speedPickRunning = false;
let speedPickActiveGroup = '';

/**
 * 下载测速：先按延迟取前 N 名候选，再逐个实测下载速度。
 * 测速期间会临时切换 PROXY，结束后还原成测速前的选择。
 */
async function measureGroupCandidates(group, delaysIn) {
  if (speedPickRunning) throw new Error('已有测速任务在运行，请稍后再试');
  const delays = delaysIn || (await testGroupDelay(group, 4000));
  const candidates = Object.entries(delays)
    .filter(([, d]) => typeof d === 'number' && d > 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, clampNum(settings.proxySpeedTestCandidates, 1, 10, 4));
  if (!candidates.length) throw new Error('组内没有可用节点（延迟测速全部失败）');

  const seconds = clampNum(settings.proxySpeedTestSeconds, 1, 30, 6);
  const prevNode = String(settings.proxySelectedNode || '');
  const prevGroup = String(settings.proxySelectedGroup || '');
  speedPickRunning = true;
  const results = [];
  try {
    for (const [name, delay] of candidates) {
      try {
        await mihomoApi('PUT', '/proxies/PROXY', { name });
      } catch (e) {
        results.push({ name, delay, speed: 0, bytes: 0 });
        log('⚡ 下载测速 ' + name + '：无法切换出口（' + e.message + '）');
        continue;
      }
      const r = await measureProxySpeed(name, seconds * 1000);
      results.push({ name, delay, speed: r.speed, bytes: r.bytes });
      log('⚡ 下载测速 ' + name + '（' + delay + 'ms）：' +
        (r.speed > 0 ? (r.speed / 1024 / 1024).toFixed(2) + ' MB/s' : '失败'));
    }
  } finally {
    speedPickRunning = false;
    // 还原成测速前的选择，随后由 applyNodeSelection 写入最终结果
    const restore = prevNode || prevGroup;
    if (restore) {
      try {
        await mihomoApi('PUT', '/proxies/PROXY', { name: restore });
      } catch (_) {}
    }
  }
  return { candidates, results, delays };
}

/** 从测速结果里挑最快的（全部失败则回退延迟最快） */
function bestSpeedResult(candidates, results) {
  const best = results.filter((r) => r.speed > 0).sort((a, b) => b.speed - a.speed)[0];
  if (best) return { name: best.name, speed: best.speed, delay: best.delay, tested: results.length, fallback: false };
  const fastest = candidates[0];
  return { name: fastest[0], speed: 0, delay: fastest[1], tested: results.length, fallback: true };
}

async function pickNodeBySpeed(group) {
  const { candidates, results } = await measureGroupCandidates(group);
  return bestSpeedResult(candidates, results);
}

/** 这个测速组是否仍是用户当前想要的出口（点击别的组/节点后旧结果就不该生效） */
function isSpeedGroupActive(group) {
  if (!group) return false;
  if (String(settings.proxySelectedGroup || '') === group) return true;
  const pick = settings.proxySpeedPick;
  return !!(pick && pick.group === group);
}

/** 后台测速队列：同一个时间只跑一个，后来的组排在前一个结束后再测 */
let speedPickQueue = Promise.resolve();
let speedPickQueuedGroup = '';
function startSpeedPickBackground(group) {
  if (!group || speedPickQueuedGroup === group) return;
  speedPickQueuedGroup = group;
  speedPickQueue = speedPickQueue.then(async () => {
    try {
      if (!isSpeedGroupActive(group)) return;
      await runSpeedPick(group);
    } catch (e) {
      log('⚡ ' + group + ' 下载测速选点失败：' + e.message);
    } finally {
      if (speedPickQueuedGroup === group) speedPickQueuedGroup = '';
    }
  }).catch((e) => log('⚡ 后台下载测速异常：' + e.message));
}

/** 对一个组做下载测速选点，并把结果固定为当前出口（定时任务也会调用） */
async function runSpeedPick(group) {
  speedPickActiveGroup = group;
  try {
    const pick = await pickNodeBySpeed(group);
    if (!isSpeedGroupActive(group)) {
      log('⚡ ' + group + ' 下载测速完成，但出口已切到其它节点，忽略本次结果');
      return pick;
    }
    settings.proxySelectedNode = pick.name;
    settings.proxySelectedGroup = '';
    settings.proxySpeedPick = { group, node: pick.name, speed: Math.round(pick.speed), at: Date.now() };
    persistSettings(settings);
    writeRuntime();
    await applyNodeSelection();
    log(
      '⚡ ' + group + ' 下载测速选点：' + pick.name +
      (pick.speed > 0
        ? '（' + (pick.speed / 1024 / 1024).toFixed(2) + ' MB/s）'
        : '（下载测速全部失败，回退延迟最快）')
    );
    return pick;
  } finally {
    speedPickActiveGroup = '';
  }
}

let speedPickTimer = null;

/** 定时复测：只复测「当前正在用的下载测速组」 */
function startSpeedPickTimer() {
  if (speedPickTimer) {
    clearInterval(speedPickTimer);
    speedPickTimer = null;
  }
  const intervalMs = clampNum(settings.proxySpeedTestIntervalSeconds, 60, 86400, 600) * 1000;
  speedPickTimer = setInterval(() => {
    const pick = settings.proxySpeedPick;
    if (!pick || !pick.group || speedPickRunning) return;
    const groups = Array.isArray(settings.proxySpeedTestGroups) ? settings.proxySpeedTestGroups : [];
    if (!groups.includes(pick.group)) return;
    if (Date.now() - (pick.at || 0) < intervalMs - 5000) return;
    startSpeedPickBackground(pick.group);
  }, 30000);
  if (speedPickTimer.unref) speedPickTimer.unref();
}

async function applyNodeSelection() {
  const group = String(settings.proxySelectedGroup || '').trim();
  if (group && group !== 'PROXY') {
    let apiGroups = null;
    try {
      apiGroups = await proxyGroupsFromApi();
    } catch (_) {}
    if (!groupExists(group, apiGroups)) {
      log('策略组已不存在，自动切回 AUTO：' + group);
      settings.proxySelectedGroup = '';
      persistSettings(settings);
      writeRuntime();
    } else {
      try {
        await mihomoApi('PUT', '/proxies/PROXY', { name: group });
      } catch (_) {}
      try {
        // 测速整组，让 url-test 组刷新最快节点；select 组则直接选中最快节点
        const delays = await testGroupDelay(group, 5000);
        const fast = fastestFromDelayMap(delays).name;
        const def = apiGroups && apiGroups.get(group);
        if (fast && def && def.type === 'select') {
          await mihomoApi('PUT', '/proxies/' + encodeURIComponent(group), { name: fast });
        }
      } catch (_) {}
      refreshHostExitNodes().catch(() => {});
      return;
    }
  } else if (group === 'PROXY') {
    settings.proxySelectedGroup = '';
    persistSettings(settings);
    writeRuntime();
  }

  const name = settings.proxySelectedNode || 'AUTO';
  const names = nodeNamesFromBlock(mihomoProxiesBlock);
  if (name !== 'AUTO' && !names.includes(name)) {
    settings.proxySelectedNode = '';
    persistSettings(settings);
    // 订阅更新后节点可能改名/消失：让下载测速组重新选一次
    const pickGroup = settings.proxySpeedPick && settings.proxySpeedPick.group;
    if (pickGroup) {
      setTimeout(() => startSpeedPickBackground(pickGroup), 800);
    }
    return;
  }
  try {
    await mihomoApi('PUT', '/proxies/PROXY', { name });
  } catch (_) {}
  refreshHostExitNodes().catch(() => {});
}

// ---------------------------------------------------------------------------
// 节点状态 / 订阅
// ---------------------------------------------------------------------------

let mihomoProxiesBlock = '';
let subscriptionState = { updating: false, lastUpdate: 0, error: null, nodeCount: 0, sources: null };
let subscriptionFirstTimer = null;
let subscriptionInterval = null;
let lastProxyNodeName = '';
/** 每个订阅源对应的「策略组名 + 该源最终节点」；按订阅顺序 */
let subscriptionSourceNodes = [];

function loadProxyState() {
  const raw = readJson(STATE_PATH);
  if (raw && raw.block) {
    mihomoProxiesBlock = filterProxyBlock(raw.block);
    subscriptionState.lastUpdate = Number(raw.updatedAt) || 0;
    subscriptionState.nodeCount = nodeNamesFromBlock(raw.block).length;
    subscriptionState.sources = Array.isArray(raw.sources) ? raw.sources : null;
    subscriptionSourceNodes = Array.isArray(raw.sourceGroups) ? raw.sourceGroups : [];
    return;
  }
  try {
    const text = fs.readFileSync(settings.mihomoConfigPath, 'utf8');
    const m = text.match(/^proxies:\s*\n([\s\S]*?)^proxy-groups:/m);
    if (m) {
      mihomoProxiesBlock = filterProxyBlock('proxies:\n' + m[1]);
      subscriptionState.nodeCount = nodeNamesFromBlock(mihomoProxiesBlock).length;
    }
  } catch (_) {}
}

async function curlFetch(urlStr, headers = {}, timeoutMs = 15000, useProxy = false) {
  const args = ['-sS', '-L', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
  args.push('-4');
  for (const [k, v] of Object.entries(headers)) {
    if (/^user-agent$/i.test(k)) args.push('-A', String(v));
    else args.push('-H', `${k}: ${v}`);
  }
  args.push('-w', '\n%{http_code}\n%{url_effective}', urlStr);
  if (useProxy && settings.proxy) args.push('-x', String(settings.proxy));

  const { stdout } = await execFileP('curl', args, {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: 'buffer'
  }).catch((e) => {
    const line = (e.stderr || e.message || '').toString().split(/\r?\n/).filter(Boolean);
    const msg = (line.find((l) => /^curl:/.test(l)) || line[0] || 'curl 请求失败').trim();
    const err = new Error(msg);
    err.code = 'ECURL';
    throw err;
  });

  const end2 = stdout.lastIndexOf(0x0a);
  const effective = stdout.slice(end2 + 1).toString();
  const end1 = stdout.lastIndexOf(0x0a, end2 - 1);
  const status = parseInt(stdout.slice(end1 + 1, end2).toString(), 10);
  const body = stdout.slice(0, end1);
  return { status, headers: {}, body, url: effective || urlStr, viaCurl: true };
}

function httpGetPlain(urlStr, headers = {}, timeout = 60000, redirects = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method: 'GET', headers, timeout, rejectUnauthorized: false },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return resolve(httpGetPlain(next, headers, timeout, redirects - 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchSubscriptionText(url) {
  const headers = { 'User-Agent': 'clash-verge/v2.0.0', Accept: '*/*' };
  if (settings.proxy) {
    try {
      const r = await curlFetch(url, headers, 60000, true);
      if (r.status === 200 && r.body.length > 1000) {
        log('↻ 订阅经本地代理下载完成');
        return r.body.toString('utf8');
      }
    } catch (_) {}
  }
  try {
    const r = await curlFetch(url, headers, 150000, false);
    if (r.status !== 200) throw new Error('订阅 HTTP ' + r.status);
    if (r.body.length < 1000) throw new Error('订阅内容过短');
    return r.body.toString('utf8');
  } catch (e) {
    const r = await httpGetPlain(url, headers, 60000);
    if (r.status !== 200) throw new Error('订阅 HTTP ' + r.status);
    return r.body.toString('utf8');
  }
}

function hostOfUrl(u) {
  try {
    return new URL(u).host || u;
  } catch (_) {
    return String(u || '').slice(0, 40);
  }
}

async function updateSubscription(reason = 'manual') {
  if (subscriptionState.updating) throw new Error('订阅正在更新中，请稍候');
  const urls = subscriptionUrlList();
  if (!urls.length) throw new Error('还没有填写订阅地址');
  subscriptionState.updating = true;
  try {
    const results = [];
    for (const url of urls) {
      try {
        const text = await fetchSubscriptionText(url);
        const block = filterProxyBlock(extractProxyBlock(text));
        const names = nodeNamesFromBlock(block);
        if (!block) throw new Error('没有 proxies: 段（可能是 base64/v2ray 格式，不是 Clash 配置）');
        if (!names.length) throw new Error('proxies: 段没解析到节点名');
        results.push({ url, ok: true, block, nodeCount: names.length });
      } catch (e) {
        results.push({ url, ok: false, error: e.message });
      }
    }
    const good = results.filter((r) => r.ok);
    if (!good.length) {
      subscriptionState.sources = results.map((r) => ({
        url: r.url,
        ok: false,
        nodeCount: 0,
        error: r.error || '更新失败'
      }));
      throw new Error(results.map((r) => `${hostOfUrl(r.url)}: ${r.error}`).join('；'));
    }

    const merged = mergeSubscriptionSources(good);
    const names = nodeNamesFromBlock(merged.block);
    if (!names.length) throw new Error('合并后没有可用节点');
    subscriptionSourceNodes = good.map((g, i) => ({
      name: sourceGroupName(g.url, i),
      url: g.url,
      names: merged.sourceNodes[i] || []
    }));

    const res = await writeMihomoConfig(merged.block);
    mihomoProxiesBlock = merged.block;
    try {
      await fsp.writeFile(
        STATE_PATH,
        JSON.stringify({
          block: merged.block,
          updatedAt: Date.now(),
          sourceUrls: urls,
          sources: results.map((r) => ({
            url: r.url,
            ok: r.ok,
            nodeCount: r.nodeCount || 0,
            error: r.error || null
          })),
          sourceGroups: subscriptionSourceNodes
        })
      );
    } catch (_) {}
    subscriptionState.lastUpdate = Date.now();
    subscriptionState.nodeCount = names.length;
    subscriptionState.sources = results.map((r) => ({
      url: r.url,
      ok: !!r.ok,
      nodeCount: r.nodeCount || 0,
      error: r.error || null
    }));
    const failed = results.filter((r) => !r.ok);
    subscriptionState.error = failed.length
      ? failed.map((r) => `${hostOfUrl(r.url)}: ${r.error}`).join('；')
      : null;
    await applyNodeSelection();
    writeRuntime();
    log(
      `订阅已更新：${good.length}/${urls.length} 个订阅，共 ${names.length} 个节点` +
        (merged.renamed ? `（重名节点已加序号 ${merged.renamed} 个）` : '') +
        (res.changed ? '（mihomo 配置已重载）' : '（节点无变化）')
    );
    if (failed.length) log('部分订阅更新失败：' + subscriptionState.error);
    return {
      nodeCount: names.length,
      changed: res.changed,
      subscriptions: results.map((r) => ({
        url: r.url,
        ok: r.ok,
        nodeCount: r.nodeCount || 0,
        error: r.error || null
      }))
    };
  } catch (e) {
    subscriptionState.error = e.message;
    log('订阅更新失败: ' + e.message);
    throw e;
  } finally {
    subscriptionState.updating = false;
  }
}

function scheduleSubscription(firstDelayMs) {
  clearTimeout(subscriptionFirstTimer);
  clearInterval(subscriptionInterval);
  subscriptionFirstTimer = null;
  subscriptionInterval = null;
  const hours = Number(settings.subscriptionUpdateHours) || 0;
  if (!subscriptionUrlList().length || hours <= 0) return;
  const run = () => updateSubscription('auto').catch(() => {});
  if (firstDelayMs != null) {
    subscriptionFirstTimer = setTimeout(run, Math.max(0, firstDelayMs));
    if (subscriptionFirstTimer.unref) subscriptionFirstTimer.unref();
  }
  subscriptionInterval = setInterval(run, hours * 3600 * 1000);
  if (subscriptionInterval.unref) subscriptionInterval.unref();
}

function testOneNode(name, timeoutMs = 5000) {
  const q = new URLSearchParams({
    url: String(settings.nodeTestUrl || 'https://www.gstatic.com/generate_204'),
    timeout: String(timeoutMs)
  });
  return mihomoApi('GET', '/proxies/' + encodeURIComponent(name) + '/delay?' + q.toString()).then((r) =>
    typeof r.delay === 'number' ? r.delay : -1
  );
}

async function testAllNodes() {
  const names = nodeNamesFromBlock(mihomoProxiesBlock);
  const out = {};
  const conc = 6;
  for (let i = 0; i < names.length; i += conc) {
    await Promise.all(
      names.slice(i, i + conc).map((n) =>
        testOneNode(n, 4000)
          .then((d) => {
            out[n] = d;
          })
          .catch(() => {
            out[n] = -1;
          })
      )
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 流量统计（节点 / 客户端）
// ---------------------------------------------------------------------------

// 连接历史靠轮询 /connections 判断「上一轮有、这一轮没了」来记录关闭事件，
// 采样越密越不容易漏掉短连接；2 秒一次对本地 mihomo 压力很小。
const TRAFFIC_SAMPLE_MS = 2000;
const TRAFFIC_SAVE_MS = 15000;
const CONN_HISTORY_LIMIT = 200;
const CONN_HISTORY_SAVE_MS = 5000;
const OTHER_NODE = '未归因';
const UNKNOWN_CLIENT = '未知';

function clientKey(ip) {
  const s = String(ip || '').trim();
  if (!s) return UNKNOWN_CLIENT;
  if (s === 'localhost' || s === '::1') return '127.0.0.1';
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) return s.slice(7);
  return s;
}

function clientGroup(ip) {
  const s = String(ip || '');
  if (s === '127.0.0.1') return '本机';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 3).join('.') + '.0/24';
  if (s.includes(':')) {
    const parts = s.split(':').filter((x) => x !== '');
    return parts.slice(0, 4).join(':') + '::/64';
  }
  return UNKNOWN_CLIENT;
}

let connTrack = {};
let connHistory = [];
let lastConnHistorySaveAt = 0;

/** mihomo 的 start 可能是毫秒数，也可能是 RFC3339 字符串 */
function connStartMs(v, now) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return now;
  if (/^\d+$/.test(s)) return Number(s) || now;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : now;
}

/** 把 mihomo 的一条活动连接规范成控制台展示/历史记录用的结构 */
function connRecord(c, now) {
  if (!c || typeof c !== 'object') return null;
  const meta = c.metadata || {};
  const host = String(meta.host || meta.destinationIP || '');
  const port = Number(meta.destinationPort) || 0;
  const start = connStartMs(c.start, now);
  const down = Math.max(0, Number(c.download) || 0);
  const up = Math.max(0, Number(c.upload) || 0);
  const rule = String(c.rule || '');
  const rulePayload = String(c.rulePayload || '');
  return {
    id: String(c.id || [meta.sourceIP, meta.sourcePort, host, port, start].join('|')),
    client: clientKey(meta.sourceIP),
    sourceIP: String(meta.sourceIP || ''),
    host,
    port,
    target: host + (port ? ':' + port : ''),
    node: (Array.isArray(c.chains) && c.chains[0]) || '',
    network: String(meta.network || ''),
    type: String(meta.type || ''),
    rule,
    rulePayload,
    ruleText: rule ? rule + (rulePayload ? ' ' + rulePayload : '') : '',
    download: down,
    upload: up,
    total: down + up,
    start,
    duration: Math.max(0, Math.round((now - start) / 1000))
  };
}

function loadConnHistory() {
  const raw = readJson(CONN_HISTORY_PATH);
  const items = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
  connHistory = items
    .filter((x) => x && typeof x === 'object')
    .slice(0, CONN_HISTORY_LIMIT)
    .map((x) => ({
      id: String(x.id || ''),
      client: String(x.client || ''),
      sourceIP: String(x.sourceIP || ''),
      host: String(x.host || ''),
      port: Number(x.port) || 0,
      target: String(x.target || x.host || ''),
      node: String(x.node || ''),
      network: String(x.network || ''),
      type: String(x.type || ''),
      ruleText: String(x.ruleText || ''),
      download: Math.max(0, Number(x.download) || 0),
      upload: Math.max(0, Number(x.upload) || 0),
      total: Math.max(0, Number(x.total) || 0),
      start: Number(x.start) || 0,
      end: Number(x.end) || 0,
      duration: Math.max(0, Number(x.duration) || 0)
    }));
}

function saveConnHistory(force = false) {
  const now = Date.now();
  if (!force && now - lastConnHistorySaveAt < CONN_HISTORY_SAVE_MS) return;
  lastConnHistorySaveAt = now;
  try {
    fs.writeFileSync(CONN_HISTORY_PATH, JSON.stringify({
      updatedAt: now,
      items: connHistory
    }) + '\n', 'utf8');
  } catch (_) {}
}

/** 对比上一轮活动连接：消失的视为已关闭，写入历史 */
function trackConnections(list, now) {
  const next = {};
  for (const c of list) {
    const rec = connRecord(c, now);
    if (rec) next[rec.id] = rec;
  }
  let closed = 0;
  for (const [id, old] of Object.entries(connTrack)) {
    if (next[id]) continue;
    connHistory.unshift(Object.assign({}, old, {
      end: now,
      duration: Math.max(0, Math.round((now - (old.start || now)) / 1000))
    }));
    closed++;
  }
  connTrack = next;
  if (connHistory.length > CONN_HISTORY_LIMIT) connHistory.length = CONN_HISTORY_LIMIT;
  if (closed) saveConnHistory(true);
  else saveConnHistory();
  return closed;
}

let lastTrafficSaveAt = 0;
let loadedConnSnapshot = false;
let lastProxyNode = '';
let lastProxyClient = '';
let proxyTraffic = {
  down: 0,
  up: 0,
  since: Date.now(),
  lastDown: null,
  lastUp: null,
  sessionDown: 0,
  sessionUp: 0,
  updatedAt: 0,
  apiOk: false,
  error: null,
  sampling: false,
  nodes: {},
  clients: {},
  conns: {}
};

function loadProxyTraffic() {
  const raw = readJson(TRAFFIC_PATH);
  if (!raw || typeof raw !== 'object') return;
  proxyTraffic.down = Math.max(0, Number(raw.down) || 0);
  proxyTraffic.up = Math.max(0, Number(raw.up) || 0);
  proxyTraffic.since = Number(raw.since) || Date.now();
  proxyTraffic.lastDown = raw.lastDown == null ? null : Number(raw.lastDown) || 0;
  proxyTraffic.lastUp = raw.lastUp == null ? null : Number(raw.lastUp) || 0;
  proxyTraffic.updatedAt = Number(raw.updatedAt) || 0;
  if (raw.nodes && typeof raw.nodes === 'object') {
    const nodes = {};
    for (const [name, v] of Object.entries(raw.nodes)) {
      if (!v || typeof v !== 'object') continue;
      nodes[name] = { down: Math.max(0, Number(v.down) || 0), up: Math.max(0, Number(v.up) || 0) };
    }
    proxyTraffic.nodes = nodes;
  }
  if (raw.clients && typeof raw.clients === 'object') {
    const clients = {};
    for (const [ip, v] of Object.entries(raw.clients)) {
      if (!v || typeof v !== 'object') continue;
      clients[ip] = {
        down: Math.max(0, Number(v.down) || 0),
        up: Math.max(0, Number(v.up) || 0),
        lastSeen: Number(v.lastSeen) || 0,
        conns: 0
      };
    }
    proxyTraffic.clients = clients;
  }
  if (raw.conns && typeof raw.conns === 'object') {
    loadedConnSnapshot = true;
    const conns = {};
    for (const [id, v] of Object.entries(raw.conns)) {
      if (!v || typeof v !== 'object') continue;
      conns[id] = {
        down: Math.max(0, Number(v.down) || 0),
        up: Math.max(0, Number(v.up) || 0),
        node: v.node || '',
        ip: v.ip || ''
      };
    }
    proxyTraffic.conns = conns;
  }
}

function saveProxyTraffic(force = false) {
  const now = Date.now();
  if (!force && now - lastTrafficSaveAt < TRAFFIC_SAVE_MS) return;
  lastTrafficSaveAt = now;
  try {
    fs.writeFileSync(
      TRAFFIC_PATH,
      JSON.stringify({
        down: proxyTraffic.down,
        up: proxyTraffic.up,
        since: proxyTraffic.since,
        lastDown: proxyTraffic.lastDown,
        lastUp: proxyTraffic.lastUp,
        updatedAt: proxyTraffic.updatedAt,
        nodes: proxyTraffic.nodes,
        clients: proxyTraffic.clients,
        conns: proxyTraffic.conns
      }) + '\n',
      'utf8'
    );
  } catch (_) {}
}

async function sampleProxyTraffic(force = false) {
  if (proxyTraffic.sampling) return proxyTraffic;
  const now = Date.now();
  if (!force && now - proxyTraffic.updatedAt < TRAFFIC_SAMPLE_MS - 500) return proxyTraffic;
  proxyTraffic.sampling = true;
  try {
    const d = await mihomoApi('GET', '/connections');
    const down = Math.max(0, Number(d && d.downloadTotal) || 0);
    const up = Math.max(0, Number(d && d.uploadTotal) || 0);
    const lastDown = proxyTraffic.lastDown;
    const lastUp = proxyTraffic.lastUp;
    let addDown = down;
    let addUp = up;
    let restarted = true;
    if (lastDown != null && lastUp != null && down >= lastDown && up >= lastUp) {
      addDown = down - lastDown;
      addUp = up - lastUp;
      restarted = false;
    }
    const prevConns = restarted ? {} : proxyTraffic.conns || {};
    const baselineOnly = !restarted && !loadedConnSnapshot && proxyTraffic.down + proxyTraffic.up > 0;
    const nodes = Object.assign({}, proxyTraffic.nodes || {});
    const clients = Object.assign({}, proxyTraffic.clients || {});
    const nextConns = {};
    let attributedDown = 0;
    let attributedUp = 0;
    const list = Array.isArray(d && d.connections) ? d.connections : [];
    trackConnections(list, now);
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const curDown = Math.max(0, Number(c.download) || 0);
      const curUp = Math.max(0, Number(c.upload) || 0);
      const node = (Array.isArray(c.chains) && c.chains[0]) || OTHER_NODE;
      if (node !== OTHER_NODE) lastProxyNode = node;
      const meta = c.metadata || {};
      const id =
        c.id ||
        [meta.sourceIP, meta.sourcePort, meta.destinationIP, meta.destinationPort, meta.host, c.start].join('|');
      const ip = clientKey(meta.sourceIP);
      if (ip !== UNKNOWN_CLIENT) lastProxyClient = ip;
      const prev = prevConns[id];
      const dDown = !prev && baselineOnly ? 0 : prev ? Math.max(0, curDown - prev.down) : curDown;
      const dUp = !prev && baselineOnly ? 0 : prev ? Math.max(0, curUp - prev.up) : curUp;
      if (dDown || dUp) {
        const b = nodes[node] || { down: 0, up: 0 };
        nodes[node] = { down: b.down + dDown, up: b.up + dUp };
        const cb = clients[ip] || { down: 0, up: 0, lastSeen: 0 };
        clients[ip] = { down: cb.down + dDown, up: cb.up + dUp, lastSeen: now, conns: 0 };
      }
      attributedDown += dDown;
      attributedUp += dUp;
      nextConns[id] = { down: curDown, up: curUp, node, ip };
    }
    const otherDown = baselineOnly ? 0 : Math.max(0, addDown - attributedDown);
    const otherUp = baselineOnly ? 0 : Math.max(0, addUp - attributedUp);
    if (otherDown || otherUp) {
      const gone = Object.keys(prevConns).filter((id) => !nextConns[id]);
      const weights = [];
      let weightSum = 0;
      for (const id of gone) {
        const p = prevConns[id];
        if (!p) continue;
        const w = Math.max(0, (p.down || 0) + (p.up || 0));
        if (!w) continue;
        weightSum += w;
        weights.push({ node: p.node || OTHER_NODE, ip: p.ip || UNKNOWN_CLIENT, w });
      }
      if (weightSum > 0) {
        let leftDown = otherDown;
        let leftUp = otherUp;
        weights.forEach((x, i) => {
          const last = i === weights.length - 1;
          const shareDown = last ? leftDown : Math.round((otherDown * x.w) / weightSum);
          const shareUp = last ? leftUp : Math.round((otherUp * x.w) / weightSum);
          leftDown -= shareDown;
          leftUp -= shareUp;
          if (!shareDown && !shareUp) return;
          const b = nodes[x.node] || { down: 0, up: 0 };
          nodes[x.node] = { down: b.down + shareDown, up: b.up + shareUp };
          const cb = clients[x.ip] || { down: 0, up: 0, lastSeen: 0, conns: 0 };
          clients[x.ip] = { down: cb.down + shareDown, up: cb.up + shareUp, lastSeen: now, conns: cb.conns || 0 };
        });
      } else {
        const target = lastProxyNode || OTHER_NODE;
        const b = nodes[target] || { down: 0, up: 0 };
        nodes[target] = { down: b.down + otherDown, up: b.up + otherUp };
        const cTarget = lastProxyClient || UNKNOWN_CLIENT;
        const cb = clients[cTarget] || { down: 0, up: 0, lastSeen: 0, conns: 0 };
        clients[cTarget] = { down: cb.down + otherDown, up: cb.up + otherUp, lastSeen: now, conns: cb.conns || 0 };
      }
    }
    const liveByClient = {};
    for (const c of Object.values(nextConns)) {
      const ip = c.ip || UNKNOWN_CLIENT;
      liveByClient[ip] = (liveByClient[ip] || 0) + 1;
    }
    for (const ip of Object.keys(clients)) {
      clients[ip] = Object.assign({}, clients[ip], { conns: liveByClient[ip] || 0 });
    }
    proxyTraffic = Object.assign({}, proxyTraffic, {
      down: proxyTraffic.down + addDown,
      up: proxyTraffic.up + addUp,
      since: proxyTraffic.since,
      lastDown: down,
      lastUp: up,
      sessionDown: down,
      sessionUp: up,
      updatedAt: now,
      apiOk: true,
      error: null,
      nodes,
      clients,
      conns: nextConns
    });
    loadedConnSnapshot = true;
    saveProxyTraffic();
  } catch (e) {
    proxyTraffic = Object.assign({}, proxyTraffic, { apiOk: false, error: e.message });
  } finally {
    proxyTraffic.sampling = false;
  }
  return proxyTraffic;
}

function trafficOverview() {
  const nodes = Object.entries(proxyTraffic.nodes || {})
    .map(([name, v]) => ({ name, download: v.down, upload: v.up, total: v.down + v.up }))
    .sort((a, b) => b.total - a.total);
  const clients = Object.entries(proxyTraffic.clients || {})
    .map(([ip, v]) => ({
      ip,
      group: clientGroup(ip),
      download: v.down,
      upload: v.up,
      total: v.down + v.up,
      conns: v.conns || 0,
      lastSeen: v.lastSeen || 0
    }))
    .filter((c) => c.total > 0 || c.conns > 0)
    .sort((a, b) => b.total - a.total);
  return {
    download: proxyTraffic.down,
    upload: proxyTraffic.up,
    total: proxyTraffic.down + proxyTraffic.up,
    sessionDownload: proxyTraffic.sessionDown,
    sessionUpload: proxyTraffic.sessionUp,
    since: proxyTraffic.since,
    updatedAt: proxyTraffic.updatedAt,
    ok: proxyTraffic.apiOk,
    error: proxyTraffic.error,
    nodes,
    clients
  };
}

/** mihomo 当前活动连接，供控制台「日志」页展示 */
async function liveConnections() {
  const d = await mihomoApi('GET', '/connections');
  const now = Date.now();
  const list = Array.isArray(d && d.connections) ? d.connections : [];
  return list
    .map((c) => connRecord(c, now))
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);
}

async function resetProxyTraffic() {
  const d = await mihomoApi('GET', '/connections');
  const down = Math.max(0, Number(d && d.downloadTotal) || 0);
  const up = Math.max(0, Number(d && d.uploadTotal) || 0);
  const conns = {};
  const list = Array.isArray(d && d.connections) ? d.connections : [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const meta = c.metadata || {};
    const id =
      c.id ||
      [meta.sourceIP, meta.sourcePort, meta.destinationIP, meta.destinationPort, meta.host, c.start].join('|');
    conns[id] = {
      down: Math.max(0, Number(c.download) || 0),
      up: Math.max(0, Number(c.upload) || 0),
      node: (Array.isArray(c.chains) && c.chains[0]) || OTHER_NODE,
      ip: clientKey(meta.sourceIP)
    };
  }
  proxyTraffic = {
    down: 0,
    up: 0,
    since: Date.now(),
    lastDown: down,
    lastUp: up,
    sessionDown: 0,
    sessionUp: 0,
    updatedAt: Date.now(),
    apiOk: true,
    error: null,
    sampling: false,
    nodes: {},
    clients: {},
    conns
  };
  loadedConnSnapshot = true;
  lastProxyNode = '';
  lastProxyClient = '';
  saveProxyTraffic(true);
  log('🧹 代理流量统计已重置，从当前时刻重新累计');
  return trafficOverview();
}

// ---------------------------------------------------------------------------
// 概览
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
  const score = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  out.sort((a, b) => score(a) - score(b));
  return out;
}

function serviceInfo() {
  const m = process.memoryUsage();
  return {
    startedAt: processStartedAt,
    uptimeSeconds: Math.round(process.uptime()),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    peakRss: process.resourceUsage ? process.resourceUsage().maxRSS * 1024 : null,
    lanIps: lanAddresses(),
    port: effectiveConsolePort()
  };
}

async function proxyOverview() {
  sampleProxyTraffic().catch(() => {});
  const names = nodeNamesFromBlock(mihomoProxiesBlock);
  const delays = {};
  let now = '';
  let exitGroup = '';
  let apiOk = false;
  let autoGroupDelay = null;
  let autoSelected = '';
  let groups = [];
  const selectedGroup = String(settings.proxySelectedGroup || '').trim();
  const selectedNode = String(settings.proxySelectedNode || '').trim();
  const speedGroupSet = new Set(Array.isArray(settings.proxySpeedTestGroups) ? settings.proxySpeedTestGroups : []);
  const speedPickGroup = settings.proxySpeedPick && settings.proxySpeedPick.group ? settings.proxySpeedPick.group : '';
  try {
    const data = await mihomoApi('GET', '/proxies');
    apiOk = true;
    const all = (data && data.proxies) || {};
    const delayOf = (name) => {
      const p = all[name];
      const h = p && Array.isArray(p.history) && p.history.length ? p.history[p.history.length - 1] : null;
      return h ? h.delay : null;
    };
    for (const n of names) delays[n] = delayOf(n);

    // 从 PROXY 开始顺着组往下找，直到真正承载连接的节点
    let cursor = all.PROXY ? all.PROXY.now || '' : '';
    let guard = 0;
    while (cursor && guard++ < 8) {
      const p = all[cursor];
      if (!p || !Array.isArray(p.all)) break;
      exitGroup = cursor;
      if (!p.now) break;
      cursor = p.now;
    }
    now = cursor || '';

    const defs = currentGroupDefs();
    const seen = new Set();
    const appendGroup = (name, def) => {
      if (!name || seen.has(name) || name === 'PROXY' || META_GROUP_NAMES.has(name)) return;
      const p = all[name];
      const apiMembers = p && Array.isArray(p.all) ? p.all : [];
      if (!def && !apiMembers.length) return;
      seen.add(name);
      const members = (apiMembers.length ? apiMembers : groupDefMembers(def, names)).filter(Boolean);
      const type = (p && p.type) || (def && def.type) || '';
      const gDelay = delayOf(name);
      let fastest = '';
      let fastestDelay = null;
      for (const m of members) {
        if (m === 'DIRECT' || m === 'REJECT') continue;
        const d = delayOf(m);
        if (typeof d === 'number' && d > 0 && (fastestDelay == null || d < fastestDelay)) {
          fastestDelay = d;
          fastest = m;
        }
      }
      groups.push({
        name,
        type,
        now: (speedPickGroup === name ? String(settings.proxySpeedPick.node || '') : ((p && p.now) || '')),
        delay: typeof gDelay === 'number' ? gDelay : null,
        members,
        memberCount: members.length,
        fastest,
        fastestDelay,
        selected: name === selectedGroup || (!!settings.proxySpeedPick && settings.proxySpeedPick.group === name),
        speedTest: speedGroupSet.has(name),
        managed: name === 'AUTO' || name === 'PROXY'
      });
    };
    for (const def of defs) appendGroup(def.name, def);
    for (const name of Object.keys(all)) appendGroup(name, null);

    if (all.PROXY) {
      const pg = groups.find((g) => g.name === 'PROXY');
      if (pg) pg.selected = !selectedGroup;
    }
    if (all.AUTO) autoSelected = all.AUTO.now || '';
    const ah = all.AUTO && Array.isArray(all.AUTO.history) && all.AUTO.history.length
      ? all.AUTO.history[all.AUTO.history.length - 1]
      : null;
    autoGroupDelay = ah ? ah.delay : null;
  } catch (_) {
    // 接口不可用时仍返回配置里的组，保证控制台能展示结构
    for (const def of currentGroupDefs()) {
      if (def.name === 'PROXY' || META_GROUP_NAMES.has(def.name)) continue;
      const members = groupDefMembers(def, names);
      groups.push({
        name: def.name,
        type: def.type,
        now: (speedPickGroup === def.name ? String(settings.proxySpeedPick.node || '') : ''),
        delay: null,
        members,
        memberCount: members.length,
        fastest: '',
        fastestDelay: null,
        selected: def.name === selectedGroup || (!!settings.proxySpeedPick && settings.proxySpeedPick.group === def.name),
        speedTest: speedGroupSet.has(def.name),
        managed: def.name === 'AUTO'
      });
    }
  }
  if (!autoSelected) {
    let best = '';
    let bestDelay = Infinity;
    for (const n of names) {
      const d = delays[n];
      if (typeof d === 'number' && d > 0 && d < bestDelay) {
        bestDelay = d;
        best = n;
      }
    }
    autoSelected = best;
  }
  const autoDelay = now && Object.prototype.hasOwnProperty.call(delays, now) ? delays[now] : null;
  if (now && now !== lastProxyNodeName) {
    if (lastProxyNodeName && settings.proxyEnabled !== false) {
      const d = delays[now];
      log(`🔄 代理出口切换：${lastProxyNodeName} → ${now}` + (typeof d === 'number' && d > 0 ? `（${d}ms）` : ''));
    }
    lastProxyNodeName = now;
  }
  const isGroup = !!selectedGroup;
  const isNode = !isGroup && !!selectedNode && selectedNode !== 'AUTO';
  return {
    names,
    delays,
    now,
    exitGroup,
    groups,
    autoSelected,
    autoDelay,
    auto: !isGroup && !isNode,
    selected: selectedGroup || selectedNode || 'AUTO',
    selectedGroup,
    selectedNode: selectedNode || 'AUTO',
    mode: isGroup ? 'group' : isNode ? 'node' : 'auto',
    speedPick: settings.proxySpeedPick || null,
    speedPickRunning: speedPickRunning === true,
    speedPickGroup: speedPickActiveGroup || '',
    apiOk,
    autoGroupDelay,
    traffic: trafficOverview(),
    service: serviceInfo(),
    lan: {
      enabled: settings.proxyAllowLan === true,
      ips: lanAddresses(),
      port: (() => {
        try {
          return Number(new URL(settings.proxy).port) || 7890;
        } catch (_) {
          return 7890;
        }
      })()
    },
    subscription: {
      updating: subscriptionState.updating,
      lastUpdate: subscriptionState.lastUpdate,
      error: subscriptionState.error,
      nodeCount: subscriptionState.nodeCount,
      updateHours: Number(settings.subscriptionUpdateHours) || 0,
      url: settings.subscriptionUrl || '',
      urls: subscriptionUrlList(),
      urlCount: subscriptionUrlList().length,
      sources: subscriptionState.sources || null,
      sourceGroups: subscriptionSourceNodes
    }
  };
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}

function sendJson(res, obj, status = 200) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit = 1024 * 1024) {
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

function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function checkAuth(req, res) {
  const pass = String(settings.adminPassword || '');
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
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="proxy-console", charset="UTF-8"' });
  res.end('需要管理密码');
  return false;
}

function publicSettings() {
  return {
    proxy: settings.proxy,
    proxyEnabled: settings.proxyEnabled,
    proxyHosts: settings.proxyHosts,
    proxyAllowLan: settings.proxyAllowLan,
    subscriptionUrls: settings.subscriptionUrls,
    subscriptionUpdateHours: settings.subscriptionUpdateHours,
    nodeTestIntervalSeconds: settings.nodeTestIntervalSeconds,
    nodeTestUrl: settings.nodeTestUrl,
    nodeTestToleranceMs: settings.nodeTestToleranceMs,
    proxySelectedNode: settings.proxySelectedNode,
    proxySelectedGroup: settings.proxySelectedGroup,
    proxyGroupFilters: settings.proxyGroupFilters || [],
    proxyRegionFilters: regionFilterMap(),
    proxyRegionDisabled: normalizeRegionDisabled(settings.proxyRegionDisabled),
    proxySubGroupMerges: settings.proxySubGroupMerges || [],
    proxyRulesEnabled: settings.proxyRulesEnabled === true,
    proxyRules: settings.proxyRules || [],
    proxySpeedTestGroups: settings.proxySpeedTestGroups || [],
    proxySpeedTestCandidates: settings.proxySpeedTestCandidates || 4,
    proxySpeedTestUrl: settings.proxySpeedTestUrl || '',
    proxySpeedTestSeconds: settings.proxySpeedTestSeconds || 6,
    proxySpeedTestIntervalSeconds: settings.proxySpeedTestIntervalSeconds || 600,
    proxySpeedPick: settings.proxySpeedPick || null,
    regionGroupDefaults: REGION_GROUPS.map((r) => ({ name: r.name, filter: r.source }))
      .concat([{ name: OTHER_GROUP_NAME, filter: '', auto: true, autoFilter: otherAutoFilter() }]),
    mihomoConfigCustom: settings.mihomoConfigCustom === true,
    mihomoApi: settings.mihomoApi,
    mihomoSecret: settings.mihomoSecret,
    mihomoConfigPath: settings.mihomoConfigPath,
    mihomoService: settings.mihomoService,
    mihomoBinary: settings.mihomoBinary,
    adminPassword: settings.adminPassword,
    // 这里返回「已保存的端口」而不是当前监听端口：改了端口后表单仍显示新值，
    // 配合 restartRequired 提示重启；实际监听端口看总览里的 service.port。
    consolePort: Number(settings.consolePort) || 8318,
    consoleHost: process.env.PROXY_CONSOLE_HOST || settings.consoleHost
  };
}

async function saveSettings(body) {
  const before = Object.assign({}, settings);
  const next = normalizeSettings(body);
  // 合并组不能和自定义组 / 订阅源组重名，否则 YAML 里会出现同名策略组
  const customNames = new Set((next.proxyGroupFilters || []).map((g) => String((g && g.name) || '').trim()));
  const sourceNames = new Set((next.subscriptionUrls || []).map((u, i) => sourceGroupName(u, i)));
  for (const g of next.proxySubGroupMerges || []) {
    if (customNames.has(g.name)) throw new Error('订阅合并组名称与自定义策略组冲突：' + g.name);
    if (sourceNames.has(g.name)) throw new Error('订阅合并组名称与订阅源组冲突：' + g.name);
  }
  const restartKeys = ['consolePort', 'consoleHost'];
  const restartRequired = restartKeys.some((k) => String(next[k]) !== String(before[k]));
  // 被删除或停用的策略组如果正在使用，回退到 AUTO，避免其它页面继续显示失效组
  const removedGroups = new Set();
  const nextFilterNames = new Set(
    (next.proxyGroupFilters || []).map((g) => String((g && g.name) || '').trim()).filter(Boolean)
  );
  for (const g of before.proxyGroupFilters || []) {
    const n = String((g && g.name) || '').trim();
    if (n && !nextFilterNames.has(n)) removedGroups.add(n);
  }
  for (const n of next.proxyRegionDisabled || []) removedGroups.add(String(n || '').trim());
  if (next.proxySelectedGroup && removedGroups.has(next.proxySelectedGroup)) {
    log('策略组「' + next.proxySelectedGroup + '」已删除，当前出口已切回 AUTO');
    next.proxySelectedGroup = '';
    next.proxySelectedNode = 'AUTO';
  }
  settings = next;
  persistSettings(settings);
  writeRuntime();

  // mihomo 配置相关：重写并热重载
  const mihomoKeys = [
    'nodeTestUrl',
    'nodeTestIntervalSeconds',
    'nodeTestToleranceMs',
    'mihomoApi',
    'mihomoSecret',
    'mihomoConfigPath',
    'mihomoService',
    'mihomoBinary',
    'proxy',
    'proxyAllowLan'
  ];
  const mihomoChanged = mihomoKeys.some((k) => String(next[k]) !== String(before[k])) ||
    JSON.stringify(next.proxyGroupFilters || []) !== JSON.stringify(before.proxyGroupFilters || []) ||
    JSON.stringify(next.proxyRegionFilters || {}) !== JSON.stringify(before.proxyRegionFilters || {}) ||
    JSON.stringify(next.proxySubGroupMerges || []) !== JSON.stringify(before.proxySubGroupMerges || []) ||
    JSON.stringify(next.proxyRules || []) !== JSON.stringify(before.proxyRules || []) ||
    next.proxyRulesEnabled !== before.proxyRulesEnabled ||
    JSON.stringify(next.proxyRegionDisabled || []) !== JSON.stringify(before.proxyRegionDisabled || []);
  if (mihomoChanged && mihomoProxiesBlock) {
    try {
      await writeMihomoConfig(mihomoProxiesBlock, true);
      log('mihomo 配置已按新设置重写并重载');
    } catch (e) {
      log('应用 mihomo 配置失败: ' + e.message);
    }
  }
  if (String(next.proxySelectedNode) !== String(before.proxySelectedNode)) await applyNodeSelection();
  if (String(next.proxySelectedGroup) !== String(before.proxySelectedGroup)) await applyNodeSelection();
  // 下载测速组的开关 / 间隔变了：清掉失效的选点并重启定时器
  const speedGroupsChanged = JSON.stringify(next.proxySpeedTestGroups || []) !== JSON.stringify(before.proxySpeedTestGroups || []);
  if (speedGroupsChanged || Number(next.proxySpeedTestIntervalSeconds) !== Number(before.proxySpeedTestIntervalSeconds)) {
    const pick = next.proxySpeedPick;
    if (pick && !(next.proxySpeedTestGroups || []).includes(pick.group)) {
      next.proxySpeedPick = null;
      settings = next;
      persistSettings(settings);
    }
    startSpeedPickTimer();
  }
  if (
    Number(next.subscriptionUpdateHours) !== Number(before.subscriptionUpdateHours) ||
    subscriptionUrlKey(next) !== subscriptionUrlKey(before)
  ) {
    scheduleSubscription(5000);
  }
  if (before.proxyEnabled !== next.proxyEnabled) {
    log(next.proxyEnabled === false ? '代理总开关已关闭：m3u-proxy 的上游请求将全部直连' : '代理总开关已开启');
  }
  log('设置已保存');
  return { ok: true, restartRequired };
}

async function persistProxyBlock(block) {
  mihomoProxiesBlock = block;
  subscriptionState.nodeCount = nodeNamesFromBlock(block).length;
  try {
    await fsp.writeFile(
      STATE_PATH,
      JSON.stringify({
        block,
        updatedAt: Date.now(),
        sourceUrls: subscriptionUrlList(),
        sources: subscriptionState.sources || null
      })
    );
  } catch (_) {}
}

function configInfo() {
  const text = currentConfigText();
  const defs = parseProxyGroups(text);
  const names = nodeNamesFromBlock(mihomoProxiesBlock);
  return {
    mode: settings.mihomoConfigCustom === true ? 'custom' : 'builtin',
    custom: settings.mihomoConfigCustom === true,
    text,
    customText: String(settings.mihomoConfigText || ''),
    defaultText: buildBuiltinConfigText(mihomoProxiesBlock),
    path: settings.mihomoConfigPath,
    groupCount: defs.length,
    nodeCount: names.length,
    groups: defs.map((g) => ({ name: g.name, type: g.type, memberCount: groupDefMembers(g, names).length })),
    rules: parseRulesFromText(text)
  };
}

async function saveCustomConfig(rawText) {
  const text = String(rawText == null ? '' : rawText).replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('配置内容不能为空');
  if (text.length > 2 * 1024 * 1024) throw new Error('配置过大（上限 2MB）');
  for (const key of ['proxies', 'proxy-groups', 'rules']) {
    if (!new RegExp('^' + key + '\\s*:', 'm').test(text)) {
      throw new Error('配置缺少 ' + key + ': 段');
    }
  }

  const beforeSettings = {
    custom: settings.mihomoConfigCustom === true,
    text: String(settings.mihomoConfigText || '')
  };
  const beforeBlock = mihomoProxiesBlock;
  let block = mihomoProxiesBlock;
  if (!nodeNamesFromBlock(block).length) {
    const extracted = extractProxyBlock(text);
    if (extracted) block = filterProxyBlock(extracted);
  }
  if (!nodeNamesFromBlock(block).length) {
    throw new Error('配置里没有可用节点：请先更新订阅，或在 proxies: 里填写节点');
  }

  settings.mihomoConfigCustom = true;
  settings.mihomoConfigText = text;
  try {
    await writeMihomoConfig(block, true);
  } catch (e) {
    settings.mihomoConfigCustom = beforeSettings.custom;
    settings.mihomoConfigText = beforeSettings.text;
    mihomoProxiesBlock = beforeBlock;
    throw e;
  }

  await persistProxyBlock(block);
  persistSettings(settings);
  writeRuntime();
  await applyNodeSelection();
  log('已保存自定义 mihomo 配置：' + text.split('\n').length + ' 行，' + nodeNamesFromBlock(block).length + ' 个节点');
  return configInfo();
}

async function resetCustomConfig() {
  const beforeSettings = {
    custom: settings.mihomoConfigCustom === true,
    text: String(settings.mihomoConfigText || '')
  };
  settings.mihomoConfigCustom = false;
  settings.mihomoConfigText = '';
  try {
    await writeMihomoConfig(mihomoProxiesBlock, true);
  } catch (e) {
    settings.mihomoConfigCustom = beforeSettings.custom;
    settings.mihomoConfigText = beforeSettings.text;
    throw e;
  }
  persistSettings(settings);
  writeRuntime();
  await applyNodeSelection();
  log('已恢复内置 mihomo 配置（地区策略组 + PROXY 入口）');
  return configInfo();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);

  // 控制台页面
  if (parts.length === 0 || parts[0] === 'admin' || parts[0] === 'index.html') {
    if (!checkAuth(req, res)) return;
    try {
      const html = await fsp.readFile(CONSOLE_HTML_PATH, 'utf8');
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    } catch (_) {
      return send(res, 500, '缺少 proxy-console.html，请把它和 proxy-service.js 放在同一目录');
    }
  }

  if (parts[0] === 'health') return sendJson(res, { ok: true, uptime: Math.round(process.uptime()) });

  // m3u-proxy 专用（只允许本机）
  if (parts[0] === 'api' && parts[1] === 'proxy' && parts[2] === 'runtime' && req.method === 'GET') {
    if (!isLoopback(req)) return sendJson(res, { error: '仅限本机' }, 403);
    return sendJson(res, {
      enabled: settings.proxyEnabled !== false,
      url: settings.proxy || '',
      hosts: settings.proxyHosts || [],
      selected: settings.proxySelectedNode || 'AUTO',
      consolePort: effectiveConsolePort(),
      updatedAt: Date.now()
    });
  }

  if (parts[0] !== 'api' || parts[1] !== 'proxy') return send(res, 404, 'Not Found');
  if (!checkAuth(req, res)) return;

  const action = parts[2] || '';
  try {
    if (action === 'state' && req.method === 'GET') {
      return sendJson(res, {
        ok: true,
        settings: publicSettings(),
        overview: await proxyOverview(),
        runtime: { updatedAt: Date.now() }
      });
    }
    if (action === 'settings' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await saveSettings(body && body.settings ? body.settings : body);
      return sendJson(res, Object.assign(r, {
        settings: publicSettings(),
        overview: await proxyOverview()
      }));
    }
    if (action === 'config' && req.method === 'GET') {
      return sendJson(res, Object.assign({ ok: true }, configInfo()));
    }
    if (action === 'config' && req.method === 'POST') {
      const body = await readBody(req, 3 * 1024 * 1024);
      const cfg = body && body.reset ? await resetCustomConfig() : await saveCustomConfig(body && body.text);
      return sendJson(res, {
        ok: true,
        config: cfg,
        settings: publicSettings(),
        overview: await proxyOverview()
      });
    }
    if (action === 'connections' && req.method === 'GET') {
      let connections = [];
      let error = null;
      try {
        connections = await liveConnections();
      } catch (e) {
        error = e.message;
      }
      return sendJson(res, {
        ok: !error,
        error,
        connections: connections.slice(0, 300),
        history: connHistory.slice(0, 120),
        historyTotal: connHistory.length
      });
    }
    if (action === 'logs' && req.method === 'GET') {
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 300));
      return sendJson(res, {
        lines: logLines.filter((l) => l.id > since).slice(-limit),
        lastId: logSeq,
        buffered: logLines.length
      });
    }
    if (action === 'action' && req.method === 'POST') {
      const body = await readBody(req);
      switch (body.action) {
        case 'updateSubscription': {
          const r = await updateSubscription('manual');
          return sendJson(res, Object.assign({ ok: true }, r));
        }
        case 'testAll':
          return sendJson(res, { ok: true, delays: await testAllNodes() });
        case 'testNode': {
          const name = String(body.name || '');
          if (!name) throw new Error('缺少节点名');
          try {
            return sendJson(res, { ok: true, name, delay: await testOneNode(name, 6000) });
          } catch (_) {
            return sendJson(res, { ok: true, name, delay: -1 });
          }
        }
        case 'testGroup': {
          const group = String(body.group || '').trim();
          if (!group) throw new Error('缺少策略组名');
          const delays = await testGroupDelay(group, 6000);
          return sendJson(res, { ok: true, group, delays, fastest: fastestFromDelayMap(delays) });
        }
        case 'testGroupSpeed': {
          const group = String(body.group || '').trim();
          if (!group) throw new Error('缺少策略组名');
          const speedGroups = Array.isArray(settings.proxySpeedTestGroups) ? settings.proxySpeedTestGroups : [];
          if (!speedGroups.includes(group)) throw new Error('该策略组没有开启下载测速');
          const delays = await testGroupDelay(group, 5000);
          const r = await measureGroupCandidates(group, delays);
          const withSpeed = r.results.filter((s) => s.speed > 0).sort((a, b) => b.speed - a.speed)[0] || null;
          return sendJson(res, { ok: true, group, delays, speeds: r.results, speedBest: withSpeed });
        }
        case 'selectGroup': {
          const group = String(body.group || '').trim();
          if (!group) throw new Error('缺少策略组名');
          if (group === 'PROXY') throw new Error('不能把 PROXY 指向自己');
          const speedGroups = Array.isArray(settings.proxySpeedTestGroups) ? settings.proxySpeedTestGroups : [];
          if (speedGroups.includes(group) && (group !== 'AUTO' || groupExists('AUTO'))) {
            let apiGroups = null;
            try {
              apiGroups = await proxyGroupsFromApi();
            } catch (_) {}
            if (group !== 'AUTO' && !groupExists(group, apiGroups)) throw new Error('策略组不存在');
            const def = apiGroups && apiGroups.get(group);
            const members = def && Array.isArray(def.members) ? def.members : null;
            const prev = settings.proxySpeedPick;
            const reuse = prev && prev.group === group && prev.node &&
              (!members || members.includes(prev.node)) ? prev.node : '';

            // 先把出口切过去（有上次测速结果就直接用，否则先让组按延迟选），点击立即生效
            if (reuse) {
              settings.proxySelectedNode = reuse;
              settings.proxySelectedGroup = '';
            } else {
              settings.proxySelectedGroup = group;
              settings.proxySelectedNode = '';
              if (prev && prev.group === group) settings.proxySpeedPick = null;
            }
            persistSettings(settings);
            writeRuntime();
            try {
              await mihomoApi('PUT', '/proxies/PROXY', { name: reuse || group });
            } catch (_) {}
            refreshHostExitNodes().catch(() => {});
            log('代理策略组：' + group + '（已切换，后台正在下载测速优选最快节点）');

            // 下载测速放到后台，不阻塞这次点击；结果出来后再自动切换到最快的节点
            startSpeedPickBackground(group);

            const ov = await proxyOverview();
            return sendJson(res, Object.assign({}, ov, {
              ok: true,
              speedPickPending: true,
              reusedPick: reuse || ''
            }));
          }
          if (group === 'AUTO') {
            settings.proxySelectedGroup = '';
            settings.proxySelectedNode = '';
            settings.proxySpeedPick = null;
            persistSettings(settings);
            writeRuntime();
            await applyNodeSelection();
            log('代理节点：切换为 AUTO（自动选择最快节点）');
            return sendJson(res, Object.assign({ ok: true }, await proxyOverview()));
          }
          let apiGroups = null;
          try {
            apiGroups = await proxyGroupsFromApi();
          } catch (_) {}
          if (!groupExists(group, apiGroups)) throw new Error('策略组不存在');
          settings.proxySelectedGroup = group;
          settings.proxySelectedNode = '';
          settings.proxySpeedPick = null;
          persistSettings(settings);
          writeRuntime();
          await applyNodeSelection();
          log('代理策略组：' + group + '（自动检测组内最快节点作为出口）');
          return sendJson(res, Object.assign({ ok: true }, await proxyOverview()));
        }
        case 'selectNode': {
          const name = String(body.name || 'AUTO');
          const names = nodeNamesFromBlock(mihomoProxiesBlock);
          if (name !== 'AUTO' && !names.includes(name)) throw new Error('节点不存在');
          settings.proxySelectedNode = name === 'AUTO' ? '' : name;
          settings.proxySelectedGroup = '';
          settings.proxySpeedPick = null;
          persistSettings(settings);
          writeRuntime();
          await applyNodeSelection();
          log(name === 'AUTO' ? '代理节点：切换为 AUTO（自动选择最快节点）' : '代理节点：固定使用 ' + name);
          return sendJson(res, Object.assign({ ok: true }, await proxyOverview()));
        }
        case 'resetTraffic':
          return sendJson(res, { ok: true, traffic: await resetProxyTraffic() });
        case 'clearConnHistory':
          connHistory = [];
          saveConnHistory(true);
          log('已清空历史连接记录');
          return sendJson(res, { ok: true });
        default:
          return sendJson(res, { error: '未知操作' }, 400);
      }
    }
    return sendJson(res, { error: '未知接口' }, 404);
  } catch (e) {
    return sendJson(res, { error: e.message }, 400);
  }
}

async function main() {
  loadProxyState();
  loadProxyTraffic();
  loadConnHistory();
  activeConsolePort = Number(process.env.PROXY_CONSOLE_PORT) || Number(settings.consolePort) || 8318;
  writeRuntime();
  sampleProxyTraffic(true).catch(() => {});
  setInterval(() => sampleProxyTraffic().catch(() => {}), TRAFFIC_SAMPLE_MS).unref();
  // 旧配置里残留的信息型假节点：启动时清理一次
  if (mihomoProxiesBlock && filterProxyBlock(mihomoProxiesBlock) !== mihomoProxiesBlock) {
    try {
      const cleaned = filterProxyBlock(mihomoProxiesBlock);
      await writeMihomoConfig(cleaned, true);
      mihomoProxiesBlock = cleaned;
      log('已清理订阅里的信息型假节点（剩余流量/套餐到期等）');
    } catch (e) {
      log('清理信息型假节点失败: ' + e.message);
    }
  }

  // 内置模式：启动时确保磁盘配置包含最新的策略组 / 规则（升级后无需等订阅刷新）
  if (mihomoProxiesBlock && settings.mihomoConfigCustom !== true) {
    try {
      const expected = buildMihomoConfigText(mihomoProxiesBlock);
      let actual = '';
      try {
        actual = fs.readFileSync(settings.mihomoConfigPath, 'utf8');
      } catch (_) {}
      if (actual !== expected) {
        await writeMihomoConfig(mihomoProxiesBlock, true);
        log('启动时已同步 mihomo 配置（地区策略组 / 规则）');
      }
    } catch (e) {
      log('启动时同步 mihomo 配置失败: ' + e.message);
    }
  }

  const port = effectiveConsolePort();
  const host = process.env.PROXY_CONSOLE_HOST || settings.consoleHost || '0.0.0.0';
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('请求处理异常:', e.message);
      try {
        sendJson(res, { error: e.message }, 500);
      } catch (_) {}
    });
  });
  server.on('error', (e) => {
    console.error('代理控制台启动失败:', e.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log('');
    console.log('  代理控制台已启动');
    console.log('  ----------------------------------------');
    console.log(`  管理页面: http://127.0.0.1:${port}/admin`);
    for (const ip of lanAddresses()) console.log(`  局域网:   http://${ip}:${port}/admin`);
    console.log(`  配置文件: ${SETTINGS_PATH}`);
    console.log(`  运行快照: ${RUNTIME_PATH}`);
    console.log('');
  });

  scheduleSubscription(15000);
  startSpeedPickTimer();

  // 每 5 秒刷新一次「规则目标 / 选中策略组」当前实际出口节点，变化时重写 runtime
  refreshHostExitNodes().catch(() => {});
  setInterval(() => refreshHostExitNodes().catch(() => {}), 5000).unref();

  const shutdown = () => {
    console.log('\n正在退出…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('代理控制台异常退出:', e);
  process.exit(1);
});
