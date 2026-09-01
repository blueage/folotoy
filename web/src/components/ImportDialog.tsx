// 导入对话框：选文件 / 拖放 → 加密备份先要密码 → 确认“整库替换” → 提交（D1、D3、D5、D8）。
// 唯一的数据入口就是备份文件，界面里没有摄像头、二维码、手动录入或 URI 粘贴（D1）。

import { useCallback, useState } from 'react';

import { ImportError, type ImportErrorCode } from '../lib/twofas/errors';
import { isEncryptedBackup, parseBackup } from '../lib/twofas/parse';
import type { ServiceEntry } from '../lib/twofas/types';

/** 导入会整库替换，这句话在提交替换之前必须一直可见（D3）。 */
export const REPLACE_WARNING = '导入会替换本地全部条目：原有条目将被整体丢弃，不合并、不去重。';

/** 每个错误码对应一条指名道姓的中文提示（D8）。 */
const ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  INVALID_JSON: '文件不是有效的 JSON，请选择 2FAS 导出的 .2fas 或 .json 备份文件',
  UNSUPPORTED_SCHEMA: '备份版本不受支持，请使用 2FAS 导出的 schemaVersion 2 至 4 的备份文件',
  NOT_A_BACKUP: '文件里既没有 services 也没有 servicesEncrypted，这不是 2FAS 备份文件',
  PASSWORD_REQUIRED: '这是加密备份，请先输入备份密码',
  WRONG_PASSWORD: '备份密码不正确，请重新输入',
  DECRYPT_FAILED: '备份解密失败，文件可能已损坏，请重新导出一份备份',
};

type Stage =
  | { kind: 'choose' }
  | { kind: 'password'; text: string; fileName: string }
  | { kind: 'confirm'; entries: ServiceEntry[]; fileName: string }
  | { kind: 'committing' };

export interface ImportDialogProps {
  /** 提交整库替换。抛错表示写入失败，此时保险库保持原样（D8）。 */
  onImport(entries: ServiceEntry[]): Promise<void>;
  onClose(): void;
}

/** 把任意失败翻译成可直接展示的中文说明（D8）。 */
function importErrorMessage(cause: unknown): string {
  if (cause instanceof ImportError) {
    return ERROR_MESSAGES[cause.code];
  }
  return cause instanceof Error ? `导入失败：${cause.message}` : '导入失败：未知错误';
}

/** jsdom 与部分浏览器上 Blob.text() 不可用，统一走 FileReader。 */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('读取文件失败'));
    };
    reader.readAsText(file);
  });
}

export default function ImportDialog({ onImport, onClose }: ImportDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /** 解析成功进入确认步骤；失败只更新提示，绝不写库、也不清空界面（D8）。 */
  const parseInto = useCallback(async (text: string, fileName: string, secret?: string) => {
    try {
      const parsed = await parseBackup(text, secret);
      setError(null);
      setStage({ kind: 'confirm', entries: parsed.entries, fileName });
    } catch (cause) {
      setError(importErrorMessage(cause));
      if (isEncryptedBackup(text)) {
        setStage({ kind: 'password', text, fileName });
      }
    }
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) {
        return;
      }
      setError(null);
      let text: string;
      try {
        text = await readFileText(file);
      } catch {
        setError('无法读取所选文件，请重新选择');
        return;
      }
      // 先嗅探再决定要不要弹密码框（D5）。
      if (isEncryptedBackup(text)) {
        setPassword('');
        setStage({ kind: 'password', text, fileName: file.name });
        return;
      }
      await parseInto(text, file.name);
    },
    [parseInto],
  );

  const commit = useCallback(
    async (entries: ServiceEntry[]) => {
      setStage({ kind: 'committing' });
      try {
        await onImport(entries);
        onClose();
      } catch (cause) {
        setError(importErrorMessage(cause));
        setStage({ kind: 'choose' });
      }
    },
    [onImport, onClose],
  );

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-dialog-title"
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-4">
        <h2
          id="import-dialog-title"
          className="text-lg font-semibold text-slate-900 dark:text-slate-100"
        >
          导入 2FAS 备份
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          关闭
        </button>
      </div>

      <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
        {REPLACE_WARNING}
      </p>

      {stage.kind === 'choose' && (
        <div
          data-testid="drop-zone"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void handleFile(event.dataTransfer?.files?.[0]);
          }}
          className={`mt-4 rounded-lg border border-dashed px-4 py-8 text-center ${
            dragging ? 'border-sky-500 bg-sky-50 dark:bg-sky-950' : 'border-slate-300'
          } dark:border-slate-700`}
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">
            把 .2fas / .json 备份文件拖到这里，或
          </p>
          <label className="mt-3 inline-block cursor-pointer rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500">
            选择备份文件
            <input
              type="file"
              accept=".2fas,.json,application/json"
              className="sr-only"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
              }}
            />
          </label>
        </div>
      )}

      {stage.kind === 'password' && (
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void parseInto(stage.text, stage.fileName, password);
          }}
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {`「${stage.fileName}」是加密备份，请输入备份密码。`}
          </p>
          <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-300">
            备份密码
            <input
              type="password"
              value={password}
              autoComplete="off"
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              解密备份
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStage({ kind: 'choose' });
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
            >
              重新选择文件
            </button>
          </div>
        </form>
      )}

      {stage.kind === 'confirm' && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {`已解析「${stage.fileName}」，共 ${stage.entries.length} 个条目。确认后将替换本地保险库。`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void commit(stage.entries);
              }}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              确认导入并替换
            </button>
            <button
              type="button"
              onClick={() => {
                setStage({ kind: 'choose' });
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'committing' && (
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">正在写入本地保险库…</p>
      )}

      {error !== null && (
        <p
          data-testid="import-error"
          role="alert"
          className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200"
        >
          {error}
        </p>
      )}
    </section>
  );
}
