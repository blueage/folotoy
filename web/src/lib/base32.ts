// RFC 4648 §6 Base32 解码。纯函数，不依赖 DOM / React / 存储层。
// 解码失败必须抛出类型化错误，交由导入流程逐条目降级处理（D9）。

/** RFC 4648 标准字母表（不含填充符）。 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 长度对 8 取余后的非法余数：这些余数不可能由任何字节序列编码得到。 */
const INVALID_REMAINDERS = new Set([1, 3, 6]);

/** Base32 解码失败。调用方据此把条目标记为不受支持（D9）。 */
export class Base32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base32Error';
    // 转译到 ES5 之外的目标时仍保证 instanceof 可用。
    Object.setPrototypeOf(this, Base32Error.prototype);
  }
}

/**
 * 解码 Base32 字符串为字节序列。
 *
 * 宽容之处：大小写不敏感、填充符 `=` 可省略、允许任意空白字符（含换行）。
 * 严格之处：出现字母表以外的字符、或长度不可能合法时抛出 {@link Base32Error}，
 * 绝不静默返回半截结果。
 */
export function base32Decode(input: string): Uint8Array {
  const stripped = input.replace(/\s+/g, '').toUpperCase();
  // 填充符只允许出现在末尾；出现在中间会在下面的字符校验里被拒绝。
  const body = stripped.replace(/=+$/, '');

  if (INVALID_REMAINDERS.has(body.length % 8)) {
    throw new Base32Error(`Base32 长度非法：${String(body.length)} 个有效字符`);
  }

  const output = new Uint8Array(Math.floor((body.length * 5) / 8));
  let written = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < body.length; i += 1) {
    const symbol = body.charAt(i);
    const value = ALPHABET.indexOf(symbol);
    if (value < 0) {
      throw new Base32Error(`Base32 含非法字符：${symbol}`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }

  return output;
}
