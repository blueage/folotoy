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
import { BADGE_MAX_ENTRIES, BADGE_PROTOCOL_VERSION } from './limits';
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
  readonly received: BadgeEntry[] = [];
  timeSec = 0;
  tzOffsetMin = 0;
  wifiSsid: string | null = null;
  wifiPassword: string | null = null;
  storedCount: number;
  wiped = false;
  /** 丢掉第 n 个 ENTRY 帧，用来制造 CRC 不匹配。 */
  dropEntryIndex: number | null = null;

  readonly #listeners = new Set<(frame: DeviceFrame) => void>();
  readonly #options: Required<Omit<FakeBadgeOptions, 'stored'>>;
  #buffer = new Uint8Array(0);
  #expected = 0;
  #staging: BadgeEntry[] = [];
  #crc = 0;
  #entrySeen = 0;

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

function decodeEntry(payload: Uint8Array): BadgeEntry {
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
  return { label, issuer, secret, digits, period, algorithm };
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
