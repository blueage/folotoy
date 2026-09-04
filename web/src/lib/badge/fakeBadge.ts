// 测试用的假工卡：按固件 main/otp_wire.c 的规则解析帧并回帧。
//
// 它刻意把校验逻辑再实现一遍（而不是复用编码器的中间结果）：这样一来，
// 编码端与解码端的任何不对称——字段顺序、端序、CRC 覆盖范围——都会在
// 测试里暴露出来，而不是等到真机上表现为"工卡一直拒收"。

import {
  AckCode,
  type BadgeEntry,
  type DeviceFrame,
  HostFrame,
  crc32,
} from './protocol';
import {
  BADGE_ICON_BLOB_MAX,
  BADGE_ICON_BLOB_VERSION,
  BADGE_ICON_H,
  BADGE_ICON_PALETTE_MAX,
  BADGE_ICON_W,
  BADGE_MAX_ENTRIES,
  BADGE_PROTOCOL_VERSION,
} from './limits';
import type { BadgeLink } from './sync';

export interface FakeBadgeOptions {
  /** 广播名。 */
  name?: string;
  /** 卡上已有的条目数（握手时回报）。 */
  stored?: number;
  /** 谎报协议版本，用来测版本不匹配。 */
  protocol?: number;
  /** 收到帧后不回任何东西，用来测超时。 */
  silent?: boolean;
}

export class FakeBadge implements BadgeLink {
  readonly received: ReceivedEntry[] = [];
  /** COMMIT 之后落在"卡上"的图标，键是条目下标。 */
  readonly icons = new Map<number, Uint8Array>();
  timeSec = 0;
  tzOffsetMin = 0;
  wifiSsid: string | null = null;
  wifiPassword: string | null = null;
  storedCount: number;
  wiped = false;
  /** 丢掉第 n 个 ENTRY 帧，用来制造 CRC 不匹配。 */
  dropEntryIndex: number | null = null;
  /** 丢掉第 n 条的全部 ICON 帧，用来验证 CRC 也覆盖图标。 */
  dropIconIndex: number | null = null;

  readonly #listeners = new Set<(frame: DeviceFrame) => void>();
  readonly #options: Required<Omit<FakeBadgeOptions, 'stored'>>;
  #buffer = new Uint8Array(0);
  #expected = 0;
  #staging: ReceivedEntry[] = [];
  #stagingIcons = new Map<number, Uint8Array>();
  #crc = 0;
  #entrySeen = 0;
  // 正在装配的那张图。工卡一次只装一张（图标必须紧跟自己那条 ENTRY）。
  #icon: { index: number; total: number; bytes: Uint8Array; filled: number } | null = null;

  constructor(options: FakeBadgeOptions = {}) {
    this.#options = {
      name: options.name ?? 'FoloPass-TEST',
      protocol: options.protocol ?? BADGE_PROTOCOL_VERSION,
      silent: options.silent ?? false,
    };
    this.storedCount = options.stored ?? 0;
  }

  subscribe(listener: (frame: DeviceFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(chunk: Uint8Array): Promise<void> {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;
    this.#drain();
    return Promise.resolve();
  }

  #emit(frame: DeviceFrame): void {
    if (this.#options.silent) {
      return;
    }
    for (const listener of [...this.#listeners]) {
      listener(frame);
    }
  }

  #ack(refFrame: number, ack: number, received = 0, expected = 0): void {
    this.#emit({ kind: 'ack', refFrame, ack, received, expected });
  }

  #status(): void {
    this.#emit({
      kind: 'status',
      protocol: this.#options.protocol,
      capacity: BADGE_MAX_ENTRIES,
      stored: this.storedCount,
      timeValid: this.timeSec > 0,
      lastSyncSec: this.timeSec,
      name: this.#options.name,
      wifiConfigured: this.wifiSsid !== null && this.wifiSsid.length > 0,
      wifiState: this.wifiSsid !== null && this.wifiSsid.length > 0 ? 3 : 0,
    });
  }

  #drain(): void {
    for (;;) {
      if (this.#buffer.length < 3) {
        return;
      }
      const length = this.#buffer[1]! | (this.#buffer[2]! << 8);
      if (this.#buffer.length - 3 < length) {
        return;
      }
      const type = this.#buffer[0]!;
      const payload = this.#buffer.slice(3, 3 + length);
      this.#buffer = this.#buffer.slice(3 + length);
      this.#handle(type, payload);
    }
  }

  #handle(type: number, payload: Uint8Array): void {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    switch (type) {
      case HostFrame.HELLO:
        if (payload[0] !== BADGE_PROTOCOL_VERSION) {
          this.#ack(type, AckCode.ERR_VERSION);
          return;
        }
        this.#status();
        return;

      case HostFrame.BEGIN: {
        const count = view.getUint16(0, true);
        if (count > BADGE_MAX_ENTRIES) {
          this.#ack(type, AckCode.ERR_TOO_MANY);
          return;
        }
        this.#expected = count;
        this.#staging = [];
        this.#stagingIcons = new Map();
        this.#icon = null;
        this.#crc = 0;
        this.#entrySeen = 0;
        this.timeSec = Number(view.getBigUint64(2, true));
        this.tzOffsetMin = view.getInt16(10, true);
        this.#ack(type, AckCode.OK, 0, count);
        return;
      }

      case HostFrame.ENTRY: {
        const index = view.getUint16(0, true);
        if (index !== this.#entrySeen) {
          this.#ack(type, AckCode.ERR_SEQUENCE, this.#staging.length, this.#expected);
          return;
        }
        this.#entrySeen += 1;
        if (this.dropEntryIndex === index) {
          // 模拟丢帧：不累计 CRC、不收条目，但也不报错——正是 COMMIT 该兜住的情况。
          return;
        }
        this.#crc = crc32(this.#crc, payload);
        this.#staging.push(decodeEntry(payload));
        return;
      }

      case HostFrame.ICON: {
        // index:u16 | offset:u16 | total:u16 | data[]
        const index = view.getUint16(0, true);
        const offset = view.getUint16(2, true);
        const total = view.getUint16(4, true);
        const chunk = payload.subarray(6);

        if (this.dropIconIndex === index) {
          // 模拟丢帧：不累计 CRC、不收图标，也不报错——正是 COMMIT 该兜住的情况。
          return;
        }

        // 图标只能跟在它自己那条 ENTRY 后面。
        if (this.#expected === 0 || index >= this.#entrySeen) {
          this.#ack(type, AckCode.ERR_SEQUENCE, this.#staging.length, this.#expected);
          return;
        }
        if (total === 0 || total > BADGE_ICON_BLOB_MAX) {
          this.#ack(type, AckCode.ERR_FIELD, this.#staging.length, this.#expected);
          return;
        }
        if (offset === 0) {
          this.#icon = { index, total, bytes: new Uint8Array(total), filled: 0 };
        } else if (
          this.#icon === null ||
          this.#icon.index !== index ||
          this.#icon.total !== total ||
          this.#icon.filled !== offset
        ) {
          this.#ack(type, AckCode.ERR_SEQUENCE, this.#staging.length, this.#expected);
          return;
        }
        const assembling = this.#icon;
        if (offset + chunk.length > total) {
          this.#ack(type, AckCode.ERR_LENGTH, this.#staging.length, this.#expected);
          return;
        }
        assembling.bytes.set(chunk, offset);
        assembling.filled = offset + chunk.length;
        this.#crc = crc32(this.#crc, payload);
        if (assembling.filled < total) {
          return;
        }
        this.#icon = null;

        if (decodeIconBlob(assembling.bytes) === null) {
          this.#ack(type, AckCode.ERR_FIELD, this.#staging.length, this.#expected);
          return;
        }
        // 位图必须正是这一条 ENTRY 声明的那张，否则整批拒收：
        // 图和条目对不上，在屏幕上表现为"别人家的 logo"，比拒收难查得多。
        if (crc32(0, assembling.bytes) !== (this.#staging[index]?.iconCrc ?? 0)) {
          this.#ack(type, AckCode.ERR_CRC, this.#staging.length, this.#expected);
          return;
        }
        this.#stagingIcons.set(index, assembling.bytes);
        return;
      }

      case HostFrame.COMMIT: {
        if (this.#staging.length !== this.#expected) {
          this.#ack(type, AckCode.ERR_SEQUENCE, this.#staging.length, this.#expected);
          return;
        }
        if (view.getUint32(0, true) !== this.#crc) {
          this.#ack(type, AckCode.ERR_CRC, this.#staging.length, this.#expected);
          return;
        }
        this.received.length = 0;
        this.received.push(...this.#staging);
        this.icons.clear();
        for (const [index, bytes] of this.#stagingIcons) {
          this.icons.set(index, bytes);
        }
        this.storedCount = this.#staging.length;
        this.#ack(type, AckCode.OK, this.#staging.length, this.#expected);
        this.#status();
        return;
      }

      case HostFrame.TIME:
        this.timeSec = Number(view.getBigUint64(0, true));
        this.tzOffsetMin = view.getInt16(8, true);
        this.#ack(type, AckCode.OK);
        return;

      case HostFrame.WIFI: {
        const ssidLength = view.getUint8(0);
        const ssid = new TextDecoder().decode(payload.subarray(1, 1 + ssidLength));
        const passLength = view.getUint8(1 + ssidLength);
        const password = new TextDecoder().decode(
          payload.subarray(2 + ssidLength, 2 + ssidLength + passLength),
        );
        this.wifiSsid = ssid;
        this.wifiPassword = password;
        this.#ack(type, AckCode.OK);
        this.#status();
        return;
      }

      case HostFrame.WIPE:
        this.wiped = true;
        this.received.length = 0;
        this.storedCount = 0;
        this.#ack(type, AckCode.OK);
        this.#status();
        return;

      default:
        this.#ack(type, AckCode.ERR_UNKNOWN_FRAME);
        return;
    }
  }
}

/** 解码出来的条目再带上工卡那边看到的 icon_crc，供 ICON 帧认亲。 */
interface ReceivedEntry extends BadgeEntry {
  iconCrc: number;
}

function decodeEntry(payload: Uint8Array): ReceivedEntry {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let cursor = 2;
  const digits = view.getUint8(cursor++);
  const period = view.getUint8(cursor++);
  const algorithm = view.getUint8(cursor++);
  const secretLength = view.getUint8(cursor++);
  const secret = payload.slice(cursor, cursor + secretLength);
  cursor += secretLength;
  const labelLength = view.getUint8(cursor++);
  const label = new TextDecoder().decode(payload.subarray(cursor, cursor + labelLength));
  cursor += labelLength;
  const issuerLength = view.getUint8(cursor++);
  const issuer = new TextDecoder().decode(payload.subarray(cursor, cursor + issuerLength));
  cursor += issuerLength;
  const accent = view.getUint16(cursor, true);
  cursor += 2;
  const iconCrc = view.getUint32(cursor, true);
  return { label, issuer, secret, digits, period, algorithm, accent, icon: null, iconCrc };
}

/**
 * 按 docs/protocol.zh_CN.md 重新实现一遍位图解码：头、调色板、行程流。
 *
 * 这里刻意不复用 lib/badge/icon.ts 的任何中间结果——编码器与解码器
 * 对"高半字节在前""计数从 1 起"这类约定的理解一旦分家，就该在测试里炸出来，
 * 而不是等到真机上表现成一张糊掉的图。
 *
 * @returns 每像素一个调色板下标；结构不合法返回 null。
 */
export function decodeIconBlob(blob: Uint8Array): Uint8Array | null {
  if (blob.length < 4 || blob[0] !== BADGE_ICON_BLOB_VERSION) {
    return null;
  }
  if (blob[1] !== BADGE_ICON_W || blob[2] !== BADGE_ICON_H) {
    return null;
  }
  const paletteLength = blob[3] ?? 0;
  if (paletteLength === 0 || paletteLength > BADGE_ICON_PALETTE_MAX) {
    return null;
  }
  let cursor = 4 + paletteLength * 3;
  if (blob.length < cursor) {
    return null;
  }

  const pixels = BADGE_ICON_W * BADGE_ICON_H;
  const indices = new Uint8Array(pixels);
  let written = 0;
  while (cursor < blob.length) {
    const count = blob[cursor++] as number;
    if (cursor >= blob.length) {
      return null;
    }
    if (count !== 0) {
      const index = blob[cursor++] as number;
      if (index >= paletteLength || written + count > pixels) {
        return null;
      }
      indices.fill(index, written, written + count);
      written += count;
      continue;
    }
    const literal = blob[cursor++] as number;
    if (literal === 0) {
      return null;
    }
    const packed = Math.ceil(literal / 2);
    if (cursor + packed > blob.length || written + literal > pixels) {
      return null;
    }
    for (let i = 0; i < literal; i += 1) {
      const byte = blob[cursor + (i >> 1)] as number;
      const index = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      if (index >= paletteLength) {
        return null;
      }
      indices[written + i] = index;
    }
    cursor += packed;
    written += literal;
  }
  return written === pixels ? indices : null;
}

/** 把假工卡包成 ConnectedBadge 的形状，供 BadgePanel 的测试使用。 */
export function fakeConnection(badge: FakeBadge, name = 'FoloPass-TEST') {
  return {
    link: badge,
    name,
    disconnect: () => undefined,
    onDisconnected: () => () => undefined,
  };
}
