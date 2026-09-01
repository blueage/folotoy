import { describe, expect, it } from 'vitest';
import {
  AES_KEY_LENGTH_BITS,
  GCM_TAG_LENGTH_BITS,
  IV_LENGTH_BYTES,
  PBKDF2_HASH,
  PBKDF2_ITERATIONS,
  SALT_LENGTH_BYTES,
  base64Decode,
  base64Encode,
  decryptField,
  encryptField,
  type EncryptedField,
} from './crypto';
import { ImportError } from './errors';
import { TWOFAS_REFERENCE_PLAINTEXT, verifyBackupPassword } from './reference';

const PASSWORD = 'correct horse battery staple';

/**
 * 测试侧独立实现的加密：直接用导出的参数常量走 WebCrypto，
 * 若 crypto.ts 的解密路径与这份常量块不一致就会失败（D6 的自洽验证，D17）。
 */
async function encryptWithDocumentedParameters(
  password: string,
  plaintext: string,
): Promise<EncryptedField> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
    material,
    { name: 'AES-GCM', length: AES_KEY_LENGTH_BITS },
    false,
    ['encrypt'],
  );
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { cipher: new Uint8Array(cipher), salt, iv };
}

describe('twofas crypto', () => {
  it('round-trips a payload encrypted with the documented parameters', async () => {
    const plaintext = JSON.stringify([{ name: '合成条目', secret: 'JBSWY3DPEHPK3PXP' }]);
    const field = await encryptWithDocumentedParameters(PASSWORD, plaintext);

    expect(field.salt).toHaveLength(SALT_LENGTH_BYTES);
    expect(field.iv).toHaveLength(IV_LENGTH_BYTES);
    // 密文尾部附带认证标签。
    expect(field.cipher.length).toBe(
      new TextEncoder().encode(plaintext).length + GCM_TAG_LENGTH_BITS / 8,
    );

    await expect(decryptField(PASSWORD, field)).resolves.toBe(plaintext);
  });

  it('round-trips through the library encrypt helper', async () => {
    const field = await encryptField(PASSWORD, TWOFAS_REFERENCE_PLAINTEXT);
    expect(field.salt).toHaveLength(SALT_LENGTH_BYTES);
    expect(field.iv).toHaveLength(IV_LENGTH_BYTES);
    await expect(decryptField(PASSWORD, field)).resolves.toBe(TWOFAS_REFERENCE_PLAINTEXT);
  });

  it('rejects a wrong password', async () => {
    const reference = await encryptWithDocumentedParameters(PASSWORD, TWOFAS_REFERENCE_PLAINTEXT);

    // 正确密码通过。
    await expect(verifyBackupPassword(PASSWORD, reference)).resolves.toBeUndefined();

    // 错误密码：认证标签校验失败，得到的是 WRONG_PASSWORD 而不是任何“解密结果”。
    const wrong = await verifyBackupPassword('wrong password', reference).catch(
      (error: unknown) => error,
    );
    expect(wrong).toBeInstanceOf(ImportError);
    expect((wrong as ImportError).code).toBe('WRONG_PASSWORD');

    // 密码对得上、但 reference 明文不是上游常量：同样判定为密码错误，不放行。
    const foreign = await encryptWithDocumentedParameters(PASSWORD, '不是 2FAS 的 reference');
    const mismatch = await verifyBackupPassword(PASSWORD, foreign).catch((error: unknown) => error);
    expect(mismatch).toBeInstanceOf(ImportError);
    expect((mismatch as ImportError).code).toBe('WRONG_PASSWORD');
  });

  it('encodes and decodes base64 without DOM helpers', () => {
    expect(base64Encode(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
    expect(base64Encode(new TextEncoder().encode('fo'))).toBe('Zm8=');
    // jsdom 与 node 的 TextEncoder 返回不同 realm 的 Uint8Array，逐字节比较避免误判。
    expect(Array.from(base64Decode('Zm9vYmFy'))).toEqual([...new TextEncoder().encode('foobar')]);
    expect(Array.from(base64Decode('Zm8='))).toEqual([...new TextEncoder().encode('fo')]);

    const random = crypto.getRandomValues(new Uint8Array(200));
    expect(Array.from(base64Decode(base64Encode(random)))).toEqual(Array.from(random));
  });
});
