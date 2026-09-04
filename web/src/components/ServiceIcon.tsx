// 条目图标：认识的发行方给品牌彩色标志，不认识的给稳定的首字母色块。
//
// 尺寸由调用方通过 className 决定——TokenCard 把它放大到超过行高再裁掉，
// 因此这里只负责铺满外框，不写死任何尺寸。
//
// 几何与配色都在 lib/icons/tile.ts 里算好（工卡上那张图标也用同一份描述
// 光栅化，见 lib/badge/raster.ts）；本文件只负责把它变成 DOM。
//
// 底色不能用品牌主色：彩色 logo 往往就是品牌主色画的（比如 Alipay 的 logo 是
// #1677FF，底也是 #1677FF），铺同色底 logo 直接消失。tile.ts 用白底 + 一层很淡的
// 品牌色，既保留品牌气质，又保证任何配色的 logo 都能读出来。
//
// 颜色一律走 SVG 的表现属性，不用行内 style——CSP 是 style-src 'self' 且没有
// 'unsafe-inline'，行内 style 在真实浏览器里会被拦掉（D11）。生成脚本已经把上游
// SVG 里的 style 声明改写成了表现属性，见 scripts/gen-brand-icons.mjs。

import { describeIconTile } from '../lib/icons/tile';
import type { ServiceEntry } from '../lib/twofas/types';

export interface ServiceIconProps {
  entry: ServiceEntry;
  /** 外框样式（尺寸、定位）。图标自身始终铺满外框。 */
  className?: string;
  /** 外层已经有无障碍名称时传 true，避免读屏重复播报。 */
  decorative?: boolean;
}

export default function ServiceIcon({ entry, className, decorative = false }: ServiceIconProps) {
  const tile = describeIconTile(entry);

  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': tile.title } as const);

  if (tile.kind === 'brand') {
    const { x, y, width, height } = tile.rect;
    return (
      <span
        data-testid="service-icon"
        data-icon-kind="brand"
        data-icon-title={tile.title}
        className={className}
      >
        <svg viewBox={tile.viewBox} className="h-full w-full" {...a11y}>
          <rect x={x} y={y} width={width} height={height} fill="#ffffff" />
          <rect
            x={x}
            y={y}
            width={width}
            height={height}
            fill={tile.accent}
            fillOpacity={tile.tintOpacity}
          />
          <g
            transform={tile.transform}
            // markup 是构建期从 @thesvg/icons 消毒后烘焙进源码的静态标记：
            // 白名单过滤过元素与属性、剥掉了 style、id 加了前缀，且完全不受任何
            // 用户输入影响，作为源码提交、可在 diff 里审阅。这里只是把它放回 DOM。
            dangerouslySetInnerHTML={{ __html: tile.markup }}
          />
        </svg>
      </span>
    );
  }

  return (
    <span
      data-testid="service-icon"
      data-icon-kind="letter"
      data-icon-letter={tile.letter}
      className={className}
    >
      <svg viewBox="0 0 24 24" className="h-full w-full" {...a11y}>
        <rect width="24" height="24" fill={tile.color} />
        <text
          x="12"
          y="12"
          textAnchor="middle"
          dominantBaseline="central"
          fill={tile.ink}
          fontSize={tile.fontSize}
          fontWeight="600"
          fontFamily="inherit"
        >
          {tile.letter}
        </text>
      </svg>
    </span>
  );
}
