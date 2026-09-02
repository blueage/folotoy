// 设置面板：手动时钟偏移（D16）与“清除全部本地数据”（D12）。
// 偏移只改本地计算用的时刻，应用永远不联网校时（D11、D16）。

import { useEffect, useState } from 'react';

export interface SettingsPanelProps {
  clockOffsetSec: number;
  /** 保存偏移；由调用方写入 SettingsStore 并刷新计算时刻。 */
  onClockOffsetChange(sec: number): void;
  /** 清除全部本地数据；只在用户确认后调用。 */
  onErase(): void;
  onClose(): void;
}

export default function SettingsPanel({
  clockOffsetSec,
  onClockOffsetChange,
  onErase,
  onClose,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState(String(clockOffsetSec));
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 外部（如首次读取设置）改了偏移就同步到输入框。
  useEffect(() => {
    setDraft(String(clockOffsetSec));
  }, [clockOffsetSec]);

  return (
    <section
      aria-labelledby="settings-title"
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id="settings-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          设置
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          关闭
        </button>
      </div>

      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number(draft);
          if (!Number.isFinite(parsed)) {
            setNotice('时钟偏移必须是数字（秒）');
            return;
          }
          onClockOffsetChange(Math.trunc(parsed));
          setNotice('时钟偏移已保存');
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-300">
          时钟偏移（秒）
          <input
            type="number"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          设备时钟偏慢时填正数、偏快时填负数。本应用不会向任何时间服务器发起请求。
          这个偏移也会叠加到<strong>推送给工卡的时间</strong>上，两处显示的验证码因此始终一致。
        </p>
        <div>
          <button
            type="submit"
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            保存偏移
          </button>
        </div>
        {notice !== null && (
          <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
            {notice}
          </p>
        )}
      </form>

      <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-medium text-slate-900 dark:text-slate-100">危险操作</h3>
        {confirming ? (
          <div className="mt-2 flex flex-col gap-2">
            <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
              将删除本地全部条目与加密密钥，且无法撤销。重新导入备份文件才能恢复。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onErase();
                }}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
              >
                确认清除
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                }}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            className="mt-2 rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
          >
            清除全部本地数据
          </button>
        )}
      </div>
    </section>
  );
}
