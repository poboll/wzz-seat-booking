#!/usr/bin/env node
/**
 * 现状探针（只读）：用 book.mjs 里同一份 token / UA，把这几个"状态"打出来。
 *
 *   node probe.mjs
 *
 * 全部是 GET，不会下单、不会动卡。
 *  1) token 存活 + 有效期
 *  2) 我名下的卡（月卡 / 活动天卡）剩余、状态、可用性
 *  3) 月卡 0 元覆盖门店数
 *  4) 当前预约订单 + 订单详情 + 该单可用卡 + 应付金额
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'book.mjs'), 'utf8');

const pick = (re, name) => {
  const m = src.match(re);
  if (!m) throw new Error(`book.mjs 里找不到 ${name}`);
  return m[1];
};
const TOKEN = pick(/token:\s*'([^']+)'/, 'token');
const CARD = pick(/zeroCardId:\s*'([^']+)'/, 'zeroCardId');
const APP = pick(/appId:\s*'([^']+)'/, 'appId');
const BASE = pick(/base:\s*'([^']+)'/, 'base');
const UA = pick(/const UA = '([^']*)';/, 'UA');
const REF = `https://servicewechat.com/${APP}/205/page-frame.html`;

async function api(p, params) {
  const u = new URL(BASE + p);
  u.searchParams.set('appId', APP);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + TOKEN, 'User-Agent': UA, Referer: REF }, signal: ctrl.signal });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return { success: false, raw: txt.slice(0, 200) }; }
  } catch (e) { return { success: false, msg: e.name === 'AbortError' ? '超时' : e.message }; }
  finally { clearTimeout(t); }
}

const jwt = (() => { try { return JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString()); } catch { return null; } })();
const line = (s = '') => console.log(s);
const H = t => { line(); line('━'.repeat(64)); line(t); line('━'.repeat(64)); };

H('① token');
if (jwt) {
  const days = Math.floor((jwt.exp * 1000 - Date.now()) / 86400000);
  line(`  userid  : ${jwt.userid}`);
  line(`  openid  : ${jwt.openid}`);
  line(`  有效期至: ${new Date(jwt.exp * 1000).toLocaleString('zh-CN', { hour12: false })}（剩 ${days} 天）`);
}
const cnt = await api('/fp/store/org/store-count');
line(`  探活    : ${cnt?.success === true || cnt?.code === 200 ? '正常' : '失败 —— ' + (cnt?.msg || cnt?.code)}（store-count=${cnt?.data}）`);
line(`  月卡 0 元清单: ${(await api('/card/available-stores', { userCardId: CARD, cityId: '', pageNo: 1, pageSize: 1 }))?.data?.total} 家`);

H('② 我名下的卡');
const tog = await api('/op/store/org/getUserTogether');
const cards = await api('/card/userCards/list', { pageNo: 1, pageSize: 50 });
if (cards?.data?.rows?.length) {
  for (const c of cards.data.rows) {
    line(`  · ${c.cardName || c.cardTypeName} | userCardId=${c.userCardId || c.id} | 剩余 ${c.remainValue ?? '?'} | 有效期至 ${c.validityPeriod || '?'} | 状态 ${c.cardStatus ?? '?'}`);
  }
} else {
  line(`  （/card/userCards/list 没返回列表：${cards?.msg || JSON.stringify(cards).slice(0, 120)}）`);
}

H('③ 当前预约');
const vos = tog?.data?.orderVos || [];
line(`  seatOrderNum=${tog?.data?.seatOrderNum ?? 0}，orderVos=${vos.length} 条`);
for (const v of vos) {
  const d = (await api('/seat/order/queryOrderDetails', { orderId: v.orderId }))?.data || {};
  line('');
  line(`  订单号  : ${v.orderId}`);
  line(`  门店    : ${d.fullName || '?'}`);
  line(`  座位    : ${d.spaceName || '?'} ${d.seatName || '?'} 号（seatId=${d.seatId}）`);
  line(`  时段    : ${d.studyDate || '?'} ${d.studyBeginTime || ''} ~ ${d.endStudyDate || d.studyDate || ''} ${d.studyEndTime || ''}`);
  line(`  状态    : orderStatus=${d.orderStatus}  cardTypeName=${d.cardTypeName || '—'}  paymentMethod=${d.paymentMethod ?? '—'}`);
  line(`  过期时间: ${d.expiredTime || '—'}`);
  const amt = (await api(`/seat/order/wechat-order-amt/${encodeURIComponent(v.orderId)}`))?.data;
  line(`  金额    : payAmt=${amt?.payAmt}（¥${((amt?.payAmt ?? 0) / 100).toFixed(2)}） price=${amt?.price}（¥${((amt?.price ?? 0) / 100).toFixed(2)}/h）`);
  const uc = (await api('/seat/order/queryUserUsedCard', { orderId: v.orderId }))?.data;
  for (const c of uc?.data || []) {
    line(`  可用卡  : ${c.cardName}（${c.userCardId}）remain=${c.remainValue} cardStatus=${c.cardStatus}` + (c.cardUnavailableCopy ? ` —— ${c.cardUnavailableCopy}` : ''));
  }
  if (d.storeManagerUrl) line(`  店长码  : ${d.storeManagerUrl}`);
}

line();
