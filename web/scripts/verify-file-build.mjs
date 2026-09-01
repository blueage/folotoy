// 校验 dist-file/folopass-2fa.html 真的是一个自足的 file:// 页面。
//
// 这几条如果破了，产物在双击打开时会静默变成白屏或功能残缺，而构建本身照样成功——
// 所以必须在构建流程里拦一道。
//
// 用法：node scripts/verify-file-build.mjs（已挂在 npm run build:file 之后）

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'dist-file';
const FILE = join(DIR, 'folopass-2fa.html');

const failures = [];
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

if (!existsSync(FILE)) {
  console.error(`✗ 产物不存在：${FILE}（先跑 npm run build:file）`);
  process.exit(1);
}

const html = readFileSync(FILE, 'utf8');

// 1. 目录里只能有这一个文件，否则「单文件」名不副实：
//    用户把 html 拷走以后，剩下的依赖就丢了。
const stray = readdirSync(DIR).filter((f) => f !== 'folopass-2fa.html');
check('产物目录只有 folopass-2fa.html', stray.length === 0, stray.join(', '));

// 2. 不能有任何外部 src/href。data: 和页内锚点除外。
const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)]
  .map((m) => m[1])
  .filter((u) => u.length > 0 && !u.startsWith('data:') && !u.startsWith('#'));
check('没有外部 src/href 引用', refs.length === 0, refs.join(', '));

// 3. 不能残留 <script src>：file:// 下外部 module script 会被 CORS 挡掉。
const externalScripts = (html.match(/<script[^>]+\bsrc=/gi) ?? []).length;
check('没有外部 script 标签', externalScripts === 0, `${externalScripts} 个`);

// 4. 必须真的有内联脚本，否则页面是空壳。
const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.length > 0);
check('存在内联脚本', inlineScripts.length > 0, `${inlineScripts.length} 段`);

// 5. CSP 里的哈希必须和内联块的实际内容对得上。
//    改了产物却忘了重算哈希的话，浏览器会拒绝执行脚本——白屏且控制台才有线索。
const cspMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
check('存在 CSP meta', cspMatch !== null);

if (cspMatch !== null) {
  const csp = cspMatch[1];
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .filter((s) => s.length > 0);

  const hashOf = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

  for (const [label, blocks, directive] of [
    ['脚本', inlineScripts, 'script-src'],
    ['样式', inlineStyles, 'style-src'],
  ]) {
    const declared = new RegExp(`${directive}\\s+([^;]*)`).exec(csp)?.[1] ?? '';
    const missing = blocks.map(hashOf).filter((h) => !declared.includes(h));
    check(`CSP ${directive} 哈希覆盖全部内联${label}`, missing.length === 0, missing.join(' '));
  }

  // 6. 严格性不能退让成 unsafe-inline —— 那样 CSP 就形同虚设了（D11）。
  check("CSP 未使用 'unsafe-inline'", !csp.includes('unsafe-inline'));
  check("CSP 未使用 'unsafe-eval'", !csp.includes('unsafe-eval'));
  check("CSP 禁止对外连接", /connect-src\s+'none'/.test(csp));
}

// 7. Service Worker 在 file:// 注册不了，残留注册代码只会在控制台报错。
check('没有 Service Worker 注册', !/serviceWorker\s*\.\s*register/.test(html));

for (const { name, ok, detail } of checks) {
  const suffix = ok || detail === undefined || detail === '' ? '' : `  (${detail})`;
  console.log(`${ok ? '✓' : '✗'} ${name}${suffix}`);
}

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`\n${FILE} — ${kb} KB`);

if (failures.length > 0) {
  console.error(`\n✗ 单文件产物校验失败（${failures.length} 项）`);
  process.exit(1);
}
console.log('✓ 单文件产物校验通过');
