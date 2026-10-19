#!/usr/bin/env node
/**
 * 王知之自习室 · 本地选座下单助手（仅自用）
 * ============================================================
 *  运行：node book.mjs              然后浏览器打开 http://127.0.0.1:8790
 *        node book.mjs --lan        监听 0.0.0.0，同一 WiFi 下手机也能看：http://<你的局域网IP>:8790
 *        （--lan 等价于 WZZ_HOST=0.0.0.0；端口可用 WZZ_PORT 改，默认 8790）
 *
 *  设计目标
 *  --------
 *  1) 只订「月卡 0 元覆盖」的门店（清单实时取自 /card/available-stores，服务端强制校验）
 *  2) 走完 0 元全流程：选店 → 选时段 → 选座 → 生成订单 → 月卡抵扣（实付 ¥0）
 *  3) 支付（非 0 元时）/ 开门 一律回原 App —— 硬件层做不到，见 README
 *  4) 轻量：零依赖，只有 http/fs/path/os 标准库；前端单文件 ui.html
 *  5) token 与 UA 分离到 auth.json，改完即生效（不用重启），支持从 HAR 一键提取
 *
 *  ★ 0 元是怎么实现的（HAR 逐字段实证，2026-10-16 那单）
 *  ---------------------------------------------------
 *    confirmSeat 只生成「待支付」订单（orderStatus=1），wechat-order-amt 报原价
 *    （四川绵阳万达店 700分/h × 4.5h = 3150 分）。真正让月卡抵扣、把单子变成
 *    「已支付」的是：
 *      POST /seat/order/changeTheTime
 *        { orderId, userCardId:<月卡>, cardId:null, cardTypeCode:'DAY',
 *          ruleId:null, extendOrderId:'', type:1, izWeChatPay:false }
 *      → 返回 data.code:326「订单支付成功」，orderStatus 1 → 3，
 *        cardTypeName=时长卡，paymentMethod=9，实付 0 元（扣月卡 1 天）。
 *    接口名写着「改时长」，但 HAR 里它就是「选卡结算」那一步，别被名字骗了。
 *
 *  三件套请求头（所有接口都要，token 与 UA 绑死，差一位就返回 12002）：
 *    Authorization: Bearer <JWT>
 *    User-Agent: 登录那串 MicroMessenger/8.0.78(...)
 *    Referer: https://servicewechat.com/<appId>/205/page-frame.html
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 内嵌资源：云端（Vercel serverless）函数包里没有 ui.html / 种子文件，
// 所以在同一目录生成 ui-html.js / zero-seed.js，import 时直接拿到字符串。
// 本机运行时同样优先用内嵌，逻辑一致、行为统一。
import { UI_HTML } from './ui-html.js';
import { ZERO_SEED } from './zero-seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ======================= CONFIG =======================
// ---- 监听地址 ----
// 默认只监听本机（安全）。想在手机上看效果（同一 WiFi）再开局域网：
//     node book.mjs --lan        或        WZZ_HOST=0.0.0.0 node book.mjs
// 端口：WZZ_PORT=xxxx（默认 8790）
// ⚠ 开放到局域网后，同网段任何设备都能操作这个账号（token 存在服务端），看完请改回本机模式。
function resolveHost() {
  if (process.argv.slice(2).includes('--lan')) return '0.0.0.0';
  return String(process.env.WZZ_HOST || '').trim() || '127.0.0.1';
}
function lanIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

const CONFIG = {
  port: Number(process.env.WZZ_PORT || 8790),
  host: resolveHost(),
  appId: 'wxa5cf43f677b9a059',
  base: 'https://wxa.wangzhizhi.mored.tech/opsli-boot/api/v1/applet',

  zeroCardId: '20261015110218471-000346pvpGZKAx',   // 月卡 userCardId（0 元覆盖）
  zeroCardTypeCode: 'DAY',                          // 月卡的 cardTypeCode，抵扣时必填
  allowCardSettle: true,                            // 允许月卡抵扣（会扣 1 天，不可撤销）

  zeroStoresTtlMs: 10 * 60 * 1000,   // 0 元门店清单缓存 10 分钟
  homeLon: 87.6, homeLat: 43.8,      // confirmSeat 的 remarks（下单不校验位置）
};

// 兜底 token：**不内置任何真实凭证**。请把 auth.json（.gitignore 已排除）放在本目录，
// 或用「我的 → 更新 JWT token」面板从 HAR 抓包一键写入。
const DEFAULT_AUTH = {
  token: '',
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.78(0x18004e33) NetType/WIFI Language/zh_CN',
  savedAt: null,
  source: '尚未配置，请从「我的 → 更新 JWT token」写入',
};

const AUTH_FILE = path.join(__dirname, 'auth.json');
const HAR_SCAN_DIRS = [path.join(os.homedir(), 'Downloads'), path.join(__dirname, '..')];

// ======================= auth（env 优先，auth.json 兜底） =======================
// 云端部署（Vercel）：token/ua 来自环境变量 WZZ_TOKEN / WZZ_UA，不落盘。
// 本机部署：仍然读 auth.json，行为不变。
let auth = null, authMtime = 0, authCheckedAt = 0;

function envAuth() {
  const t = String(process.env.WZZ_TOKEN || '').trim();
  if (t.length < 40) return null;
  return {
    token: t,
    ua: String(process.env.WZZ_UA || '').trim() || DEFAULT_AUTH.ua,
    savedAt: null,
    source: '环境变量 WZZ_TOKEN',
  };
}

function loadAuth(force = false) {
  const now = Date.now();
  const ev = envAuth();
  if (ev) return ev;                    // 云端：env 有就用 env，不碰文件
  if (!force && auth && now - authCheckedAt < 2000) return auth;
  authCheckedAt = now;
  try {
    const st = fs.statSync(AUTH_FILE);
    if (!force && auth && st.mtimeMs === authMtime) return auth;
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (j && typeof j.token === 'string' && j.token.length > 40) {
      auth = { token: j.token.trim(), ua: (j.ua || DEFAULT_AUTH.ua).trim(), savedAt: j.savedAt || null, source: j.source || 'auth.json' };
      authMtime = st.mtimeMs;
      return auth;
    }
  } catch { /* 不存在或坏文件 → 用兜底 */ }
  if (!auth) { auth = { ...DEFAULT_AUTH }; authMtime = 0; }
  return auth;
}

function saveAuth(next) {
  const payload = { token: next.token, ua: next.ua, savedAt: new Date().toISOString(), source: next.source || '手动更新' };
  // 云端只存内存（serverless 文件系统只读）；本机才写 auth.json
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    auth = { ...payload };
    authMtime = fs.statSync(AUTH_FILE).mtimeMs;
  } catch {
    auth = { ...payload };
  }
  return auth;
}

// ======================= 访问控制（仅写操作需要登录密钥） =======================
// 公开访问的部分（任何人都能看）：门店清单 / 门店详情 / 座位图 / 订单查询 / 卡片 / 状态 / 占座。
// 需要「登录密钥」的部分：一切会动你账号的操作 —— 订座、结算、开门、签到、退座、取消、
//   换座、延长、人脸建档、以及更新 token 本身。
// 设计意图：部署到公网时，浏览门店、看座位图完全开放；只有「真正下单 / 操作硬件」时才
//   要求输入登录密钥（前端在对应按钮处弹出，用的是项目自带的弹窗样式，不是整站门禁）。
// 本机跑（不设 WZZ_ACCESS_KEY）：全部放行，行为不变。
// 密钥取值：环境变量 WZZ_ACCESS_KEY；前端通过 X-Access-Key 头带上（并存 localStorage）。
const ACCESS_KEY = String(process.env.WZZ_ACCESS_KEY || '').trim();
// 需要密钥的写操作路由（按 pathname 判定）
const PROTECTED = new Set([
  '/api/book', '/api/settle', '/api/use-card', '/api/cancel',
  '/api/face', '/api/door', '/api/light', '/api/leave', '/api/checkin',
  '/api/changeSeat', '/api/extend', '/api/token',
]);
function hasKey(req) {
  if (!ACCESS_KEY) return true;                       // 没设密钥：本机直通
  const hdr = String(req.headers['x-access-key'] || '');
  if (hdr && hdr === ACCESS_KEY) return true;
  const ck = String(req.headers['cookie'] || '');
  const m = /(?:^|;\s*)wzz_key=([^;]+)/.exec(ck);
  return !!m && decodeURIComponent(m[1]) === ACCESS_KEY;
}

// ======================= 上游 API 代理 =======================
// GET 自动重试（12002/5xx/网络抖动实测瞬时出现，重试即恢复）；
// POST 绝不重试 —— confirmSeat 超时重试会重复下单，changeTheTime 重试会重复扣天数。
async function apiOnce(p, params, method, body, timeoutMs, authOverride, form) {
  const a = authOverride || loadAuth();
  const url = new URL(CONFIG.base + p);
  url.searchParams.set('appId', CONFIG.appId);
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': 'Bearer ' + a.token,
        'User-Agent': a.ua,
        'Referer': `https://servicewechat.com/${CONFIG.appId}/205/page-frame.html`,
        // 上游分两种入参风格（实测）：judgment_condition / openLight / chooseSeatNow 收 JSON；
        // finishStudy / changeSeat / immediatelySeat 只认 form-urlencoded（传 JSON 会报「订单号不能为空」，传 form 给 openLight 会 HTTP 415）。
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: form ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : undefined),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); }
    catch { return { success: false, code: null, msg: `非 JSON 响应（HTTP ${res.status}）`, raw: text.slice(0, 300), retryable: res.status >= 500 }; }
    const retryable = j?.code === 12002 || (j?.httpStatus ?? 0) >= 500;
    return { ...j, retryable };
  } catch (e) {
    return { success: false, code: null, msg: '请求失败：' + (e.name === 'AbortError' ? '超时' : e.message), retryable: true };
  } finally { clearTimeout(timer); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(p, params = null, method = 'GET', body = null, timeoutMs = 20000, retries = 2, authOverride = null) {
  const max = method === 'GET' ? retries : 0;
  for (let attempt = 0; ; attempt++) {
    const r = await apiOnce(p, params, method, body, timeoutMs, authOverride);
    if (!r.retryable || attempt >= max) return r;
    await sleep(1000 * (attempt + 1));
  }
}

// POST 一律不重试（见上），form-urlencoded 变体也一样。
async function apiForm(p, form, timeoutMs = 20000) {
  return apiOnce(p, null, 'POST', null, timeoutMs, null, form);
}

// ======================= 订单状态码 =======================
// ⚠ 平台没有公开枚举。下表里 confirmed 的是 HAR / 实测直接观察到的，inferred 的由前端标注提示。
//   已实证：1 = 待支付（wechat-order-amt 报原价、queryUserUsedCard 返回 308）
//          3 = 已支付（changeTheTime 返回 326 后回读所得，paymentMethod=9、cardTypeName=时长卡）
//          6 = 使用中（同一单在 19:20–23:47 时段内回读为 6；此状态下 finishStudy 可执行）
//          8 = 已结束（实测 finishStudy 之后 6 → 8，且 studyEndTime 被截断为退座那一刻）
//   注意：早先版本把 6 标成「已结束」是错的 —— 那是「进行中」，8 才是结束。
const ORDER_STATUS = {
  1: { label: '待支付', tone: 'warn', conf: 'confirmed', hint: '还没结算。用月卡抵扣后才会变「已支付」。' },
  3: { label: '已支付（待使用）', tone: 'ok', conf: 'confirmed', hint: '钱/卡已结清。到时段前后可以开门、开灯。' },
  6: { label: '使用中', tone: 'blue', conf: 'confirmed', hint: '当前正处于预约时段内，座位已锁定。此状态下能开门 / 开灯 / 退座。' },
  4: { label: '已取消', tone: 'mute', conf: 'confirmed', hint: '用「取消预约」撤销了这单，座位已释放、月卡天数不退。' },
  8: { label: '已结束', tone: 'mute', conf: 'confirmed', hint: '已退座或时段已过。座位已释放，无法再开门。' },
  // 下面两档来自 querySeatOrderList 的历史单观察（账号里 5 有 7 张、7 有 2 张），
  // 平台不返回文字状态、App 是前端映射的，所以标 inferred，请以原 App 显示为准。
  5: { label: '已完成', tone: 'mute', conf: 'inferred', hint: '历史单里最常见的终态。平台不返回文案，此标签是按分布推断的。' },
  7: { label: '已关闭', tone: 'mute', conf: 'inferred', hint: '历史单里出现过的终态，疑似「未到店 / 已过期」。请以原 App 显示为准。' },
};

function statusInfo(code) {
  const c = Number(code);
  if (ORDER_STATUS[c]) return { code: c, ...ORDER_STATUS[c] };
  return { code: c, label: `状态 ${Number.isFinite(c) ? c : '?'}`, tone: 'mute', conf: 'unknown', hint: '该状态码尚未确认，请以原 App 显示为准' };
}

// ======================= 0 元门店清单 =======================
let zeroCache = null;

function cityOf(areaName = '') {
  const a = (areaName || '').trim();
  for (const m of ['北京市', '天津市', '上海市', '重庆市']) if (a.startsWith(m)) return m;
  const prov = a.match(/^([^省]{2,10}?(?:省|自治区))/);
  const city = a.match(/(?:省|自治区)([^省]{2,15}?(?:市|自治州|地区|盟))/);
  if (city) return city[1];
  const m2 = a.match(/^([^\s市]{2,12}市)/);
  if (m2) return m2[1];
  if (prov) {
    const m3 = a.slice(prov[1].length).match(/^([^\s]{2,15}?(?:市|自治州|地区|盟))/);
    if (m3) return m3[1];
  }
  return '未知';
}

// 平台的数据里偶发把区名重复一遍，官方小程序拿到的原样就是这样：
//   '重庆市重庆市渝北区'                （getStoreBrief / getStoreDetail 的 storeAreaName）
//   '重庆市渝北区重庆市渝北区山茶路…'   （/card/available-stores 的 storeAreaName）
// 前者是「市区重了」，后者是「区名前缀重了」。这里统一折叠掉重复前缀，
// 否则门店列表/门店详情会显示成「重庆市渝北区重庆市渝北区山茶路…」。
function dedupeAddr(s = '') {
  let a = String(s || '').trim();
  // 「市辖区」是平台塞的占位符，后面往往又跟了真正的市+区，先去掉
  a = a.replace(/市辖区/g, '');
  // 把连写两遍的「市/区/县」折叠成一遍：
  //   「重庆市重庆市渝北区」            → 「重庆市渝北区」
  //   「安徽省蚌埠市蚌埠市蚌山区…」      → 「安徽省蚌埠市蚌山区…」
  a = a.replace(/([\u4e00-\u9fa5]{2,6}(?:市|区|县))\1/g, '$1');
  return a;
}

function normalizeStore(row) {
  // 字段优先级：storeAreaAll/storeAreaTotal 是完整地址；商店列表接口只有 storeAreaName。
  const addr = dedupeAddr(row.storeAreaAll || row.storeAreaTotal || row.storeAreaName || '');
  return {
    storeId: String(row.storeId ?? row.id),
    // 门店名去掉首尾空白：平台有「 知之书房·翠苑·社区自习室」这种带前导空格的名字，
    // 原样透出会在列表里看起来像多了一条，且排序会跑到最前。
    storeName: String(row.storeName ?? '').trim(),
    city: cityOf(addr),
    addr,
    bizTime: row.storeBusinessTime || '',
  };
}

function loadSeedStores() {
  try {
    const seed = ZERO_SEED;   // 内嵌种子，云端/本机一致
    return { map: new Map(seed.stores.map(r => [String(r.storeId), normalizeStore(r)])), total: seed.stores.length };
  } catch { return { map: new Map(), total: 0 }; }
}

// 分页拉全（免得某张卡覆盖超过单页上限时漏店）
async function fetchAllZeroStores() {
  // 平台分页不可靠：pageSize 小的时候 pageNo=2 会重复返回第一页，
  // 顺着 pageCount 翻会得到重复数据、后面真正的门店被漏掉。
  // 实测 pageSize 1000 一次就能把 225 家全给回来（pageCount=1），所以直接要一个大页，
  // 万一哪天超过 1000 家，再按 total 判断是否需要继续翻页。
  const pageSize = 1000;
  const all = [];
  const seen = new Set();
  for (let pageNo = 1; pageNo <= 20; pageNo++) {
    const r = await api('/card/available-stores', { userCardId: CONFIG.zeroCardId, cityId: '', pageNo, pageSize });
    const rows = r?.data?.rows || [];
    let fresh = 0;
    for (const row of rows) {
      const id = String(row.storeId ?? row.id);
      if (seen.has(id)) continue;        // 同一页重复返回时去重，避免提前收工
      seen.add(id); all.push(row); fresh++;
    }
    const total = Number(r?.data?.total ?? 0);
    // 收工条件：没数据 / 没有新数据 / 已拿满 total
    if (!rows.length || !fresh) break;
    if (total && all.length >= total) break;
  }
  return all;
}

async function getZeroStores(force = false) {
  if (zeroCache && !force && Date.now() - zeroCache.ts < CONFIG.zeroStoresTtlMs) return zeroCache;
  try {
    const rows = await fetchAllZeroStores();
    if (rows.length) {
      const map = new Map(rows.map(row => [String(row.storeId ?? row.id), normalizeStore(row)]));
      zeroCache = { ts: Date.now(), map, total: map.size, stale: false };
      return zeroCache;
    }
    throw new Error('接口返回空清单');
  } catch (e) {
    const seed = loadSeedStores();
    zeroCache = { ts: Date.now(), map: seed.map, total: seed.total, stale: true, failMsg: e.message };
    return zeroCache;
  }
}

async function isZeroStore(storeId) {
  const z = await getZeroStores();
  const hit = z.map.get(String(storeId));
  if (hit) return { ok: true, store: hit, total: z.total };
  // 缓存可能过期（刚买卡/换卡）→ 强刷一次再判
  const fresh = await getZeroStores(true);
  const hit2 = fresh.map.get(String(storeId));
  return { ok: !!hit2, store: hit2 || null, total: fresh.total };
}

// ======================= 小工具 =======================
function decodeToken(token = loadAuth().token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { exp: p.exp, iat: p.iat, userId: p.userid, openid: p.openid, appid: p.appid };
  } catch { return null; }
}

function send(res, obj, code = 200) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limit = 12e6) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}

const minToHHMM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

// 计费：向上取整到 continueTimeUnit（HAR 实证 267min → 4.5h，unit=30）
function billableMinutes(minutes, unit = 30) { return Math.ceil(minutes / unit) * unit; }

// ======================= 月卡 / 卡券 =======================
// 权威来源：GET /card/user_cards（无需入参，返回用户全部卡）。
// 注意：/api/status 里 token.exp（2026/11/15）是 **JWT 的过期时间**，不是月卡有效期
// （月卡是 2026-11-11 23:59:59）。早先把两者混为一谈，正是「月卡剩余时间和
// 截止日期显示不正确」的根因。
const CARD_STATUS = {
  1: { label: '生效中', tone: 'ok',   usable: true  },
  2: { label: '未生效', tone: 'mute', usable: false },
  3: { label: '已用完', tone: 'mute', usable: false },
  4: { label: '不可用', tone: 'warn', usable: false },
  5: { label: '已过期', tone: 'mute', usable: false },
};
const cardCache = { ts: 0, data: null };
const CARD_TTL = 3 * 60 * 1000;

function normalizeCard(c) {
  const st = CARD_STATUS[c && c.status] || { label: '状态' + (c && c.status), tone: 'mute', usable: false };
  const exp = c && c.expiredTime ? String(c.expiredTime).slice(0, 16) : null;
  let daysLeft = null;
  if (c && c.expiredTime) {
    const t = new Date(String(c.expiredTime).replace(' ', 'T')).getTime();
    if (!isNaN(t)) daysLeft = Math.ceil((t - Date.now()) / 86400000);
  }
  const isHour = c && c.cardTypeCode === 'HOUR';
  return {
    userCardId: c && c.userCardId, cardId: c && c.cardId, name: c && c.cardName,
    typeCode: c && c.cardTypeCode, remain: c && c.remainValue,
    remainUnit: isHour ? '小时' : '天',
    expiredTime: exp, daysLeft,
    status: c && c.status, statusLabel: st.label, tone: st.tone, usable: st.usable,
    activateStatus: c && c.activateStatus,
    image: (c && (c.showImage || (Array.isArray(c.showImageList) && c.showImageList[0]))) || null,
  };
}

async function getCards(force) {
  if (!force && cardCache.data && Date.now() - cardCache.ts < CARD_TTL) return cardCache.data;
  const resp = await api('/card/user_cards', null, 'GET');
  const raw = Array.isArray(resp && resp.data) ? resp.data : (Array.isArray(resp) ? resp : []);
  const cards = raw.map(normalizeCard);
  // 主卡 = 生效中且按天计费的那张（月卡）
  const primary = cards.find(c => c.usable && c.typeCode === 'DAY')
    || cards.find(c => c.usable) || cards[0] || null;
  cardCache.ts = Date.now();
  cardCache.data = { cards, primary };
  return cardCache.data;
}

// ======================= 路由 =======================
const routes = [];
const get = (p, h) => routes.push({ method: 'GET', pattern: p, handler: h });
const post = (p, h) => routes.push({ method: 'POST', pattern: p, handler: h });

// ---------- 自检：这台机器/这个函数看到的外网 IP ----------
// 用途：判断「Vercel 之后我们的出口 IP 会不会变」。
// 实测结论（写死在这里免得以后又猜）：Vercel 函数走 AWS Lambda，出口 IP 是**固定的一组**
// （每个区域固定的几个地址），不会像家宽那样拨号就换。所以从平台看，
// 我们的请求始终来自「同一批机房 IP」——稳定，不像异地登录；
// 但也正因为是机房 IP，绝不能多账号共用这一个 token。
get('/api/whoami', async (q, _b, r) => {
  let ip = null, ms = null;
  try {
    const t0 = Date.now();
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    ip = j.ip; ms = Date.now() - t0;
  } catch (e) { ip = '查询失败：' + e.message; }
  send(r, { ok: true, ip, ms, env: process.env.VERCEL ? 'vercel' : 'local', region: process.env.VERCEL_REGION || null });
});

// ---------- 状态总览 ----------
get('/api/status', async (q, _b, r) => {
  const a = loadAuth(true);
  const t = decodeToken(a.token);
  let alive = null, probeMsg = null;
  try {
    const probe = await api('/fp/store/org/store-count', null, 'GET', null, 12000, 1);
    alive = probe?.success === true || probe?.code === 200;
    if (probe?.code === 12002) probeMsg = '服务端返回 Token失效(12002)';
    else if (!alive) probeMsg = probe?.msg || probe?.code || '探活失败';
  } catch (e) { probeMsg = e.message; }

  let zeroCount = null, zeroStale = null, storesAt = null, cities = 0, failMsg = null;
  try {
    const z = await getZeroStores();
    zeroCount = z.total; zeroStale = !!z.stale; storesAt = z.ts; failMsg = z.failMsg || null;
    cities = new Set([...z.map.values()].map(s => s.city)).size;
  } catch { }

  let cards = null, primaryCard = null, cardMsg = null;
  try { const c = await getCards(false); cards = c.cards; primaryCard = c.primary; }
  catch (e) { cardMsg = e.message; }

  send(r, {
    ok: true,
    token: t ? {
      exp: t.exp, iat: t.iat,
      expStr: new Date(t.exp * 1000).toLocaleString('zh-CN', { hour12: false }),
      iatStr: t.iat ? new Date(t.iat * 1000).toLocaleString('zh-CN', { hour12: false }) : null,
      daysLeft: Math.floor((t.exp * 1000 - Date.now()) / 86400000),
      myUserId: t.userId,
    } : null,
    tokenAlive: alive, probeMsg,
    tokenSource: a.source, tokenSavedAt: a.savedAt,
    zeroCount, zeroStale, storesAt, failMsg, cities,
    cardId: CONFIG.zeroCardId,
    cards, primaryCard, cardMsg,
    allowCardSettle: CONFIG.allowCardSettle,
    orderStatusMap: ORDER_STATUS,
  });
});

// ---------- 卡券列表（新鲜拉取）----------
get('/api/cards', async (q, _b, r) => {
  try { const c = await getCards(q.force === '1'); send(r, { ok: true, ...c }); }
  catch (e) { send(r, { ok: false, msg: e.message }, 502); }
});

// ---------- 取消预约 ----------
// 官方小程序有「取消预约」按钮（用户确认）。两份 HAR 都没抓到它，靠 840 个候选
// 路由爆破找到：POST /seat/order/cancelReservation，form-urlencoded，只需 orderId。
// 规则来自 queryCancelRule：aheadCancelBookingMinutes=30 —— 离开车不足 30 分钟再取消
// 属违约，按 bookingAheadCloseDeductMinutes=30 扣减（用户所述「违约扣 30 分钟」）。
post('/api/cancel', async (q, b, r) => {
  const orderId = b.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (b.confirm !== true) {
    return send(r, { ok: false, blocked: true, needConfirm: true, msg: '取消预约会释放座位，需要二次确认' }, 409);
  }
  let before;
  try { before = await api('/seat/order/queryOrderDetails', { orderId }); }
  catch (e) { return send(r, { ok: false, msg: '查单失败：' + e.message }, 502); }
  const d = before && before.data;
  if (!d || !d.orderId) return send(r, { ok: false, msg: (before && before.msg) || '订单不存在' }, 404);

  const st = Number(d.orderStatus);
  if (st === 8) return send(r, { ok: false, msg: '这单已经结束了，不用取消' }, 409);

  const beginStr = d.studyBeginTime || d.beginTime || null;

  // 门店取消规则 + 离开车时间还有多久
  let rule = null;
  try {
    const storeId = d.storeId || d.orgId;
    if (storeId) rule = (await api(`/seat/order/${encodeURIComponent(storeId)}/queryCancelRule`)).data || null;
  } catch { }
  let leadMin = null;
  if (beginStr) {
    const t = new Date(String(beginStr).replace(' ', 'T')).getTime();
    if (!isNaN(t)) leadMin = Math.floor((t - Date.now()) / 60000);
  }
  const need = Number((rule && rule.aheadCancelBookingMinutes) ?? 30);
  const deduct = Number((rule && rule.bookingAheadCloseDeductMinutes) ?? 30);
  const penalty = leadMin != null && leadMin > 0 && leadMin < need;

  let res = null, err = null;
  try { res = await apiForm('/seat/order/cancelReservation', { orderId, appId: CONFIG.appId }); }
  catch (e) { err = e.message; }

  // 成功与否以**回读服务端真值**为准，不信返回码的自我祝贺
  let after = null;
  try { after = await api('/seat/order/queryOrderDetails', { orderId }, 'GET', null, 12000, 1); } catch { }
  const ad = after && after.data;
  const afterStatus = ad && ad.orderId ? Number(ad.orderStatus) : null;
  const gone = !ad || !ad.orderId;
  const cancelled = gone || afterStatus === 8;

  let cardAfter = null;
  if (cancelled) { try { cardAfter = (await getCards(true)).primary; } catch { } }

  send(r, {
    ok: !!cancelled,
    code: Number((res && res.data && res.data.code) ?? (res && res.code)) || null,
    message: (res && ((res.data && res.data.message) || res.msg)) || err || null,
    raw: (res && (res.data || res)) || null,
    before: { orderStatus: st, label: (ORDER_STATUS[st] || {}).label || '状态' + st, begin: beginStr },
    after: afterStatus != null
      ? { orderStatus: afterStatus, label: (ORDER_STATUS[afterStatus] || {}).label || '状态' + afterStatus }
      : (gone ? { orderStatus: null, label: '订单已不在列表（已取消）' } : null),
    leadMin, rule: rule ? { need, deduct } : null, penalty,
    penaltyNote: leadMin == null ? null
      : leadMin <= 0 ? '已经过了开始时间，取消属于违约'
      : penalty ? `离开车只剩 ${leadMin} 分钟（少于门店要求的提前 ${need} 分钟），属于违约，扣减 ${deduct} 分钟`
                : `离开车还有 ${leadMin} 分钟，满足「提前 ${need} 分钟取消」，不违约`,
    cardAfter: cardAfter ? { name: cardAfter.name, remain: cardAfter.remain, remainUnit: cardAfter.remainUnit } : null,
    msg: cancelled ? '已取消预约' : (err || (res && res.msg) || '取消失败'),
  });
});

// ---------- 0 元门店列表 ----------
get('/api/stores', async (q, _b, r) => {
  const z = await getZeroStores(q.force === '1');
  const stores = [...z.map.values()].sort((a, b) => a.city.localeCompare(b.city, 'zh') || a.storeName.localeCompare(b.storeName, 'zh'));
  const byCity = {};
  for (const s of stores) (byCity[s.city] ||= []).push(s.storeId);
  send(r, {
    ok: true, total: z.total, updatedAt: z.ts, stale: !!z.stale, failMsg: z.failMsg || null,
    cityCount: Object.keys(byCity).length, byCity, stores,
  });
});

// ---------- 门店详情（含营业状态 / 座位数 / 取消规则 / 空间单价）----------
get('/api/store', async (q, _b, r) => {
  const storeId = q.storeId;
  if (!storeId) return send(r, { ok: false, msg: '缺少 storeId' }, 400);
  const date = q.date || new Date().toLocaleDateString('sv-SE');
  const [det, open, prices, rule] = await Promise.all([
    api('/sp/store/org/getStoreDetail', { id: storeId, storeLat: CONFIG.homeLat, storeLon: CONFIG.homeLon, date }),
    api('/store/live_situation/iz_open', { storeId }),
    api('/store-space-booking-prices/list', { storeId, seatType: 'SEAT' }),
    api(`/seat/order/${encodeURIComponent(storeId)}/queryCancelRule`),
  ]);
  const d = det?.data || {};
  if (!d.id && !d.storeName) return send(r, { ok: false, msg: det?.msg || '门店详情获取失败' }, 502);
  const priceList = prices?.data?.[0]?.spacePriceList || [];
  send(r, {
    ok: true,
    store: {
      storeId: String(storeId), name: d.storeName, area: d.storeAreaName,
      addr: d.storeAreaAll || d.detailAddress || d.storeAreaName,
      lon: d.storeLon, lat: d.storeLat, distance: d.storeDistance,
      photos: d.storePhotoAll || [], pledge: d.civilizedPledge || [],
      bizStart: d.businessStartTime, bizEnd: d.businessEndTime,
      seatAll: d.storeSeatAll, seatUsed: d.storeSeatUsed,
      demandMinutes: d.storeDemandTime ?? 60,        // 最短时长
      maxMinutes: d.orderLongestReservationTime ?? 720, // 最长时长
      advanceReservation: d.storeAdvanceReservation ?? 30,
      demandDay: d.storeDemandDay ?? 5,              // 可提前几天
      stepMinutes: d.stepMinutes ?? d.seatSelectionInterval ?? 30,
      distanceStipulation: d.storeDistanceStipulation ?? 1000,
      isOpen: open?.data === true,
    },
    prices: priceList.map(p => ({ spaceId: String(p.spaceId), price: p.price, yuanPerHour: p.price / 100 })),
    cancelRule: rule?.data || null,
  });
});

// ---------- 座位图 ----------
get('/api/seats', async (q, _b, r) => {
  const { storeId, date, start, end } = q;
  if (!storeId || !date || !start || !end) return send(r, { ok: false, msg: '缺少 storeId/date/start/end' }, 400);
  const startTime = `${date} ${start}:00`, endTime = `${date} ${end}:00`;
  const [live, det, prices] = await Promise.all([
    api('/store/live_situation/query', { storeId, startTime, endTime, chooseWay: 2 }),
    api('/sp/store/org/getStoreDetail', { id: storeId, storeLat: CONFIG.homeLat, storeLon: CONFIG.homeLon, date }),
    api('/store-space-booking-prices/list', { storeId, seatType: 'SEAT' }),
  ]);
  if (live?.success === false) return send(r, { ok: false, msg: live.msg || '座位图获取失败' }, 502);
  const t = decodeToken();
  const rooms = (live?.data || []).map(room => ({
    roomId: room.roomId, roomName: room.roomName,
    img: room.bgImgUrl,
    imgW: Number(room.bgImgWidth) || 100,   // x 坐标基准
    imgH: Number(room.bgImgLength) || 100,  // y 坐标基准
    seats: (room.seatSelectionConfigs || []).map(s => ({
      seatId: String(s.seatId), spaceId: String(s.spaceId),
      spaceName: s.spaceName, seatName: String(s.seatName),
      x: Number(s.coordinateX) || 0, y: Number(s.coordinateY) || 0,
      w: Number(s.imageWidth) || 50, h: Number(s.imageLength) || 50,
      taken: s.userId != null, occupantUserId: s.userId ? String(s.userId) : null,
      photo: s.userPhoto || null,
      mine: !!(t?.userId && s.userId && String(s.userId) === String(t.userId)),
      bookable: s.openBookingStatus === 1,
    })),
  }));
  const d = det?.data || {};
  const priceList = prices?.data?.[0]?.spacePriceList || [];
  send(r, {
    ok: true, rooms,
    prices: priceList.map(p => ({ spaceId: String(p.spaceId), price: p.price, yuanPerHour: p.price / 100 })),
    store: {
      storeId, name: d.storeName, area: d.storeAreaName,
      bizStart: d.businessStartTime, bizEnd: d.businessEndTime,
      seatAll: d.storeSeatAll, seatUsed: d.storeSeatUsed,
      lon: d.storeLon, lat: d.storeLat,
      stepMinutes: d.stepMinutes ?? d.seatSelectionInterval ?? 30,
      demandMinutes: d.storeDemandTime ?? 60,
      maxMinutes: d.orderLongestReservationTime ?? 720,
    },
    myUserId: t?.userId || null,
  });
});

// ---------- 单座位空闲校验 ----------
get('/api/spare', async (q, _b, r) => {
  const { storeId, spaceId, seatId, date, start, end } = q;
  if (!storeId || !spaceId || !seatId || !date || !start || !end) return send(r, { ok: false, msg: '参数不完整' }, 400);
  const res = await api('/seat/querySeatSpareTime', {
    storeId, spaceId, seatId,
    studyBeginTime: `${date} ${start}:00`, studyEndTime: `${date} ${end}:00`,
  });
  const busy = Array.isArray(res?.data) ? res.data : [];
  send(r, { ok: true, busyCount: busy.length, busy });
});

// ---------- 下单 ----------
post('/api/book', async (q, body, r) => {
  const { storeId, spaceId, seatId, date, start, end } = body || {};
  if (!storeId || !spaceId || !seatId || !date || !start || !end) {
    return send(r, { ok: false, msg: '参数不完整（storeId/spaceId/seatId/date/start/end）' }, 400);
  }
  // ① 硬约束：只订月卡 0 元覆盖店
  const zero = await isZeroStore(storeId);
  if (!zero.ok) {
    return send(r, { ok: false, blocked: true, msg: `已拒绝：该店不在月卡 0 元覆盖清单（${zero.total} 家）内。本工具只订 0 元店。` }, 403);
  }
  const st = zero.store;
  const startTime = `${date} ${start}:00`, endTime = `${date} ${end}:00`;

  // ② 本地前置校验（给出比后端更友好的提示；最终以后端 chooseSeatNow 为准）
  const info = (await api('/sp/store/org/getStoreDetail', { id: storeId, storeLat: CONFIG.homeLat, storeLon: CONFIG.homeLon, date }))?.data || {};
  const dur = toMin(end) - toMin(start);
  const demand = info.storeDemandTime ?? 60, longest = info.orderLongestReservationTime ?? 720;
  if (dur <= 0) return send(r, { ok: false, msg: '开始时间必须早于结束时间' }, 400);
  if (dur < demand) return send(r, { ok: false, msg: `该店最短可预约 ${demand} 分钟，你选了 ${dur} 分钟` }, 400);
  if (dur > longest) return send(r, { ok: false, msg: `该店单次最长 ${Math.floor(longest / 60)} 小时，你选了 ${(dur / 60).toFixed(1)} 小时` }, 400);

  // ③ 该座位在这个时段是否真的空着（HAR 里小程序也先调了这一步）
  const spare = await api('/seat/querySeatSpareTime', { storeId, spaceId, seatId, studyBeginTime: startTime, studyEndTime: endTime });
  if (Array.isArray(spare?.data) && spare.data.length) {
    return send(r, { ok: false, blocked: true, stage: 'querySeatSpareTime', msg: '该座位在这个时段已被占用，换一个座位或换个时段。' }, 409);
  }

  // ④ 前置校验（code 308 = 可继续）
  const pre = await api('/seat/order/chooseSeatNow', null, 'POST',
    { storeId, startTime, endTime, chooseWay: 2, timeStep: 60, storeAdvanceReservation: info.storeAdvanceReservation ?? 30, seatType: 1 });
  const preCode = pre?.data?.code, preMsg = pre?.data?.message || pre?.msg;
  if (preCode !== 308) {
    return send(r, { ok: false, blocked: true, stage: 'chooseSeatNow', code: preCode, msg: `前置校验未通过（code=${preCode}）：${preMsg || '该时段可能不可预约'}` }, 409);
  }

  // ⑤ 生成订单（★ POST 不重试，超时后请去「当前预约」看有没有生成）
  const conf = await api('/seat/order/confirmSeat', null, 'POST',
    { storeId, spaceId, seatId, startTime, endTime, chooseWay: 2, remarks: `${CONFIG.homeLon},${CONFIG.homeLat}` });
  const orderId = conf?.data?.data;
  if (!orderId || typeof orderId !== 'string') {
    return send(r, { ok: false, stage: 'confirmSeat', msg: '下单失败：' + JSON.stringify(conf?.data || conf).slice(0, 300) }, 409);
  }

  // ⑥ 报价 + 该单可用卡（此刻订单还是 orderStatus=1「待支付」，payAmt 是原价）
  const [amt, usable] = await Promise.all([
    api(`/seat/order/wechat-order-amt/${encodeURIComponent(orderId)}`),
    listUsableCards(orderId),
  ]);
  const payFen = amt?.data?.payAmt ?? null, priceFen = amt?.data?.price ?? null;
  const zeroCard = usable.find(c => c.userCardId === CONFIG.zeroCardId && c.usable);
  const estFen = priceFen == null ? null : priceFen * (billableMinutes(dur, 30) / 60);
  send(r, {
    ok: true, orderId,
    payAmtFen: payFen, payAmtYuan: payFen == null ? null : payFen / 100,
    priceYuan: priceFen == null ? null : priceFen / 100,
    estimateYuan: estFen == null ? null : estFen / 100,
    minutes: dur,
    isZero: payFen === 0,
    store: st.storeName,
    cards: usable,
    canSettleWithCard: CONFIG.allowCardSettle && !!zeroCard,
    settleWithCardHint: zeroCard
      ? `用月卡抵扣 → 实付 ¥0（扣月卡 1 天，卡内剩余 ${zeroCard.remainValue ?? '?'} 天）`
      : '该单的月卡不可用（这个区域/空间可能不在月卡范围内）',
    warn: (payFen != null && payFen > 0 && !zeroCard)
      ? `⚠ 订单已生成，但月卡在本单不可用，需实付 ¥${(payFen / 100).toFixed(2)}。请回原 App 支付或处理，本工具不再自动操作。`
      : null,
  });
});

// ============ 月卡 0 元抵扣（changeTheTime 就是「选卡结算」那一步）============
// 订单：orderStatus=1 待支付 --选卡结算--> orderStatus=3 已支付，实付 0，扣月卡 1 天。
// 不可逆：平台没有取消 / 退卡接口，扣掉的 1 天要不回来。必须界面二次确认后才调。
const settling = new Set();   // 防重复提交：同一 orderId 同时只允许一次

async function listUsableCards(orderId) {
  const r = await api('/seat/order/queryUserUsedCard', { orderId });
  const rows = r?.data?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map(c => ({
    userCardId: c.userCardId, cardName: c.cardName, cardTypeCode: c.cardTypeCode,
    remainValue: c.remainValue, validityPeriod: c.validityPeriod, cardStatus: c.cardStatus,
    unusableReason: c.cardUnavailableCopy || null,
    usable: c.cardStatus === 1 && !c.cardUnavailableCopy,
  }));
}

async function settleHandler(_q, body, r) {
  const orderId = body?.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (!CONFIG.allowCardSettle) return send(r, { ok: false, msg: '已禁用卡结算（CONFIG.allowCardSettle=false）' }, 403);
  if (settling.has(orderId)) return send(r, { ok: false, msg: '这一单正在抵扣中，请勿重复提交' }, 409);
  settling.add(orderId);
  try {
    // ① 先回读订单真实状态：必须是「待支付」才继续（不信前端）
    const before = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
    if (before.orderStatus !== 1) {
      const si = statusInfo(before.orderStatus);
      return send(r, { ok: false, blocked: true, orderStatus: before.orderStatus, statusInfo: si,
        msg: `已拒绝：这一单当前是「${si.label}」（orderStatus=${before.orderStatus}），不是待支付状态，不能再抵扣。` }, 409);
    }
    // ② 再确认这单真的能用月卡
    const cards = await listUsableCards(orderId);
    const card = cards.find(c => c.userCardId === CONFIG.zeroCardId && c.usable);
    if (!card) {
      const mine = cards.find(c => c.userCardId === CONFIG.zeroCardId);
      return send(r, { ok: false, blocked: true, cards,
        msg: '已拒绝：这单的月卡不可用' + (mine?.unusableReason ? `（${mine.unusableReason}）` : '（订单可能已不是待支付状态）') }, 409);
    }
    // ③ 选卡结算（请求体逐字段照抄 HAR，字段名/顺序都别改）
    const settle = await api('/seat/order/changeTheTime', null, 'POST', {
      orderId,
      userCardId: card.userCardId,
      cardId: null,
      cardTypeCode: card.cardTypeCode || CONFIG.zeroCardTypeCode,
      ruleId: null,
      extendOrderId: '',
      type: 1,
      izWeChatPay: false,
    });
    const sc = settle?.data?.code, smsg = settle?.data?.message || settle?.msg;
    // ④ 回读订单，用真实状态说话（别只信 code）
    const after = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
    const amt = (await api(`/seat/order/wechat-order-amt/${encodeURIComponent(orderId)}`))?.data || {};
    const paid = after.orderStatus === 3;
    send(r, {
      ok: paid, code: sc, message: smsg,
      orderStatus: after.orderStatus, statusInfo: statusInfo(after.orderStatus),
      cardTypeName: after.cardTypeName, paymentMethod: after.paymentMethod,
      payAmtFen: amt.payAmt ?? null, cardLeft: card.remainValue,
      msg: paid
        ? `月卡抵扣成功：实付 ¥${((amt.payAmt ?? 0) / 100).toFixed(2)}，订单已变「已支付」。开门请回原 App。`
        : `抵扣结果未能确认成功（code=${sc} ${smsg || ''}），请打开原 App 核对这一单。`,
    });
  } finally { settling.delete(orderId); }
}
post('/api/settle', settleHandler);
post('/api/use-card', settleHandler);   // 旧路径保留

// ============ 当前状况（一眼看到「现在到底怎么回事」）============
// 拼三件事：门店此刻的实时座位占用 + 灯光/门锁能操作的活跃订单 + 服务端时间。
get('/api/live', async (q, _b, r) => {
  const storeId = q.storeId;
  if (!storeId) return send(r, { ok: false, msg: '缺少 storeId' }, 400);
  const date = q.date || new Date().toLocaleDateString('sv-SE');
  const start = q.start || '00:00', end = q.end || '23:59';
  const [open, live, det] = await Promise.all([
    api('/store/live_situation/iz_open', { storeId }),
    api('/store/live_situation/query', { storeId, startTime: `${date} ${start}:00`, endTime: `${date} ${end}:00`, chooseWay: 2 }),
    api('/sp/store/org/getStoreDetail', { id: storeId, storeLat: CONFIG.homeLat, storeLon: CONFIG.homeLon, date }),
  ]);
  const d = det?.data || {};
  const t = decodeToken();
  const rooms = (live?.data || []).map(room => {
    const seats = room.seatSelectionConfigs || [];
    return {
      roomName: room.roomName,
      seats: seats.length,
      free: seats.filter(s => !s.userId).length,
      taken: seats.filter(s => s.userId).length,
      mine: seats.filter(s => s.userId && String(s.userId) === String(t?.userId))
        .map(s => ({ spaceName: s.spaceName, seatName: s.seatName, seatId: String(s.seatId) })),
    };
  });
  // 找本店「能操作硬件」的活跃订单：只有 3（已支付）和 6（使用中）才有意义
  let active = null;
  try {
    const ut = await api('/op/store/org/getUserTogether');
    for (const v of ut?.data?.orderVos || []) {
      const dd = (await api('/seat/order/queryOrderDetails', { orderId: v.orderId }))?.data || {};
      if (String(dd.storeId) !== String(storeId)) continue;
      if (![3, 6].includes(Number(dd.orderStatus))) continue;
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const adv = Number(dd.advanceOpeningTime ?? 0);
      active = {
        orderId: v.orderId, orderStatus: dd.orderStatus, statusInfo: statusInfo(dd.orderStatus),
        date: dd.studyDate, endDate: dd.endStudyDate, begin: dd.studyBeginTime, end: dd.studyEndTime,
        spaceName: dd.spaceName, seatName: dd.seatName, seatId: String(dd.seatId || ''),
        lightOpenStatus: dd.lightOpenStatus ?? null,
        advanceOpeningTime: dd.advanceOpeningTime ?? null,
        operateHardwareTime: dd.operateHardwareTime ?? null,
        devices: (dd.buttonNames || []).map(b => ({ buttonName: b.buttonName, deviceId: b.deviceId, manufacturerCode: b.manufacturerCode })),
        // 能否现在开门 = 现在 >= 开始前 advanceOpeningTime 分钟
        canOpenNow: dd.studyDate === date ? nowMin >= (toMin(dd.studyBeginTime) - adv) : true,
        openWindowFrom: adv ? minToHHMM(toMin(dd.studyBeginTime) - adv) : null,
      };
      break;
    }
  } catch { }
  let isZero = null;
  try { isZero = (await isZeroStore(storeId)).ok; } catch { }
  send(r, {
    ok: true,
    now: new Date().toLocaleString('zh-CN', { hour12: false }),
    date, start, end,
    isOpen: open?.data === true,
    bizStart: d.businessStartTime, bizEnd: d.businessEndTime,
    seatAll: d.storeSeatAll ?? null, seatUsed: d.storeSeatUsed ?? null,
    rooms, activeOrder: active, isZero,
  });
});

// ============ 某座位被占用的时段（= 点占座人头像能看到的东西）============
// 关键逆向结论：/seat/querySeatSpareTime 名字叫「空闲时段」，但实测返回的是
// 「该座位已被预约/占用的区间列表」—— 占用座会返回一段包含当前时刻的区间，
// 空闲座只返回未来的区间（或空数组）。格式 'YYYY-MM-DD HH:mm:ss-YYYY-MM-DD HH:mm:ss'，
// 日期本身含 '-'，所以只能按固定位置切，不能 split('-')。
function parseSpareRanges(arr) {
  const now = Date.now();
  return (Array.isArray(arr) ? arr : []).map(x => {
    const s = String(x);
    const m = s.match(/^(.{19})-(.{19})$/);
    if (!m) return { raw: s, begin: null, end: null, state: 'unknown' };
    const bt = new Date(m[1].replace(' ', 'T')).getTime();
    const et = new Date(m[2].replace(' ', 'T')).getTime();
    return {
      raw: s, begin: m[1], end: m[2],
      state: (now >= bt && now <= et) ? 'now' : (et < now ? 'past' : 'future'),
    };
  }).sort((a, b) => String(a.begin).localeCompare(String(b.begin)));
}

get('/api/occupancy', async (q, _b, r) => {
  const { storeId, spaceId, seatId } = q;
  if (!storeId || !spaceId || !seatId) return send(r, { ok: false, msg: '缺少 storeId/spaceId/seatId' }, 400);
  const date = q.date || new Date().toLocaleDateString('sv-SE');
  const from = q.from || `${date} 00:00:00`, to = q.to || `${date} 23:59:59`;
  const [spare, live] = await Promise.all([
    api('/seat/querySeatSpareTime', { storeId, spaceId, seatId, studyBeginTime: from, studyEndTime: to }),
    api('/store/live_situation/query', { storeId, startTime: from, endTime: to, chooseWay: 2 }),
  ]);
  // 从 live_situation 里捞出这个座位的占座人
  let occ = null;
  for (const room of live?.data || []) {
    for (const s of room.seatSelectionConfigs || []) {
      if (String(s.seatId) !== String(seatId)) continue;
      occ = {
        userId: s.userId ? String(s.userId) : null,
        photo: s.userPhoto || null,
        spaceName: s.spaceName, seatName: String(s.seatName),
        roomName: room.roomName,
        seatStatus: s.seatStatus, openBookingStatus: s.openBookingStatus, isBlack: s.isBlack,
      };
    }
  }
  const ranges = parseSpareRanges(spare?.data);
  const t = decodeToken();
  send(r, {
    ok: true,
    occupant: occ,
    isMine: !!(occ?.userId && t?.userId && String(occ.userId) === String(t.userId)),
    ranges,
    rangeCount: ranges.length,
    busyNow: ranges.some(x => x.state === 'now'),
    window: { from, to },
    note: spare?.success === false ? (spare.msg || '座位时段读取失败') : null,
  });
});

// ============ 本店「已被预约的时段」总览 ============
// live_situation 每个座位只告诉你「谁占着」（userId/userPhoto），没有任何时间字段；
// 时间只能靠 /seat/querySeatSpareTime 一个座一个座地问。占用座才有意义，所以只问占用座，
// 并发 8 条，再把相同区间聚合成「哪段时间、被几个座占着」。结果缓存 60 秒，
// 免得用户在选座页来回切时段时把 26 个座位反复问一遍。
const agendaCache = new Map();
const AGENDA_TTL = 60 * 1000;

get('/api/agenda', async (q, _b, r) => {
  const { storeId } = q;
  if (!storeId) return send(r, { ok: false, msg: '缺少 storeId' }, 400);
  const date = q.date || new Date().toLocaleDateString('sv-SE');
  const from = q.from || `${date} 00:00:00`;
  const to = q.to || `${date} 23:59:59`;
  const key = `${storeId}|${from}|${to}`;
  const hit = agendaCache.get(key);
  if (hit && Date.now() - hit.at < AGENDA_TTL) return send(r, { ...hit.data, cached: true });

  const live = await api('/store/live_situation/query', { storeId, startTime: from, endTime: to, chooseWay: 2 });
  const seats = [];
  for (const room of live?.data || []) {
    for (const s of room.seatSelectionConfigs || []) {
      seats.push({
        seatId: String(s.seatId), spaceId: String(s.spaceId),
        seatName: String(s.seatName), spaceName: s.spaceName, roomName: room.roomName,
        userId: s.userId ? String(s.userId) : null, photo: s.userPhoto || null,
      });
    }
  }
  const t = decodeToken();
  const occupied = seats.filter(s => s.userId);
  const done = [];
  const queue = occupied.slice();
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const res = await api('/seat/querySeatSpareTime', {
          storeId, spaceId: s.spaceId, seatId: s.seatId, studyBeginTime: from, studyEndTime: to,
        });
        s.ranges = parseSpareRanges(res?.data);
      } catch { s.ranges = []; }
      done.push(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, occupied.length) || 1 }, worker));

  const byKey = new Map();
  for (const s of done) {
    for (const rg of s.ranges) {
      const k = `${rg.begin}|${rg.end}`;
      if (!byKey.has(k)) byKey.set(k, { begin: rg.begin, end: rg.end, state: rg.state, raw: rg.raw, seats: [] });
      byKey.get(k).seats.push({
        seatId: s.seatId, spaceName: s.spaceName, seatName: s.seatName, roomName: s.roomName,
        mine: !!(t?.userId && s.userId === String(t.userId)), photo: s.photo,
      });
    }
  }
  const ranges = [...byKey.values()]
    .map(x => ({ ...x, seatCount: x.seats.length }))
    .sort((a, b) => String(a.begin).localeCompare(String(b.begin)));

  const data = {
    ok: true, date, window: { from, to },
    seatAll: seats.length, occupied: occupied.length,
    seatsWithRanges: done.filter(s => s.ranges.length).length,
    busyNow: ranges.some(x => x.state === 'now'),
    ranges,
    note: live?.success === false ? (live.msg || '座位数据读取失败') : null,
  };
  agendaCache.set(key, { at: Date.now(), data });
  send(r, data);
});

// ============ 人脸门禁：把本人照片传到平台建档 ============
// 端点来自用户抓的「上传人脸」HAR（51 条，入口 entry[2..10]）：
//   ① POST /opsli-boot/api/v1/store/home/page/upload/file
//        multipart/form-data；注意这条路径【不在 /applet 之下】，而且【完全不带 Authorization】，
//        只认 User-Agent + Referer。返回 {"success":true,"code":200,"data":["<OSS 地址>"]}。
//   ② POST /opsli-boot/api/v1/applet/user-face/create
//        JSON {"url":"<OSS 地址>","appId":"wxa5cf43f677b9a059"}
//        → {"success":true,"msg":"操作成功！","code":200,"data":false}
//        HAR 里连传三次都是 data:false（新建而不是覆盖），三次都 success:true。
// 平台没有读接口：user-face 下的 query/info/detail/status/list/delete… 24 个候选名全部 404，
// 所以问不到「有没有建过脸」，只能上传/覆盖，界面里不能回显状态。
// 之前的 1398 次爆破之所以没命中，是因为只试了 face / userFace / user/face，没试连字符的 user-face。
const FACE_FIELD_CANDIDATES = ['file', 'files', 'multipartFile', 'upload', 'image', 'img'];

async function uploadFaceToOss(buf, filename, mime) {
  loadAuth();
  const origin = new URL(CONFIG.base).origin;
  const url = origin + '/opsli-boot/api/v1/store/home/page/upload/file';
  let lastErr = '（没试）';
  for (const field of FACE_FIELD_CANDIDATES) {
    const B = '----wzzface' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${B}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`, 'utf8');
    const tail = Buffer.from(`\r\n--${B}--\r\n`, 'utf8');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${B}`,
          'User-Agent': auth.ua,
          Referer: `https://servicewechat.com/${CONFIG.appId}/205/page-frame.html`,
        },
        body: Buffer.concat([head, buf, tail]),
      });
      const txt = await res.text();
      let j = null; try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
      const got = Array.isArray(j?.data) ? j.data[0] : (typeof j?.data === 'string' ? j.data : null);
      if (got) return { ok: true, url: got, field, http: res.status };
      lastErr = `字段名 "${field}" → HTTP ${res.status} ${txt.slice(0, 160)}`;
    } catch (e) { lastErr = `字段名 "${field}" → ${e.message}`; }
  }
  return { ok: false, msg: '照片上传到 OSS 失败：' + lastErr };
}

post('/api/face', async (_q, body, r) => {
  const dataUrl = String(body?.dataUrl || '');
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!m) return send(r, { ok: false, msg: '需要 dataUrl 字段，形如 data:image/jpeg;base64,…' }, 400);
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 1024) return send(r, { ok: false, msg: `图片只有 ${buf.length} 字节，太小了，可能没拍上` }, 400);
  if (buf.length > 8e6) return send(r, { ok: false, msg: `图片 ${(buf.length / 1048576).toFixed(1)}MB 超过 8MB，先在手机上裁一下` }, 413);
  if (!body?.confirm) return send(r, { ok: false, needConfirm: true, msg: '这会把你的照片上传到平台并建人脸档，请二次确认' }, 409);

  const up = await uploadFaceToOss(buf, `face-${Date.now()}.jpg`, mime);
  if (!up.ok) return send(r, { ok: false, msg: up.msg });
  // 只传 OSS、不建档 —— 用来验通道，不会动你账号上的人脸
  if (body?.uploadOnly) return send(r, {
    ok: true, uploadOnly: true, uploadedUrl: up.url, uploadField: up.field,
    imageBytes: buf.length, msg: '只上传了图片，没有建档（uploadOnly）',
  });
  const res = await apiOnce('/user-face/create', null, 'POST', { url: up.url, appId: CONFIG.appId });
  const ok = res?.success === true;
  send(r, {
    ok,
    uploadedUrl: up.url, uploadField: up.field, imageBytes: buf.length, imageMime: mime,
    createCode: res?.code, createMsg: res?.msg ?? res?.message, createData: res?.data,
    raw: res,
    msg: ok ? '照片已上传平台并建好人脸档' : (res?.msg || '建档失败'),
    note: '建完档到门禁机上刷脸就行，不必再在网页点开门。平台没有「查有没有建过脸」的读接口，所以这里回显不了状态。',
  });
});

// ============ 开门（真实硬件指令，会让门锁动作）============
// 服务的请求体里 lat/lon/wifiName/hardwareMessageId 全由客户端提供，服务端只做「提交点与门店点
// 距离是否在允许范围内」的判定，再下发指令。所以这里默认提交「订单详情自带的门店坐标」。
// 注意：这仍然是本人订单对应的锁，但它的近场校验形同虚设 —— 请只开自己的门，别替不在场的人开。
post('/api/door', async (_q, body, r) => {
  const orderId = body?.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (body?.confirm !== true) {
    return send(r, { ok: false, blocked: true, needConfirm: true,
      msg: '开门会给门锁下发真实指令。确认请带 confirm:true 再调一次。' }, 409);
  }
  const d = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  if (!d.orderId) return send(r, { ok: false, msg: '订单查不到：' + (d.msg || '可能已被清理') }, 404);
  const dev = (d.buttonNames || [])[0];
  if (!dev?.hardwareMessageId) return send(r, { ok: false, blocked: true, msg: '这一单没有返回开门设备（buttonNames 为空）' }, 409);

  // 用门店坐标而不是「我」的坐标：服务端比的是提交点与门店点的直线距离
  const lat = body?.lat != null ? Number(body.lat) : Number(d.storeLat);
  const lon = body?.lon != null ? Number(body.lon) : Number(d.storeLon);
  const wifiName = body?.wifiName != null ? String(body.wifiName) : ((d.storeWifiNames || [])[0] || '');

  const res = await api('/seat/order/openDoor/judgment_condition', null, 'POST', {
    orderId, storeId: String(d.storeId), lat, lon, wifiName, lockData: null,
    hardwareMessageId: dev.hardwareMessageId,
  });
  // 外层 code=200 只代表「请求收到了」；真正的业务结果在 data.code 里。
  // 【实测】通过时 data.code = 2000「门已开」；被拒时 317「当前距离过大 不可进行开门」。
  // 别把 2000 当成错误码 —— 我第一次就写错了，把成功当失败报了。
  const inner = res?.data || null;
  const code = inner?.code;
  const okCode = code === 2000 || code === 200;
  const readable = {
    2000: '门已开 —— 门锁收到了指令并已动作。',
    317: '当前距离过大 —— 服务端认为提交的定位离门店太远。',
    316: '不在可开门时间内 —— 受订单的「可提前开门」字段限制。',
  }[code] || null;
  send(r, {
    ok: !!okCode,
    code, message: inner?.message || null,
    requestCode: res?.code, raw: inner,
    sent: { orderId, storeId: String(d.storeId), lat, lon, wifiName, hardwareMessageId: dev.hardwareMessageId, deviceId: dev.deviceId, manufacturerCode: dev.manufacturerCode },
    orderStatus: d.orderStatus, statusInfo: statusInfo(d.orderStatus),
    msg: okCode
      ? `✅ ${inner?.message || '门锁指令已下发'}（data.code=${code}）—— 距离判定通过，服务端已把开门指令发给 deviceId ${dev.deviceId}。`
      : `❌ 开门被拒（data.code=${code}）：${inner?.message || '未知原因'}${readable ? ' · ' + readable : ''}`,
  });
});

// ============ 开灯 / 关灯 ============
// 实测：POST /seat/order/openLight，JSON 入参（用 form 会 HTTP 415），只需 orderId。
// 开关状态读订单字段 lightOpenStatus（0 = 关着）。同名单一接口由服务端决定开还是关。
post('/api/light', async (_q, body, r) => {
  const orderId = body?.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (body?.confirm !== true) {
    return send(r, { ok: false, blocked: true, needConfirm: true,
      msg: '开灯会下发真实灯光指令。确认请带 confirm:true 再调一次。' }, 409);
  }
  const d = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  if (!d.orderId) return send(r, { ok: false, msg: '订单查不到：' + (d.msg || '') }, 404);
  const before = d.lightOpenStatus ?? null;

  // 【实测 2026-10-16】openLight 要求订单处于「使用中」：
  //   订单「已支付(3)」→ code 100862「当前订单未在进行中 不可进行开灯」
  //   订单「使用中(6)」→ code 500（msg 为空）。试过只传 orderId / type:0|1|2 /
  //     lightStatus / openStatus / +appId / +hardwareMessageId+deviceId / door 同款 payload，
  //     **全部一样返回 500**，所以这个接口没能跑通（form 入参会 415，说明它收 JSON）。
  // 而「灯」实际是 签到(immediatelySeat) 点亮的、退座(finishStudy) 关掉的。
  if (d.orderStatus !== 6) {
    return send(r, { ok: false, blocked: true, stage: 'precheck',
      orderStatus: d.orderStatus, statusInfo: statusInfo(d.orderStatus),
      lightBefore: before, lightAfter: before,
      knownCode: 100862, knownMsg: '当前订单未在进行中 不可进行开灯',
      msg: `开灯被拒：这个接口要求订单处于「使用中」，本单现在是「${statusInfo(d.orderStatus).label}」。先签到（立即入座）把订单推成「使用中」再开灯。`,
    });
  }

  const res = await api('/seat/order/openLight', null, 'POST', { orderId });
  const inner = res?.data || null;
  const after = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  const now = after.lightOpenStatus ?? null;
  const changed = before != null && now != null && before !== now;
  const broken = res?.code === 500 || inner?.code === 500;
  send(r, {
    ok: changed,
    requestCode: res?.code, innerCode: inner?.code, message: inner?.message || res?.msg || null,
    lightBefore: before, lightAfter: now, changed,
    orderStatus: after.orderStatus, statusInfo: statusInfo(after.orderStatus),
    msg: changed
      ? `✅ 灯光状态已变化：lightOpenStatus ${before} → ${now}`
      : broken
        ? `⚠ 开灯没能生效：/seat/order/openLight 在订单「使用中」时恒定返回 code 500（msg 为空），换各种参数组合都一样 —— 这个接口没跑通。灯其实是「签到」点亮的、「退座」关掉的（本单现在 lightOpenStatus=${now}）。`
        : `指令已发出（${inner?.message || res?.msg || '操作成功'}），但 lightOpenStatus 仍是 ${now}。`,
  });
});

post('/api/leave', async (_q, body, r) => {
  const orderId = body?.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (body?.confirm !== true) {
    return send(r, {
      ok: false, blocked: true, needConfirm: true,
      msg: '退座不可逆：会立刻结束本次学习、释放座位，已扣的月卡天数不退回。要确认请带 confirm:true 再调一次。',
    }, 409);
  }
  const before = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  if (!before.orderId) return send(r, { ok: false, msg: '订单查不到' }, 404);
  if (Number(before.orderStatus) === 1) {
    return send(r, { ok: false, blocked: true, orderStatus: 1,
      msg: '这一单还是「待支付」，不需要退座 —— 未支付会在 5 分钟后自动失效，别点退座。' }, 409);
  }
  const res = await apiForm('/seat/order/finishStudy', { orderId });
  const inner = res?.data || null;
  const after = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  const ended = Number(after.orderStatus) === 8;
  send(r, {
    ok: ended || res?.success === true,
    requestCode: res?.code, innerCode: inner?.code, message: inner?.message || res?.msg || null,
    statusBefore: before.orderStatus, statusAfter: after.orderStatus, statusInfo: statusInfo(after.orderStatus),
    endBefore: before.studyEndTime, endAfter: after.studyEndTime,
    msg: `退座结果：orderStatus ${before.orderStatus} → ${after.orderStatus}，结束时间 ${before.studyEndTime} → ${after.studyEndTime}。座位已释放。${inner?.message ? '（服务端：' + inner.message + '）' : ''}`,
  });
});

// ============ 到店签到 / 立即入座 ============
// HAR entry[3] 实证：POST /seat/order/immediatelySeat，**form-urlencoded**，
// 字段 orderId / lat / lon / wifiName。与开门同一套距离校验（HAR 里返回 999998「距离过大 不可进行立即入座」）。
// 语义：人到店后点「立即入座」，把这一单从「已支付」推成「使用中」。
// 注意：这会让座位真正被占用，所以同样要二次确认 + 后端校验 orderStatus。
post('/api/checkin', async (_q, body, r) => {
  const orderId = body?.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (body?.confirm !== true) {
    return send(r, { ok: false, blocked: true, needConfirm: true,
      msg: '签到会让这个座位立刻变成「占用中」（对你自己的账号生效）。确认请带 confirm:true 再调一次。' }, 409);
  }
  const before = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  if (!before.orderId) return send(r, { ok: false, msg: '订单查不到' }, 404);
  const lat = body?.lat != null ? Number(body.lat) : Number(before.storeLat);
  const lon = body?.lon != null ? Number(body.lon) : Number(before.storeLon);
  const wifiName = body?.wifiName != null ? String(body.wifiName) : ((before.storeWifiNames || [])[0] || '');
  const res = await apiForm('/seat/order/immediatelySeat', { orderId, lat, lon, wifiName });
  const inner = res?.data || null;
  const after = (await api('/seat/order/queryOrderDetails', { orderId }))?.data || {};
  send(r, {
    ok: res?.code === 200,
    requestCode: res?.code, innerCode: inner?.code, message: inner?.message || res?.msg || null,
    statusBefore: before.orderStatus, statusAfter: after.orderStatus, statusInfo: statusInfo(after.orderStatus),
    sent: { orderId, lat, lon, wifiName },
    msg: res?.code === 200
      ? `签到请求成功：orderStatus ${before.orderStatus} → ${after.orderStatus}（${statusInfo(after.orderStatus).label}）。${inner?.message || ''}`
      : `签到被拒（code=${inner?.code ?? res?.code}）：${inner?.message || res?.msg || '未知原因'}`,
  });
});

// ---------- 当前预约 ----------
// 订单详情 → 前端用的归一化结构（/api/orders 与 /api/order 共用一套字段）
function normalizeOrder(dd, orderIdFallback = null) {
  const t = decodeToken();
  return {
    orderId: dd.orderId || orderIdFallback, seatType: dd.seatType,
    storeName: dd.fullName, storeId: dd.storeId, area: dd.detailAddress,
    spaceName: dd.spaceName, seatName: dd.seatName, seatId: dd.seatId ? String(dd.seatId) : null,
    date: dd.studyDate, endDate: dd.endStudyDate,
    begin: dd.studyBeginTime, end: dd.studyEndTime,
    orderStatus: dd.orderStatus, statusInfo: statusInfo(dd.orderStatus),
    expiredTime: dd.expiredTime, cardTypeName: dd.cardTypeName, paymentMethod: dd.paymentMethod,
    storeManagerUrl: dd.storeManagerUrl,
    devices: (dd.buttonNames || []).map(b => ({ buttonName: b.buttonName, deviceId: b.deviceId, manufacturerCode: b.manufacturerCode, hardwareMessageId: b.hardwareMessageId })),
    lon: dd.storeLon, lat: dd.storeLat,
    myUserId: t?.userId,
    // 到店开门相关的字段：queryOrderDetails 里没有金额字段，钱只在 wechat-order-amt 里出现
    wifiNames: dd.storeWifiNames || [],
    advanceOpeningTime: dd.advanceOpeningTime ?? null,   // 可以提前多久开门（分钟）
    operateHardwareTime: dd.operateHardwareTime ?? null,
    lightOpenStatus: dd.lightOpenStatus ?? null,
    longestReservationTime: dd.orderLongestReservationTime ?? null,   // 还能续多久
    advanceContinueTime: dd.orderAdvanceContinueTime ?? null,         // 提前多久可续
    extendStatus: dd.extendStatus ?? null,
    latestExtendOrderId: dd.latestExtendOrderId || null,
  };
}

// ---------- 订单历史（querySeatOrderList）----------
// 实测：GET /seat/order/querySeatOrderList?pageNo&pageSize 分页返回历史单。
// 单条字段只有 11 个：orderId / fullName / orderStatus / areaName / studyDate /
// startTime / endTime / spaceName / seatName / seatId / periodTime。
// ⚠ 返回体里的 pageCount 字段不可信（实测等于条数），所以直接翻到空页为止。
async function fetchOrderList(maxPages = 20, pageSize = 50) {
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const r = await api('/seat/order/querySeatOrderList', { pageNo: p, pageSize, appId: CONFIG.appId });
    const d = r?.data || {};
    const lst = d.seatOrderListList || d.seatOrderList || [];
    if (!lst.length) break;
    out.push(...lst);
    if (lst.length < pageSize) break;
  }
  return out;
}

function normalizeListOrder(o) {
  const st = Number(o.orderStatus);
  const day = String(o.studyDate || o.startTime || '').slice(0, 10);
  return {
    orderId: o.orderId, orderStatus: st, statusInfo: statusInfo(st),
    storeName: o.fullName, areaName: o.areaName, spaceName: o.spaceName, seatName: o.seatName,
    seatId: o.seatId != null ? String(o.seatId) : null,
    date: o.studyDate, day, begin: o.startTime, end: o.endTime,
    active: [1, 3, 6].includes(st),
  };
}

// 本机时区今天 00:00 往前推 n 天的毫秒值
function dayStartMs(daysAgo = 0) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.getTime() - daysAgo * 86400000;
}

get('/api/orders', async (q, _b, r) => {
  const all = q.all === '1';
  const days = all ? null : Math.max(1, Number(q.days || 3));

  // ① 当前预约：getUserTogether 只返回**活跃**单，结束/取消后立刻消失
  let active = [], user = null, seatOrderNum = 0;
  try {
    const ut = await api('/op/store/org/getUserTogether');
    if (ut?.success !== false) {
      user = ut?.data ? { phone: ut.data.userPhone, nick: ut.data.nickName } : null;
      seatOrderNum = ut?.data?.seatOrderNum ?? 0;
      const vos = ut?.data?.orderVos || [];
      active = await Promise.all(vos.map(async v =>
        normalizeOrder((await api('/seat/order/queryOrderDetails', { orderId: v.orderId }))?.data || {}, v.orderId)));
      // 待支付排最前，方便一眼看到还能处理的
      active.sort((a, b) => (a.orderStatus === 1 ? -1 : 1) - (b.orderStatus === 1 ? -1 : 1));
    }
  } catch { }

  // ② 历史单：默认只给最近 3 天；?all=1 给全部
  let history = [], historyAll = 0;
  try {
    const list = (await fetchOrderList()).map(normalizeListOrder);
    historyAll = list.length;
    const activeIds = new Set(active.map(o => o.orderId));
    history = list.filter(o => !activeIds.has(o.orderId));
    if (!all && days != null) {
      const from = dayStartMs(days - 1);
      history = history.filter(o => {
        const t = Date.parse(String(o.date || '').replace(' ', 'T'));
        return isNaN(t) ? true : t >= from;
      });
    }
  } catch { }

  send(r, { ok: true, seatOrderNum, user, orders: active,
            history, historyAll, days, statusMap: ORDER_STATUS });
});

// ---------- 按订单号查单（能查到已结束、已从「当前预约」里消失的单）----------
// 重要：/op/store/org/getUserTogether 只返回**活跃**预约 —— 实测一单退座变成 orderStatus 8 之后，
// 它就从「当前预约」列表里消失了。所以结束后必须靠订单号回查。
get('/api/order', async (q, _b, r) => {
  const orderId = String(q.orderId || '').trim();
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  const res = await api('/seat/order/queryOrderDetails', { orderId });
  const dd = res?.data;
  if (!dd || !dd.orderId) return send(r, { ok: false, msg: res?.msg || '查不到这一单（订单号是否正确？）' }, 404);
  // 金额只有「待支付」的单查得到，其余会报「非法的订单号」，失败就置 null 别报错
  let payAmtFen = null;
  try { payAmtFen = (await api(`/seat/order/wechat-order-amt/${encodeURIComponent(orderId)}`))?.data?.payAmt ?? null; } catch { }
  // 取消规则随订单一起给前端：用户关心「提前多久取消不算违约」。
  // 不能依赖前端 state.cancelRule —— 那条路径要求先访问过门店详情页，直接打开订单就没有。
  let cancelRule = null;
  try {
    const sid = dd.storeId || dd.orgId;
    if (sid) cancelRule = (await api(`/seat/order/${encodeURIComponent(sid)}/queryCancelRule`))?.data || null;
  } catch { }
  send(r, { ok: true, order: normalizeOrder(dd, orderId), payAmtFen, cancelRule });
});

// ---------- 换座 ----------
// POST /seat/order/changeSeat —— form-urlencoded。
// ⚠ 未实测：换座必须有**活跃**订单才能验证，而账号目前被平台拉黑没法建单。
//   已实测的只有一件事：拿「已取消」「已结束」的单去调，它照样返回 code 200「操作成功！」
//   却什么都不改 —— 说明它只看订单号格式、不看订单状态。
//   所以**绝不能拿返回码判成功，必须回读 seatId 有没有真的变成目标座位**。
post('/api/changeSeat', async (_q, b, r) => {
  const orderId = b.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (!b.seatId) return send(r, { ok: false, msg: '缺少要换到的 seatId' }, 400);
  if (b.confirm !== true) {
    return send(r, { ok: false, blocked: true, needConfirm: true,
      msg: '换座会释放当前座位并占用新座位，需要二次确认' }, 409);
  }
  const form = { orderId: String(orderId), seatId: String(b.seatId), appId: CONFIG.appId };
  if (b.spaceId) form.spaceId = String(b.spaceId);
  if (b.storeId) form.storeId = String(b.storeId);

  const before = await api('/seat/order/queryOrderDetails', { orderId });
  let res = null, err = null;
  try { res = await apiForm('/seat/order/changeSeat', form); } catch (e) { err = e.message; }
  const after = await api('/seat/order/queryOrderDetails', { orderId });

  const bSeat = before?.data?.seatId != null ? String(before.data.seatId) : null;
  const aSeat = after?.data?.seatId != null ? String(after.data.seatId) : null;
  const changed = !!(aSeat && aSeat === String(b.seatId) && aSeat !== bSeat);

  send(r, {
    ok: changed, verified: false, raw: res, err, sent: form,
    before: { seatId: bSeat, seatName: before?.data?.seatName, spaceName: before?.data?.spaceName },
    after: { seatId: aSeat, seatName: after?.data?.seatName, spaceName: after?.data?.spaceName },
    msg: changed ? '换座成功（已回读确认座位变了）'
      : `没换成功${err ? '：' + err : `：平台回 ${res?.code ?? '?'} ${res?.msg || ''}`}；座位仍是 ${after?.data?.seatName || '?'}`,
  });
});

// ---------- 延长时间 ----------
// 平台没有独立的「延长」接口 —— 60 个候选名（extendOrder / continueOrder / renewOrder …）
// 在 /seat/order/ 下全部 404。延长走的就是 changeTheTime（它请求体里本来就有 extendOrderId）。
// ⚠ 未实测：changeTheTime 的必填字段用死单只能探到第二层
//   （给 orderId 说「支付账号不能为空」，再给 type 说「支付方式不能为空」就断了），
//   要确定 type / extendOrderId / 支付方式 的组合必须有活跃订单。
post('/api/extend', async (_q, b, r) => {
  const orderId = b.orderId;
  if (!orderId) return send(r, { ok: false, msg: '缺少 orderId' }, 400);
  if (b.confirm !== true) {
    return send(r, { ok: false, blocked: true, needConfirm: true,
      msg: '延长会按门店规则继续占用座位并可能扣减月卡时长，需要二次确认' }, 409);
  }
  const before = await api('/seat/order/queryOrderDetails', { orderId });
  const d = before?.data || {};
  const body = {
    orderId: String(orderId),
    userCardId: b.userCardId || d.userCardId || CONFIG.zeroCardId,
    cardId: null,
    cardTypeCode: b.cardTypeCode || 'DAY',
    ruleId: null,
    extendOrderId: b.extendOrderId != null ? b.extendOrderId : (d.latestExtendOrderId || ''),
    type: b.type != null ? b.type : 2,
    izWeChatPay: false,
    appId: CONFIG.appId,
  };
  let res = null, err = null;
  try { res = await apiOnce('/seat/order/changeTheTime', null, 'POST', body); } catch (e) { err = e.message; }
  const after = await api('/seat/order/queryOrderDetails', { orderId });

  const bEnd = d.studyEndTime, aEnd = after?.data?.studyEndTime;
  const changed = !!(aEnd && bEnd && String(aEnd) !== String(bEnd));
  send(r, {
    ok: changed, verified: false, raw: res, err, sent: body,
    before: { end: bEnd, advanceContinueTime: d.orderAdvanceContinueTime ?? null, longestReservationTime: d.orderLongestReservationTime ?? null },
    after: { end: aEnd, extendStatus: after?.data?.extendStatus ?? null, latestExtendOrderId: after?.data?.latestExtendOrderId ?? null },
    msg: changed ? '延长成功（已回读确认结束时间变了）'
      : `没延长成功${err ? '：' + err : `：平台回 ${res?.data?.code ?? res?.code ?? '?'} ${res?.data?.message || res?.msg || ''}`}`,
  });
});

// ---------- token 管理 ----------
const TOKEN_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const UA_RE = /Mozilla\/5\.0 \(iPhone[^"\\\n]{0,300}MicroMessenger\/[^"\\\n\)]{0,60}\)[^"\\\n]{0,60}/;

/** HAR 里正斜杠被转义成 \/ ，UA 匹配前必须先还原，否则永远抓不到 UA。 */
function unescapeHarSlash(text) { return String(text).replace(/\\\//g, '/'); }

function extractTokensFromText(text) {
  const toks = [...new Set((String(text).match(TOKEN_RE) || []))].filter(t => t.length > 60);
  // token 可能出现在被转义过的 JSON 片段里，两边都试
  const ua = (unescapeHarSlash(text).match(UA_RE) || [])[0] || null;
  return {
    toks: toks.map(t => ({ token: t, ...(decodeToken(t) || {}) })).filter(x => x.exp),
    ua: ua ? ua.trim() : null,
  };
}

function scanHarFiles(limit = 10) {
  const files = [];
  for (const dir of HAR_SCAN_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/\.har$/i.test(n)) continue;
      try {
        const full = path.join(dir, n);
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > 400 * 1024 * 1024) continue;
        files.push({ file: full, name: n, size: st.size, mtime: st.mtimeMs });
      } catch { }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit);
}

get('/api/hars', async (_q, _b, r) => {
  const out = [];
  for (const f of scanHarFiles(10)) {
    try {
      const text = fs.readFileSync(f.file, 'utf8');
      if (!text.includes('wangzhizhi')) continue;
      const { toks, ua } = extractTokensFromText(text);
      const best = toks.sort((a, b) => (b.iat || b.exp) - (a.iat || a.exp))[0];
      if (!best) continue;
      out.push({
        file: f.file, name: f.name, sizeMB: +(f.size / 1048576).toFixed(1),
        mtimeStr: new Date(f.mtime).toLocaleString('zh-CN', { hour12: false }),
        exp: best.exp, expStr: new Date(best.exp * 1000).toLocaleString('zh-CN', { hour12: false }),
        daysLeft: Math.floor((best.exp * 1000 - Date.now()) / 86400000),
        expired: best.exp * 1000 < Date.now(),
        hasUa: !!ua, ua: ua || null,
        userId: best.userId || null,
      });
    } catch { }
  }
  out.sort((a, b) => b.exp - a.exp);
  send(r, { ok: true, dirs: HAR_SCAN_DIRS, files: out });
});

post('/api/token', async (_q, body, r) => {
  const cur = loadAuth(true);
  let token = null, ua = null, source = '手动粘贴';

  if (body?.harPath) {
    const full = path.resolve(String(body.harPath));
    const allowed = HAR_SCAN_DIRS.some(d => full.startsWith(path.resolve(d) + path.sep) || full === path.resolve(d));
    if (!allowed) return send(r, { ok: false, msg: '出于安全，只允许读取这些目录下的 HAR：' + HAR_SCAN_DIRS.join('、') }, 403);
    if (!fs.existsSync(full)) return send(r, { ok: false, msg: '文件不存在：' + full }, 400);
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes('wangzhizhi')) return send(r, { ok: false, msg: '这个 HAR 里没有王知之小程序的请求，抓包时请在小程序里点几下。' }, 400);
    const ex = extractTokensFromText(text);
    const best = ex.toks.sort((a, b) => (b.iat || b.exp) - (a.iat || a.exp))[0];
    if (!best) return send(r, { ok: false, msg: '这个 HAR 里没找到 JWT token。' }, 400);
    token = best.token; ua = ex.ua || cur.ua;
    source = path.basename(full);
  } else if (body?.harText) {
    const ex = extractTokensFromText(String(body.harText));
    const best = ex.toks.sort((a, b) => (b.iat || b.exp) - (a.iat || a.exp))[0];
    if (!best) return send(r, { ok: false, msg: '粘贴的内容里没找到 JWT token。' }, 400);
    token = best.token; ua = ex.ua || cur.ua; source = '粘贴的抓包内容';
  } else if (body?.token) {
    const t = String(body.token).trim();
    const m = extractTokensFromText(t);
    token = m.toks[0]?.token || (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t) ? t : null);
    if (!token) return send(r, { ok: false, msg: '这不像一个 JWT（应为三段 base64，以 eyJ 开头）。' }, 400);
    ua = body.ua ? String(body.ua).trim() : cur.ua;
    source = '手动粘贴';
  } else {
    return send(r, { ok: false, msg: '请提供 harPath / harText / token 之一' }, 400);
  }

  const d = decodeToken(token);
  if (!d?.exp) return send(r, { ok: false, msg: 'token 解析失败（拿不到 exp 字段）' }, 400);

  // 保存前先用新 token 探活一次，把结果一起告诉用户
  let alive = null, probeMsg = null;
  try {
    const probe = await api('/fp/store/org/store-count', null, 'GET', null, 12000, 1, { token, ua });
    alive = probe?.success === true || probe?.code === 200;
    probeMsg = alive ? `探活正常（全平台门店数 ${probe.data}）` : (probe?.code === 12002 ? '服务端返回 Token失效(12002) —— UA 可能不匹配' : (probe?.msg || probe?.code || '探活失败'));
  } catch (e) { probeMsg = e.message; }

  saveAuth({ token, ua, source });
  send(r, {
    ok: true, alive, probeMsg, source,
    token: {
      exp: d.exp, expStr: new Date(d.exp * 1000).toLocaleString('zh-CN', { hour12: false }),
      daysLeft: Math.floor((d.exp * 1000 - Date.now()) / 86400000), myUserId: d.userId,
    },
    msg: alive
      ? `token 已更新并生效（${source}），有效期至 ${new Date(d.exp * 1000).toLocaleString('zh-CN', { hour12: false })}`
      : `token 已写入，但探活没通过：${probeMsg}。若是重抓包的 UA 变了，请确认 HAR 里带上了 MicroMessenger 的 UA。`,
  });
});

// ---------- 静态页 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
function sendHtml(res, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

function serveFile(res, file) {
  // ui.html 优先用内嵌字符串，云端/本机都能服务，不用读盘
  if (file === 'ui.html') return sendHtml(res, UI_HTML);
  fs.readFile(path.join(__dirname, file), (err, buf) => {
    if (err) return send(res, { ok: false, msg: file + ' 缺失：' + err.message }, 500);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=86400',
    });
    res.end(buf);
  });
}

// ======================= 读接口短缓存 =======================
// 为什么需要：每刷新一次页面，前端会并发打好几个读接口（状态/订单/门店…），
// 每个都实打实转给上游平台。频繁刷新在平台侧就是「高频访问同一账号」，
// 这正是封号列表里那条「异常访问频率」。所以读接口给一层短缓存：
//   · 缓存命中直接返回，完全不碰上游
//   · 多个请求同时打同一个 key，只放一个去上游，其余等它的结果（in-flight 合并）
// 写操作（下单/开门/退座/取消…）绝不缓存，永远实打实发出去。
// 另外所有响应都带 Cache-Control，浏览器自己也不会反复请求。
const READ_CACHE = new Map();          // key -> { at, ttl, body }
const INFLIGHT = new Map();            // key -> Promise<body>
const READ_TTL = {
  '/api/status': 20000,      // token/月卡：20 秒
  '/api/orders': 15000,      // 订单列表：15 秒
  '/api/stores': 300000,     // 门店清单：5 分钟（服务端本来还有一层 3 分钟缓存）
  '/api/cards': 60000,       // 月卡：1 分钟
};
function cacheTtl(pathname, query) {
  if (query && (query.force === '1' || query.all === '1')) return 0;  // 强制刷新 / 查看全部 → 不缓存
  return READ_TTL[pathname] || 0;
}

// 同一个 key 的并发请求共用一次上游结果（in-flight 合并）。
// 返回值带 tag，告诉调用方这一份是新拉的还是蹭的别人的。
// ⚠ 这里有个曾经踩过的坑：先 await 再 set 会让并发全部穿透（5 个请求全打上游），
// 所以必须**先**把 promise 放进 INFLIGHT，再 await。
async function runAndCache(m, query, body, key, ttl) {
  const running = INFLIGHT.get(key);
  if (running) return { buf: await running, tag: 'merged' };
  const p = (async () => {
    // 用一个只收集字节的 sink 接 handler 的写操作；它不参与真正的 HTTP 生命周期，
    // 所以不会和 ServerResponse 的内部状态打架。
    const chunks = [];
    let code = 200;
    const sink = {
      writeHead(c) { code = c; },
      end(x) { if (x != null) chunks.push(Buffer.from(x)); },
      setHeader() { }, getHeader() { },
    };
    await m.handler(query, body, sink);
    const buf = Buffer.concat(chunks);
    if (code >= 200 && code < 300) READ_CACHE.set(key, { at: Date.now(), ttl, body: buf });
    return buf;
  })();
  // 先登记，再返回：后续并发进来直接 hit 到这一个 promise
  INFLIGHT.set(key, p);
  try {
    return { buf: await p, tag: 'miss' };
  } finally {
    INFLIGHT.delete(key);          // 只在真正的发起者这里清，避免 merged 方误删
  }
}

// 统一出口：带缓存头，把字节原样吐出去
function sendRaw(res, code, buf, ttl, tag) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, max-age=' + Math.floor(ttl / 1000),
    'Content-Length': buf.length,
    'X-WZZ-Cache': tag,
  });
  res.end(buf);
}

// ======================= 请求分发（本机 / Vercel serverless 共用） =======================
export async function requestHandler(req, res) {
  try {
    const host = req.headers.host || `${CONFIG.host}:${CONFIG.port}`;
    const u = new URL(req.url, `http://${host}`);

    // favicon：用平台自己的小程序 logo（/fp/photo/org/getAppletMessage 里那条 小程序logo.png）
    if (u.pathname === '/favicon.ico' || u.pathname === '/favicon.png') return serveFile(res, 'favicon.png');
    if (u.pathname === '/apple-touch-icon.png') return serveFile(res, 'apple-touch-icon.png');

    // 页面路由：'/' 与 '/app' 都直接返回应用（任何人都能打开、浏览门店）。
    if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/app' || u.pathname === '/gate') {
      return serveFile(res, 'ui.html');
    }

    const m = routes.find(rt => rt.method === req.method && rt.pattern === u.pathname);
    if (!m) return send(res, { ok: false, msg: '不存在：' + u.pathname }, 404);

    // 写操作门：受保护路由要求登录密钥（X-Access-Key 头或 wzz_key cookie）。
    // 读接口（门店/座位/订单/状态…）全部开放，不用登录。
    if (ACCESS_KEY && PROTECTED.has(u.pathname) && !hasKey(req)) {
      return send(res, { ok: false, needLogin: true, msg: '请先在「我的」里登录' }, 401);
    }

    const query = Object.fromEntries(u.searchParams);
    const body = req.method === 'POST' ? await readBody(req) : null;

    // —— 读接口走缓存（只有 GET，写操作绝不缓存）——
    // 注意：这里绝不能用「假的 res」去截 handler 的返回。handler 里可能 await 上游
    // 好几百毫秒，而 http.ServerResponse 自己也有 end 回调链；一旦延迟 end，
    // 并发同 key 时就会出现「handler 已经写过头、外面又写一次」的崩栈 + 请求悬挂。
    // 正确做法：真正把结果发给客户端；缓存只保存**一份拷贝**，供后续请求复用。
    const ttl = req.method === 'GET' ? cacheTtl(u.pathname, query) : 0;
    if (ttl > 0) {
      const key = u.pathname + '?' + u.searchParams.toString();
      const hit = READ_CACHE.get(key);
      if (hit && Date.now() - hit.at < hit.ttl) {
        return sendRaw(res, 200, hit.body, ttl, 'hit');
      }
      const { buf, tag } = await runAndCache(m, query, body, key, ttl);
      return sendRaw(res, 200, buf, ttl, tag);
    }

    return await m.handler(query, body, res);
  } catch (e) {
    return send(res, { ok: false, msg: '服务端错误：' + e.message }, 500);
  }
}

// 本机模式才启动长驻 HTTP 服务。被作为模块 import（Vercel serverless）时不 listen。
export function startLocal() {
  const server = http.createServer(requestHandler);
  server.keepAliveTimeout = 65000;

  server.listen(CONFIG.port, CONFIG.host, async () => {
    const a = loadAuth(true);
    const t = decodeToken(a.token);
    console.log('');
    console.log('  ◆ 王知之自习室 · 本地选座下单助手');
    console.log(`  → 本机   http://127.0.0.1:${CONFIG.port}`);
    if (CONFIG.host === '0.0.0.0') {
      const ips = lanIPv4();
      if (ips.length) for (const i of ips) console.log(`  → 局域网 http://${i.address}:${CONFIG.port}   (${i.name})`);
      else console.log('  ⚠ 没找到局域网 IPv4 地址（检查 WiFi 是否连上）');
      console.log('  ⚠ 已开放到局域网：同一网络下任何设备都能操作这个账号。看完请去掉 --lan。');
    }
    console.log(`  → token 来源：${a.source || 'auth.json'}`);
    if (ACCESS_KEY) console.log('  → 登录密钥：已开启（仅下单/开门等写操作需要；浏览门店无需登录）');
    if (t) console.log(`  → token 有效期至 ${new Date(t.exp * 1000).toLocaleString('zh-CN', { hour12: false })}（剩 ${Math.floor((t.exp * 1000 - Date.now()) / 86400000)} 天）`);
    else console.log('  ⚠ token 解析失败，请检查 auth.json / WZZ_TOKEN');
    try {
      const probe = await api('/fp/store/org/store-count', null, 'GET', null, 12000, 1);
      if (probe?.success === true || probe?.code === 200) console.log('  → token 探活：正常');
      else console.log(`  ⚠ token 探活失败：${probe?.msg || probe?.code || '未知'} —— 若你在微信里重新登录过，旧 token 会被顶掉；网页「我的 → 更新 token」一键换。`);
    } catch { }
    console.log('  → 只订 0 元店；开门 / 提前入座 / 退座 / 取消预约 都在订单详情页直接做');
    try {
      const z = await getZeroStores();
      console.log(`  → 月卡 0 元覆盖：${z.total} 家${z.stale ? `（种子兜底，实时拉取失败：${z.failMsg || ''}）` : ''}`);
    } catch { }
    console.log('');
  });
  return server;
}

// 直接执行（node book.mjs / npm start）时启动本机服务；
// 被 import（Vercel serverless）时不 listen，由 api/index.js 复用 requestHandler。
if (process.argv[1] && process.argv[1].endsWith('book.mjs')) {
  startLocal();
}
