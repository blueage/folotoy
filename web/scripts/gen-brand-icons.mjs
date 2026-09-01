// 从 @thesvg/icons 挑出常见 2FA 发行方的**彩色**图标，消毒后烘焙成
// src/lib/icons/brands.generated.ts。
//
// 为什么要生成而不是运行时依赖：@thesvg/icons 完整包解包后约 76MB，
// 而本应用要打成一个可离线双击打开的单文件 HTML。这里只固化用得上的那几十个，
// 它因此只是 devDependency，产物里没有它的运行时代码。
//
// 改动图标集合后重新运行：npm run icons
//
// ── 为什么需要"消毒"这一步 ─────────────────────────────────────────
// 上游 SVG 直接内联进页面会踩三个坑，每一个都是**静默**出错：
//
//  1. style="..." 属性与 <style> 标签：本应用的 CSP 是 style-src 'self'（生产）
//     / sha256 白名单（单文件），都不含 'unsafe-inline'，浏览器会拦掉它们，
//     图标就少了填充或变形。这里把能识别的样式声明改写成等价的表现属性，
//     改写不了的丢弃。
//  2. id="a" 这类短 id：内联 SVG 的 id 是**整个文档**范围的，多个图标同时存在时
//     url(#a) 会解析到第一个匹配，渐变直接串色。这里给所有 id 加上 slug 前缀，
//     并同步改写引用它们的属性。
//  3. 未知元素/属性：白名单之外的一律剔除，避免把上游某天引入的
//     <script>/<image>/on* 之类东西带进这个存放 2FA 种子的页面。
//
// 消毒后的结果是纯静态标记，作为源码提交、可在 diff 里审阅，运行时不再解析任何东西。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'src', 'lib', 'icons', 'brands.generated.ts');
const CUSTOM_DIR = join(here, '..', 'assets', 'brand-icons');

/**
 * 上游图标库里没有的服务：SVG 放在 assets/brand-icons/<slug>.svg，
 * 在这里登记标题与品牌主色（主色只用于底色的淡叠加）。
 * 文件缺失时会在报告里列出，不会让整个生成失败。
 */
const CUSTOM_ICONS = {
  dnb: { title: 'Dun & Bradstreet', hex: '#006B9F' },
  mteam: { title: 'M-Team', hex: '#2B5C9B' },
};

// 精选的 @thesvg/icons slug。覆盖常见的国际服务与中文服务；
// 命中不了的发行方会退回首字母色块，因此这份清单不追求穷尽。
const SLUGS = [
  // 平台 / 开发
  'google', 'github', 'gitlab', 'bitbucket', 'atlassian', 'jetbrains', 'docker',
  'npm', 'pypi', 'linux', 'ubuntu', 'debian', 'codeberg',
  // 云 / 基础设施
  'googlecloud', 'digitalocean', 'cloudflare', 'vercel', 'netlify', 'hetzner',
  'ovh', 'alibabacloud', 'vmware', 'aws', 'azure', 'linode', 'heroku', 'oracle',
  'ibm',
  // 账号 / 社交
  'apple', 'microsoft', 'facebook', 'instagram', 'x', 'linkedin', 'reddit',
  'discord', 'slack', 'telegram', 'signal', 'whatsapp', 'line', 'wechat', 'qq',
  'snapchat', 'pinterest', 'tiktok', 'mastodon', 'twitch', 'weibo',
  // 存储 / 生产力
  'dropbox', 'box', 'notion', 'figma', 'trello', 'asana', 'zoom', 'evernote',
  'obsidian', 'todoist', 'airtable',
  // 邮件 / 安全
  'proton', 'bitwarden', 'lastpass', '1password', 'okta', 'auth0', 'keepassxc',
  'tuta', 'zoho', 'fastmail',
  // 金融 / 加密货币
  'paypal', 'stripe', 'wise', 'revolut', 'binance', 'coinbase', 'kraken',
  'trezor', 'ledger',
  // 域名 / 主机
  'namecheap', 'godaddy', 'porkbun', 'cpanel', 'wordpress', 'ghost',
  // 电商 / 娱乐
  'steam', 'playstation', 'xbox', 'nintendo', 'ebay', 'shopify', 'etsy',
  'spotify', 'netflix', 'youtube',
  // 监控 / 数据
  'sentry', 'datadog', 'grafana', 'mongodb', 'redis', 'supabase', 'firebase',
  // 中文服务
  'alipay', 'bilibili', 'zhihu', 'baidu', 'xiaomi', 'huawei', 'gitee', 'douban',
  'netease', 'jd', 'taobao', 'meituan', 'tencent',
  // 其他常见
  'sap', 'salesforce', 'adobe', 'intuit', 'coursera', 'udemy', 'duolingo',
  'patreon', 'kickstarter',
];

// ── 白名单 ────────────────────────────────────────────────────────
// 只保留画图形必需的元素与属性。宁可漏掉某个花哨效果，也不放进不认识的东西。

const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'use',
  // 刻意不含 title / desc：无障碍名称由组件统一给（见 ServiceIcon 的 decorative），
  // 图标内再带一个会让读屏重复播报。
]);

const ALLOWED_ATTRS = new Set([
  'viewbox', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'fill-rule',
  'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity', 'transform',
  'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'fx', 'fy',
  'width', 'height', 'points', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'patternunits',
  'clippathunits', 'maskunits', 'maskcontentunits',
  'id', 'clip-path', 'mask', 'href',
]);

/** style 声明里能安全改写成表现属性的属性名。其余丢弃。 */
const STYLE_TO_ATTR = new Set([
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity', 'opacity',
  'stop-color', 'stop-opacity',
]);

/** 引用 id 的属性：值形如 url(#foo)。 */
const URL_REF_ATTRS = ['fill', 'stroke', 'clip-path', 'mask', 'filter'];

const stats = {
  styleAttrs: 0,
  styleTags: 0,
  idsRenamed: 0,
  paintFallback: 0,
  stylesheetsResolved: 0,
  droppedElements: new Map(),
  droppedAttrs: new Map(),
};

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** WCAG 相对亮度，0（黑）到 1（白）。 */
function luminance(hex) {
  const channel = (offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * 判断这个图标是不是"深色背景专用"的白版。
 *
 * 很多品牌资源页只给一个反白 logo（Dun & Bradstreet 就是），画在浅色底上等于消失。
 * 这里检测：图标里所有实心填充是否都很亮。是的话就标记出来，让组件改用品牌色深底
 * 而不是白底——否则用户看到的是一块空白，而且没有任何报错提示他哪里不对。
 */
function needsDarkBackdrop(markup) {
  // 有渐变/图案填充的图标自带彩色底（Instagram、Telegram 就是这样），不需要我们补。
  if (markup.includes('url(#')) return false;

  const fills = [...markup.matchAll(/fill="([^"]+)"/g)]
    .map((m) => m[1].trim())
    .filter((value) => value !== 'none');
  if (fills.length === 0) return false;

  // 只要有任何一笔不是"浅色"，图标自身就有对比，不必换底。
  // 具名颜色（YouTube 的 red）一律按非浅色处理——这里不打算内建一张颜色名表，
  // 判错方向也要选保守的那个：多铺一次白底顶多不好看，判成深底却会让深色 logo 消失。
  return fills.every((value) => {
    if (value.toLowerCase() === 'white') return true;
    if (!value.startsWith('#')) return false;
    return luminance(normalizeHex(value)) > 0.6;
  });
}

/** 上游的 hex 有 3 位简写（#fff），统一成 6 位，下游取色逻辑才不用两套分支。 */
function normalizeHex(value) {
  const raw = String(value ?? '888888').replace(/^#/, '');
  const six = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
  return /^[0-9A-Fa-f]{6}$/.test(six) ? `#${six}` : '#888888';
}

/**
 * 把 viewBox 居中扩成正方形。
 *
 * 图标框是正方形，而字标类 logo 常常是宽幅的（M-Team 是 2096×720）。SVG 默认的
 * preserveAspectRatio 会做信箱式留白：内容缩到中间一条带，上下留空。底色矩形画在
 * viewBox 坐标系里，于是**跟着一起被压到那条带**，上下两块就没有底色了。
 *
 * 在这里把 viewBox 补成正方形，比在组件里想办法盖住留白要干净：所有图标出库即为
 * 正方，组件那边一条规则走天下，也不必依赖"SVG 不裁 viewBox 之外"这种细节。
 */
function squareViewBox(viewBox) {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return viewBox;

  const [minX, minY, width, height] = parts;
  if (width === height) return viewBox;

  const side = Math.max(width, height);
  const x = minX - (side - width) / 2;
  const y = minY - (side - height) / 2;
  const round = (n) => Number(n.toFixed(3));
  return `${round(x)} ${round(y)} ${round(side)} ${round(side)}`;
}

/** 把 style="fill:#fff;opacity:.5" 拆成键值对。 */
function parseStyle(text) {
  const out = [];
  for (const chunk of text.split(';')) {
    const index = chunk.indexOf(':');
    if (index === -1) continue;
    const name = chunk.slice(0, index).trim().toLowerCase();
    const value = chunk.slice(index + 1).trim();
    if (name.length > 0 && value.length > 0) out.push([name, value]);
  }
  return out;
}

/**
 * 把 <style> 里的类规则落成表现属性，然后才轮到消毒器把 <style>/class 剔除。
 *
 * Illustrator 导出的 SVG 几乎都是这个形态：<style>.st0{fill:#fff}</style> 配
 * class="st0"。不先解析就直接剔除，图形会全部失去填充，最后退化成一团纯色。
 *
 * 只认最简单的 `.类名` 选择器（可用逗号分组），够覆盖导出工具的产物；
 * 认不出的选择器直接忽略——宁可少上一点色，也不引入一个半吊子的 CSS 引擎。
 *
 * 优先级按 CSS 来：表现属性 < 样式表 < 行内 style，所以这里覆盖式写入。
 */
function applyStylesheet(root) {
  const sheets = [...root.querySelectorAll('style')].map((node) => node.textContent ?? '');
  if (sheets.length === 0) return;

  for (const css of sheets) {
    // 去掉注释，避免注释里的花括号打乱切分。
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(',').map((s) => s.trim());
      const declarations = parseStyle(rule[2]);
      if (declarations.length === 0) continue;

      for (const selector of selectors) {
        const match = /^\.([\w-]+)$/.exec(selector);
        if (match === null) continue;
        for (const element of root.querySelectorAll(`.${match[1]}`)) {
          for (const [prop, value] of declarations) {
            if (STYLE_TO_ATTR.has(prop)) element.setAttribute(prop, value);
          }
        }
      }
    }
  }
  stats.stylesheetsResolved += sheets.length;
}

/**
 * 消毒一棵 SVG 树。就地修改，返回根元素。
 * idPrefix 用于把文档级的 id 变成图标级的，避免跨图标碰撞。
 */
function sanitize(element, idPrefix) {
  for (const child of [...element.children]) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(tag)) {
      // <style> 单独记一笔：它是 CSP 问题的主要来源，值得在报告里看到。
      if (tag === 'style') stats.styleTags += 1;
      else bump(stats.droppedElements, tag);
      child.remove();
      continue;
    }
    sanitize(child, idPrefix);
  }

  for (const attr of [...element.attributes]) {
    const name = attr.name.toLowerCase();

    if (name === 'style') {
      stats.styleAttrs += 1;
      // 能改写成表现属性的搬过去；表现属性优先级低于 style，
      // 但既然 style 会被 CSP 拦掉，改写后的结果才是实际生效的那份。
      for (const [prop, value] of parseStyle(attr.value)) {
        // 行内 style 的优先级高于表现属性与样式表，覆盖式写入。
        if (STYLE_TO_ATTR.has(prop)) element.setAttribute(prop, value);
      }
      element.removeAttribute(attr.name);
      continue;
    }

    // 命名空间属性（xmlns、xlink:*）一律去掉：内联进 HTML 后不需要，
    // 留着还会让 React 的属性校验报警。xlink:href 先降级成 href。
    if (name === 'xlink:href') {
      element.setAttribute('href', attr.value);
      element.removeAttribute(attr.name);
      continue;
    }
    if (name.startsWith('xmlns') || name.startsWith('xml:')) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (!ALLOWED_ATTRS.has(name)) {
      bump(stats.droppedAttrs, name);
      element.removeAttribute(attr.name);
    }
  }

  // id 加前缀，并改写所有 url(#...) 与 href="#..." 引用。
  if (element.hasAttribute('id')) {
    element.setAttribute('id', `${idPrefix}-${element.getAttribute('id')}`);
    stats.idsRenamed += 1;
  }
  for (const name of URL_REF_ATTRS) {
    const value = element.getAttribute(name);
    if (value !== null && value.includes('url(#')) {
      element.setAttribute(name, value.replace(/url\(#([^)]+)\)/g, `url(#${idPrefix}-$1)`));
    }
  }
  const href = element.getAttribute('href');
  if (href !== null && href.startsWith('#')) {
    element.setAttribute('href', `#${idPrefix}-${href.slice(1)}`);
  }

  return element;
}

const dom = new JSDOM('<!doctype html><body></body>');
const { document } = dom.window;

const found = [];
const missing = [];

/**
 * 把一段原始 SVG 变成可入库的条目。上游图标与自定义图标走的是同一条路径，
 * 因此自定义图标同样享有消毒、id 前缀、着色兜底这些保护。
 * 处理不了时返回 null。
 */
function buildIcon(slug, raw, meta) {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  const host = document.createElement('div');
  host.innerHTML = raw;
  const svg = host.querySelector('svg');
  if (svg === null) return null;

  // 先把 <style> 落成属性，再消毒——顺序反了就等于把颜色信息扔掉。
  applyStylesheet(svg);

  const viewBox = squareViewBox(svg.getAttribute('viewBox') ?? '0 0 24 24');
  sanitize(svg, slug);

  // 大量上游图标把颜色写在根 <svg fill="#xxx"> 上，靠子元素继承。
  // 我们只取 innerHTML，根属性会丢，那些图标就会退化成黑色剪影——
  // 所以把根上可继承的表现属性包进一个 <g>，让 markup 自身保持完整。
  const inherited = [];
  for (const name of ['fill', 'stroke', 'fill-rule', 'clip-rule', 'stroke-width']) {
    const value = svg.getAttribute(name);
    if (value !== null) inherited.push(`${name}="${value}"`);
  }
  const inner = svg.innerHTML.replace(/\s+/g, ' ').trim();
  if (inner.length === 0) return null;

  // 少数图标靠 <style> + class 上色，两者都被消毒器剔除后会变成纯黑剪影。
  // 退回品牌主色，至少是个单色的正确 logo，而不是一团黑。
  const hasPaint = /fill="(?!none)/.test(inner) || /gradient/i.test(inner);
  if (!hasPaint && inherited.length === 0) {
    inherited.push(`fill="${meta.hex}"`);
    stats.paintFallback += 1;
  }

  const markup = inherited.length > 0 ? `<g ${inherited.join(' ')}>${inner}</g>` : inner;

  return {
    slug,
    title: meta.title,
    hex: meta.hex,
    license: meta.license,
    viewBox,
    // 只要内部标记：外层 <svg> 由组件自己渲染，尺寸与无障碍属性归组件管。
    markup,
    onDark: needsDarkBackdrop(markup),
  };
}

for (const slug of SLUGS) {
  let module;
  try {
    module = await import(`@thesvg/icons/${slug}`);
  } catch {
    missing.push(slug);
    continue;
  }

  // default 变体就是官方彩色版；没有就退回顶层 svg。
  const icon = buildIcon(slug, module.variants?.default ?? module.svg, {
    title: module.title ?? slug,
    hex: normalizeHex(module.hex),
    license: module.license ?? 'unknown',
  });
  if (icon === null) missing.push(slug);
  else found.push(icon);
}

// 自定义图标：上游没有的服务，SVG 由 assets/brand-icons/ 提供。
const customMissing = [];
for (const [slug, meta] of Object.entries(CUSTOM_ICONS)) {
  const file = join(CUSTOM_DIR, `${slug}.svg`);
  if (!existsSync(file)) {
    customMissing.push(`${slug} (缺 ${slug}.svg)`);
    continue;
  }
  const icon = buildIcon(slug, readFileSync(file, 'utf8'), {
    title: meta.title,
    hex: normalizeHex(meta.hex),
    license: 'custom (assets/brand-icons)',
  });
  if (icon === null) customMissing.push(`${slug} (${slug}.svg 解析失败)`);
  else found.push(icon);
}

found.sort((a, b) => a.slug.localeCompare(b.slug));

const entries = found
  .map(
    (icon) =>
      `  ${JSON.stringify(icon.slug)}: {\n` +
      `    title: ${JSON.stringify(icon.title)},\n` +
      `    hex: ${JSON.stringify(icon.hex)},\n` +
      `    viewBox: ${JSON.stringify(icon.viewBox)},\n` +
      `    markup: ${JSON.stringify(icon.markup)},\n` +
      `    onDark: ${icon.onDark},\n` +
      `  },`,
  )
  .join('\n');

const licenseCounts = new Map();
for (const icon of found) bump(licenseCounts, icon.license);

const source = `// 本文件由 scripts/gen-brand-icons.mjs 生成，请勿手改。
// 重新生成：npm run icons
//
// 图标来自 @thesvg/icons，各自沿用上游许可（见下）；品牌商标归其所有者所有，
// 此处仅用于在用户自己的本地列表中识别条目。
//
// markup 已在生成阶段消毒：剔除白名单外的元素与属性，把 style 声明改写成表现属性
// （CSP 不允许行内样式），并给所有 id 加上 slug 前缀（内联 SVG 的 id 是文档级的，
// 不加前缀会跨图标串色）。运行时直接内联这段静态标记，不做任何解析。
//
// 图标数：${found.length}
// 许可分布：${[...licenseCounts].map(([k, v]) => `${k} × ${v}`).join('；')}

/** 一个品牌图标。markup 是已消毒的 <svg> 内部标记，配合 viewBox 使用。 */
export interface BrandIcon {
  title: string;
  /** 品牌主色，形如 #4285F4。用于首字母回退与背景取色。 */
  hex: string;
  viewBox: string;
  /** 已消毒的 SVG 内部标记（不含外层 <svg>）。 */
  markup: string;
  /** 这是个反白 logo，只在深色底上可见——组件据此改用品牌色深底而非白底。 */
  onDark: boolean;
}

export const BRAND_ICONS: Readonly<Record<string, BrandIcon>> = {
${entries}
};
`;

writeFileSync(OUT, source, 'utf8');

console.log(`wrote ${OUT}`);
console.log(`  icons: ${found.length}`);
console.log(`  bytes: ${(source.length / 1024).toFixed(0)}KB`);
console.log(`  licenses: ${[...licenseCounts].map(([k, v]) => `${k}×${v}`).join(', ')}`);
console.log('  sanitiser:');
console.log(`    style="" rewritten: ${stats.styleAttrs}`);
console.log(`    <style> dropped:    ${stats.styleTags}`);
console.log(`    ids namespaced:     ${stats.idsRenamed}`);
if (stats.droppedElements.size > 0) {
  console.log(`    elements dropped:   ${[...stats.droppedElements].map(([k, v]) => `${k}×${v}`).join(', ')}`);
}
if (stats.droppedAttrs.size > 0) {
  console.log(`    attrs dropped:      ${[...stats.droppedAttrs].map(([k, v]) => `${k}×${v}`).join(', ')}`);
}
if (missing.length > 0) {
  console.log(`  MISSING upstream (${missing.length}): ${missing.join(', ')}`);
}
if (customMissing.length > 0) {
  console.log(`  MISSING custom (${customMissing.length}): ${customMissing.join(', ')}`);
  console.log('    → 把 SVG 放进 assets/brand-icons/ 后重跑 npm run icons');
}
