// 应用外壳：组合导入对话框、令牌列表、搜索与设置（设计 §3.1）。
// 存储实例通过 props 注入（默认用应用单例），测试才能整体替换（要求 13）。

import { useCallback, useEffect, useState } from 'react';

import BadgePanel from './components/BadgePanel';
import ImportDialog from './components/ImportDialog';
import SettingsPanel from './components/SettingsPanel';
import TokenList from './components/TokenList';
import { useTicker } from './hooks/useTicker';
import { useVault } from './hooks/useVault';
import type { ServiceEntry } from './lib/twofas/types';
import { type SettingsStore, settingsStore } from './store/settings';
import { type VaultStore, vaultStore } from './store/vault';

export interface AppProps {
  vault?: VaultStore;
  settings?: SettingsStore;
}

export default function App({ vault = vaultStore, settings = settingsStore }: AppProps = {}) {
  const {
    entries,
    loading,
    error,
    replaceEntries,
    removeEntry,
    reorderEntries,
    updateEntry,
    eraseAll,
  } = useVault(vault);
  const tickMs = useTicker();

  const [clockOffsetSec, setClockOffsetSec] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showBadge, setShowBadge] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    settings.getClockOffsetSec().then(
      (sec) => {
        if (!cancelled) {
          setClockOffsetSec(sec);
        }
      },
      () => {
        // 读不到就用 0，界面照常可用。
      },
    );
    return () => {
      cancelled = true;
    };
  }, [settings]);

  const handleImport = useCallback(
    async (imported: ServiceEntry[]) => {
      await replaceEntries(imported);
      setActionError(null);
    },
    [replaceEntries],
  );

  const handleOffsetChange = useCallback(
    (sec: number) => {
      setClockOffsetSec(sec);
      settings.setClockOffsetSec(sec).catch(() => {
        setActionError('时钟偏移未能保存到本地');
      });
    },
    [settings],
  );

  const handleDelete = useCallback(
    (id: string) => {
      removeEntry(id).then(
        () => {
          setActionError(null);
        },
        () => {
          setActionError('删除失败，条目仍在本地');
        },
      );
    },
    [removeEntry],
  );

  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      reorderEntries(orderedIds).then(
        () => {
          setActionError(null);
        },
        () => {
          setActionError('顺序未能保存到本地');
        },
      );
    },
    [reorderEntries],
  );

  const handleUpdateEntry = useCallback(
    (next: ServiceEntry) => {
      updateEntry(next).then(
        () => {
          setActionError(null);
        },
        () => {
          setActionError('工卡设置未能保存到本地');
        },
      );
    },
    [updateEntry],
  );

  const handleErase = useCallback(() => {
    eraseAll().then(
      () => {
        setActionError(null);
        setShowSettings(false);
      },
      () => {
        setActionError('清除本地数据失败，请重试');
      },
    );
  }, [eraseAll]);

  // 时钟偏移只作用于计算验证码的时刻，不改设备时钟（D16）。
  const nowMs = tickMs + clockOffsetSec * 1000;
  const banner = actionError ?? error;

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-4 px-4 py-8">
      {banner !== null && (
        <p
          role="alert"
          className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950 dark:text-rose-200"
        >
          {banner}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">正在读取本地数据…</p>
      ) : (
        <TokenList
          entries={entries}
          nowMs={nowMs}
          onImportClick={() => {
            setShowSettings(false);
            setShowBadge(false);
            setShowImport(true);
          }}
          onDelete={handleDelete}
          onReorder={handleReorder}
          // 面板打开时把键盘让给它，否则打字会被搜索框抢走。
          typeToSearchEnabled={!showImport && !showSettings && !showBadge}
        />
      )}

      {/*
        面板挤在列表**下方**、紧挨着触发它们的页脚链接。
        放在上方会把整张列表往下推，视线和滚动位置都被打乱；而入口本身就在底部，
        面板从底部展开也更符合"点哪儿、从哪儿出来"的预期。
      */}
      {showBadge && (
        <BadgePanel
          entries={entries}
          onUpdateEntry={handleUpdateEntry}
          onClose={() => {
            setShowBadge(false);
          }}
        />
      )}

      {showSettings && (
        <SettingsPanel
          clockOffsetSec={clockOffsetSec}
          onClockOffsetChange={handleOffsetChange}
          onErase={handleErase}
          onClose={() => {
            setShowSettings(false);
          }}
        />
      )}

      {showImport && (
        <ImportDialog
          onImport={handleImport}
          onClose={() => {
            setShowImport(false);
          }}
        />
      )}

      {/* 入口收在页面底部并弱化为小号链接：日常使用只看验证码，导入与设置是低频操作。 */}
      <footer className="mt-auto flex items-center justify-center gap-4 pt-8">
        <button
          type="button"
          onClick={() => {
            setShowImport((open) => !open);
            setShowSettings(false);
            setShowBadge(false);
          }}
          className="text-xs text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
        >
          导入备份
        </button>
        <span aria-hidden="true" className="text-xs text-slate-300 dark:text-slate-700">
          ·
        </span>
        <button
          type="button"
          onClick={() => {
            setShowBadge((open) => !open);
            setShowImport(false);
            setShowSettings(false);
          }}
          className="text-xs text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
        >
          同步到工卡
        </button>
        <span aria-hidden="true" className="text-xs text-slate-300 dark:text-slate-700">
          ·
        </span>
        <button
          type="button"
          onClick={() => {
            setShowSettings((open) => !open);
            setShowImport(false);
            setShowBadge(false);
          }}
          className="text-xs text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
        >
          设置
        </button>
      </footer>
    </main>
  );
}
