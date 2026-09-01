import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from '../App';
import { generateTotp } from '../lib/totp';
import type { ServiceEntry } from '../lib/twofas/types';
import type { SettingsStore } from '../store/settings';
import type { VaultStore } from '../store/vault';

/** RFC 6238 的官方测试密钥；不是任何真实账号（D17）。 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const TOTP_ENTRY: ServiceEntry = {
  id: 'rfc-sha1',
  name: 'RFC 6238',
  issuer: 'RFC',
  account: 'sha1@example.test',
  secret: RFC_SECRET,
  algorithm: 'SHA1',
  digits: 8,
  period: 30,
  tokenType: 'TOTP',
  unsupportedReason: null,
};

function fakeVault(entries: ServiceEntry[]): VaultStore {
  return {
    load: vi.fn<VaultStore['load']>().mockResolvedValue(entries),
    replaceAll: vi.fn<VaultStore['replaceAll']>().mockResolvedValue(undefined),
    remove: vi.fn<VaultStore['remove']>().mockResolvedValue(undefined),
    reorder: vi.fn<VaultStore['reorder']>().mockResolvedValue(undefined),
    update: vi.fn<VaultStore['update']>().mockResolvedValue(undefined),
    erase: vi.fn<VaultStore['erase']>().mockResolvedValue(undefined),
  };
}

function fakeSettings(offsetSec = 0): SettingsStore {
  return {
    getClockOffsetSec: vi.fn<SettingsStore['getClockOffsetSec']>().mockResolvedValue(offsetSec),
    setClockOffsetSec: vi.fn<SettingsStore['setClockOffsetSec']>().mockResolvedValue(undefined),
  };
}

/** 假定时器下推进真实的微任务/IO 队列：crypto.subtle 的 Promise 不受假定时器影响。 */
async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    });
  }
}

/**
 * 推进队列直到条件成立。
 *
 * 固定轮数的 settle() 不可靠：crypto.subtle 是真正的异步，整套测试并行跑、机器
 * 负载高的时候，几轮 setImmediate 未必轮得到它，断言就会读到上一周期的旧验证码
 * （表现为偶发失败，单独跑这个文件又永远复现不了）。
 */
async function settleUntil(predicate: () => boolean, maxRounds = 60): Promise<void> {
  for (let index = 0; index < maxRounds; index += 1) {
    if (predicate()) {
      return;
    }
    await settle(1);
  }
}

/** 当前显示的验证码（两个半段拼起来）。 */
function shownCode(): string {
  return screen.getByTestId('token-code').textContent ?? '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SettingsPanel', () => {
  it('persists the clock offset and shifts the computed code', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // 设备时钟停在第 0 个周期内；偏移 +30 秒后落到 T=59s 的 RFC 向量上。
    vi.setSystemTime(29_000);

    const vault = fakeVault([TOTP_ENTRY]);
    const settings = fakeSettings(0);
    render(<App vault={vault} settings={settings} />);
    await settle();

    const before = await generateTotp(TOTP_ENTRY, 0);
    await settleUntil(() => shownCode() === before);
    expect(screen.getByTestId('token-code')).toHaveTextContent(before);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByLabelText('时钟偏移（秒）'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '保存偏移' }));

    // 偏移后的时刻 59_000ms 落在第 1 个周期：RFC 6238 SHA1 / 8 位 → 94287082。
    await settleUntil(() => shownCode() === '94287082');

    expect(settings.setClockOffsetSec).toHaveBeenCalledWith(30);
    expect(screen.getByTestId('token-code')).toHaveTextContent('94287082');
    expect('94287082').not.toBe(before);
  });

  it('erases all data only after confirmation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(59_000);

    const vault = fakeVault([TOTP_ENTRY]);
    const settings = fakeSettings(0);
    render(<App vault={vault} settings={settings} />);
    await settle();
    expect(screen.getByTestId('token-card')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '清除全部本地数据' }));
    // 只是进入确认步骤，还没有清任何东西（D12）。
    expect(vault.erase).not.toHaveBeenCalled();
    expect(screen.getByTestId('token-card')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认清除' }));
    await settle();

    expect(vault.erase).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('token-card')).toBeNull();
  });
});
