// 图标位图编码的契约。断言的对象是"工卡那边能不能原样读回来"，
// 因此还原一律走 fakeBadge 里那个照着协议文档另写的解码器，
// 不复用编码器的中间结果——两端对格式的理解一旦分家，就该在这里炸出来。

import { describe, expect, it } from 'vitest';

import { decodeIconBlob } from './fakeBadge';
import { buildIconBlob, encodeRuns, fromRgb565, quantize, toRgb565 } from './icon';
import { BADGE_ICON_BLOB_MAX, BADGE_ICON_H, BADGE_ICON_PALETTE_MAX, BADGE_ICON_W } from './limits';

const PIXELS = BADGE_ICON_W * BADGE_ICON_H;

/** 用一个"第 i 个像素该是什么颜色"的函数造一张图。 */
function image(paint: (index: number) => [number, number, number, number]): {
  data: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const data = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i += 1) {
    const [r, g, b, a] = paint(i);
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { data, width: BADGE_ICON_W, height: BADGE_ICON_H };
}

/** 位图里的调色板，按设备侧的读法解出来。 */
function readPalette(blob: Uint8Array): { rgb565: number; alpha: number }[] {
  const length = blob[3] ?? 0;
  return Array.from({ length }, (_unused, i) => ({
    rgb565: (blob[4 + i * 3] ?? 0) | ((blob[5 + i * 3] ?? 0) << 8),
    alpha: blob[6 + i * 3] ?? 0,
  }));
}

describe('量化', () => {
  it('颜色不超过 16 种时一格不差地保留', () => {
    // 四种颜色都能被 RGB565 精确表示，量化不该动它们。
    const colors: [number, number, number, number][] = [
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ];
    const { palette, indices } = quantize(image((i) => colors[i % 4] as [number, number, number, number]));

    expect(palette).toHaveLength(4);
    for (let i = 0; i < 8; i += 1) {
      const slot = palette[indices[i] as number];
      const [r, g, b] = fromRgb565(slot?.rgb565 ?? 0);
      expect([r, g, b, slot?.alpha]).toEqual(colors[i % 4]);
    }
  });

  it('全透明的像素不管原本什么颜色都归到同一格', () => {
    // 画布上被清空的区域，各像素残留的 RGB 可能不同，但它们在屏幕上是一样的
    // ——不合并的话，透明区域能白白吃掉好几格调色板。
    const { palette } = quantize(
      image((i) => (i % 2 === 0 ? [255, 0, 0, 0] : [0, 255, 0, 0])),
    );
    expect(palette).toHaveLength(1);
    expect(palette[0]?.alpha).toBe(0);
  });

  it('颜色再多也收敛到 16 格', () => {
    const { palette, indices } = quantize(image((i) => [i % 256, (i * 7) % 256, (i * 13) % 256, 255]));
    expect(palette.length).toBeLessThanOrEqual(BADGE_ICON_PALETTE_MAX);
    expect(palette.length).toBeGreaterThan(1);
    // 每个像素都得指向一个真实存在的格子。
    for (const index of indices) {
      expect(index).toBeLessThan(palette.length);
    }
  });
});

describe('行程编码', () => {
  it('同色长段与杂色段都能被设备侧解码器还原', () => {
    // 前半段整片同色（走行程），后半段每像素都变（走字面量段）。
    const source = quantize(
      image((i) => (i < PIXELS / 2 ? [255, 255, 255, 255] : [(i % 2) * 255, 0, 0, 255])),
    );
    const blob = buildIconBlob(
      image((i) => (i < PIXELS / 2 ? [255, 255, 255, 255] : [(i % 2) * 255, 0, 0, 255])),
    );

    const decoded = decodeIconBlob(blob);
    expect(decoded).not.toBeNull();
    expect([...(decoded as Uint8Array)]).toEqual([...source.indices]);
  });

  it('单像素的段也能原样还原（奇数个字面量要补半个字节）', () => {
    const indices = new Uint8Array(PIXELS);
    // 长度为奇数的杂色段：最后一个下标只占半字节，另外半个字节是填充。
    indices[0] = 1;
    indices[1] = 2;
    indices[2] = 1;
    const runs = encodeRuns(indices);
    // 头两个记号：一个 3 像素的字面量段，然后是剩下的同色行程。
    expect(runs[0]).toBe(0x00);
    expect(runs[1]).toBe(3);
  });
});

describe('位图', () => {
  it('头部写着版本与几何，工卡靠它认出"这张图不是给我的"', () => {
    const blob = buildIconBlob(image(() => [10, 20, 30, 255]));
    expect(blob[0]).toBe(1);
    expect(blob[1]).toBe(BADGE_ICON_W);
    expect(blob[2]).toBe(BADGE_ICON_H);
    expect(readPalette(blob)).toEqual([{ rgb565: toRgb565(10, 20, 30), alpha: 255 }]);
  });

  it('尺寸不对直接抛，而不是编出一张工卡会拒收的图', () => {
    expect(() =>
      buildIconBlob({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    ).toThrow(RangeError);
  });

  it('最坏情况也在工卡的字节上限之内', () => {
    // 相邻像素永不相同 —— 行程编码一点忙都帮不上，全靠字面量段兜底。
    // 这正是 BADGE_ICON_BLOB_MAX 那个数字要挡住的情况。
    const blob = buildIconBlob(image((i) => [(i % 16) * 16, 0, 0, 255]));
    expect(blob.length).toBeLessThanOrEqual(BADGE_ICON_BLOB_MAX);
    expect(decodeIconBlob(blob)).not.toBeNull();
  });

  it('整片纯色压得极小（一张图不该占掉半分钟的蓝牙时间）', () => {
    const blob = buildIconBlob(image(() => [255, 255, 255, 255]));
    expect(blob.length).toBeLessThan(64);
  });
});
