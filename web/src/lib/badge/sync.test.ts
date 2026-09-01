// 推送流程的端到端测试：编码器与（照着固件规则实现的）假工卡对接。

import { describe, expect, it } from 'vitest';

import { FakeBadge } from './fakeBadge';
import { BADGE_MAX_ENTRIES } from './limits';
import type { BadgeEntry } from './protocol';
import {
  BadgeSyncError,
  pushEntries,
  pushTime,
  readStatus,
  setWifiCredentials,
  wipeBadge,
} from './sync';

const NOW = 1700000000;

function entry(label: string, overrides: Partial<BadgeEntry> = {}): BadgeEntry {
  return {
    label,
    issuer: 'me@example.com',
    secret: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    digits: 6,
    period: 30,
    algorithm: 0,
    ...overrides,
  };
}

describe('readStatus', () => {
  it('握手后读回工卡状态', async () => {
    const badge = new FakeBadge({ stored: 3, name: 'FoloPass-1A2B' });
    const status = await readStatus(badge);
    expect(status).toMatchObject({ stored: 3, capacity: BADGE_MAX_ENTRIES, name: 'FoloPass-1A2B' });
  });

  it('协议版本不一致时拒绝继续', async () => {
    const badge = new FakeBadge({ protocol: 99 });
    await expect(readStatus(badge)).rejects.toBeInstanceOf(BadgeSyncError);
  });

  it('工卡不回应时给出可操作的提示，而不是一直挂着', async () => {
    const badge = new FakeBadge({ silent: true });
    await expect(readStatus(badge, 20)).rejects.toThrow(/SYNC/);
  });
});

describe('pushEntries', () => {
  it('按列表顺序整批送达，并顺带对时', async () => {
    const badge = new FakeBadge();
    const result = await pushEntries(badge, [entry('GitHub'), entry('AWS')], {
      nowSec: () => NOW,
    });

    expect(result.count).toBe(2);
    expect(result.status.stored).toBe(2);
    expect(badge.received.map((item) => item.label)).toEqual(['GitHub', 'AWS']);
    expect(badge.timeSec).toBe(NOW);
  });

  it('原样保留密钥字节与参数', async () => {
    const badge = new FakeBadge();
    const secret = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12]);
    await pushEntries(badge, [entry('X', { secret, digits: 8, period: 60, algorithm: 2 })], {
      nowSec: () => NOW,
    });

    const [stored] = badge.received;
    expect(stored?.secret).toEqual(secret);
    expect(stored).toMatchObject({ digits: 8, period: 60, algorithm: 2 });
  });

  it('逐条汇报进度', async () => {
    const badge = new FakeBadge();
    const seen: string[] = [];
    await pushEntries(badge, [entry('A'), entry('B'), entry('C')], {
      nowSec: () => NOW,
      onProgress: (sent, total) => seen.push(`${String(sent)}/${String(total)}`),
    });
    expect(seen).toEqual(['1/3', '2/3', '3/3']);
  });

  it('传输中丢帧时报 CRC 错误，工卡上什么都没变', async () => {
    const badge = new FakeBadge({ stored: 5 });
    badge.dropEntryIndex = 1;

    await expect(
      pushEntries(badge, [entry('A'), entry('B'), entry('C')], { nowSec: () => NOW }),
    ).rejects.toThrow(/校验和|顺序/);
    expect(badge.received).toHaveLength(0);
  });

  it('超过工卡容量时本地就拦下，不去打扰设备', async () => {
    const badge = new FakeBadge();
    const many = Array.from({ length: BADGE_MAX_ENTRIES + 1 }, (_, index) =>
      entry(`S${String(index)}`),
    );
    await expect(pushEntries(badge, many, { nowSec: () => NOW })).rejects.toThrow(/最多/);
    expect(badge.received).toHaveLength(0);
  });

  it('推空列表等于把卡清成 0 条', async () => {
    const badge = new FakeBadge({ stored: 4 });
    const result = await pushEntries(badge, [], { nowSec: () => NOW });
    expect(result.count).toBe(0);
    expect(badge.received).toHaveLength(0);
  });

  it('工卡在写入阶段失联时报错', async () => {
    const badge = new FakeBadge({ silent: true });
    await expect(
      pushEntries(badge, [entry('A')], { nowSec: () => NOW, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(BadgeSyncError);
  });
});

describe('时区', () => {
  it('推送时把浏览器时区一并带上，工卡才能显示本地时间', async () => {
    const badge = new FakeBadge();
    await pushEntries(badge, [entry('A')], { nowSec: () => NOW, tzOffsetMin: 480 });
    expect(badge.tzOffsetMin).toBe(480);
  });

  it('只对时也带时区，且负偏移原样送达', async () => {
    const badge = new FakeBadge();
    await pushTime(badge, { nowSec: () => NOW, tzOffsetMin: -300 });
    expect(badge.tzOffsetMin).toBe(-300);
  });
});

describe('setWifiCredentials', () => {
  it('把凭据存进工卡，握手状态随之变成已配置', async () => {
    const badge = new FakeBadge();
    await setWifiCredentials(badge, 'my-ap', 'hunter2hunter2');
    expect(badge.wifiSsid).toBe('my-ap');
    expect(badge.wifiPassword).toBe('hunter2hunter2');
    await expect(readStatus(badge)).resolves.toMatchObject({ wifiConfigured: true });
  });

  it('空 SSID 等于关掉开机联网', async () => {
    const badge = new FakeBadge();
    await setWifiCredentials(badge, 'my-ap', 'pw');
    await setWifiCredentials(badge, '', '');
    expect(badge.wifiSsid).toBe('');
    await expect(readStatus(badge)).resolves.toMatchObject({ wifiConfigured: false });
  });

  it('工卡没回应时报错而不是假装成功', async () => {
    const badge = new FakeBadge({ silent: true });
    await expect(setWifiCredentials(badge, 'ap', 'pw', 20)).rejects.toBeInstanceOf(BadgeSyncError);
  });
});

describe('pushTime / wipeBadge', () => {
  it('只对时不动条目', async () => {
    const badge = new FakeBadge();
    await pushEntries(badge, [entry('A')], { nowSec: () => NOW });
    await pushTime(badge, { nowSec: () => NOW + 120 });
    expect(badge.timeSec).toBe(NOW + 120);
    expect(badge.received).toHaveLength(1);
  });

  it('清空后工卡上一条不剩', async () => {
    const badge = new FakeBadge();
    await pushEntries(badge, [entry('A')], { nowSec: () => NOW });
    await wipeBadge(badge);
    expect(badge.wiped).toBe(true);
    expect(badge.received).toHaveLength(0);
  });
});
