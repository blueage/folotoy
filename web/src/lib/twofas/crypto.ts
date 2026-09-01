// 2FAS 官方加密备份的解密原语（D5）：PBKDF2 派生 + AES-GCM 解密。
// 只使用 crypto.subtle 与纯 JS，不触碰 DOM / IndexedDB / React。

/* ------------------------------------------------------------------ *
 * 上游参数常量块（D6）
 *
 * 来源：2FAS Auth 开源实现的备份加解密模块
 *   - twofas/2fas-android — 备份导出/导入的 AES-GCM + PBKDF2 实现
 *   - twofas/2fas-ios     — 同一方案的 iOS 侧实现
 * 二者使用同一套参数，保证跨平台备份互通。
 *
 * 本文件是这些数值的唯一来源：上游参数如有出入，只需修改此处一个常量块，
 * parse.ts / reference.ts 与测试夹具都跟随变化。
 *
 * 注意：仓库内只允许合成夹具（D17），因此这些参数在自动化测试中只能做
 * “加密-解密自洽”验证。用真实 .2fas 备份文件做端到端确认属于人工任务 M02。
 * ------------------------------------------------------------------ */

/** PBKDF2 使用的摘要算法。 */
export const PBKDF2_HASH = 'SHA-256';
/** PBKDF2 迭代次数。 */
export const PBKDF2_ITERATIONS = 10_000;
/** 派生出的 AES 密钥长度（比特）—— AES-256-GCM。 */
export const AES_KEY_LENGTH_BITS = 256;
/** 随机盐长度（字节）。 */
export const SALT_LENGTH_BYTES = 32;
/** AES-GCM 初始化向量长度（字节）。 */
export const IV_LENGTH_BYTES = 12;
/** AES-GCM 认证标签长度（比特），密文尾部即为标签。 */
export const GCM_TAG_LENGTH_BITS = 128;
/** servicesEncrypted / reference 字段内各段的分隔符。 */
export const ENCRYPTED_FIELD_SEPARATOR = ':';
/** 各段的顺序：密文（含认证标签）、盐、IV，均为 base64。 */
export const ENCRYPTED_FIELD_PART_ORDER = ['cipher', 'salt', 'iv'] as const;

/* ------------------------------------------------------------------ */

/** 加密字段拆分后的三段。 */
export interface EncryptedField {
  /** 密文，尾部含 AES-GCM 认证标签。 */
  readonly cipher: Uint8Array;
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
}

/** 解密/编解码层面的失败。调用方据此映射为 WRONG_PASSWORD 或 DECRYPT_FAILED（D8）。 */
export class TwofasCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwofasCryptoError';
    Object.setPrototypeOf(this, TwofasCryptoError.prototype);
  }
}

// base64 自行实现而不用 atob/btoa：库层刻意只依赖 crypto.subtle 与 TextEncoder/TextDecoder，
// 这样这一层可以在任何 JS 运行时（含 Worker、测试环境）里复用。
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 解码，容忍空白与省略的填充符。 */
export function base64Decode(input: string): Uint8Array {
  const body = input.replace(/\s+/g, '').replace(/=+$/, '');
  if (body.length % 4 === 1) {
    throw new TwofasCryptoError(`base64 长度非法：${String(body.length)} 个有效字符`);
  }

  const output = new Uint8Array(Math.floor((body.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < body.length; i += 1) {
    const symbol = body.charAt(i);
    const value = BASE64_ALPHABET.indexOf(symbol);
    if (value < 0) {
      throw new TwofasCryptoError(`base64 含非法字符：${symbol}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }

  return output;
}

/** base64 编码（带填充）。 */
export function base64Encode(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    output += BASE64_ALPHABET.charAt((triple >> 18) & 0x3f);
    output += BASE64_ALPHABET.charAt((triple >> 12) & 0x3f);
    output += b1 === undefined ? '=' : BASE64_ALPHABET.charAt((triple >> 6) & 0x3f);
    output += b2 === undefined ? '=' : BASE64_ALPHABET.charAt(triple & 0x3f);
  }
  return output;
}

/**
 * 复制成由普通 ArrayBuffer 支撑的视图。
 * WebCrypto 的 BufferSource 不接受 SharedArrayBuffer 支撑的缓冲区，而 Uint8Array 的类型是宽泛的；
 * 这里的缓冲区都很小（盐 / IV / 备份密文），复制的代价可以忽略。
 */
// 返回类型刻意交给推断：显式写 Uint8Array 会退回宽泛的 ArrayBufferLike，白做一次复制。
function toBufferSource(bytes: Uint8Array) {
  return new Uint8Array(bytes);
}

/** 按上游参数从备份密码派生 AES-GCM 密钥。 */
export async function deriveBackupKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toBufferSource(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    material,
    { name: 'AES-GCM', length: AES_KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 解密一个加密字段，返回 UTF-8 明文。
 *
 * @throws {TwofasCryptoError} 认证标签校验失败（密码错误或数据损坏）时抛出。
 */
export async function decryptField(password: string, field: EncryptedField): Promise<string> {
  const key = await deriveBackupKey(password, field.salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(field.iv), tagLength: GCM_TAG_LENGTH_BITS },
      key,
      toBufferSource(field.cipher),
    );
  } catch {
    throw new TwofasCryptoError('AES-GCM 解密失败：密码错误或数据已损坏');
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * 用同一套上游参数加密一段明文。
 *
 * 应用本身从不导出备份（D19），此函数存在的意义是让测试用与解密完全相同的
 * 参数构造合成夹具（D17），避免两处各写一遍常量而悄悄漂移。
 */
export async function encryptField(password: string, plaintext: string): Promise<EncryptedField> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const key = await deriveBackupKey(password, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { cipher: new Uint8Array(cipher), salt, iv };
}
