// 图标位图的编码：一块 48×48 的 RGBA 像素 → 工卡认识的那串字节。
//
// 格式与固件 main/otp_icon.c 一一对应，写在 docs/protocol.zh_CN.md 的
// 「图标位图」一节：
//
//   version:u8 | width:u8 | height:u8 | palette_len:u8
//   palette[palette_len] × { rgb565:u16 小端, alpha:u8 }
//   行程流：count(1..255) index:u8   —— 同色行程
//           0x00 count(1..255) 4bpp  —— 字面量段（高半字节在前）
//
// 为什么不直接发 RGB565：48×48×2 = 4.6 KB/张，30 张 130 KB，按每次写 20 字节的
// BLE 速度要传好几分钟。调色板 + 行程编码之后一般是四五百字节。
//
// 这一层是纯函数：不碰 canvas，也不碰 DOM。像素怎么来的在 raster.ts。

import {
  BADGE_ICON_BLOB_MAX,
  BADGE_ICON_BLOB_VERSION,
  BADGE_ICON_H,
  BADGE_ICON_PALETTE_MAX,
  BADGE_ICON_W,
} from './limits';

/** ImageData 的最小形状。测试里直接构造，不需要真的 canvas。 */
export interface PixelBuffer {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** 调色板里的一格。颜色已经是屏幕的 565 精度。 */
export interface PaletteSlot {
  rgb565: number;
  alpha: number;
}

/**
 * alpha 低于这个值就当作全透明。
 *
 * 抗锯齿会在斜边上留下 alpha=1、2 这样的像素，它们在屏幕上完全看不见，
 * 却会各自占掉一格调色板——16 格经不起这么花。
 */
const ALPHA_FLOOR = 8;

/** 8 位分量 → RGB565。 */
export function toRgb565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/** '#RRGGBB' → RGB565。工卡那块屏就是 16 位的，多带两位精度只是浪费带宽。 */
export function hexToRgb565(hex: string): number {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(value)) {
    return 0;
  }
  return toRgb565((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

/** RGB565 → 8 位分量。高位补到低位，否则纯白会还原成浅灰。 */
export function fromRgb565(value: number): [number, number, number] {
  const r5 = (value >> 11) & 0x1f;
  const g6 = (value >> 5) & 0x3f;
  const b5 = value & 0x1f;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

interface Sample {
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

/** 把像素折算到屏幕精度后统计直方图。键是 (alpha, rgb565)。 */
function histogram(image: PixelBuffer): Map<number, Sample> {
  const counts = new Map<number, Sample>();
  for (let i = 0; i < image.width * image.height; i += 1) {
    const offset = i * 4;
    const alpha = image.data[offset + 3] ?? 0;
    // 全透明的像素颜色无意义，一律归到同一个键上，否则透明区域会按各自的
    // 残留颜色分成好几格。
    const transparent = alpha < ALPHA_FLOOR;
    const r = transparent ? 0 : (image.data[offset] ?? 0);
    const g = transparent ? 0 : (image.data[offset + 1] ?? 0);
    const b = transparent ? 0 : (image.data[offset + 2] ?? 0);
    const a = transparent ? 0 : alpha;
    const rgb565 = toRgb565(r, g, b);
    const key = a * 0x10000 + rgb565;
    const existing = counts.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    // 存回 565 还原后的分量：后面的取色、求平均都要在"屏幕真能显示的颜色"
    // 之间做，否则算出来的平均色到了工卡上又要被截一次精度。
    const [r8, g8, b8] = fromRgb565(rgb565);
    counts.set(key, { r: r8, g: g8, b: b8, a, count: 1 });
  }
  return counts;
}

/**
 * 中位切分（median cut）：把颜色装进一个盒子，反复沿"最长的那条边"切开，
 * 直到盒子数达到上限，每个盒子取加权平均色。
 *
 * 对这类图特别合适：色块本身只有三五种纯色，剩下的全是斜边上的过渡色，
 * 切分会自然把过渡色归拢成两三格，而把纯色各留一格。
 */
function medianCut(samples: Sample[], max: number): Sample[] {
  let boxes: Sample[][] = [samples];

  while (boxes.length < max) {
    // 挑像素最多的那个盒子来切：切它收益最大。
    let target = -1;
    let best = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) {
        return;
      }
      const weight = box.reduce((sum, sample) => sum + sample.count, 0);
      if (weight > best) {
        best = weight;
        target = index;
      }
    });
    if (target < 0) {
      break;  // 每个盒子都只剩一种颜色，切不动了
    }

    const box = boxes[target] as Sample[];
    const channel = widestChannel(box);
    const sorted = [...box].sort((left, right) => channel(left) - channel(right));
    // 按像素数对半分，而不是按颜色个数：一格只出现一次的过渡色不该和
    // 铺满半张图的底色平起平坐。
    const total = sorted.reduce((sum, sample) => sum + sample.count, 0);
    let running = 0;
    let split = 1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      running += (sorted[i] as Sample).count;
      if (running * 2 >= total) {
        split = i + 1;
        break;
      }
      split = i + 2;
    }
    // 兜住两头：切点落在 0 或 len 会切出一个空盒子，随后求平均时除以 0。
    split = Math.min(Math.max(split, 1), sorted.length - 1);
    boxes = [
      ...boxes.slice(0, target),
      sorted.slice(0, split),
      sorted.slice(split),
      ...boxes.slice(target + 1),
    ];
  }

  return boxes.map((box) => {
    const weight = box.reduce((sum, sample) => sum + sample.count, 0);
    const mean = (pick: (sample: Sample) => number): number =>
      Math.round(box.reduce((sum, sample) => sum + pick(sample) * sample.count, 0) / weight);
    return { r: mean((s) => s.r), g: mean((s) => s.g), b: mean((s) => s.b), a: mean((s) => s.a), count: weight };
  });
}

/** 盒子里跨度最大的那个通道。alpha 与颜色同等对待：它一样会被人看见。 */
function widestChannel(box: Sample[]): (sample: Sample) => number {
  const picks: ((sample: Sample) => number)[] = [
    (s) => s.r,
    (s) => s.g,
    (s) => s.b,
    (s) => s.a,
  ];
  let best = picks[0] as (sample: Sample) => number;
  let bestRange = -1;
  for (const pick of picks) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const sample of box) {
      const value = pick(sample);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (max - min > bestRange) {
      bestRange = max - min;
      best = pick;
    }
  }
  return best;
}

/** 距离最近的那一格。alpha 权重和颜色相同——差一档透明度和差一档颜色一样显眼。 */
function nearest(palette: Sample[], sample: Sample): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  palette.forEach((slot, index) => {
    const dr = slot.r - sample.r;
    const dg = slot.g - sample.g;
    const db = slot.b - sample.b;
    const da = slot.a - sample.a;
    const distance = dr * dr + dg * dg + db * db + da * da;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export interface IndexedImage {
  palette: PaletteSlot[];
  /** 每个像素一个调色板下标，按行优先。 */
  indices: Uint8Array;
}

/** 量化到至多 16 色。颜色本来就不超过 16 种时是精确的，不做任何近似。 */
export function quantize(image: PixelBuffer): IndexedImage {
  const counts = histogram(image);
  const samples = [...counts.values()];
  const palette =
    samples.length <= BADGE_ICON_PALETTE_MAX ? samples : medianCut(samples, BADGE_ICON_PALETTE_MAX);

  // 键 → 下标的缓存：一张图两千多个像素，但不同的颜色只有几十种。
  const lookup = new Map<number, number>();
  const indices = new Uint8Array(image.width * image.height);
  for (const [key, sample] of counts) {
    lookup.set(key, nearest(palette, sample));
  }
  for (let i = 0; i < indices.length; i += 1) {
    const offset = i * 4;
    const alpha = image.data[offset + 3] ?? 0;
    const transparent = alpha < ALPHA_FLOOR;
    const rgb565 = transparent
      ? 0
      : toRgb565(image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0);
    const key = (transparent ? 0 : alpha) * 0x10000 + rgb565;
    indices[i] = lookup.get(key) ?? 0;
  }

  return {
    palette: palette.map((slot) => ({ rgb565: toRgb565(slot.r, slot.g, slot.b), alpha: slot.a })),
    indices,
  };
}

/** 一段字面量最多能带多少像素（计数是 u8）。 */
const MAX_RUN = 255;
/** 短于这个长度的同色段走字面量更划算：行程记号要 2 字节，字面量每像素半字节。 */
const MIN_RUN = 3;

/** 行程编码。与固件的解码器（walk_stream）严格对应。 */
export function encodeRuns(indices: Uint8Array): Uint8Array {
  const out: number[] = [];
  const literal: number[] = [];

  const emitLiteral = (take: number[]): void => {
    out.push(0x00, take.length);
    for (let i = 0; i < take.length; i += 2) {
      // 高半字节在前，和固件解码时的取法一致。
      out.push(((take[i] ?? 0) << 4) | (take[i + 1] ?? 0));
    }
  };

  const flushLiteral = (): void => {
    while (literal.length > 0) {
      emitLiteral(literal.splice(0, MAX_RUN));
    }
  };

  let cursor = 0;
  while (cursor < indices.length) {
    const value = indices[cursor] as number;
    let run = 1;
    while (run < MAX_RUN && indices[cursor + run] === value) {
      run += 1;
    }
    if (run >= MIN_RUN) {
      flushLiteral();
      out.push(run, value);
    } else {
      for (let i = 0; i < run; i += 1) {
        literal.push(value);
      }
      // 字面量段的计数也是 u8，攒满就得先发走。
      if (literal.length >= MAX_RUN) {
        emitLiteral(literal.splice(0, MAX_RUN));
      }
    }
    cursor += run;
  }
  flushLiteral();

  return Uint8Array.from(out);
}

/**
 * 一块 48×48 的 RGBA 像素 → 工卡的图标位图。
 *
 * 几何不对就直接抛：尺寸是两端写死的契约，工卡收到不匹配的位图会整批拒收，
 * 与其让用户在真机上看到"一直拒收"，不如在这里就说清楚。
 */
export function buildIconBlob(image: PixelBuffer): Uint8Array {
  if (image.width !== BADGE_ICON_W || image.height !== BADGE_ICON_H) {
    throw new RangeError(
      `图标必须是 ${String(BADGE_ICON_W)}×${String(BADGE_ICON_H)}，收到 ${String(image.width)}×${String(image.height)}`,
    );
  }

  const { palette, indices } = quantize(image);
  const runs = encodeRuns(indices);
  const blob = new Uint8Array(4 + palette.length * 3 + runs.length);
  let w = 0;
  blob[w++] = BADGE_ICON_BLOB_VERSION;
  blob[w++] = BADGE_ICON_W;
  blob[w++] = BADGE_ICON_H;
  blob[w++] = palette.length;
  for (const slot of palette) {
    blob[w++] = slot.rgb565 & 0xff;
    blob[w++] = (slot.rgb565 >> 8) & 0xff;
    blob[w++] = slot.alpha;
  }
  blob.set(runs, w);

  if (blob.length > BADGE_ICON_BLOB_MAX) {
    // 编码器封了顶（字面量段最坏也只是每像素半字节），走到这里说明常量算错了。
    throw new RangeError(`图标编码后 ${String(blob.length)} 字节，超过工卡的上限`);
  }
  return blob;
}
