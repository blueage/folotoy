// 线格式的编码契约。这些断言是与固件 main/otp_wire.c 的接口约定：
// 任何一条改了，固件那边必须同步改，否则工卡会静默拒收。

import { describe, expect, it } from 'vitest';

import {
  AckCode,
  type BadgeEntry,
  DeviceFrameReader,
  DeviceFrameType,
  HostFrame,
  browserTzOffsetMin,
  buildPushFrames,
  crc32,
  describeAck,
  encodeCommit,
  encodeEntryPayload,
  encodeHello,
  encodeTime,
  encodeWifi,
  encodeWipe,
} from './protocol';
import { BADGE_PROTOCOL_VERSION } from './limits';

function entry(overrides: Partial<BadgeEntry> = {}): BadgeEntry {
  return {
    label: 'GitHub',
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

describe('帧头', () => {
  it('是 type + 小端 u16 长度', () => {
    const frame = encodeHello();
    expect([...frame]).toEqual([HostFrame.HELLO, 1, 0, BADGE_PROTOCOL_VERSION]);
  });

  it('COMMIT 带小端 CRC32', () => {
    const frame = encodeCommit(0xcbf43926);
    expect([...frame]).toEqual([HostFrame.COMMIT, 4, 0, 0x26, 0x39, 0xf4, 0xcb]);
  });

  it('WIPE 没有 payload', () => {
    expect([...encodeWipe()]).toEqual([HostFrame.WIPE, 0, 0]);
  });

  it('TIME 是小端 u64 秒', () => {
    const frame = encodeTime(1700000000, 480);
    expect(frame[0]).toBe(HostFrame.TIME);
    const view = new DataView(frame.buffer, 3);
    expect(Number(view.getBigUint64(0, true))).toBe(1700000000);
    expect(view.getInt16(8, true)).toBe(480);
  });
});

describe('CRC32', () => {
  it('与固件 otp_crc32 同一实现', () => {
    // 标准测试向量：CRC-32("123456789") = 0xCBF43926。
    const data = new TextEncoder().encode('123456789');
    expect(crc32(0, data)).toBe(0xcbf43926);
  });

  it('分段累计等于一次算完', () => {
    const data = new TextEncoder().encode('123456789');
    const split = crc32(crc32(0, data.slice(0, 4)), data.slice(4));
    expect(split).toBe(0xcbf43926);
  });
});

describe('ENTRY payload', () => {
  it('按 index/digits/period/alg/变长字段/accent/icon_crc 的次序排列', () => {
    const payload = encodeEntryPayload(2, entry({ label: 'AB', issuer: 'C', accent: 0x1234 }));
    expect([...payload]).toEqual([
      2, 0, // index
      6, 30, 0, // digits / period / algorithm
      10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, // secret
      2, 0x41, 0x42, // label "AB"
      1, 0x43, // issuer "C"
      0x34, 0x12, // accent（RGB565，小端）
      0, 0, 0, 0, // icon_crc：没有图标就是 0
    ]);
  });

  it('带图标时尾巴上是这张图的 CRC32', () => {
    const icon = Uint8Array.from([1, 2, 3, 4, 5]);
    const payload = encodeEntryPayload(0, entry({ icon }));
    const view = new DataView(payload.buffer, payload.byteOffset);
    expect(view.getUint32(payload.length - 4, true)).toBe(crc32(0, icon));
  });

  it('超出工卡上限时抛错，而不是悄悄截断', () => {
    expect(() => encodeEntryPayload(0, entry({ secret: new Uint8Array(41) }))).toThrow(RangeError);
    expect(() => encodeEntryPayload(0, entry({ label: 'x'.repeat(21) }))).toThrow(RangeError);
  });
});

describe('buildPushFrames', () => {
  it('CRC 覆盖全部 ENTRY payload，且下标从 0 递增', () => {
    const entries = [entry({ label: 'A' }), entry({ label: 'B' })];
    const frames = buildPushFrames(entries, 1700000000, 480);

    expect(frames.stream).toHaveLength(2);
    expect(frames.stream[0]?.[3]).toBe(0); // 第一条的 index 低字节
    expect(frames.stream[1]?.[3]).toBe(1);

    let expected = 0;
    entries.forEach((item, index) => {
      expected = crc32(expected, encodeEntryPayload(index, item));
    });
    const commitCrc = new DataView(
      frames.commit.buffer,
      frames.commit.byteOffset + 3,
    ).getUint32(0, true);
    expect(commitCrc).toBe(expected);
  });

  it('空列表也有 BEGIN 与 COMMIT —— 这是"把卡清成 0 条"的合法用法', () => {
    const frames = buildPushFrames([], 1700000000, -300);
    expect(frames.stream).toHaveLength(0);
    expect(frames.begin[0]).toBe(HostFrame.BEGIN);
    expect(frames.commit[0]).toBe(HostFrame.COMMIT);
  });
});


describe('时区', () => {
  it('BEGIN 带上有符号的时区偏移', () => {
    const east = buildPushFrames([], 1700000000, 480).begin;
    expect(new DataView(east.buffer, east.byteOffset + 3).getInt16(10, true)).toBe(480);

    // 西半球是负数：按无符号写会变成 65236 分钟，工卡的表盘会拨到 45 天后。
    const west = buildPushFrames([], 1700000000, -300).begin;
    expect(new DataView(west.buffer, west.byteOffset + 3).getInt16(10, true)).toBe(-300);
  });

  it('浏览器时区偏移的符号与直觉相反，要取反', () => {
    // getTimezoneOffset() 对 UTC+8 返回 -480。
    const fake = { getTimezoneOffset: () => -480 } as Date;
    expect(browserTzOffsetMin(fake)).toBe(480);
  });
});

describe('WIFI 帧', () => {
  it('按 ssid_len | ssid | pass_len | pass 排列', () => {
    const frame = encodeWifi('ap', 'pw');
    expect([...frame]).toEqual([HostFrame.WIFI, 6, 0, 2, 0x61, 0x70, 2, 0x70, 0x77]);
  });

  it('空 SSID 是合法的：那是"以后别再联网"', () => {
    expect([...encodeWifi('', '')]).toEqual([HostFrame.WIFI, 2, 0, 0, 0]);
  });

  it('超过 802.11 的长度上限时抛错', () => {
    expect(() => encodeWifi('x'.repeat(33), '')).toThrow(RangeError);
    expect(() => encodeWifi('ap', 'y'.repeat(65))).toThrow(RangeError);
  });
});

describe('DeviceFrameReader', () => {
  function statusFrame(name: string, wifi = true): Uint8Array {
    const nameBytes = new TextEncoder().encode(name);
    const payload = new Uint8Array(13 + nameBytes.length + (wifi ? 2 : 0));
    const view = new DataView(payload.buffer);
    payload[0] = BADGE_PROTOCOL_VERSION;
    payload[1] = 30;
    payload[2] = 4;
    payload[3] = 1;
    view.setBigUint64(4, BigInt(1700000000), true);
    payload[12] = nameBytes.length;
    payload.set(nameBytes, 13);
    if (wifi) {
      payload[13 + nameBytes.length] = 1;
      payload[14 + nameBytes.length] = 3;
    }

    const frame = new Uint8Array(3 + payload.length);
    frame[0] = DeviceFrameType.STATUS;
    frame[1] = payload.length;
    frame.set(payload, 3);
    return frame;
  }

  it('解出 STATUS 的各字段', () => {
    const [frame] = new DeviceFrameReader().push(statusFrame('FoloPass-1A2B'));
    expect(frame).toEqual({
      kind: 'status',
      protocol: BADGE_PROTOCOL_VERSION,
      capacity: 30,
      stored: 4,
      timeValid: true,
      lastSyncSec: 1700000000,
      name: 'FoloPass-1A2B',
      wifiConfigured: true,
      wifiState: 3,
    });
  });


  it('老固件的 STATUS 没有 Wi-Fi 字段时按未配置读，而不是解析失败', () => {
    const [frame] = new DeviceFrameReader().push(statusFrame('FoloPass-1A2B', false));
    expect(frame).toMatchObject({ kind: 'status', wifiConfigured: false, wifiState: 0 });
  });

  it('一帧被拆进多次通知时也能重组', () => {
    const reader = new DeviceFrameReader();
    const frame = statusFrame('FoloPass-1A2B');
    for (let i = 0; i < frame.length - 1; i += 1) {
      expect(reader.push(frame.slice(i, i + 1))).toHaveLength(0);
    }
    expect(reader.push(frame.slice(frame.length - 1))).toHaveLength(1);
  });

  it('一次通知里带两帧时全部解出', () => {
    const ack = new Uint8Array([DeviceFrameType.ACK, 6, 0, HostFrame.COMMIT, AckCode.OK, 3, 0, 3, 0]);
    const merged = new Uint8Array([...ack, ...statusFrame('X')]);
    const frames = new DeviceFrameReader().push(merged);
    expect(frames.map((item) => item.kind)).toEqual(['ack', 'status']);
    expect(frames[0]).toMatchObject({ refFrame: HostFrame.COMMIT, ack: AckCode.OK, received: 3 });
  });

  it('未知帧类型不会让流卡死', () => {
    const unknown = new Uint8Array([0xf0, 2, 0, 1, 2]);
    const frames = new DeviceFrameReader().push(new Uint8Array([...unknown, ...statusFrame('X')]));
    expect(frames.map((item) => item.kind)).toEqual(['unknown', 'status']);
  });
});

describe('describeAck', () => {
  it('已知错误码给出中文说明', () => {
    expect(describeAck(AckCode.ERR_CRC)).toContain('校验和');
  });

  it('未知错误码也要可读', () => {
    expect(describeAck(99)).toContain('99');
  });
});
