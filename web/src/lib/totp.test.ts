import { describe, expect, it } from 'vitest';
import { TotpError, generateTotp, periodProgress } from './totp';
import type { OtpAlgorithm, ServiceEntry } from './twofas/types';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 测试侧的 Base32 编码器：把 RFC 6238 的 ASCII 种子转成条目里的 Base32 密钥。 */
function base32Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET.charAt((buffer >> bits) & 0x1f);
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET.charAt((buffer << (5 - bits)) & 0x1f);
  }
  return output;
}

/**
 * RFC 6238 附录 B 的种子：每种算法的种子长度不同
 * （SHA1 20 字节、SHA256 32 字节、SHA512 64 字节，均为 "12345678901234567890..." 的截断/重复）。
 */
const SEEDS: Record<OtpAlgorithm, string> = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
};

/** RFC 6238 附录 B 的测试向量：时间（秒）→ 8 位验证码。 */
const VECTORS: ReadonlyArray<{ t: number; SHA1: string; SHA256: string; SHA512: string }> = [
  { t: 59, SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' },
  { t: 1111111109, SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' },
  { t: 1111111111, SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' },
  { t: 1234567890, SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' },
  { t: 2000000000, SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' },
  { t: 20000000000, SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' },
];

function entryFor(algorithm: OtpAlgorithm, digits: number): ServiceEntry {
  return {
    id: `rfc6238-${algorithm}`,
    name: 'RFC 6238',
    issuer: null,
    account: null,
    secret: base32Encode(SEEDS[algorithm]),
    algorithm,
    digits,
    period: 30,
    tokenType: 'TOTP',
    unsupportedReason: null,
  };
}

describe('generateTotp', () => {
  it('matches RFC 6238 vectors for SHA1', async () => {
    const entry = entryFor('SHA1', 8);
    // 契约里的标准夹具：20 字节 ASCII 种子、8 位、t=59s。
    await expect(generateTotp(entry, 59 * 1000)).resolves.toBe('94287082');
    for (const vector of VECTORS) {
      await expect(generateTotp(entry, vector.t * 1000)).resolves.toBe(vector.SHA1);
    }
  });

  it('matches RFC 6238 vectors for SHA256 and SHA512', async () => {
    const sha256 = entryFor('SHA256', 8);
    const sha512 = entryFor('SHA512', 8);
    for (const vector of VECTORS) {
      await expect(generateTotp(sha256, vector.t * 1000)).resolves.toBe(vector.SHA256);
      await expect(generateTotp(sha512, vector.t * 1000)).resolves.toBe(vector.SHA512);
    }
  });

  it('pads short codes to the requested digit count', async () => {
    // t=1111111109 的 8 位码为 07081804，截到 6 位是 081804：两处前导零都必须保留。
    await expect(generateTotp(entryFor('SHA1', 8), 1111111109 * 1000)).resolves.toBe('07081804');
    const sixDigits = await generateTotp(entryFor('SHA1', 6), 1111111109 * 1000);
    expect(sixDigits).toBe('081804');
    expect(sixDigits).toHaveLength(6);
  });

  it('refuses to compute a code for an unsupported entry', async () => {
    const base = entryFor('SHA1', 6);
    await expect(generateTotp({ ...base, tokenType: 'HOTP' }, 0)).rejects.toBeInstanceOf(TotpError);
    await expect(generateTotp({ ...base, tokenType: 'STEAM' }, 0)).rejects.toBeInstanceOf(TotpError);
    await expect(generateTotp({ ...base, digits: 9 }, 0)).rejects.toBeInstanceOf(TotpError);
    await expect(
      generateTotp({ ...base, unsupportedReason: '密钥不是有效的 Base32 编码' }, 0),
    ).rejects.toBeInstanceOf(TotpError);
  });

  it('uses the period when bucketing time', async () => {
    const entry = entryFor('SHA1', 8);
    // 同一个 30 秒窗口内结果不变，跨过边界后改变。
    await expect(generateTotp(entry, 30_000)).resolves.toBe(await generateTotp(entry, 59_999));
    expect(await generateTotp(entry, 60_000)).not.toBe(await generateTotp(entry, 59_999));
  });
});

describe('periodProgress', () => {
  it('periodProgress reports the period boundary', () => {
    const entry = entryFor('SHA1', 6);

    // 周期起点：整个周期都还剩着。
    expect(periodProgress(entry, 1_800_000_000_000)).toEqual({ remainingSec: 30, fraction: 1 });
    // 周期中点。
    expect(periodProgress(entry, 1_800_000_015_000)).toEqual({ remainingSec: 15, fraction: 0.5 });
    // 最后一秒。
    expect(periodProgress(entry, 1_800_000_029_000).remainingSec).toBe(1);
    expect(periodProgress(entry, 1_800_000_029_999).remainingSec).toBe(1);
    // 下一个周期的起点重新开始。
    expect(periodProgress(entry, 1_800_000_030_000)).toEqual({ remainingSec: 30, fraction: 1 });
  });

  it('honours a non-default period', () => {
    const entry: ServiceEntry = { ...entryFor('SHA1', 6), period: 60 };
    expect(periodProgress(entry, 0)).toEqual({ remainingSec: 60, fraction: 1 });
    expect(periodProgress(entry, 45_000)).toEqual({ remainingSec: 15, fraction: 0.25 });
  });
});
