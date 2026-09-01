// 工卡面板：连接、挑条目、改工卡上的显示名、整批推送。
//
// 三条刻意的设计，改动前请先了解：
//   1. **顺序不在这里改。** 工卡上的顺序就是主列表的顺序（拖拽图标调整），
//      在两个地方都能排序只会让"到底哪个说了算"变得没法回答。
//   2. **推送是整体替换。** 工卡侧只有 COMMIT 成功才生效，因此这里不做
//      "增量同步"的假象：勾中的条目就是推送后卡上的全部条目。
//   3. **连不上/推不动一律显示原因。** 蓝牙失败的形态太多（没进 SYNC 页、
//      浏览器不支持、走远了），只说"失败"用户无从下手。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type ConnectedBadge, connectBadge, isWebBluetoothAvailable } from '../lib/badge/ble';
import { effectiveBadgeLabel, isBadgeEnabled, toBadgeEntry } from '../lib/badge/entry';
import {
  BADGE_LABEL_MAX,
  BADGE_MAX_ENTRIES,
  BADGE_WIFI_PASS_MAX,
  BADGE_WIFI_SSID_MAX,
  sanitizeBadgeText,
} from '../lib/badge/limits';
import { WIFI_STATE_LABELS } from '../lib/badge/protocol';
import {
  type BadgeStatus,
  pushEntries,
  pushTime,
  readStatus,
  setWifiCredentials,
  wipeBadge,
} from '../lib/badge/sync';
import type { ServiceEntry } from '../lib/twofas/types';

export interface BadgePanelProps {
  /** 按显示顺序排列的全部条目；这个顺序就是推送后工卡上的顺序。 */
  entries: ServiceEntry[];
  onUpdateEntry(entry: ServiceEntry): void;
  onClose(): void;
  /** 建立连接的方式。默认走 Web Bluetooth；测试注入假链路。 */
  connect?: () => Promise<ConnectedBadge>;
  /** 取当前 Unix 秒。测试注入固定值。 */
  nowSec?: () => number;
}

type Phase = 'idle' | 'connecting' | 'ready' | 'working';

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function formatLastSync(lastSyncSec: number): string {
  if (lastSyncSec <= 0) {
    return '从未同步';
  }
  return new Date(lastSyncSec * 1000).toLocaleString();
}

export default function BadgePanel({
  entries,
  onUpdateEntry,
  onClose,
  connect = connectBadge,
  nowSec = () => Math.floor(Date.now() / 1000),
}: BadgePanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<BadgeStatus | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');

  // 连接握在 ref 里：它不参与渲染，放进 state 只会让每次状态更新都拖着它跑。
  const badgeRef = useRef<ConnectedBadge | null>(null);

  const dropConnection = useCallback(() => {
    badgeRef.current?.disconnect();
    badgeRef.current = null;
    setPhase('idle');
    setStatus(null);
    setDeviceName(null);
    setProgress(null);
  }, []);

  // 面板关掉就断链：让工卡回到"只广播、没人连着"的状态，别把连接吊着。
  useEffect(() => dropConnection, [dropConnection]);

  const rows = useMemo(
    () =>
      entries.map((entry) => ({
        entry,
        enabled: isBadgeEnabled(entry),
        label: effectiveBadgeLabel(entry),
        conversion: toBadgeEntry(entry),
      })),
    [entries],
  );

  const chosen = rows.filter((row) => row.enabled);
  const blocked = chosen.filter((row) => !row.conversion.ok);
  const capacity = status?.capacity ?? BADGE_MAX_ENTRIES;
  const overCapacity = chosen.length > capacity;

  const handleConnect = useCallback(async () => {
    setError(null);
    setNotice(null);
    setPhase('connecting');
    try {
      const badge = await connect();
      badgeRef.current = badge;
      setDeviceName(badge.name);
      badge.onDisconnected(() => {
        badgeRef.current = null;
        setPhase('idle');
        setStatus(null);
        setError('与工卡的连接已断开。');
      });
      setStatus(await readStatus(badge.link));
      setPhase('ready');
    } catch (cause) {
      dropConnection();
      setError(describe(cause, '连接工卡失败'));
    }
  }, [connect, dropConnection]);

  const runOnLink = useCallback(
    async (label: string, action: (badge: ConnectedBadge) => Promise<string>) => {
      const badge = badgeRef.current;
      if (badge === null) {
        setError('还没有连接工卡。');
        return;
      }
      setError(null);
      setNotice(null);
      setPhase('working');
      try {
        setNotice(await action(badge));
        setPhase('ready');
      } catch (cause) {
        setError(describe(cause, `${label}失败`));
        // 失败后连接通常还在（工卡只是拒收了这批数据），保持 ready 让用户能重试。
        setPhase(badgeRef.current === null ? 'idle' : 'ready');
      } finally {
        setProgress(null);
      }
    },
    [],
  );

  const handlePush = useCallback(() => {
    if (blocked.length > 0) {
      setError('有勾选的条目工卡放不下，请先取消勾选或修正它们。');
      return;
    }
    const payload = chosen.flatMap((row) => (row.conversion.ok ? [row.conversion.entry] : []));
    void runOnLink('推送', async (badge) => {
      const result = await pushEntries(badge.link, payload, {
        nowSec,
        onProgress: (sent, total) => {
          setProgress({ sent, total });
        },
      });
      setStatus(result.status);
      return `已推送 ${String(result.count)} 条到工卡，并顺带对好了时间。`;
    });
  }, [blocked.length, chosen, nowSec, runOnLink]);

  const handleTime = useCallback(() => {
    void runOnLink('对时', async (badge) => {
      await pushTime(badge.link, { nowSec });
      return '已把当前时间同步给工卡。';
    });
  }, [nowSec, runOnLink]);

  const handleSaveWifi = useCallback(() => {
    const ssid = wifiSsid.trim();
    void runOnLink('保存 Wi-Fi', async (badge) => {
      await setWifiCredentials(badge.link, ssid, wifiPassword);
      // 口令不留在页面状态里：它已经在工卡上了，这里留着只是多一处泄露面。
      setWifiPassword('');
      setStatus(await readStatus(badge.link));
      return ssid.length > 0
        ? `已保存 Wi-Fi「${ssid}」，工卡下次开机会自动对时。`
        : '已关闭开机联网对时。';
    });
  }, [runOnLink, wifiPassword, wifiSsid]);

  const handleWipe = useCallback(() => {
    setConfirmingWipe(false);
    void runOnLink('清空', async (badge) => {
      await wipeBadge(badge.link);
      setStatus((current) => (current === null ? null : { ...current, stored: 0 }));
      return '工卡上的令牌已全部清除。';
    });
  }, [runOnLink]);

  const commitLabel = useCallback(
    (entry: ServiceEntry, draft: string) => {
      const cleaned = sanitizeBadgeText(draft, BADGE_LABEL_MAX).text;
      setLabelDrafts((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
      // 清空输入框 = 回到自动推导的名字，因此存 null 而不是空串。
      const badgeLabel = cleaned.length > 0 ? cleaned : null;
      if (badgeLabel !== (entry.badgeLabel ?? null)) {
        onUpdateEntry({ ...entry, badgeLabel });
      }
    },
    [onUpdateEntry],
  );

  const busy = phase === 'connecting' || phase === 'working';

  return (
    <section
      aria-labelledby="badge-title"
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id="badge-title" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          同步到工卡
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          关闭
        </button>
      </div>

      {!isWebBluetoothAvailable() && (
        <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-300">
          这个浏览器不支持 Web Bluetooth。请在桌面版 Chrome / Edge 或安卓 Chrome
          中打开本页面（页面需为 HTTPS 或 localhost）。iOS Safari 不支持。
        </p>
      )}

      <ol className="mt-3 list-decimal pl-5 text-xs text-slate-500 dark:text-slate-400">
        <li>在工卡上长按「确定」进入 SYNC 页面，屏幕会显示 FoloPass-XXXX。</li>
        <li>点下面的「连接工卡」，在浏览器弹窗里选中同名设备。</li>
        <li>勾选要放到卡上的条目，点「推送」。推送是整体替换，卡上原有条目会被顶掉。</li>
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {phase === 'idle' ? (
          <button
            type="button"
            onClick={() => {
              void handleConnect();
            }}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            连接工卡
          </button>
        ) : (
          <button
            type="button"
            onClick={dropConnection}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
          >
            断开连接
          </button>
        )}

        <button
          type="button"
          disabled={phase !== 'ready' || chosen.length === 0 || overCapacity}
          onClick={handlePush}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          推送 {chosen.length} 条到工卡
        </button>

        <button
          type="button"
          disabled={phase !== 'ready'}
          onClick={handleTime}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
        >
          只对时
        </button>

        {confirmingWipe ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleWipe}
              className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-500"
            >
              确认清空工卡
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingWipe(false);
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={phase !== 'ready'}
            onClick={() => {
              setConfirmingWipe(true);
            }}
            className="rounded-lg border border-rose-300 px-3 py-2 text-sm text-rose-700 disabled:opacity-40 dark:border-rose-800 dark:text-rose-300"
          >
            清空工卡
          </button>
        )}
      </div>

      {busy && (
        <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-300">
          {phase === 'connecting' ? '正在连接工卡…' : '正在与工卡通信…'}
          {progress !== null && ` ${String(progress.sent)}/${String(progress.total)}`}
        </p>
      )}

      {status !== null && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
          <dt>工卡</dt>
          <dd>{deviceName ?? status.name}</dd>
          <dt>卡上条目</dt>
          <dd>
            {status.stored} / {status.capacity}
          </dd>
          <dt>卡上时间</dt>
          <dd>{status.timeValid ? '可用' : '未同步（卡上不会显示验证码）'}</dd>
          <dt>上次同步</dt>
          <dd>{formatLastSync(status.lastSyncSec)}</dd>
        </dl>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}
      {notice !== null && (
        <p role="status" className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">
          {notice}
        </p>
      )}


      <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-medium text-slate-900 dark:text-slate-100">
          开机自动对时（Wi-Fi）
        </h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          存一个 Wi-Fi 到工卡，它每次开机会连上去用 NTP 对一次时，
          <strong>对完立刻关掉 Wi-Fi</strong>，之后不再联网。不配也能用，只是每次断电后
          都要靠这个页面对时。密码经不加密的蓝牙链路下发，和令牌种子同等对待。
        </p>

        {status !== null && (
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            工卡当前：{status.wifiConfigured ? '已配置' : '未配置'} ·{' '}
            {WIFI_STATE_LABELS[status.wifiState] ?? `状态 ${String(status.wifiState)}`}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-300">
            Wi-Fi 名称（2.4 GHz）
            <input
              type="text"
              value={wifiSsid}
              maxLength={BADGE_WIFI_SSID_MAX}
              onChange={(event) => {
                setWifiSsid(event.target.value);
              }}
              className="w-48 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-700 dark:text-slate-300">
            密码
            <input
              type="password"
              value={wifiPassword}
              maxLength={BADGE_WIFI_PASS_MAX}
              onChange={(event) => {
                setWifiPassword(event.target.value);
              }}
              className="w-48 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </label>
          <button
            type="button"
            disabled={phase !== 'ready' || wifiSsid.trim().length === 0}
            onClick={handleSaveWifi}
            className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            保存到工卡
          </button>
          <button
            type="button"
            disabled={phase !== 'ready'}
            onClick={() => {
              setWifiSsid('');
              setWifiPassword('');
              void runOnLink('关闭 Wi-Fi', async (badge) => {
                await setWifiCredentials(badge.link, '', '');
                setStatus(await readStatus(badge.link));
                return '已关闭开机联网对时。';
              });
            }}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            关闭联网
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          ESP32-C3 只支持 2.4 GHz；5 GHz 的网络工卡看不见。
        </p>
      </div>

      <div className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-slate-900 dark:text-slate-100">
            要放到卡上的条目
          </h3>
          <span
            className={`text-xs ${
              overCapacity ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'
            }`}
          >
            已选 {chosen.length} / 上限 {capacity}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          卡上的顺序就是这里的顺序；要改顺序请在上面的列表里拖拽图标。工卡只有拉丁字体，
          中文名会被自动去掉，请给这类条目手填一个 ASCII 名字。
        </p>

        {entries.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            还没有条目。先导入备份文件。
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.entry.id}
                className="flex flex-wrap items-center gap-2 rounded border border-slate-200 px-2 py-2 dark:border-slate-800"
              >
                <input
                  type="checkbox"
                  checked={row.enabled}
                  aria-label={`推送 ${row.entry.name}`}
                  onChange={(event) => {
                    onUpdateEntry({ ...row.entry, badgeEnabled: event.target.checked });
                  }}
                  className="h-4 w-4"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-slate-200">
                  {row.entry.name}
                </span>
                <input
                  type="text"
                  value={labelDrafts[row.entry.id] ?? row.label}
                  maxLength={BADGE_LABEL_MAX}
                  aria-label={`${row.entry.name} 在工卡上的名字`}
                  onChange={(event) => {
                    const value = event.target.value;
                    setLabelDrafts((current) => ({ ...current, [row.entry.id]: value }));
                  }}
                  onBlur={(event) => {
                    commitLabel(row.entry, event.target.value);
                  }}
                  className="w-40 rounded border border-slate-300 px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                {!row.conversion.ok && (
                  <span className="w-full text-xs text-rose-600 dark:text-rose-400">
                    {row.conversion.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
