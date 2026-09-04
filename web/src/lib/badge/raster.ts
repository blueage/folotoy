// 把页面上的图标画成工卡屏幕上的那 48×48 像素。
//
// 这是整条链路里**唯一碰浏览器 API 的一层**（canvas / Image），和 ble.ts 的定位
// 一样：几何与配色在 lib/icons/tile.ts，编码在 lib/badge/icon.ts，都是纯函数、
// 能在 jsdom 里测；这里只负责"把那段 SVG 画出来，取回像素"。
//
// 为什么在浏览器里光栅化，而不是让工卡自己画：
//   工卡上没有矢量渲染器，也没有品牌图标库（121 个图标解压后比整个固件还大）。
//   把"画成什么样"留在网页这边，两处看到的就永远是同一张图。

import { describeIconTile, iconTileSvg } from '../icons/tile';
import type { IconSource } from '../icons/tile';
import { BADGE_ICON_H, BADGE_ICON_W } from './limits';
import { buildIconBlob } from './icon';

/*
 * 斜着的色块，照抄网页那一行的观感：色块比窗口大得多，四边都被窗口裁掉，
 * 于是看到的是 logo 放大后的中段——而不是一整枚缩小的 logo。
 *
 * 三个数字（窗口 48×48）：
 *
 *   - 边长 62：比窗口大 29%。这一版特意从 54 放大了约 15%：54 那会儿整枚 logo
 *     都塞得下，看着像一张贴纸；放大之后 logo 的边缘被窗口切掉，才有网页上
 *     那种"图比行还大、被行裁住"的劲儿。
 *   - 左移 10：让色块的中心停在 x=21（窗口中心是 24），也就是**放大前后中心不动**，
 *     否则放大会把 logo 整个推向一边、单边切得特别狠。
 *   - 转 10°：和网页的 rotate-[10deg] 同一个角度。
 *
 * 放大的代价：54 那一版四角还能露出一点行底色（那条斜边看得见），62 之后色块
 * 已经盖满整个窗口，斜边跑到窗口外面去了——倾斜只剩 logo 自身还看得出来。
 * 想把那条斜边找回来就得把边长调回 56 以下，两者不可兼得。
 *
 * 透明部分（如果还有）不烤底色——底色随"这一行是否选中"变化，混合交给工卡去做。
 */
const TILE_SIDE = 62;
const TILE_LEFT = -10;
const TILE_TOP = (BADGE_ICON_H - TILE_SIDE) / 2;
const TILE_ROTATION_DEG = 10;

/**
 * SVG 先按 3 倍分辨率画，再缩到 48×48。
 *
 * 直接按 54px 画出来的斜边是硬邦邦的锯齿；超采样之后缩放，斜边和 logo 的细节
 * 都带上了过渡色——那正是调色板里留着 alpha 的意义。
 */
const SUPERSAMPLE = 3;

/** 工卡只有拉丁字体，首字母色块用什么字体画都行，给一串常见的无衬线族。 */
const RASTER_FONT = 'Helvetica, Arial, sans-serif';

/** 浏览器不支持 canvas / 图片解码时抛这个；调用方据此退回"不带图标"。 */
export class IconRasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IconRasterError';
  }
}

/**
 * 图片解码的等待上限。
 *
 * 不是防"慢"：data: URL 的解码是本地的、以毫秒计。它防的是**永远不 load 也不
 * error** 的环境（jsdom 就不加载任何资源）。没有它，一次推送会永远卡在这里，
 * 连"图标画不出来就不带它"这条退路都走不到。
 */
const DECODE_TIMEOUT_MS = 3000;

function loadSvg(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    const timer = setTimeout(() => {
      reject(new IconRasterError('图标渲染超时'));
    }, DECODE_TIMEOUT_MS);
    image.addEventListener('load', () => {
      clearTimeout(timer);
      resolve(image);
    });
    image.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new IconRasterError('图标渲染失败'));
    });
    // data: URL 而不是 blob:：页面的 CSP 里 img-src 只放行了 'self' 与 data:。
    // encodeURIComponent 而不是 base64——图标标记里有中文标题时 btoa 会直接抛。
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * 光栅化一个条目的图标，返回工卡认识的位图字节。
 *
 * 失败一律抛 IconRasterError：图标只是锦上添花，调用方接住它、照常推送令牌就好。
 */
export async function rasterizeBadgeIcon(entry: IconSource): Promise<Uint8Array> {
  // 先要画布再解码图片：画布拿不到（jsdom、老浏览器）时立刻失败，
  // 不必先白等一次图片解码。
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_ICON_W;
  canvas.height = BADGE_ICON_H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new IconRasterError('这个浏览器不提供 2D 画布，无法生成图标');
  }

  const tile = describeIconTile(entry);
  const svg = iconTileSvg(tile, TILE_SIDE * SUPERSAMPLE, RASTER_FONT);
  const image = await loadSvg(svg);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 绕色块自己的中心转，因此先把原点挪过去。
  ctx.translate(TILE_LEFT + TILE_SIDE / 2, TILE_TOP + TILE_SIDE / 2);
  ctx.rotate((TILE_ROTATION_DEG * Math.PI) / 180);
  ctx.drawImage(image, -TILE_SIDE / 2, -TILE_SIDE / 2, TILE_SIDE, TILE_SIDE);

  const pixels = ctx.getImageData(0, 0, BADGE_ICON_W, BADGE_ICON_H);
  return buildIconBlob(pixels);
}
