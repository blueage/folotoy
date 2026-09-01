// 导入流程的类型化错误。界面层按 code 决定提示与后续动作（D8）。

/** 导入失败的原因分类。 */
export type ImportErrorCode =
  | 'INVALID_JSON'
  | 'UNSUPPORTED_SCHEMA'
  | 'NOT_A_BACKUP'
  | 'PASSWORD_REQUIRED'
  | 'WRONG_PASSWORD'
  | 'DECRYPT_FAILED';

/**
 * 导入失败。message 为可直接展示的中文说明，code 为界面层的判定依据。
 * 任何失败都以抛出的方式结束，绝不返回填了一半的 ParsedBackup（D8）。
 */
export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    Object.setPrototypeOf(this, ImportError.prototype);
  }
}
