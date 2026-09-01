// 备份密码校验（D5）：先解密 reference 字段并与上游常量比对，通过后才允许解密条目。

import { decryptField, TwofasCryptoError, type EncryptedField } from './crypto';
import { ImportError } from './errors';

/* ------------------------------------------------------------------ *
 * 上游 reference 明文常量（D6）
 *
 * 来源：2FAS Auth 开源实现（twofas/2fas-android、twofas/2fas-ios）在导出加密备份时，
 * 用同一个备份密码加密这个固定字符串写入 `reference` 字段，供导入方校验密码。
 * 它是常量而非秘密：与 crypto.ts 的参数常量块一样，只在此处维护一份。
 *
 * 真实 .2fas 备份文件的端到端确认属于人工任务 M02；仓库内只使用合成夹具（D17）。
 * ------------------------------------------------------------------ */
export const TWOFAS_REFERENCE_PLAINTEXT =
  'tRViSsLKzd86Hprh4ceC2OP7xazn4rrt4xhfEUbOjxLX8Rc3mkISXE0lWbmnWfggogbBJhtYgpK6fMl1D6mtsy92R3HkdGfwuXbzLebqVFJsR7IZ2w58t3udQY5Y83nM';

/**
 * 校验备份密码。
 *
 * 解密失败（认证标签不通过）与解出的明文不等于上游常量，都视为密码错误：
 * 前者是密码不对的典型表现，后者说明文件不是 2FAS 生成的加密备份。
 * 两种情况都在解密任何条目之前抛出，保证密码错误时不产生任何条目（D5）。
 *
 * @throws {ImportError} code 为 `WRONG_PASSWORD`。
 */
export async function verifyBackupPassword(
  password: string,
  reference: EncryptedField,
): Promise<void> {
  let plaintext: string;
  try {
    plaintext = await decryptField(password, reference);
  } catch (error) {
    if (error instanceof TwofasCryptoError) {
      throw new ImportError('WRONG_PASSWORD', '备份密码错误');
    }
    throw error;
  }

  if (plaintext !== TWOFAS_REFERENCE_PLAINTEXT) {
    throw new ImportError('WRONG_PASSWORD', '备份密码错误');
  }
}
