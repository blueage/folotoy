// 保险库条目 → 工卡条目的转换规则。工卡的限制比浏览器严，
// 这里的每一次拒绝都必须给出用户能照着改的理由。

import { describe, expect, it } from 'vitest';

import type { ServiceEntry } from '../twofas/types';
import {
  defaultBadgeAccount,
  defaultBadgeLabel,
  effectiveBadgeAccount,
  effectiveBadgeLabel,
  isBadgeEnabled,
  toBadgeEntry,
} from './entry';
import { BADGE_ISSUER_MAX, BADGE_LABEL_MAX, sanitizeBadgeText } from './limits';

function makeEntry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'id-1',
    name: 'GitHub',
    issuer: 'GitHub',
    account: 'me@example.com',
    // 16 个 Base32 字符 = 10 字节，正好是工卡接受的下限。
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    tokenType: 'TOTP',
    unsupportedReason: null,
    ...overrides,
  };
}

describe('toBadgeEntry', () => {
  it('把 Base32 密钥解成字节并带上参数', () => {
    const result = toBadgeEntry(makeEntry());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entry.secret).toHaveLength(10);
    expect(result.entry).toMatchObject({
      label: 'GitHub',
      issuer: 'me@example.com',
      digits: 6,
      period: 30,
      algorithm: 0,
    });
  });

  it('算法名映射到固件的编号', () => {
    const sha256 = toBadgeEntry(makeEntry({ algorithm: 'SHA256' }));
    const sha512 = toBadgeEntry(makeEntry({ algorithm: 'SHA512' }));
    expect(sha256.ok && sha256.entry.algorithm).toBe(1);
    expect(sha512.ok && sha512.entry.algorithm).toBe(2);
  });

  it('拒绝非 TOTP 与已标记不受支持的条目', () => {
    expect(toBadgeEntry(makeEntry({ tokenType: 'HOTP' })).ok).toBe(false);
    expect(toBadgeEntry(makeEntry({ unsupportedReason: '密钥无法解码' })).ok).toBe(false);
  });

  it('拒绝工卡放不下的密钥长度', () => {
    // 8 个字符 = 5 字节，短于工卡下限。
    const short = toBadgeEntry(makeEntry({ secret: 'JBSWY3DP' }));
    expect(short.ok).toBe(false);
    expect(short.ok ? '' : short.reason).toMatch(/太短/);

    // 72 个字符 = 45 字节，超过 40 字节上限。
    const long = toBadgeEntry(makeEntry({ secret: 'A'.repeat(72) }));
    expect(long.ok).toBe(false);
    expect(long.ok ? '' : long.reason).toMatch(/40/);
  });

  it('拒绝工卡不支持的周期', () => {
    const result = toBadgeEntry(makeEntry({ period: 5 }));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/周期/);
  });

  it('密钥不是合法 Base32 时把原因原样传出来', () => {
    const result = toBadgeEntry(makeEntry({ secret: '1234!!!!' }));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/Base32/);
  });

  it('全中文名字会被要求手填 ASCII 名字，而不是推一行豆腐块上卡', () => {
    const result = toBadgeEntry(makeEntry({ issuer: '支付宝', name: '支付宝' }));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/ASCII/);
  });

  it('用户填了工卡显示名就用它', () => {
    const result = toBadgeEntry(makeEntry({ issuer: '支付宝', name: '支付宝', badgeLabel: 'Alipay' }));
    expect(result.ok && result.entry.label).toBe('Alipay');
  });
});

describe('显示名', () => {
  it('缺省取发行方，没有发行方就取服务名', () => {
    expect(defaultBadgeLabel(makeEntry())).toBe('GitHub');
    expect(defaultBadgeLabel(makeEntry({ issuer: null, name: 'Backup Code' }))).toBe('Backup Code');
  });

  it('自定义名字为空白时退回自动推导，不留一个空行在卡上', () => {
    expect(effectiveBadgeLabel(makeEntry({ badgeLabel: '   ' }))).toBe('GitHub');
    expect(effectiveBadgeLabel(makeEntry({ badgeLabel: null }))).toBe('GitHub');
  });

  it('超长名字按工卡宽度截断', () => {
    const long = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    expect(effectiveBadgeLabel(makeEntry({ badgeLabel: long }))).toHaveLength(BADGE_LABEL_MAX);
  });
});

describe('副标题', () => {
  it('缺省就是账号本身', () => {
    expect(defaultBadgeAccount(makeEntry())).toBe('me@example.com');
    expect(defaultBadgeAccount(makeEntry({ account: null }))).toBe('');
  });

  it('用户填了就用用户的', () => {
    expect(effectiveBadgeAccount(makeEntry({ badgeAccount: 'work' }))).toBe('work');
    expect(toBadgeEntry(makeEntry({ badgeAccount: 'work' }))).toMatchObject({
      entry: { issuer: 'work' },
    });
  });

  it('空串是"不要副标题"，不是"回到账号"', () => {
    // 这一条是副标题与显示名最大的区别：账号常是一长串邮箱，用户清空它就是
    // 想让它消失；若按显示名那套规则把空串当成"自动推导"，它会立刻长回来。
    expect(effectiveBadgeAccount(makeEntry({ badgeAccount: '' }))).toBe('');
    expect(toBadgeEntry(makeEntry({ badgeAccount: '' }))).toMatchObject({
      entry: { issuer: '' },
    });
  });

  it('null 才是回到账号', () => {
    expect(effectiveBadgeAccount(makeEntry({ badgeAccount: null }))).toBe('me@example.com');
    expect(effectiveBadgeAccount(makeEntry())).toBe('me@example.com');
  });

  it('同样按工卡的字符集与宽度清洗', () => {
    expect(effectiveBadgeAccount(makeEntry({ badgeAccount: '微信 work' }))).toBe('work');
    expect(
      effectiveBadgeAccount(makeEntry({ badgeAccount: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' })),
    ).toHaveLength(BADGE_ISSUER_MAX);
  });
});

describe('sanitizeBadgeText', () => {
  it('丢掉工卡显示不了的字符并如实报告', () => {
    expect(sanitizeBadgeText('微信 Pay', 20)).toEqual({ text: 'Pay', dropped: true });
    expect(sanitizeBadgeText('GitHub', 20)).toEqual({ text: 'GitHub', dropped: false });
  });
});

describe('isBadgeEnabled', () => {
  it('没有这个字段的老记录默认参与推送', () => {
    expect(isBadgeEnabled(makeEntry())).toBe(true);
    expect(isBadgeEnabled(makeEntry({ badgeEnabled: false }))).toBe(false);
  });
});
