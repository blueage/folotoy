// 条目图标那块"色块 + 标志"的**唯一定义**：几何、配色、留白全在这里算一次。
//
// 两个消费者：
//   - <ServiceIcon>：把它渲染成页面上的 DOM；
//   - lib/badge/raster.ts：把它序列化成一段独立 SVG，光栅化后推给工卡。
//
// 分出来是因为工卡上那张图必须和页面上看到的是同一张。两边各算一遍留白、
// 各挑一遍底色，迟早会算出两张不一样的图，而"哪一张才是对的"没人答得上来。

import { findBrandIcon, letterAvatar, readableOn } from './resolve';

/** 描述图标所需的最小条目信息。给 ServiceEntry 用，也方便测试构造。 */
export interface IconSource {
  issuer: string | null;
  name: string;
}

/**
 * 色块的实际边长（px），用来把"留白多少像素"换算成 viewBox 里的比例。
 *
 * 来自 TokenCard：色块是行高的 160%（ICON_BOX 的 h-[160%]），行高约 64px。
 *
 * 行高由**最高的那一列**决定，而那一列是验证码（text-2xl 32px + 已复制提示 16px
 * = 48px），不是左侧的标题块（text-base 24px + 账号 16px = 40px）。所以改标题
 * 字号并不会改变行高——除非它涨到超过 48px。加上行自身的 py-2（16px）共 64px。
 */
export const TILE_PX = 102;

/** logo 四周与色块边缘的留白（px）。贴边会显得局促。 */
export const LOGO_PADDING_PX = 10;

/**
 * 品牌 logo 相对色块的倍数，由上面两个像素值反推。
 *
 * < 1 是四周留白；= 1 恰好铺满、四边相切；> 1 会溢出并被色块边缘裁掉
 * （溢出部分靠 SVG 根元素默认的 overflow: hidden 裁切——底色铺满整个画布，
 * 因此画布边缘就是色块边缘）。
 *
 * 调这个值不会影响色块本身的尺寸与位置：改的只是画布里画什么，画布多大由
 * TokenCard 决定。注意别和那里 ICON_BOX 的 160% 混淆——那个是色块相对**行高**
 * 的倍数，两者性质不同。
 */
const LOGO_SCALE = (TILE_PX - LOGO_PADDING_PX * 2) / TILE_PX;

/** 首字母跟 logo 用同一个缩放比例，两种图标的视觉重量才一致。 */
const LETTER_SCALE = LOGO_SCALE;

/** 白底之上品牌色的浓度。够出气质，又不至于压过 logo 本身的颜色。 */
export const TINT_OPACITY = '0.14';

/**
 * 首字母的字号。
 *
 * 不能直接用 24×LETTER_SCALE：字号是 em 框的高度，而字形的墨迹只占其中一部分
 * （西文大写字母的 cap height 约 0.7em），直接用会让字母看着比 logo 小一圈。
 * 但也不能补满到 1/0.7：W、M 这类宽字母的宽度可达 0.9em，补太多会横向溢出被裁。
 * 0.95 是"和 logo 一样满"与"最宽的字母也不被裁"之间的折中。
 */
const LETTER_FONT_SIZE = (24 * LETTER_SCALE * 0.95).toFixed(2);

/** 找图标时的候选名字：先发行方，再服务名。 */
function iconCandidates(entry: IconSource): string[] {
  return [entry.issuer, entry.name].filter((v): v is string => v !== null && v.trim().length > 0);
}

function brandOf(entry: IconSource): ReturnType<typeof findBrandIcon> {
  return iconCandidates(entry).reduce<ReturnType<typeof findBrandIcon>>(
    (found, candidate) => found ?? findBrandIcon(candidate),
    null,
  );
}

/**
 * 这个条目的主色：认识的发行方用品牌色，否则用首字母色块的底色。
 *
 * 导出是为了让整行的底色和图标底色取自同一处——两边各算一遍迟早会算出不同的结果。
 */
export function iconAccent(entry: IconSource): string {
  const brand = brandOf(entry);
  return brand?.hex ?? letterAvatar(entry.issuer ?? entry.name).color;
}

/** 品牌标志版的色块。 */
export interface BrandTile {
  kind: 'brand';
  /** 无障碍名称。 */
  title: string;
  accent: string;
  viewBox: string;
  /** 底色矩形的位置与尺寸；原点可能为负，见下。 */
  rect: { x: number; y: number; width: number; height: number };
  /** 白底之上那层品牌色的浓度。反白 logo 是 '1'（实底）。 */
  tintOpacity: string;
  /** logo 的缩放/居中变换。 */
  transform: string;
  /** 已消毒的上游标记。 */
  markup: string;
}

/** 首字母版的色块。 */
export interface LetterTile {
  kind: 'letter';
  title: string;
  accent: string;
  letter: string;
  /** 底色。 */
  color: string;
  /** 字色，保证在底色上可读。 */
  ink: string;
  fontSize: string;
}

export type IconTile = BrandTile | LetterTile;

/** 把一个条目化成一块可画的图标。纯函数，不碰 DOM。 */
export function describeIconTile(entry: IconSource): IconTile {
  const brand = brandOf(entry);
  const name = entry.issuer ?? entry.name;

  if (brand === null) {
    const { letter, color } = letterAvatar(name);
    return {
      kind: 'letter',
      title: name,
      accent: color,
      letter,
      color,
      ink: readableOn(color),
      fontSize: LETTER_FONT_SIZE,
    };
  }

  // 上游 viewBox 各不相同（24、1024、2447.6…），所以 logo 的缩放要按它自己的
  // 尺度算，不能套用 24 画布的数字。
  // viewBox 的原点未必是 0 0：生成脚本把非方形的 viewBox 居中扩成了正方形，
  // 补出来的那一半是负坐标（M-Team 就是 "0 -688 2096 2096"）。底色矩形必须从
  // 原点起画，否则会错位、露出没铺到的部分。
  const [vbMinX = '0', vbMinY = '0', vbWidth = '24', vbHeight = '24'] = brand.viewBox.split(/\s+/);
  const minX = Number(vbMinX);
  const minY = Number(vbMinY);
  const width = Number(vbWidth);
  const height = Number(vbHeight);
  // 以 viewBox 的中心为基准缩放。中心是 (minX + width/2)，不是 (width/2)——
  // 原点可能为负（见上），套用后者会在 LOGO_SCALE ≠ 1 时把 logo 推偏。
  const offsetX = (minX + width / 2) * (1 - LOGO_SCALE);
  const offsetY = (minY + height / 2) * (1 - LOGO_SCALE);

  return {
    kind: 'brand',
    title: brand.title,
    accent: brand.hex,
    viewBox: brand.viewBox,
    rect: { x: minX, y: minY, width, height },
    // 反白 logo（品牌资源页常只提供这一版）画在白底上等于消失，
    // 改用品牌色实底。生成脚本按图标自身的着色判定，见 needsDarkBackdrop。
    tintOpacity: brand.onDark ? '1' : TINT_OPACITY,
    transform: `translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${LOGO_SCALE.toFixed(4)})`,
    markup: brand.markup,
  };
}

/**
 * 把色块序列化成一段独立的 SVG 文本，供光栅化用（页面上的 DOM 由
 * ServiceIcon 直接渲染，不走这里）。
 *
 * 两处和页面不同，都是"独立文档"带来的：
 *   - 必须写 xmlns，否则 <img> 认不出这是 SVG；
 *   - 字体不能写 inherit（没有可继承的上下文），得给一串具体的字体名。
 */
export function iconTileSvg(tile: IconTile, size: number, fontFamily: string): string {
  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="${tile.kind === 'brand' ? tile.viewBox : '0 0 24 24'}">`;

  if (tile.kind === 'brand') {
    const { x, y, width, height } = tile.rect;
    return (
      open +
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#ffffff"/>` +
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${tile.accent}" ` +
      `fill-opacity="${tile.tintOpacity}"/>` +
      `<g transform="${tile.transform}">${tile.markup}</g>` +
      '</svg>'
    );
  }

  return (
    open +
    `<rect width="24" height="24" fill="${tile.color}"/>` +
    `<text x="12" y="12" text-anchor="middle" dominant-baseline="central" ` +
    `fill="${tile.ink}" font-size="${tile.fontSize}" font-weight="600" ` +
    `font-family="${fontFamily}">${escapeText(tile.letter)}</text>` +
    '</svg>'
  );
}

/** 首字母来自用户数据，进 SVG 文本前必须转义。 */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
