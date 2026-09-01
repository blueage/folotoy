import { describe, expect, it } from 'vitest';
import { Base32Error, base32Decode } from './base32';

// jsdom 与 node 的 TextEncoder 返回不同 realm 的 Uint8Array，逐字节比较避免误判。
const utf8 = (text: string): number[] => Array.from(new TextEncoder().encode(text));
const bytes = (value: Uint8Array): number[] => Array.from(value);

/** RFC 4648 §10 的标准测试向量。 */
const RFC4648_VECTORS: ReadonlyArray<[decoded: string, encoded: string]> = [
  ['', ''],
  ['f', 'MY======'],
  ['fo', 'MZXQ===='],
  ['foo', 'MZXW6==='],
  ['foob', 'MZXW6YQ='],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI======'],
];

describe('base32Decode', () => {
  it('decodes RFC 4648 test vectors', () => {
    for (const [decoded, encoded] of RFC4648_VECTORS) {
      expect(bytes(base32Decode(encoded))).toEqual(utf8(decoded));
    }
  });

  it('accepts lowercase, missing padding and whitespace', () => {
    const canonical = bytes(base32Decode('MZXW6YTBOI======'));
    expect(bytes(base32Decode('mzxw6ytboi======'))).toEqual(canonical);
    expect(bytes(base32Decode('MZXW6YTBOI'))).toEqual(canonical);
    expect(bytes(base32Decode('mzxw6ytboi'))).toEqual(canonical);
    expect(bytes(base32Decode('MZXW 6YTB\nOI'))).toEqual(canonical);
    expect(bytes(base32Decode('  MZXW6YTBOI  '))).toEqual(canonical);
    expect(canonical).toEqual(utf8('foobar'));
  });

  it('throws on an invalid character', () => {
    // 0、1、8、9 与标点都不在 RFC 4648 字母表内。
    expect(() => base32Decode('MZXW0YTB')).toThrow(Base32Error);
    expect(() => base32Decode('MZXW1YTB')).toThrow(Base32Error);
    expect(() => base32Decode('MZXW6YTB!')).toThrow(Base32Error);
    // 填充符只能在末尾。
    expect(() => base32Decode('MZ=XW6YTB')).toThrow(Base32Error);
    // 不可能出现的长度余数，同样拒绝而不是静默截断。
    expect(() => base32Decode('MZXW6YTBO')).toThrow(Base32Error);
  });
});
