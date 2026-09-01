// 把备份里千奇百怪的发行方名字映射到一枚品牌图标；映射不到就给一个稳定的首字母色块。
//
// 这一层是纯函数，不碰 DOM，也不碰 React——和 src/lib 下其余模块同样的定位。

import { BRAND_ICONS, type BrandIcon } from './brands.generated';

/**
 * 归一化发行方名字：转小写并丢掉所有非字母数字的字符。
 * 用 \p{L}\p{N} 而不是 [a-z0-9]，否则中文名字会被清成空串。
 */
export function normalizeIssuerKey(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 别名 → simple-icons slug。左边一律是已归一化的形式。
 * 上游没有的品牌（Microsoft、AWS、LinkedIn、Slack 等，见生成脚本里的说明）不在此列，
 * 它们会走首字母色块。
 */
const ALIASES: Readonly<Record<string, string>> = {
  // 同一家的不同叫法
  gmail: 'google',
  googlemail: 'google',
  googleaccount: 'google',
  googleaccounts: 'google',
  gcp: 'googlecloud',
  googlecloudplatform: 'googlecloud',
  twitter: 'x',
  meta: 'facebook',
  fb: 'facebook',
  ig: 'instagram',
  onepassword: '1password',
  tutanota: 'tuta',
  gog: 'gogdotcom',
  blockchain: 'blockchaindotcom',
  aliyun: 'alibabacloud',
  aliyuncs: 'alibabacloud',
  tencentqq: 'qq',
  weibo: 'sinaweibo',
  wordpresscom: 'wordpress',
  wordpressorg: 'wordpress',
  do: 'digitalocean',
  cf: 'cloudflare',
  protonme: 'proton',
  protonmailcom: 'protonmail',
  // 自定义图标（assets/brand-icons/）：上游图标库里没有，SVG 自备
  dnbcom: 'dnb',
  dunbradstreet: 'dnb',
  dunandbradstreet: 'dnb',
  mteamcc: 'mteam',
  mteamtp: 'mteam',
  // 中文名
  微信: 'wechat',
  企业微信: 'wechat',
  支付宝: 'alipay',
  知乎: 'zhihu',
  百度: 'baidu',
  小米: 'xiaomi',
  华为: 'huawei',
  哔哩哔哩: 'bilibili',
  豆瓣: 'douban',
  微博: 'sinaweibo',
  新浪微博: 'sinaweibo',
  阿里云: 'alibabacloud',
  码云: 'gitee',
  谷歌: 'google',
  苹果: 'apple',
  网易: 'neteasecloudmusic',
};

/** 常见后缀。只有剥掉之后正好命中已知图标时才采纳，避免把 cisco 削成 cis。 */
const TRAILING_NOISE = ['com', 'net', 'org', 'io', 'co', 'cn', 'dev', 'app', 'me', 'xyz', 'inc'];

/** 参与子串匹配的最短图标名。太短会误伤（x、qq、npm 靠精确匹配即可）。 */
const MIN_SUBSTRING_LEN = 4;

function lookupExact(key: string): BrandIcon | null {
  if (key.length === 0) {
    return null;
  }
  const direct = BRAND_ICONS[key];
  if (direct !== undefined) {
    return direct;
  }
  const aliased = ALIASES[key];
  if (aliased !== undefined) {
    return BRAND_ICONS[aliased] ?? null;
  }
  return null;
}

function lookupWithoutNoise(key: string): BrandIcon | null {
  for (const suffix of TRAILING_NOISE) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const trimmed = key.slice(0, -suffix.length);
      const hit = lookupExact(trimmed);
      if (hit !== null) {
        return hit;
      }
    }
  }
  return null;
}

/** 最长子串匹配：googlecloudplatform 应该命中 googlecloud 而不是 google。 */
function lookupSubstring(key: string): BrandIcon | null {
  let best: BrandIcon | null = null;
  let bestLen = 0;
  for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
    if (slug.length >= MIN_SUBSTRING_LEN && slug.length > bestLen && key.includes(slug)) {
      best = icon;
      bestLen = slug.length;
    }
  }
  return best;
}

/**
 * 按分段（主机名的每一段、名字里的每个词）逐个尝试精确匹配。
 *
 * 归一化会把 `sso.dnb.com` 压成 `ssodnbcom`，而 `dnb` 只有 3 个字符、低于子串匹配的
 * 长度门槛，于是整条都匹配不上。按点/空格/连字符切开后 `dnb` 就能精确命中。
 *
 * 只做精确与别名匹配、不做子串，因此不会误伤：`com`、`sso` 这类段落谁也匹配不到。
 * 排在子串匹配之后，`Google Cloud Platform` 才不会被 `google` 这一段抢先命中。
 */
function lookupParts(raw: string): BrandIcon | null {
  const parts = raw
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeIssuerKey)
    .filter((part) => part.length >= 2);

  let best: BrandIcon | null = null;
  let bestLen = 0;
  for (const part of parts) {
    const hit = lookupExact(part);
    if (hit !== null && part.length > bestLen) {
      best = hit;
      bestLen = part.length;
    }
  }
  return best;
}

/** 按精确 → 去后缀 → 最长子串 → 分段的顺序找图标；都不中返回 null。 */
export function findBrandIcon(raw: string | null | undefined): BrandIcon | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const key = normalizeIssuerKey(raw);
  if (key.length === 0) {
    return null;
  }
  return (
    lookupExact(key) ?? lookupWithoutNoise(key) ?? lookupSubstring(key) ?? lookupParts(raw)
  );
}

/**
 * 首字母色块的配色。CSP 不允许行内 style，因此颜色以 SVG 的 fill 属性下发
 * （fill 是表现属性，不受 style-src 限制），这里给的是十六进制字符串。
 * 每个颜色都保证白字可读。
 */
const AVATAR_COLORS = [
  '#0f766e',
  '#b91c1c',
  '#1d4ed8',
  '#a16207',
  '#7e22ce',
  '#be123c',
  '#0369a1',
  '#4d7c0f',
  '#c2410c',
  '#6d28d9',
  '#0e7490',
  '#9d174d',
  '#374151',
  '#15803d',
] as const;

/** 名字为空、或索引取值意外落空时的兜底色。 */
const FALLBACK_COLOR = '#374151';

/** FNV-1a：短字符串上分布够均匀，且实现稳定——同一个发行方永远同一个颜色。 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * 在给定底色上取一个readable的前景色（白或近黑）。
 *
 * simple-icons 的图标都是单色剪影，因此「品牌色铺底 + 反差色画 logo」既是常见的
 * 应用图标观感，也顺带解决了深色模式：GitHub(#181717) 这类极深的品牌色若直接画在
 * 深色卡片上会糊成一团，铺成底色再用白色画 logo 就始终清晰。
 *
 * 用 WCAG 相对亮度，而不是简单的 RGB 均值——后者会在黄绿色系上判错。
 */
export function readableOn(hex: string): string {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.45 ? '#0f172a' : '#ffffff';
}

export interface LetterAvatar {
  /** 展示用的单个字符，已转大写。 */
  letter: string;
  /** 十六进制底色。 */
  color: string;
}

/** 由名字推出稳定的首字母 + 底色。名字为空时退回问号。 */
export function letterAvatar(raw: string | null | undefined): LetterAvatar {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return { letter: '?', color: FALLBACK_COLOR };
  }
  // 用 Array.from 取首个码位，避免把 emoji 或代理对切成半个字符。
  const first = Array.from(trimmed)[0] ?? '?';
  const key = normalizeIssuerKey(trimmed) || trimmed;
  return {
    letter: first.toUpperCase(),
    color: AVATAR_COLORS[hashString(key) % AVATAR_COLORS.length] ?? FALLBACK_COLOR,
  };
}

export type { BrandIcon };
