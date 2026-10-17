#!/usr/bin/env node
/**
 * 从 HAR 抓包文件里提取最新的 Bearer JWT，写回 book.mjs 的 CONFIG.token。
 *
 * 用法：node refresh-token.mjs <你的新抓包.har>
 *
 * token 30 天过期，过期后重抓一次包运行本脚本即可，不用手动改代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bookPath = path.join(__dirname, 'book.mjs');
const harPath = process.argv[2];

if (!harPath || !fs.existsSync(harPath)) {
  console.error('用法：node refresh-token.mjs <新抓包.har>');
  process.exit(1);
}

// 1) 收 HAR 里所有 Authorization，按 iat 取最新
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const seen = [];
let harUA = null;
for (const en of har?.log?.entries || []) {
  for (const h of en.request?.headers || []) {
    const name = String(h.name).toLowerCase();
    if (name === 'authorization' && h.value.startsWith('Bearer ')) {
      const tok = h.value.slice(7);
      try {
        const p = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
        if (p.exp && p.exp * 1000 > Date.now()) seen.push({ tok, exp: p.exp, iat: p.iat || 0, userid: p.userid });
      } catch { /* 跳过解析不了的 */ }
    }
    // token 与 User-Agent 绑定：换包时 UA 必须同步更新，否则服务端返回 12002「Token失效」
    if (name === 'user-agent' && h.value && !harUA) harUA = h.value;
  }
}
if (!seen.length) {
  console.error('HAR 里没找到有效（未过期）的 Authorization token。确认抓包包含小程序接口请求。');
  process.exit(1);
}
seen.sort((a, b) => (b.iat || b.exp) - (a.iat || a.exp));
const pick = seen[0];
const expStr = new Date(pick.exp * 1000).toLocaleString('zh-CN', { hour12: false });
const days = Math.floor((pick.exp * 1000 - Date.now()) / 86400000);

// 2) 写回 book.mjs（token + UA 一起换）
const src = fs.readFileSync(bookPath, 'utf8');
const re = /(token:\s*')([^']*)(')/;
if (!re.test(src)) { console.error('book.mjs 里找不到 token 配置行（token: \'...\'）'); process.exit(1); }
const old = src.match(re)[2];
let updated = src.replace(re, `$1${pick.tok}$3`);
let uaChanged = null;
const uaRe = /const UA = '([^']*)';/;
if (harUA) {
  const curUA = updated.match(uaRe)?.[1] || '';
  if (curUA !== harUA) {
    updated = updated.replace(uaRe, `const UA = '${harUA}';`);
    uaChanged = { old: curUA, now: harUA };
  }
}
fs.writeFileSync(bookPath, updated);

console.log('');
console.log('  ✅ token 已更新');
console.log(`  旧 token：${old.slice(0, 32)}…`);
console.log(`  新 token：${pick.tok.slice(0, 32)}…`);
console.log(`  userid ：${pick.userid}`);
console.log(`  有效期至：${expStr}（剩 ${days} 天）`);
if (uaChanged) {
  console.log('  ✅ UA 已同步（token 与 UA 绑定，不同 UA 会被判 Token失效/12002）');
  console.log(`     旧 UA：${uaChanged.old}`);
  console.log(`     新 UA：${uaChanged.now}`);
}
console.log('  重启 book.mjs 生效：node book.mjs');
console.log('');
