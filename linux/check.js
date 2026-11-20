#!/usr/bin/env node
'use strict';

/**
 * 直播源体检工具
 * ------------------------------------------------------------
 * 逐个请求源清单里的频道，报告：状态码 / 耗时 / 跳转目标 / 是否拿到 m3u8。
 * 用来判断「到底是哪一类源坏了」，尤其是 mcp / mg 两类源的差异。
 *
 * 用法：
 *   node check.js                 # 检测全部频道
 *   node check.js mcp             # 只检测 URL 里包含 mcp 的频道
 *   node check.js mg              # 只检测 URL 里包含 mg 的频道
 *   node check.js 卫视            # 只检测频道名包含「卫视」的
 *   node check.js mcp 1200        # 间隔 1200ms
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;

function loadConfig() {
  const d = {
    source:
      'https://gist.githubusercontent.com/git-starsh/c935f1184c0a01fca21abce9e0b2546d/raw/tv.m3u',
    defaultUserAgent: 'okHttp/Mod-1.5.0.0',
    requestTimeoutMs: 12000
  };
  try {
    const f = path.join(ROOT, 'config.json');
    if (fs.existsSync(f)) Object.assign(d, JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (_) {}
  return d;
}

const config = loadConfig();
const filter = (process.argv[2] || '').trim();
const delayMs = Number(process.argv[3]) || 1500;
const limit = Number(process.argv[4]) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseM3U(text) {
  const out = [];
  let group = '';
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (/^#EXTGRP:/i.test(t)) {
      group = t.slice(8).trim();
      continue;
    }
    if (/^#EXTINF:/i.test(t)) {
      pending = t;
      continue;
    }
    if (t.startsWith('#')) continue;
    if (!pending) continue;
    const m =
      pending.match(/http-user-agent="([^"]*)"/i) || pending.match(/http-user-agent=([^\s,]+)/i);
    out.push({
      group,
      name: pending.split(',').pop().trim(),
      ua: m ? m[1] : null,
      url: t
    });
    pending = null;
  }
  return out;
}

function rawRequest(urlStr, { headers, timeout }) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return resolve({ status: 0, error: e.message });
    }
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const req = mod.request(
      u,
      { method: 'GET', headers, agent: false, insecureHTTPParser: true },
      (res) => {
        const chunks = [];
        res.on('data', (c) => {
          chunks.push(c);
          if (chunks.reduce((n, b) => n + b.length, 0) > 2 * 1024 * 1024) req.destroy();
        });
        res.on('end', () =>
          done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', (e) => done({ status: 0, error: e.message }));
      }
    );
    const timer = setTimeout(() => {
      done({ status: 0, error: 'timeout' });
      req.destroy();
    }, timeout);
    req.on('error', (e) => done({ status: 0, error: e.code || e.message }));
    req.end();
  });
}

function curlRequest(urlStr, { headers, timeout }) {
  return new Promise((resolve) => {
    const sec = Math.max(1, Math.ceil(timeout / 1000));
    const args = ['-sS', '-L', '--max-time', String(sec)];
    for (const [k, v] of Object.entries(headers)) {
      if (/^user-agent$/i.test(k)) args.push('-A', v);
      else args.push('-H', `${k}: ${v}`);
    }
    args.push('-w', '\n%{http_code}\n%{url_effective}', urlStr);
    execFile(
      'curl',
      args,
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        if (err && !stdout) return resolve({ status: 0, error: 'curl 不可用' });
        const e2 = stdout.lastIndexOf(0x0a);
        const effective = stdout.slice(e2 + 1).toString();
        const e1 = stdout.lastIndexOf(0x0a, e2 - 1);
        const status = parseInt(stdout.slice(e1 + 1, e2).toString(), 10);
        resolve({ status, body: stdout.slice(0, e1), url: effective, viaCurl: true });
      }
    );
  });
}

async function probe(ch) {
  const headers = {
    'User-Agent': ch.ua || config.defaultUserAgent,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Connection: 'close'
  };
  const t0 = Date.now();
  let r = await rawRequest(ch.url, { headers, timeout: config.requestTimeoutMs });
  let via = 'node';

  if (r.status === 0 || r.status >= 500) {
    const r2 = await curlRequest(ch.url, { headers, timeout: config.requestTimeoutMs });
    if (r2.status && r2.status !== 0) {
      r = r2;
      via = 'curl';
    }
  }

  const ms = Date.now() - t0;
  const body = r.body ? r.body.toString('utf8') : '';
  let kind = '—';
  if (r.status >= 300 && r.status < 400) kind = '跳转';
  else if (/#EXT-X-STREAM-INF/i.test(body)) kind = '主清单';
  else if (/#EXTM3U/i.test(body)) kind = '媒体清单';
  else if (r.status === 200) kind = '非m3u8';

  let note = '';
  const loc = (r.headers && r.headers.location) || (r.status >= 300 && r.status < 400 ? r.url : '');
  if (/jsdelivr|feiyang666999/i.test(loc || body)) note = '⚠ 演示视频';
  if (/#EXT-X-ENDLIST/i.test(body)) note = '⚠ 点播(ENDLIST)';

  return {
    group: ch.group,
    name: ch.name,
    url: ch.url,
    status: r.status || (r.error ? `ERR ${r.error}` : '?'),
    ms,
    kind,
    via,
    location: (loc || '').slice(0, 160),
    note
  };
}

async function main() {
  let text = '';
  if (/^https?:/i.test(config.source)) {
    const r = await curlRequest(config.source, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 20000
    });
    text = r.body ? r.body.toString('utf8') : '';
  } else {
    text = fs.readFileSync(config.source, 'utf8');
  }

  let list = parseM3U(text);
  if (filter) {
    const f = filter.toLowerCase();
    list = list.filter(
      (c) =>
        c.url.toLowerCase().includes(f) ||
        c.name.toLowerCase().includes(f) ||
        c.group.toLowerCase().includes(f)
    );
  }

  if (!list.length) {
    console.log('没有匹配的频道');
    return;
  }
  if (limit > 0) list = list.slice(0, limit);

  console.log(`共 ${list.length} 个频道，逐个检测（间隔 ${delayMs}ms）…\n`);

  const results = [];
  for (const ch of list) {
    const r = await probe(ch);
    results.push(r);
    const status = String(r.status).padEnd(9);
    console.log(
      `${status} ${String(r.ms + 'ms').padEnd(8)} ${r.kind.padEnd(7)} ${r.note.padEnd(8)} ${r.name}`
    );
    if (r.location && r.status !== 200) console.log(`          → ${r.location}`);
    await sleep(delayMs);
  }

  const stat = {};
  for (const r of results) {
    const k = typeof r.status === 'number' ? (r.status < 300 ? '2xx/3xx' : String(r.status)) : r.status;
    stat[k] = (stat[k] || 0) + 1;
  }

  console.log('\n===== 汇总 =====');
  for (const [k, v] of Object.entries(stat).sort()) console.log(`${k}: ${v}`);

  const outFile = path.join(ROOT, 'check-result.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\n详细结果已写入 ${outFile}`);
}

main().catch((e) => {
  console.error('检测失败:', e.message);
  process.exit(1);
});
