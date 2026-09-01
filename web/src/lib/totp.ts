// RFC 6238 TOTP 计算与倒计时进度（D13、D15）。
// 只使用 crypto.subtle，不触碰 DOM / IndexedDB / React。

import { base32Decode } from './base32';
import type { OtpAlgorithm, ServiceEntry } from './twofas/types';

/** OTP 默认参数（D7）：缺省即 SHA1 / 6 位 / 30 秒。 */
export const DEFAULT_ALGORITHM: OtpAlgorithm = 'SHA1';
export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD_SEC = 30;

/** 支持的位数区间（D13）。 */
export const MIN_DIGITS = 6;
export const MAX_DIGITS = 8;

/** 内部算法名 → WebCrypto 摘要名。 */
const SUBTLE_HASH: Record<OtpAlgorithm, 'SHA-1' | 'SHA-256' | 'SHA-512'> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
};

/** 无法为某条目计算验证码。界面层应展示“不受支持”而不是错误码（D13）。 */
export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpError';
    Object.setPrototypeOf(this, TotpError.prototype);
  }
}

/**
 * 该条目是否可以计算验证码。
 * 被标记为不受支持的条目、非 TOTP 令牌、越界的位数/周期一律返回 false（D13）。
 */
export function canGenerateTotp(entry: ServiceEntry): boolean {
  return (
    entry.unsupportedReason === null &&
    entry.tokenType === 'TOTP' &&
    Number.isInteger(entry.digits) &&
    entry.digits >= MIN_DIGITS &&
    entry.digits <= MAX_DIGITS &&
    Number.isFinite(entry.period) &&
    entry.period > 0 &&
    entry.secret.length > 0
  );
}

/**
 * 按 RFC 6238 计算指定时刻的验证码。
 *
 * @param atMs 计算时刻（毫秒）。由调用方显式传入，便于测试与时钟偏移（D16）。
 * @returns 补零到 entry.digits 位的十进制字符串。
 * @throws {TotpError} 条目不受支持时抛出，绝不返回可能错误的验证码（D13）。
 */
export async function generateTotp(entry: ServiceEntry, atMs: number): Promise<string> {
  if (!canGenerateTotp(entry)) {
    throw new TotpError(entry.unsupportedReason ?? `条目不支持计算验证码：${entry.name}`);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    // 复制成由普通 ArrayBuffer 支撑的视图：WebCrypto 的 BufferSource 不接受 SharedArrayBuffer 支撑的缓冲区。
    new Uint8Array(base32Decode(entry.secret)),
    { name: 'HMAC', hash: SUBTLE_HASH[entry.algorithm] },
    false,
    ['sign'],
  );

  // 计数器 = floor(unix 秒 / 周期)，8 字节大端。
  const counter = Math.floor(atMs / 1000 / entry.period);
  const counterBytes = new ArrayBuffer(8);
  new DataView(counterBytes).setBigUint64(0, BigInt(counter));

  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));
  const byteAt = (index: number): number => mac[index] ?? 0;

  // RFC 4226 §5.3 动态截断。
  const offset = byteAt(mac.length - 1) & 0x0f;
  const binary =
    ((byteAt(offset) & 0x7f) << 24) |
    (byteAt(offset + 1) << 16) |
    (byteAt(offset + 2) << 8) |
    byteAt(offset + 3);

  const code = binary % 10 ** entry.digits;
  return String(code).padStart(entry.digits, '0');
}

/**
 * 当前周期的剩余进度（D15）。
 *
 * @returns `remainingSec` 为向上取整的剩余秒数（周期起点等于整个周期长度，
 *          周期最后一秒为 1）；`fraction` 为剩余比例，周期起点为 1、边界处趋近 0。
 */
export function periodProgress(
  entry: ServiceEntry,
  atMs: number,
): { remainingSec: number; fraction: number } {
  // 展示型辅助函数：周期非法时退回默认值，而不是抛错打断整个列表渲染。
  const periodSec =
    Number.isFinite(entry.period) && entry.period > 0 ? entry.period : DEFAULT_PERIOD_SEC;
  const periodMs = periodSec * 1000;
  const elapsedMs = ((atMs % periodMs) + periodMs) % periodMs;
  const remainingMs = periodMs - elapsedMs;

  return {
    remainingSec: Math.ceil(remainingMs / 1000),
    fraction: remainingMs / periodMs,
  };
}
