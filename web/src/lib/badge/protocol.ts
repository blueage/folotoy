// 网页 → 工卡的线格式编码与工卡 → 网页的通知解码。
// 与固件 main/otp_wire.c 一一对应：帧头是 type:u8 | len:u16 小端 | payload。
// 纯函数，不碰 DOM、Web Bluetooth 与存储层，因此可以整块单测。

import {
  BADGE_ISSUER_MAX,
  BADGE_LABEL_MAX,
  BADGE_PROTOCOL_VERSION,
  BADGE_SECRET_MAX_BYTES,
  BADGE_WIFI_PASS_MAX,
  BADGE_WIFI_SSID_MAX,
} from './limits';

/** 网页 → 工卡。 */
export const HostFrame = {
  HELLO: 0x01,
  BEGIN: 0x02,
  ENTRY: 0x03,
  COMMIT: 0x04,
  TIME: 0x05,
  WIPE: 0x06,
  WIFI: 0x07,
} as const;

/** 工卡 → 网页。 */
export const DeviceFrameType = {
  STATUS: 0x81,
  ACK: 0x82,
} as const;

/** 固件 otp_ack_t 的结果码。 */
export const AckCode = {
  OK: 0,
  ERR_VERSION: 1,
  ERR_SEQUENCE: 2,
  ERR_TOO_MANY: 3,
  ERR_FIELD: 4,
  ERR_CRC: 5,
  ERR_LENGTH: 6,
  ERR_UNKNOWN_FRAME: 7,
  ERR_NO_TIME: 8,
  ERR_STORAGE: 9,
} as const;

/** 固件 otp_wifi_state_t 的中文说明。 */
export const WIFI_STATE_LABELS: Record<number, string> = {
  0: '未配置（开机不联网）',
  1: '正在连接',
  2: '正在对时',
  3: '开机对时成功',
  4: '开机对时失败',
};

const ACK_MESSAGES: Record<number, string> = {
  [AckCode.OK]: '成功',
  [AckCode.ERR_VERSION]: '工卡固件的协议版本与本页面不一致，请更新其中一侧',
  [AckCode.ERR_SEQUENCE]: '帧顺序错乱，工卡已丢弃这批数据，请重试',
  [AckCode.ERR_TOO_MANY]: '条目数超过工卡容量，请减少要推送的条目',
  [AckCode.ERR_FIELD]: '有条目的字段超出工卡的限制（密钥长度、位数或非 ASCII 名字）',
  [AckCode.ERR_CRC]: '校验和不匹配，传输中出现丢失，请重试',
  [AckCode.ERR_LENGTH]: '帧长度非法，请重试',
  [AckCode.ERR_UNKNOWN_FRAME]: '工卡不认识这种帧，可能是固件版本过旧',
  [AckCode.ERR_NO_TIME]: '工卡没有可用时间，本次推送未写入',
  [AckCode.ERR_STORAGE]: '工卡写入存储失败，令牌未保存',
};

/** 把工卡回的结果码翻成中文。未知码也要给出可读文本，不能只丢一个数字。 */
export function describeAck(ack: number): string {
  return ACK_MESSAGES[ack] ?? `工卡返回未知错误码 ${String(ack)}`;
}

/** 一条已经过校验、可以直接上工卡的条目。 */
export interface BadgeEntry {
  label: string;
  issuer: string;
  /** 已 Base32 解码的原始密钥字节。 */
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: number;
}

const ASCII = new TextEncoder();

function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(3 + payload.length);
  frame[0] = type;
  frame[1] = payload.length & 0xff;
  frame[2] = (payload.length >> 8) & 0xff;
  frame.set(payload, 3);
  return frame;
}

function writeU64(view: DataView, offset: number, value: number): void {
  // 时间戳远小于 2^53，用 BigInt 只是为了拿到干净的小端 64 位写入。
  view.setBigUint64(offset, BigInt(Math.trunc(value)), true);
}

export function encodeHello(): Uint8Array {
  return encodeFrame(HostFrame.HELLO, new Uint8Array([BADGE_PROTOCOL_VERSION]));
}

export function encodeBegin(count: number, unixSeconds: number, tzOffsetMin: number): Uint8Array {
  const payload = new Uint8Array(12);
  const view = new DataView(payload.buffer);
  view.setUint16(0, count, true);
  writeU64(view, 2, unixSeconds);
  // 有符号：西半球的时区是负数，按无符号写工卡会把表盘拨到 45 天后。
  view.setInt16(10, tzOffsetMin, true);
  return encodeFrame(HostFrame.BEGIN, payload);
}

export function encodeTime(unixSeconds: number, tzOffsetMin: number): Uint8Array {
  const payload = new Uint8Array(10);
  const view = new DataView(payload.buffer);
  writeU64(view, 0, unixSeconds);
  view.setInt16(8, tzOffsetMin, true);
  return encodeFrame(HostFrame.TIME, payload);
}

/** 浏览器所在时区相对 UTC 的分钟偏移（东八区 = +480）。 */
export function browserTzOffsetMin(at: Date = new Date()): number {
  // getTimezoneOffset() 的符号与直觉相反：UTC+8 返回 -480。
  return -at.getTimezoneOffset();
}

/** Wi-Fi 凭据。ssid 传空串表示"以后不要再联网对时"。 */
export function encodeWifi(ssid: string, password: string): Uint8Array {
  const ssidBytes = ASCII.encode(ssid);
  const passBytes = ASCII.encode(password);
  if (ssidBytes.length > BADGE_WIFI_SSID_MAX) {
    throw new RangeError(`Wi-Fi 名称超过 ${String(BADGE_WIFI_SSID_MAX)} 字节`);
  }
  if (passBytes.length > BADGE_WIFI_PASS_MAX) {
    throw new RangeError(`Wi-Fi 密码超过 ${String(BADGE_WIFI_PASS_MAX)} 字节`);
  }
  const payload = new Uint8Array(2 + ssidBytes.length + passBytes.length);
  let w = 0;
  payload[w++] = ssidBytes.length;
  payload.set(ssidBytes, w);
  w += ssidBytes.length;
  payload[w++] = passBytes.length;
  payload.set(passBytes, w);
  return encodeFrame(HostFrame.WIFI, payload);
}

export function encodeWipe(): Uint8Array {
  return encodeFrame(HostFrame.WIPE, new Uint8Array(0));
}

export function encodeCommit(crc: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, crc >>> 0, true);
  return encodeFrame(HostFrame.COMMIT, payload);
}

/** ENTRY 的 payload（不含帧头）。COMMIT 的 CRC 正是对这些字节依次累计的。 */
export function encodeEntryPayload(index: number, entry: BadgeEntry): Uint8Array {
  const label = ASCII.encode(entry.label);
  const issuer = ASCII.encode(entry.issuer);
  if (entry.secret.length > BADGE_SECRET_MAX_BYTES) {
    throw new RangeError(`密钥过长：${String(entry.secret.length)} 字节`);
  }
  if (label.length > BADGE_LABEL_MAX || issuer.length > BADGE_ISSUER_MAX) {
    throw new RangeError('名字超过工卡的长度上限');
  }

  const payload = new Uint8Array(6 + entry.secret.length + 1 + label.length + 1 + issuer.length);
  let w = 0;
  payload[w++] = index & 0xff;
  payload[w++] = (index >> 8) & 0xff;
  payload[w++] = entry.digits;
  payload[w++] = entry.period;
  payload[w++] = entry.algorithm;
  payload[w++] = entry.secret.length;
  payload.set(entry.secret, w);
  w += entry.secret.length;
  payload[w++] = label.length;
  payload.set(label, w);
  w += label.length;
  payload[w++] = issuer.length;
  payload.set(issuer, w);
  return payload;
}

/** CRC-32/IEEE，与固件 otp_crc32() 同一实现（反射多项式 0xEDB88320）。 */
export function crc32(seed: number, data: Uint8Array): number {
  let crc = ~seed >>> 0;
  for (const byte of data) {
    crc = (crc ^ byte) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1) >>> 0;
      crc = ((crc >>> 1) ^ (0xedb88320 & mask)) >>> 0;
    }
  }
  return ~crc >>> 0;
}

/** 一次完整推送的三段帧。数组顺序即工卡上的显示顺序。 */
export interface PushFrames {
  begin: Uint8Array;
  entries: Uint8Array[];
  commit: Uint8Array;
}

/** 拼出一次完整推送：BEGIN → ENTRY × n → COMMIT（CRC 覆盖全部 ENTRY payload）。 */
export function buildPushFrames(
  entries: BadgeEntry[],
  unixSeconds: number,
  tzOffsetMin: number,
): PushFrames {
  let crc = 0;
  const frames = entries.map((entry, index) => {
    const payload = encodeEntryPayload(index, entry);
    crc = crc32(crc, payload);
    return encodeFrame(HostFrame.ENTRY, payload);
  });
  return {
    begin: encodeBegin(entries.length, unixSeconds, tzOffsetMin),
    entries: frames,
    commit: encodeCommit(crc),
  };
}

/** 工卡回给网页的一帧。 */
export type DeviceFrame =
  | {
      kind: 'status';
      protocol: number;
      capacity: number;
      stored: number;
      timeValid: boolean;
      lastSyncSec: number;
      name: string;
      /** 工卡上是否存了 Wi-Fi 凭据。 */
      wifiConfigured: boolean;
      /** 固件 otp_wifi_state_t：0 未配置 1 连接中 2 对时中 3 成功 4 失败。 */
      wifiState: number;
    }
  | { kind: 'ack'; refFrame: number; ack: number; received: number; expected: number }
  | { kind: 'unknown'; frameType: number; payload: Uint8Array };

/**
 * 通知的重组器。单条通知理论上装得下整帧，但 GATT 不保证这一点，
 * 因此这里同样按字节流处理。
 */
export class DeviceFrameReader {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): DeviceFrame[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);

    const frames: DeviceFrame[] = [];
    let offset = 0;
    for (;;) {
      if (merged.length - offset < 3) {
        break;
      }
      const length = (merged[offset + 1] ?? 0) | ((merged[offset + 2] ?? 0) << 8);
      if (merged.length - offset - 3 < length) {
        break;
      }
      const type = merged[offset] ?? 0;
      const payload = merged.subarray(offset + 3, offset + 3 + length);
      frames.push(decodeDeviceFrame(type, payload));
      offset += 3 + length;
    }
    this.#buffer = merged.slice(offset);
    return frames;
  }
}

function decodeDeviceFrame(type: number, payload: Uint8Array): DeviceFrame {
  // 一律走 DataView：下标读出来的是 number | undefined，逐处判空只会
  // 把解析逻辑淹没在 ?? 0 里。
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  if (type === DeviceFrameType.ACK && payload.length >= 6) {
    return {
      kind: 'ack',
      refFrame: view.getUint8(0),
      ack: view.getUint8(1),
      received: view.getUint16(2, true),
      expected: view.getUint16(4, true),
    };
  }

  if (type === DeviceFrameType.STATUS && payload.length >= 13) {
    const nameLength = view.getUint8(12);
    const name = new TextDecoder().decode(payload.subarray(13, 13 + nameLength));
    // Wi-Fi 两个字段追加在变长的名字之后，可能缺席（老固件），按缺省值读。
    const wifiOffset = 13 + nameLength;
    const hasWifi = payload.length >= wifiOffset + 2;
    return {
      kind: 'status',
      protocol: view.getUint8(0),
      capacity: view.getUint8(1),
      stored: view.getUint8(2),
      timeValid: view.getUint8(3) === 1,
      lastSyncSec: Number(view.getBigUint64(4, true)),
      name,
      wifiConfigured: hasWifi && view.getUint8(wifiOffset) === 1,
      wifiState: hasWifi ? view.getUint8(wifiOffset + 1) : 0,
    };
  }

  return { kind: 'unknown', frameType: type, payload: new Uint8Array(payload) };
}
