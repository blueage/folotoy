// 条目图标：认识的发行方给品牌彩色标志，不认识的给稳定的首字母色块。
//
// 尺寸由调用方通过 className 决定——TokenCard 把它放大到超过行高再裁掉，
// 因此这里只负责铺满外框，不写死任何尺寸。
//
// 底色不能用品牌主色：彩色 logo 往往就是品牌主色画的（比如 Alipay 的 logo 是
// #1677FF，底也是 #1677FF），铺同色底 logo 直接消失。这里用白底 + 一层很淡的
// 品牌色，既保留品牌气质，又保证任何配色的 logo 都能读出来。
//
// 颜色一律走 SVG 的表现属性，不用行内 style——CSP 是 style-src 'self' 且没有
// 'unsafe-inline'，行内 style 在真实浏览器里会被拦掉（D11）。生成脚本已经把上游
// SVG 里的 style 声明改写成了表现属性，见 scripts/gen-brand-icons.mjs。

import { findBrandIcon, letterAvatar, readableOn } from '../lib/icons/resolve';
import type { ServiceEntry } from '../lib/twofas/types';

export interface ServiceIconProps {
  entry: ServiceEntry;
  /** 外框样式（尺寸、定位）。图标自身始终铺满外框。 */
  className?: string;
  /** 外层已经有无障碍名称时传 true，避免读屏重复播报。 */
  decorative?: boolean;
}

/** 找图标时的候选名字：先发行方，再服务名。 */
function iconCandidates(entry: ServiceEntry): string[] {
  return [entry.issuer, entry.name].filter((v): v is string => v !== null && v.trim().length > 0);
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
 * 这个条目的主色：认识的发行方用品牌色，否则用首字母色块的底色。
 *
 * 导出是为了让整行的底色和图标底色取自同一处——两边各算一遍迟早会算出不同的结果。
 */
export function iconAccent(entry: ServiceEntry): string {
  const brand = iconCandidates(entry).reduce<ReturnType<typeof findBrandIcon>>(
    (found, candidate) => found ?? findBrandIcon(candidate),
    null,
  );
  return brand?.hex ?? letterAvatar(entry.issuer ?? entry.name).color;
}

/**
 * 首字母的字号。
 *
 * 不能直接用 24×LETTER_SCALE：字号是 em 框的高度，而字形的墨迹只占其中一部分
 * （西文大写字母的 cap height 约 0.7em），直接用会让字母看着比 logo 小一圈。
 * 但也不能补满到 1/0.7：W、M 这类宽字母的宽度可达 0.9em，补太多会横向溢出被裁。
 * 0.95 是"和 logo 一样满"与"最宽的字母也不被裁"之间的折中。
 */
const LETTER_FONT_SIZE = (24 * LETTER_SCALE * 0.95).toFixed(2);

export default function ServiceIcon({ entry, className, decorative = false }: ServiceIconProps) {
  const brand = iconCandidates(entry).reduce<ReturnType<typeof findBrandIcon>>(
    (found, candidate) => found ?? findBrandIcon(candidate),
    null,
  );
  const name = entry.issuer ?? entry.name;

  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': brand?.title ?? name } as const);

  if (brand !== null) {
    // 上游 viewBox 各不相同（24、1024、2447.6…），所以 logo 的缩放要按它自己的
    // 尺度算，不能套用 24 画布的数字。
    // viewBox 的原点未必是 0 0：生成脚本把非方形的 viewBox 居中扩成了正方形，
    // 补出来的那一半是负坐标（M-Team 就是 "0 -688 2096 2096"）。底色矩形必须从
    // 原点起画，否则会错位、露出没铺到的部分。
    const [vbMinX = '0', vbMinY = '0', vbWidth = '24', vbHeight = '24'] =
      brand.viewBox.split(/\s+/);
    const minX = Number(vbMinX);
    const minY = Number(vbMinY);
    const width = Number(vbWidth);
    const height = Number(vbHeight);
    // 以 viewBox 的中心为基准缩放。中心是 (minX + width/2)，不是 (width/2)——
    // 原点可能为负（见上），套用后者会在 LOGO_SCALE ≠ 1 时把 logo 推偏。
    const offsetX = (minX + width / 2) * (1 - LOGO_SCALE);
    const offsetY = (minY + height / 2) * (1 - LOGO_SCALE);

    return (
      <span
        data-testid="service-icon"
        data-icon-kind="brand"
        data-icon-title={brand.title}
        className={className}
      >
        <svg viewBox={brand.viewBox} className="h-full w-full" {...a11y}>
          {/*
            反白 logo（品牌资源页常只提供这一版）画在白底上等于消失，
            改用品牌色实底。生成脚本按图标自身的着色判定，见 needsDarkBackdrop。
          */}
          <rect x={minX} y={minY} width={width} height={height} fill="#ffffff" />
          <rect
            x={minX}
            y={minY}
            width={width}
            height={height}
            fill={brand.hex}
            fillOpacity={brand.onDark ? '1' : TINT_OPACITY}
          />
          <g
            transform={`translate(${offsetX.toFixed(2)} ${offsetY.toFixed(2)}) scale(${LOGO_SCALE.toFixed(4)})`}
            // markup 是构建期从 @thesvg/icons 消毒后烘焙进源码的静态标记：
            // 白名单过滤过元素与属性、剥掉了 style、id 加了前缀，且完全不受任何
            // 用户输入影响，作为源码提交、可在 diff 里审阅。这里只是把它放回 DOM。
            dangerouslySetInnerHTML={{ __html: brand.markup }}
          />
        </svg>
      </span>
    );
  }

  const { letter, color } = letterAvatar(name);
  return (
    <span
      data-testid="service-icon"
      data-icon-kind="letter"
      data-icon-letter={letter}
      className={className}
    >
      <svg viewBox="0 0 24 24" className="h-full w-full" {...a11y}>
        <rect width="24" height="24" fill={color} />
        <text
          x="12"
          y="12"
          textAnchor="middle"
          dominantBaseline="central"
          fill={readableOn(color)}
          fontSize={LETTER_FONT_SIZE}
          fontWeight="600"
          fontFamily="inherit"
        >
          {letter}
        </text>
      </svg>
    </span>
  );
}
