// 生成内嵌资源模块。
//
// 为什么需要：Vercel 的 serverless 函数包里拿不到 ui.html / zero_stores_seed.json
// 这类运行时读盘的文件，所以把它们编译成 ES 模块（字符串常量）直接 import。
//
// 改了 ui.html 或 zero_stores_seed.json 之后必须跑一次：
//     node build.mjs
// 忘了会怎样：ui-html.js 还是旧的，页面看起来「改了没生效」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

const ui = read('ui.html');
const seed = JSON.parse(read('zero_stores_seed.json'));

// 用 JSON.stringify 转义，保证引号/换行/emoji 都安全
fs.writeFileSync(path.join(dir, 'ui-html.js'), 'export const UI_HTML = ' + JSON.stringify(ui) + ';\n');
fs.writeFileSync(path.join(dir, 'zero-seed.js'), 'export const ZERO_SEED = ' + JSON.stringify(seed) + ';\n');

const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log('✅ ui-html.js    ' + kb(ui.length) + '（来自 ui.html）');
console.log('✅ zero-seed.js  ' + kb(JSON.stringify(seed).length) + '（' + (seed.stores || seed).length + ' 家门店）');
