// 推送流程的端到端测试：编码器与（照着固件规则实现的）假工卡对接。

import { describe, expect, it } from 'vitest';

import { FakeBadge, decodeIconBlob } from './fakeBadge';
import { buildIconBlob } from './icon';
import { BADGE_ICON_H, BADGE_ICON_W, BADGE_MAX_ENTRIES } from './limits';
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
    accent: 0,
    icon: null,
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

  it('写入完成后补一帧新鲜时间，抵消整批传输的耗时', async () => {
    const badge = new FakeBadge();
    // 模拟"传输花了 10 秒"：第一次取时间用于 BEGIN，第二次是写完之后。
    let call = 0;
    const nowSec = () => NOW + call++ * 10;

    await pushEntries(badge, [entry('A')], { nowSec });

    // 工卡上最终的时间必须是**写完之后**那次，而不是开始传输时的那次；
    // 否则条目越多、工卡的表越慢。
    expect(badge.timeSec).toBe(NOW + 10);
  });

  it('补时间失败不影响推送本身的成败', async () => {
    const badge = new FakeBadge();
    // 条目写进去之后就不再回帧，补时间那一步会超时。
    const original = badge.send.bind(badge);
    let committed = false;
    badge.send = (chunk: Uint8Array) => {
      if (committed) {
        return Promise.resolve();
      }
      const result = original(chunk);
      if (badge.received.length > 0) {
        committed = true;
      }
      return result;
    };

    const result = await pushEntries(badge, [entry('A')], { nowSec: () => NOW, timeoutMs: 30 });
    expect(result.count).toBe(1);
    expect(badge.received).toHaveLength(1);
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

describe('图标', () => {
  /** 造一张 48×48 的测试图：左半白、右半品牌色，右下角透明。 */
  function icon(): Uint8Array {
    const pixels = BADGE_ICON_W * BADGE_ICON_H;
    const data = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < pixels; i += 1) {
      const x = i % BADGE_ICON_W;
      const y = Math.floor(i / BADGE_ICON_W);
      const transparent = x + y > BADGE_ICON_W + 12;
      data[i * 4] = x < BADGE_ICON_W / 2 ? 255 : 0x16;
      data[i * 4 + 1] = x < BADGE_ICON_W / 2 ? 255 : 0x77;
      data[i * 4 + 2] = x < BADGE_ICON_W / 2 ? 255 : 0xff;
      data[i * 4 + 3] = transparent ? 0 : 255;
    }
    return buildIconBlob({ data, width: BADGE_ICON_W, height: BADGE_ICON_H });
  }

  it('图标随条目一起送达，字节一个不差', async () => {
    const badge = new FakeBadge();
    const bytes = icon();
    await pushEntries(badge, [entry('GitHub', { icon: bytes, accent: 0x1234 })], {
      nowSec: () => NOW,
    });

    expect([...(badge.icons.get(0) ?? [])]).toEqual([...bytes]);
    expect(badge.received[0]?.accent).toBe(0x1234);
    // 设备侧照着协议文档解一遍：像素数正好铺满一屏图标。
    expect(decodeIconBlob(badge.icons.get(0) as Uint8Array)).toHaveLength(
      BADGE_ICON_W * BADGE_ICON_H,
    );
  });

  it('一张图要拆成很多帧，进度也按帧走', async () => {
    const badge = new FakeBadge();
    const seen: number[] = [];
    await pushEntries(badge, [entry('A', { icon: icon() })], {
      nowSec: () => NOW,
      onProgress: (sent) => seen.push(sent),
    });
    // 一条 ENTRY + 若干 ICON 分片：帧数远多于条数，否则说明图标压根没发出去。
    expect(seen.length).toBeGreaterThan(2);
  });

  it('没有图标的条目照常推送，只是卡上少一块图', async () => {
    const badge = new FakeBadge();
    await pushEntries(badge, [entry('A'), entry('B', { icon: icon() })], { nowSec: () => NOW });
    expect(badge.icons.has(0)).toBe(false);
    expect(badge.icons.has(1)).toBe(true);
  });

  it('图标分片丢了同样过不了 COMMIT 的校验', async () => {
    // CRC 必须覆盖 ICON payload：否则丢了图标的一批数据会"成功"写进去，
    // 屏幕上表现为一张莫名其妙的图，比整批拒收难查得多。
    const badge = new FakeBadge();
    badge.dropIconIndex = 0;
    await expect(
      pushEntries(badge, [entry('A', { icon: icon() })], { nowSec: () => NOW }),
    ).rejects.toThrow(/校验和/);
    expect(badge.received).toHaveLength(0);
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
