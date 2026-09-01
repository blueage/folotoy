// 导入之前的空状态：指向唯一的入口——导入 2FAS 备份文件（D1）。

export interface EmptyStateProps {
  onImportClick(): void;
}

export default function EmptyState({ onImportClick }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className="rounded-lg border border-dashed border-slate-300 px-6 py-12 text-center dark:border-slate-700"
    >
      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">还没有任何条目</p>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        导入 2FAS 备份文件后即可在此查看验证码；本应用只支持从备份文件导入。
      </p>
      <button
        type="button"
        onClick={onImportClick}
        className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
      >
        导入备份文件
      </button>
    </div>
  );
}
