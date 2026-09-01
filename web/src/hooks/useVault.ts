// 保险库在界面侧的状态：挂载时读一次条目，之后由导入 / 清除动作驱动（设计 §3.1）。
// 存储实例由调用方注入，界面层不直接引用 src/store 的单例，测试才能替换它。

import { useCallback, useEffect, useState } from 'react';

import type { ServiceEntry } from '../lib/twofas/types';
import type { VaultStore } from '../store/vault';

export interface VaultState {
  entries: ServiceEntry[];
  /** 首次读取尚未完成。 */
  loading: boolean;
  /** 读取失败时的中文说明；成功即为 null。 */
  error: string | null;
  /** 用一批新条目整体替换保险库（D3）。 */
  replaceEntries(entries: ServiceEntry[]): Promise<void>;
  /** 删除单条条目。 */
  removeEntry(id: string): Promise<void>;
  /** 按给定 id 次序重排并落盘。 */
  reorderEntries(orderedIds: string[]): Promise<void>;
  /** 重写单条条目（工卡显示名、是否推送）并落盘。 */
  updateEntry(entry: ServiceEntry): Promise<void>;
  /** 清除全部本地数据（D12）。 */
  eraseAll(): Promise<void>;
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export function useVault(store: VaultStore): VaultState {
  const [entries, setEntries] = useState<ServiceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    store.load().then(
      (loaded) => {
        if (cancelled) {
          return;
        }
        setEntries(loaded);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) {
          return;
        }
        // 读不出来就停在空列表 + 错误提示，绝不把界面变成空白（D8）。
        setError(describe(cause, '读取本地数据失败'));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store]);

  // 先落盘再更新内存：写失败时抛给调用方，内存里的旧条目原样保留（D8）。
  const replaceEntries = useCallback(
    async (next: ServiceEntry[]) => {
      await store.replaceAll(next);
      setEntries(next);
      setError(null);
    },
    [store],
  );

  // 同样是先落盘再更新内存：删除失败时条目原样留在列表里，不会出现
  // “界面上没了、刷新又回来”的假象。
  const removeEntry = useCallback(
    async (id: string) => {
      await store.remove(id);
      setEntries((current) => current.filter((entry) => entry.id !== id));
      setError(null);
    },
    [store],
  );

  const reorderEntries = useCallback(
    async (orderedIds: string[]) => {
      await store.reorder(orderedIds);
      setEntries((current) => {
        const remaining = new Map(current.map((entry) => [entry.id, entry]));
        const next: ServiceEntry[] = [];
        for (const id of orderedIds) {
          const entry = remaining.get(id);
          if (entry !== undefined) {
            next.push(entry);
            remaining.delete(id);
          }
        }
        // orderedIds 没提到的条目按原相对次序缀在后面，绝不因重排而丢条目。
        return [...next, ...remaining.values()];
      });
      setError(null);
    },
    [store],
  );

  // 同样先落盘再更新内存：写失败时界面上还是旧值，不会出现"改了又变回去"。
  const updateEntry = useCallback(
    async (next: ServiceEntry) => {
      await store.update(next);
      setEntries((current) =>
        current.map((entry) => (entry.id === next.id ? next : entry)),
      );
      setError(null);
    },
    [store],
  );

  const eraseAll = useCallback(async () => {
    await store.erase();
    setEntries([]);
    setError(null);
  }, [store]);

  return {
    entries,
    loading,
    error,
    replaceEntries,
    removeEntry,
    reorderEntries,
    updateEntry,
    eraseAll,
  };
}
