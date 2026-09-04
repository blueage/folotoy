// 色块描述与它的 SVG 序列化。
//
// 这一层存在的意义是"页面上的图标和推给工卡的图标是同一张"，因此这里断言的
// 重点是：序列化出来的那段 SVG 用的是 describeIconTile 给的同一组数字与颜色，
// 而不是另算一遍。

import { describe, expect, it } from 'vitest';

import { describeIconTile, iconAccent, iconTileSvg } from './tile';

const FONT = 'Helvetica, Arial, sans-serif';

describe('describeIconTile', () => {
  it('认识的发行方给品牌标志与品牌色', () => {
    const tile = describeIconTile({ issuer: 'GitHub', name: 'GitHub' });
    expect(tile.kind).toBe('brand');
    expect(tile.title).toBe('GitHub');
    expect(tile.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('不认识的发行方给稳定的首字母色块', () => {
    const first = describeIconTile({ issuer: 'Acme Internal SSO', name: 'acme' });
    const second = describeIconTile({ issuer: 'Acme Internal SSO', name: 'acme' });
    expect(first.kind).toBe('letter');
    expect(first).toEqual(second);
    if (first.kind === 'letter') {
      expect(first.letter).toBe('A');
    }
  });

  it('主色与 iconAccent 是同一个值（整行底色和图标底色不能各算各的）', () => {
    const entry = { issuer: 'Alipay', name: 'Alipay' };
    expect(describeIconTile(entry).accent).toBe(iconAccent(entry));
  });
});

describe('iconTileSvg', () => {
  it('是一段能被 <img> 加载的独立 SVG（带 xmlns 与尺寸）', () => {
    const tile = describeIconTile({ issuer: 'GitHub', name: 'GitHub' });
    const svg = iconTileSvg(tile, 162, FONT);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="162" height="162"')).toBe(
      true,
    );
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('品牌标志：白底 + 一层品牌色 + 同一个 transform 与标记', () => {
    const tile = describeIconTile({ issuer: 'GitHub', name: 'GitHub' });
    const svg = iconTileSvg(tile, 48, FONT);
    if (tile.kind !== 'brand') {
      throw new Error('GitHub 应该命中品牌图标');
    }
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain(`fill="${tile.accent}" fill-opacity="${tile.tintOpacity}"`);
    expect(svg).toContain(`transform="${tile.transform}"`);
    expect(svg).toContain(tile.markup);
    expect(svg).toContain(`viewBox="${tile.viewBox}"`);
  });

  it('首字母：给具体字体名，不写 inherit（独立文档里没有可继承的上下文）', () => {
    const tile = describeIconTile({ issuer: 'Acme Internal', name: 'acme' });
    const svg = iconTileSvg(tile, 48, FONT);
    expect(svg).toContain(`font-family="${FONT}"`);
    expect(svg).not.toContain('inherit');
    expect(svg).toContain('>A</text>');
  });

  it('首字母来自用户数据，进 SVG 前要转义', () => {
    // 名字的首个码位可能是 < 或 &，原样拼进 SVG 会拼出一段坏文档。
    const tile = describeIconTile({ issuer: '<script>', name: '<script>' });
    const svg = iconTileSvg(tile, 48, FONT);
    expect(svg).toContain('>&lt;</text>');
    expect(svg).not.toContain('><</text>');
  });
});
