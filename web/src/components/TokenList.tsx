// 令牌列表：搜索框 + 卡片列表 + 空状态（D15）。
// 条目级操作限于复制、删除与拖拽排序；仍然没有新增、编辑、分组（D2 已按用户要求放宽）。

import { useCallback, useMemo, useRef, useState } from 'react';

import { useTypeToSearch } from '../hooks/useTypeToSearch';
import type { ServiceEntry } from '../lib/twofas/types';
import EmptyState from './EmptyState';
import SearchBar from './SearchBar';
import TokenCard from './TokenCard';

export interface TokenListProps {
  entries: ServiceEntry[];
  /** 计算验证码的时刻（毫秒），已叠加时钟偏移（D16）。 */
  nowMs: number;
  onImportClick(): void;
  onDelete(id: string): void;
  /** 提交新的显示顺序（全量 id 数组）。 */
  onReorder(orderedIds: string[]): void;
  /** 传 false 停用“直接打字即搜索”，例如导入对话框打开时。 */
  typeToSearchEnabled?: boolean;
}

/** 大小写不敏感地匹配发行方与账号；服务名同样参与匹配，否则没有发行方的条目一搜就消失。 */
function matches(entry: ServiceEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return [entry.issuer, entry.account, entry.name].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
}

/** 把 fromId 移到 toId 所在的位置，返回新的 id 顺序。 */
function moveTo(ids: string[], fromId: string, toId: string): string[] {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1 || from === to) {
    return ids;
  }
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

export default function TokenList({
  entries,
  nowMs,
  onImportClick,
  onDelete,
  onReorder,
  typeToSearchEnabled = true,
}: TokenListProps) {
  const [query, setQuery] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const clearQuery = useCallback(() => {
    setQuery('');
  }, []);

  // 直接打字就跳进搜索框；有对话框打开时（typeToSearchEnabled=false）让位给对话框。
  useTypeToSearch({ inputRef: searchRef, onEscape: clearQuery, enabled: typeToSearchEnabled });

  const filtering = query.trim().length > 0;
  const visible = useMemo(() => entries.filter((entry) => matches(entry, query)), [entries, query]);

  const commit = useCallback(
    (orderedIds: string[]) => {
      // 过滤时不允许排序，所以 visible 一定就是全部条目，可以直接整表提交。
      onReorder(orderedIds);
    },
    [onReorder],
  );

  // 落点只用一条指示线表示，行的次序在整个拖拽过程中保持不变。
  //
  // 千万不要在拖拽进行时重排 DOM：浏览器一旦发现被拖拽的源节点被移动，
  // 就会中止本次拖拽（表现为“排序无效”），而重排又会让光标下的元素随之改变、
  // 触发新一轮 dragEnter，形成来回震荡的抖动。松手后再整体提交才是稳的。
  const handleDrop = useCallback(() => {
    if (draggingId !== null && overId !== null && draggingId !== overId) {
      commit(
        moveTo(
          visible.map((entry) => entry.id),
          draggingId,
          overId,
        ),
      );
    }
    setDraggingId(null);
    setOverId(null);
  }, [draggingId, overId, visible, commit]);

  /** 落点在目标行的哪一侧：向下拖插到目标之后，向上拖插到目标之前。 */
  const dropEdgeFor = useCallback(
    (id: string): 'top' | 'bottom' | null => {
      if (draggingId === null || overId !== id || draggingId === id) {
        return null;
      }
      const ids = visible.map((entry) => entry.id);
      return ids.indexOf(draggingId) < ids.indexOf(id) ? 'bottom' : 'top';
    },
    [draggingId, overId, visible],
  );

  /** 键盘排序：把某条上移或下移一位。 */
  const handleMove = useCallback(
    (id: string, delta: -1 | 1) => {
      const ids = entries.map((entry) => entry.id);
      const from = ids.indexOf(id);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= ids.length) {
        return;
      }
      const next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, id);
      commit(next);
    },
    [entries, commit],
  );

  if (entries.length === 0) {
    return <EmptyState onImportClick={onImportClick} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
      {filtering && (
        <p data-testid="reorder-disabled-hint" className="px-1 text-xs text-slate-500">
          搜索状态下不能调整顺序，清空搜索后即可拖动。
        </p>
      )}
      {visible.length === 0 ? (
        <p data-testid="no-match" className="px-1 py-6 text-center text-sm text-slate-500">
          没有匹配的条目
        </p>
      ) : (
        <ul data-testid="token-list" className="flex flex-col gap-2">
          {visible.map((entry) => (
            <TokenCard
              key={entry.id}
              entry={entry}
              nowMs={nowMs}
              onDelete={onDelete}
              // 过滤时拖拽会得到一个只覆盖子集的顺序，语义含糊，因此直接不下发 drag。
              // exactOptionalPropertyTypes 下不能显式传 undefined，只能条件展开。
              {...(filtering
                ? {}
                : {
                    drag: {
                      dragging: draggingId === entry.id,
                      dropEdge: dropEdgeFor(entry.id),
                      onStart: (id: string) => {
                        setDraggingId(id);
                      },
                      // dragOver 每几十毫秒就触发一次，且会从子元素冒泡上来；
                      // 值没变就不 setState，避免无谓的重渲染。
                      onOver: (id: string) => {
                        setOverId((current) => (current === id ? current : id));
                      },
                      onEnd: () => {
                        setDraggingId(null);
                        setOverId(null);
                      },
                      onDrop: handleDrop,
                      onMove: handleMove,
                    },
                  })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
