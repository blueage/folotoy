import { describe, expect, it } from 'vitest';
import { encryptField } from './crypto';
import { ImportError, type ImportErrorCode } from './errors';
import { isEncryptedBackup, joinEncryptedField, parseBackup } from './parse';
import { TWOFAS_REFERENCE_PLAINTEXT } from './reference';
import type { ParsedBackup } from './types';

const PASSWORD = '合成夹具密码 correct-horse';

/** 合成条目：全部由测试自己生成，仓库内不存在任何真实密钥或账号（D17）。 */
const SYNTHETIC_SERVICES: readonly unknown[] = [
  {
    name: 'GitHub',
    secret: 'JBSWY3DPEHPK3PXP',
    updatedAt: 1_700_000_000_000,
    otp: {
      label: 'octocat',
      account: 'octocat',
      issuer: 'GitHub',
      digits: 8,
      period: 60,
      algorithm: 'SHA256',
      tokenType: 'TOTP',
      source: 'Link',
    },
    order: { position: 0 },
  },
  {
    // otp 整块缺失：全部走 SHA1 / 6 位 / 30 秒的默认值（D7）。
    name: '示例服务',
    secret: 'GEZDGNBVGY3TQOJQ',
    order: { position: 1 },
  },
];

function plaintextBackup(services: readonly unknown[] = SYNTHETIC_SERVICES): unknown {
  return {
    services,
    groups: [],
    updatedAt: 1_700_000_000_000,
    schemaVersion: 4,
    appVersionCode: 5_000_000,
    appOrigin: 'android',
  };
}

async function encryptedBackup(
  services: readonly unknown[] = SYNTHETIC_SERVICES,
  password: string = PASSWORD,
): Promise<unknown> {
  const [encryptedServices, encryptedReference] = await Promise.all([
    encryptField(password, JSON.stringify(services)),
    encryptField(password, TWOFAS_REFERENCE_PLAINTEXT),
  ]);
  return {
    // 真实的加密备份里 services 是空数组，加密内容在 servicesEncrypted 中。
    services: [],
    groups: [],
    updatedAt: 1_700_000_000_000,
    schemaVersion: 4,
    appVersionCode: 5_000_000,
    appOrigin: 'android',
    servicesEncrypted: joinEncryptedField(encryptedServices),
    reference: joinEncryptedField(encryptedReference),
  };
}

/** 断言 parseBackup 抛出 ImportError，并返回其 code；同时确认没有产出任何结果。 */
async function expectImportError(promise: Promise<ParsedBackup>): Promise<ImportErrorCode> {
  const outcome = await promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error('预期解析失败，却成功返回了结果');
  }
  expect(outcome.error).toBeInstanceOf(ImportError);
  return (outcome.error as ImportError).code;
}

describe('parseBackup', () => {
  it('parses a plaintext backup into normalised entries', async () => {
    const result = await parseBackup(JSON.stringify(plaintextBackup()));

    expect(result.wasEncrypted).toBe(false);
    expect(result.schemaVersion).toBe(4);
    expect(result.entries).toHaveLength(2);

    expect(result.entries[0]).toMatchObject({
      name: 'GitHub',
      issuer: 'GitHub',
      account: 'octocat',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
      tokenType: 'TOTP',
      unsupportedReason: null,
    });

    // 缺失字段回落到 SHA1 / 6 位 / 30 秒（D7）。
    expect(result.entries[1]).toMatchObject({
      name: '示例服务',
      issuer: null,
      account: null,
      secret: 'GEZDGNBVGY3TQOJQ',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      tokenType: 'TOTP',
      unsupportedReason: null,
    });

    // id 稳定：同一份文件重复导入得到同一批 id（D7）。
    const again = await parseBackup(plaintextBackup());
    expect(again.entries.map((entry) => entry.id)).toEqual(result.entries.map((entry) => entry.id));
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(2);
  });

  it('parses a synthetic encrypted backup', async () => {
    const plain = await parseBackup(plaintextBackup());
    const result = await parseBackup(JSON.stringify(await encryptedBackup()), PASSWORD);

    expect(result.wasEncrypted).toBe(true);
    expect(result.schemaVersion).toBe(4);
    expect(result.entries).toEqual(plain.entries);
  });

  it('throws WRONG_PASSWORD for a good file and a bad password', async () => {
    const backup = await encryptedBackup();
    expect(await expectImportError(parseBackup(backup, '错误的密码'))).toBe('WRONG_PASSWORD');
  });

  it('throws PASSWORD_REQUIRED when an encrypted backup gets no password', async () => {
    const backup = await encryptedBackup();
    expect(await expectImportError(parseBackup(backup))).toBe('PASSWORD_REQUIRED');
    expect(await expectImportError(parseBackup(backup, ''))).toBe('PASSWORD_REQUIRED');
  });

  it('throws INVALID_JSON / UNSUPPORTED_SCHEMA / NOT_A_BACKUP for the corresponding malformed inputs', async () => {
    expect(await expectImportError(parseBackup('{ 这不是 JSON'))).toBe('INVALID_JSON');
    expect(await expectImportError(parseBackup('[]'))).toBe('INVALID_JSON');
    expect(await expectImportError(parseBackup(JSON.stringify({ schemaVersion: 1 })))).toBe(
      'UNSUPPORTED_SCHEMA',
    );
    expect(await expectImportError(parseBackup(JSON.stringify({ services: [] })))).toBe(
      'UNSUPPORTED_SCHEMA',
    );
    expect(await expectImportError(parseBackup(JSON.stringify({ schemaVersion: 4 })))).toBe(
      'NOT_A_BACKUP',
    );
  });

  it('marks an HOTP entry unsupported instead of dropping it', async () => {
    const result = await parseBackup(
      plaintextBackup([
        SYNTHETIC_SERVICES[0],
        {
          name: 'HOTP 服务',
          secret: 'JBSWY3DPEHPK3PXP',
          otp: { tokenType: 'HOTP', counter: 7, issuer: 'HOTP 服务' },
        },
      ]),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]?.tokenType).toBe('HOTP');
    expect(result.entries[1]?.unsupportedReason).not.toBeNull();
    expect(result.entries[1]?.unsupportedReason).toContain('HOTP');
  });

  it('keeps a malformed entry with a reason instead of aborting the import', async () => {
    const result = await parseBackup(
      plaintextBackup([
        { name: '坏密钥', secret: '这不是 Base32!!', otp: { issuer: '坏密钥' } },
        { name: '坏参数', secret: 'JBSWY3DPEHPK3PXP', otp: { algorithm: 'MD5', digits: 12, period: 0 } },
        { name: '缺密钥', otp: { tokenType: 'TOTP' } },
        'not an object',
        SYNTHETIC_SERVICES[0],
      ]),
    );

    expect(result.entries).toHaveLength(5);
    expect(result.entries[0]?.unsupportedReason).toContain('Base32');
    const badParameters = result.entries[1];
    expect(badParameters?.unsupportedReason).toContain('MD5');
    // 非法参数回落到默认值，条目本身照样保留（D9）。
    expect(badParameters?.algorithm).toBe('SHA1');
    expect(badParameters?.digits).toBe(6);
    expect(badParameters?.period).toBe(30);
    expect(result.entries[2]?.unsupportedReason).toContain('密钥');
    expect(result.entries[3]?.unsupportedReason).not.toBeNull();
    // 好条目不受牵连。
    expect(result.entries[4]?.unsupportedReason).toBeNull();
  });
});

describe('isEncryptedBackup', () => {
  it('distinguishes encrypted from plaintext backups', async () => {
    expect(isEncryptedBackup(await encryptedBackup())).toBe(true);
    expect(isEncryptedBackup(JSON.stringify(await encryptedBackup()))).toBe(true);
    expect(isEncryptedBackup(plaintextBackup())).toBe(false);
    expect(isEncryptedBackup(JSON.stringify(plaintextBackup()))).toBe(false);
    expect(isEncryptedBackup('{ 这不是 JSON')).toBe(false);
    expect(isEncryptedBackup(null)).toBe(false);
  });
});
