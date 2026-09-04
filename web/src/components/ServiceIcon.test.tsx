import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ServiceEntry } from '../lib/twofas/types';
import { LOGO_PADDING_PX, TILE_PX } from '../lib/icons/tile';
import ServiceIcon from './ServiceIcon';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function entry(overrides: Partial<ServiceEntry> & { id: string }): ServiceEntry {
  return {
    name: overrides.id,
    issuer: null,
    account: null,
    secret: RFC_SECRET,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    tokenType: 'TOTP',
    unsupportedReason: null,
    ...overrides,
  };
}

describe('ServiceIcon', () => {
  it('认识的发行方渲染品牌标志', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'GitHub', name: 'GitHub' })} />);
    const icon = screen.getByTestId('service-icon');
    expect(icon.dataset.iconKind).toBe('brand');
    expect(icon.dataset.iconTitle).toBe('GitHub');
  });

  it('发行方为空时退回用服务名找图标', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: null, name: 'Bitwarden' })} />);
    expect(screen.getByTestId('service-icon').dataset.iconTitle).toBe('Bitwarden');
  });

  it('不认识的发行方渲染首字母色块', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Acme Internal SSO', name: 'acme' })} />);
    const icon = screen.getByTestId('service-icon');
    expect(icon.dataset.iconKind).toBe('letter');
    expect(icon.dataset.iconLetter).toBe('A');
  });

  it('同一发行方两次渲染颜色一致', () => {
    const { unmount } = render(<ServiceIcon entry={entry({ id: '1', issuer: 'Acme Corp' })} />);
    const first = screen.getByTestId('service-icon').querySelector('rect')?.getAttribute('fill');
    unmount();
    render(<ServiceIcon entry={entry({ id: '2', issuer: 'Acme Corp' })} />);
    const second = screen.getByTestId('service-icon').querySelector('rect')?.getAttribute('fill');
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('颜色走 fill 属性而不是行内 style（CSP 不允许行内样式）', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'GitHub' })} />);
    const path = screen.getByTestId('service-icon').querySelector('path');
    expect(path?.getAttribute('fill')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(path?.getAttribute('style')).toBeNull();
  });

  it('图标带无障碍名称', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Steam' })} />);
    expect(screen.getByRole('img', { name: 'Steam' })).toBeInTheDocument();
  });

  it('decorative 时不暴露给读屏（外层已有名称）', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Steam' })} decorative />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTestId('service-icon').querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('底色是白底加一层淡品牌色，而不是品牌色实底', () => {
    // 关键：彩色 logo 常常就是品牌主色画的（Alipay 的 logo 是 #1677FF），
    // 铺同色实底会让它直接消失。
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Alipay' })} />);
    const rects = screen.getByTestId('service-icon').querySelectorAll('rect');

    expect(rects[0]?.getAttribute('fill')).toBe('#ffffff');
    expect(rects[1]?.getAttribute('fill')?.toLowerCase()).toBe('#1677ff');
    // 品牌色只是薄薄一层，压不过 logo 自身的颜色。
    expect(Number(rects[1]?.getAttribute('fill-opacity'))).toBeLessThan(0.3);
  });

  it('渲染上游的彩色标记，保留其原本配色', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Alipay' })} />);
    const icon = screen.getByTestId('service-icon');

    // logo 用品牌自己的颜色，不再被改写成白/黑反差色。
    const paths = [...icon.querySelectorAll('path')];
    expect(paths.length).toBeGreaterThan(0);
    const fills = paths.map((p) => p.getAttribute('fill')).filter(Boolean);
    const inheritedFill = icon.querySelector('g[fill]')?.getAttribute('fill');
    expect([...fills, inheritedFill].some((f) => f?.toLowerCase() === '#1677ff')).toBe(true);
  });

  it('反白 logo 改用品牌色实底，不会消失在白底上', () => {
    // Dun & Bradstreet 官方只提供白版 logo，白底上等于看不见。
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'sso.dnb.com' })} />);
    const rects = screen.getByTestId('service-icon').querySelectorAll('rect');

    expect(screen.getByTestId('service-icon').dataset.iconTitle).toBe('Dun & Bradstreet');
    // 品牌色铺满不透明，而不是 14% 的淡叠加。
    expect(rects[1]?.getAttribute('fill-opacity')).toBe('1');
  });

  it('非方形 logo 的底色铺满整块，不留信箱空白', () => {
    // M-Team 是 2096×720 的宽幅字标；生成脚本已把 viewBox 居中扩成正方形，
    // 底色矩形必须从（可能为负的）原点起画，否则上下会露出没铺到的部分。
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'm-team' })} />);
    const icon = screen.getByTestId('service-icon');
    const [minX, minY, width, height] = (
      icon.querySelector('svg')?.getAttribute('viewBox') ?? ''
    ).split(/\s+/);

    expect(Number(width)).toBe(Number(height));
    const rect = icon.querySelector('rect');
    expect(rect?.getAttribute('x')).toBe(String(Number(minX)));
    expect(rect?.getAttribute('y')).toBe(String(Number(minY)));
    expect(rect?.getAttribute('width')).toBe(String(Number(width)));
  });

  it('底色矩形按该图标自己的 viewBox 铺满画布', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'GitHub' })} />);
    const icon = screen.getByTestId('service-icon');
    const svg = icon.querySelector('svg');

    // 上游各家的 viewBox 尺度不同（24、1024、2447.6…），底色必须按该图标
    // 自己的 viewBox 铺满，不能套用 24 这个数字，否则大尺度的图标底色只占一角。
    const [, , vbWidth, vbHeight] = (svg?.getAttribute('viewBox') ?? '').split(/\s+/);
    const rect = icon.querySelector('rect');
    expect(rect?.getAttribute('width')).toBe(vbWidth);
    expect(rect?.getAttribute('height')).toBe(vbHeight);
  });

  it('logo 四周留白，不贴着色块边缘', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'GitHub' })} />);
    const icon = screen.getByTestId('service-icon');
    const [vbMinX, , vbWidth] = (icon.querySelector('svg')?.getAttribute('viewBox') ?? '').split(
      /\s+/,
    );

    const transform = icon.querySelector('g[transform]')?.getAttribute('transform') ?? '';
    const scale = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1]);
    const offset = Number(/translate\((-?[\d.]+)/.exec(transform)?.[1]);

    // 缩得比色块小 → 四周有留白（贴边会显得局促）。
    expect(scale).toBeGreaterThan(0.5);
    expect(scale).toBeLessThan(1);

    // 留白在两侧对称：左边距 == 右边距。
    // transform 里的数字做了舍入（translate 2 位、scale 4 位），因此两侧会差
    // 千分之几个 viewBox 单位——在 1024 这种尺度下小于千分之一像素，可以忽略。
    const width = Number(vbWidth);
    const minX = Number(vbMinX);
    const leftGap = offset + minX * scale - minX;
    const rightGap = minX + width - (offset + (minX + width) * scale);
    expect(Math.abs(leftGap - rightGap) / width).toBeLessThan(0.001);
    expect(leftGap).toBeGreaterThan(0);
  });

  it('留白换算回像素正好是设定的值', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'GitHub' })} />);
    const transform =
      screen.getByTestId('service-icon').querySelector('g[transform]')?.getAttribute('transform') ??
      '';
    const scale = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1]);

    // 断言的是意图（四周留白多少像素），而不是抄一遍那个比例常数——
    // 后者只会在色块尺寸变化时跟着一起改，测不出任何东西。
    const paddingPx = (TILE_PX * (1 - scale)) / 2;
    expect(paddingPx).toBeCloseTo(LOGO_PADDING_PX, 1);
  });

  it('首字母与 logo 用同一比例，视觉重量一致', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Acme Internal' })} />);
    const text = screen.getByTestId('service-icon').querySelector('text');
    const fontSize = Number(text?.getAttribute('font-size'));

    expect(text?.textContent).toBe('A');
    // 字母铺满色块的大部分，而不是缩在中间的一小团。
    expect(fontSize).toBeGreaterThan(24 * 0.7);
    // 但不能大到让 W、M 这类宽字母横向溢出被裁（宽度可达 0.9em）。
    expect(fontSize).toBeLessThanOrEqual(24);
  });

  it('最宽的字母也完整落在色块内', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'Wacme' })} />);
    const fontSize = Number(
      screen.getByTestId('service-icon').querySelector('text')?.getAttribute('font-size'),
    );

    // W 的字宽约 0.9em，居中后左右各占 0.45em，不能超出 24 画布的一半。
    expect((fontSize * 0.9) / 2).toBeLessThanOrEqual(12);
  });

  it('尺寸由调用方给，组件自身不写死', () => {
    render(<ServiceIcon entry={entry({ id: '1', issuer: 'GitHub' })} className="h-16 w-16" />);
    const icon = screen.getByTestId('service-icon');

    expect(icon.className).toContain('h-16');
    // 内部 svg 铺满外框，不自带尺寸。
    expect(icon.querySelector('svg')?.getAttribute('class')).toContain('h-full');
  });
});
