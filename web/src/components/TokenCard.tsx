// 单条令牌卡片：发行方/账号、分组显示的验证码、剩余秒数，点击复制区复制验证码（D15）。
// 不受支持的条目只显示徽章与原因，绝不显示占位码或可能算错的码（D13）。
//
// 行的结构是「拖拽手柄 + 复制区 + 删除区」三块：复制区本身是 <button>，
// 因此删除按钮和手柄必须是它的兄弟节点而不是子节点——按钮不能嵌套按钮。

import { useCallback, useEffect, useRef, useState } from 'react';

import { canGenerateTotp, generateTotp, periodProgress } from '../lib/totp';
import type { ServiceEntry } from '../lib/twofas/types';
import ServiceIcon, { iconAccent } from './ServiceIcon';

/** 不受支持条目的徽章文案（D13）。 */
export const UNSUPPORTED_BADGE = '不支持';

/** 复制成功提示的停留时长（毫秒）。剪贴板本身永不自动清空（D15）。 */
const COPIED_HINT_MS = 1500;

/** 倒计时圆环的半径与周长；用 SVG 属性表达进度，避免行内 style（CSP 只允许 'self' 样式，D11）。 */
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 进入这个剩余秒数后，验证码与圆环转红，提示「快过期了，别再拿去粘贴」。
 * remainingSec 是 Math.ceil 的结果，取值 1..period，因此 <= 5 覆盖最后五秒。
 */
const URGENT_THRESHOLD_SEC = 5;

/**
 * 整行品牌色的浓度，独立于图标那块的 TINT_OPACITY。
 *
 * 两者刻意不共用：行的面积比图标大得多，同样的浓度铺满整行会明显更重。
 */
const ROW_TINT_OPACITY = '0.05';

/**
 * 删除按钮：绝对定位在行的右上角，平时完全隐形，鼠标移到那个角上才浮现。
 *
 * 几点讲究：
 * - **绝对定位**，因此完全不占布局位置——之前用 opacity 隐藏虽然看不见，但仍然
 *   占着一格宽度，把右侧的验证码往左挤；
 * - 只对**自身**的 hover 生效（不是整行的 group-hover）：鼠标划过行的其它地方
 *   不会让它冒出来，符合"移到右上角才显示"；
 * - 隐形时保留 pointer-events，否则它自己永远收不到 hover、也就永远显不出来。
 *   误触的代价很低：删除要两步确认；
 * - 触屏没有 hover，(hover: none) 下降级为常驻半透明，否则那里的用户够不到它；
 * - 键盘 Tab 到它时也要显形，否则会出现"能聚焦但看不见"的状态。
 */
const CORNER_DELETE =
  'absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded ' +
  'opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 ' +
  '[@media(hover:none)]:opacity-40';

/** 拖拽排序所需的状态与回调。省略即该行不可拖拽（例如搜索过滤生效时）。 */
export interface TokenCardDrag {
  /** 本行正被拖动。 */
  dragging: boolean;
  /** 落点指示线画在本行的哪一侧；null 表示本行不是落点。 */
  dropEdge: 'top' | 'bottom' | null;
  onStart(id: string): void;
  /** 拖拽悬停在本行上方（由 dragOver 驱动，比 dragEnter 更可靠）。 */
  onOver(id: string): void;
  onEnd(): void;
  onDrop(): void;
  /** 键盘排序：-1 上移，1 下移。 */
  onMove(id: string, delta: -1 | 1): void;
}

export interface TokenCardProps {
  entry: ServiceEntry;
  /** 计算验证码的时刻（毫秒），调用方已叠加时钟偏移（D16）。 */
  nowMs: number;
  onDelete(id: string): void;
  drag?: TokenCardDrag;
}

/** 把验证码对半分组，只为可读性；两段之间靠间距区分，textContent 仍是完整验证码。 */
function groupCode(code: string): [string, string] {
  const half = Math.ceil(code.length / 2);
  return [code.slice(0, half), code.slice(half)];
}

/** 卡片标题：优先发行方，其次服务名。 */
function titleOf(entry: ServiceEntry): string {
  return entry.issuer ?? entry.name;
}

export default function TokenCard({ entry, nowMs, onDelete, drag }: TokenCardProps) {
  const supported = canGenerateTotp(entry);
  const { remainingSec, fraction } = periodProgress(entry, nowMs);
  const urgent = remainingSec <= URGENT_THRESHOLD_SEC;
  // 只按“当前周期”重算：周期内每秒的 tick 不触发多余的 crypto 调用，
  // 周期一翻转 counter 就变，验证码在一秒内跟着换（D15）。
  const counter = Math.floor(nowMs / 1000 / entry.period);
  const periodStartMs = counter * entry.period * 1000;

  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!supported) {
      setCode(null);
      return;
    }
    let cancelled = false;
    generateTotp(entry, periodStartMs).then(
      (next) => {
        if (!cancelled) {
          setCode(next);
        }
      },
      () => {
        // 算不出来就退回“无验证码”，宁可不显示也不显示错的（D13）。
        if (!cancelled) {
          setCode(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entry, supported, periodStartMs]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    if (code === null) {
      return;
    }
    const showHint = (ok: boolean): void => {
      setCopied(ok);
      setCopyFailed(!ok);
      if (copiedTimer.current !== null) {
        clearTimeout(copiedTimer.current);
      }
      // 只是收起提示；剪贴板内容不做任何清理（D15）。
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
        setCopyFailed(false);
      }, COPIED_HINT_MS);
    };

    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      showHint(false);
      return;
    }
    clipboard.writeText(code).then(
      () => {
        showHint(true);
      },
      () => {
        showHint(false);
      },
    );
  }, [code]);

  const heading = (
    <div className="min-w-0 text-left">
      {/* 条目名是这一行的主标识，加大加粗；账号只是备注，样式保持不变。 */}
      <p className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
        {titleOf(entry)}
      </p>
      {entry.account !== null && (
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{entry.account}</p>
      )}
    </div>
  );

  // 图标绝对定位、倾斜 10°、远大于行高，四个角都被行的 overflow-hidden 裁掉。
  //
  // 尺寸是算出来的，不是试出来的。设边长 s、行高 h，绕中心转 θ=10°：
  // 右上角相对中心的垂直偏移是 (s/2)·(cosθ - sinθ) ≈ 0.41s，行的半高是 0.5h，
  // 因此**只有 s > 1.22h 时右上/右下角才会被上下边裁掉**。取 160% 是为了越过这个
  // 阈值足够多（0.41×1.6h = 0.66h vs 0.5h），裁切明显、不至于擦边。
  //
  // 其余几点：
  // - 绝对定位是前提：图标不参与行高计算，行高只由文字决定，图标才可能"比行高大"；
  // - h-[160%] 相对行高取值，行高以后怎么变都自动跟随，不用回来改死数字；
  //   aspect-square 让宽度跟随高度（百分比宽度会按行宽算，那是错的）；
  // - -left-3 把方块往左推：旋转后左边缘是一条斜线，不外推的话左上/左下会露出
  //   两个三角形空隙；推出去再裁掉，左边就是一条干净的直边。
  const ICON_BOX = 'absolute -left-3 top-1/2 h-[160%] aspect-square -translate-y-1/2 rotate-[10deg]';

  // 图标本身就是拖拽把手（不再有独立的点阵手柄）。
  // 搜索过滤时不可排序，此时退化成一个纯展示的 span。
  const icon =
    drag === undefined ? (
      <span className={ICON_BOX}>
        <ServiceIcon entry={entry} className="block h-full w-full" />
      </span>
    ) : (
      <button
        type="button"
        data-testid="drag-handle"
        draggable
        aria-label={`拖动排序：${titleOf(entry)}，或用方向键上下移动`}
        onDragStart={(event) => {
          // 默认拖影只有图标那一块，换成整行更容易看清在拖什么。
          //
          // setDragImage 的后两个参数是"光标落在拖影里的哪个点"。给 (0,0) 等于把
          // 整行的左上角对齐到光标，行就会整个跳到光标的右下方。传光标在行内的实际
          // 相对坐标，拖影才会稳稳停在提起它的位置、不产生跳动。
          if (rowRef.current !== null) {
            const rect = rowRef.current.getBoundingClientRect();
            event.dataTransfer.setDragImage(
              rowRef.current,
              event.clientX - rect.left,
              event.clientY - rect.top,
            );
          }
          event.dataTransfer.effectAllowed = 'move';
          // Firefox 不设 data 就不会触发后续的 drag 事件。
          event.dataTransfer.setData('text/plain', entry.id);
          drag.onStart(entry.id);
        }}
        onDragEnd={drag.onEnd}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            drag.onMove(entry.id, -1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            drag.onMove(entry.id, 1);
          }
        }}
        className={`${ICON_BOX} cursor-grab active:cursor-grabbing`}
      >
        {/* 无障碍名称在按钮上，图标本身按装饰处理，避免读屏重复播报。 */}
        <ServiceIcon entry={entry} className="block h-full w-full" decorative />
      </button>
    );

  // 确认态浮在右上角、向左展开；此时不再隐形，鼠标移开也不会消失。
  const deleteControl = confirmingDelete ? (
    <div className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded bg-white/95 p-0.5 shadow-sm dark:bg-slate-900/95">
      <button
        type="button"
        data-testid="delete-confirm"
        onClick={() => {
          setConfirmingDelete(false);
          onDelete(entry.id);
        }}
        className="rounded bg-rose-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-rose-500"
      >
        确认删除
      </button>
      <button
        type="button"
        data-testid="delete-cancel"
        onClick={() => {
          setConfirmingDelete(false);
        }}
        className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700"
      >
        取消
      </button>
    </div>
  ) : (
    <button
      type="button"
      data-testid="delete-button"
      aria-label={`删除 ${titleOf(entry)}`}
      onClick={() => {
        setConfirmingDelete(true);
      }}
      className={`${CORNER_DELETE} text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950 dark:hover:text-rose-400`}
    >
      <svg viewBox="0 0 20 20" className="h-3 w-3" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M5 5l10 10M15 5L5 15" />
      </svg>
    </button>
  );

  // 落点指示线是一个绝对定位的元素：不占布局、不改变行的几何。
  // 这一点很关键——拖拽过程中行的尺寸/位置一旦变化，光标下的元素就会跟着变，
  // 又会引出新一轮 dragOver，造成来回抖动。
  const dropEdge = drag?.dropEdge ?? null;
  const rowClasses = [
    // relative 是图标、落点指示线、右上角删除按钮三者绝对定位的基准。
    //
    // isolate（isolation: isolate）不能省：position: relative 在 z-index 为 auto 时
    // **不创建层叠上下文**，rowTint 的 -z-10 就会跑到更外层去，在绘制顺序上排在本行
    // bg-white 之前，被这层不透明白底整个盖住——表现是"底色根本没变"。
    // 有了 isolate，负层子元素才绘制在本行背景之上、内容之下。
    // overflow-hidden 负责裁掉超出行高的图标，并让图标跟随行的圆角。
    // pl-28 给绝对定位的图标让出位置：行高约 72px → 边长约 115px，左移 12px 后
    // 右缘落在 103px，112px 的内边距刚好清开，文字不会压到图标上。
    'relative isolate flex items-center justify-between gap-3 overflow-hidden rounded-lg border border-slate-200 bg-white py-2 pl-28 pr-2 dark:border-slate-800 dark:bg-slate-900',
    drag?.dragging === true ? 'opacity-40' : '',
  ]
    .filter((cls) => cls.length > 0)
    .join(' ');

  /*
    整行铺一层与图标底色同源的品牌色。

    走 SVG 的 fill 而不是 CSS：颜色随条目而变，Tailwind 表达不了任意 hex，
    而 CSP 不含 'unsafe-inline'、行内 style 会被浏览器拦掉（与图标同一个约束）。

    -z-10 让它落在行内所有内容之下：绝对定位元素默认会盖在静态兄弟节点之上，
    不压到负层的话文字和验证码都会被这层色挡住。
    行自身的 bg-white / dark:bg-slate-900 仍在最底下，所以深色模式下叠出来的是
    「深色 + 品牌色」，不会变成刺眼的白底。
  */
  const rowTint = (
    <svg
      data-testid="row-tint"
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox="0 0 1 1"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
    >
      <rect width="1" height="1" fill={iconAccent(entry)} fillOpacity={ROW_TINT_OPACITY} />
    </svg>
  );

  // 指示线画在行内边缘：行有 overflow-hidden，画到行外会被裁掉看不见。
  const dropIndicator =
    dropEdge === null ? null : (
      <span
        data-testid="drop-indicator"
        data-edge={dropEdge}
        aria-hidden="true"
        className={
          dropEdge === 'top'
            ? 'pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-sky-500 dark:bg-sky-400'
            : 'pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-sky-500 dark:bg-sky-400'
        }
      />
    );

  const rowDragProps =
    drag === undefined
      ? {}
      : {
          onDragOver: (event: React.DragEvent) => {
            // 不 preventDefault 就不会触发 drop。
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move' as const;
            drag.onOver(entry.id);
          },
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            drag.onDrop();
          },
        };

  const body = !supported ? (
    <div
      data-testid="token-card"
      className="flex min-w-0 flex-1 items-center justify-between gap-3 px-2 py-0"
    >
      {heading}
      <div className="text-right">
        <span
          data-testid="token-unsupported"
          className="inline-block rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
        >
          {UNSUPPORTED_BADGE}
        </span>
        {entry.unsupportedReason !== null && (
          <p className="mt-1 max-w-[16rem] text-xs text-slate-500 dark:text-slate-400">
            {entry.unsupportedReason}
          </p>
        )}
      </div>
    </div>
  ) : (
    <button
      type="button"
      data-testid="token-card"
      onClick={handleCopy}
      disabled={code === null}
      aria-label={`复制 ${titleOf(entry)} 的验证码`}
      className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-2 py-0 text-left transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-slate-800"
    >
      {heading}
      <div className="flex items-center gap-3">
        <div className="text-right">
          {code === null ? (
            <span className="text-sm text-slate-400">计算中…</span>
          ) : (
            (() => {
              const [head, tail] = groupCode(code);
              return (
                <span
                  data-testid="token-code"
                  data-code={code}
                  data-urgent={urgent}
                  className={
                    urgent
                      ? 'flex gap-2 font-mono text-2xl tabular-nums tracking-widest text-red-600 dark:text-red-400'
                      : 'flex gap-2 font-mono text-2xl tabular-nums tracking-widest text-slate-900 dark:text-slate-100'
                  }
                >
                  <span>{head}</span>
                  <span>{tail}</span>
                </span>
              );
            })()
          )}
          <span
            data-testid="token-copied"
            aria-live="polite"
            className="block text-xs text-emerald-600 dark:text-emerald-400"
          >
            {copied && '已复制'}
            {copyFailed && '复制失败，请手动选取'}
          </span>
        </div>
        <span
          data-testid="token-countdown"
          title={`${remainingSec} 秒后更新`}
          className="relative flex h-6 w-6 shrink-0 items-center justify-center"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="2"
              className="stroke-slate-200 dark:stroke-slate-700"
            />
            <circle
              cx="12"
              cy="12"
              r={RING_RADIUS}
              fill="none"
              strokeWidth="2"
              strokeDasharray={`${(RING_CIRCUMFERENCE * fraction).toFixed(3)} ${RING_CIRCUMFERENCE.toFixed(3)}`}
              className={urgent ? 'stroke-red-500' : 'stroke-sky-500'}
            />
          </svg>
          <span className="sr-only">{`剩余 ${remainingSec} 秒`}</span>
        </span>
      </div>
    </button>
  );

  return (
    <li ref={rowRef} data-testid="token-row" className={rowClasses} {...rowDragProps}>
      {rowTint}
      {dropIndicator}
      {icon}
      {body}
      {deleteControl}
    </li>
  );
}
