// 工卡面板的行为：连接、挑条目、改工卡显示名、推送与清空。
// 全程用假工卡（src/lib/badge/fakeBadge.ts），不需要真实蓝牙。

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FakeBadge, fakeConnection } from '../lib/badge/fakeBadge';
import type { ServiceEntry } from '../lib/twofas/types';
import BadgePanel from './BadgePanel';

const NOW = 1700000000;

function makeEntry(overrides: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    id: 'id-1',
    name: 'GitHub',
    issuer: 'GitHub',
    account: 'me@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    tokenType: 'TOTP',
    unsupportedReason: null,
    ...overrides,
  };
}

function renderPanel(entries: ServiceEntry[], badge = new FakeBadge()) {
  const onUpdateEntry = vi.fn();
  render(
    <BadgePanel
      entries={entries}
      onUpdateEntry={onUpdateEntry}
      onClose={() => undefined}
      connect={() => Promise.resolve(fakeConnection(badge))}
      nowSec={() => NOW}
    />,
  );
  return { badge, onUpdateEntry };
}

async function connect(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '连接工卡' }));
  await screen.findByText('FoloPass-TEST');
}

describe('BadgePanel', () => {
  it('连接后显示工卡状态', async () => {
    const badge = new FakeBadge({ stored: 3 });
    renderPanel([makeEntry()], badge);
    await connect();

    expect(screen.getByText('3 / 30')).toBeInTheDocument();
    // 卡上没时间时必须说清后果，而不只是"未同步"三个字。
    expect(screen.getByText('未同步（卡上不会显示验证码）')).toBeInTheDocument();
  });

  it('推送把勾选的条目按列表顺序送到工卡', async () => {
    const { badge } = renderPanel([
      makeEntry({ id: 'a', name: 'GitHub', issuer: 'GitHub' }),
      makeEntry({ id: 'b', name: 'AWS', issuer: 'AWS' }),
    ]);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: '推送 2 条到工卡' }));
    await screen.findByText(/已推送 2 条/);

    expect(badge.received.map((item) => item.label)).toEqual(['GitHub', 'AWS']);
    expect(badge.timeSec).toBe(NOW);
  });

  it('取消勾选的条目不会被推上去', async () => {
    const { badge } = renderPanel([
      makeEntry({ id: 'a', name: 'GitHub', issuer: 'GitHub' }),
      makeEntry({ id: 'b', name: 'AWS', issuer: 'AWS', badgeEnabled: false }),
    ]);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: '推送 1 条到工卡' }));
    await screen.findByText(/已推送 1 条/);
    expect(badge.received.map((item) => item.label)).toEqual(['GitHub']);
  });

  it('勾选状态的改动落到保险库', async () => {
    const { onUpdateEntry } = renderPanel([makeEntry()]);
    fireEvent.click(screen.getByRole('checkbox', { name: '推送 GitHub' }));
    expect(onUpdateEntry).toHaveBeenCalledWith(expect.objectContaining({ badgeEnabled: false }));
  });

  it('工卡显示名在失焦时保存，并去掉工卡显示不了的字符', () => {
    const { onUpdateEntry } = renderPanel([makeEntry()]);
    const input = screen.getByRole('textbox', { name: 'GitHub 在工卡上的名字' });
    fireEvent.change(input, { target: { value: '微信 Pay' } });
    fireEvent.blur(input);
    expect(onUpdateEntry).toHaveBeenCalledWith(expect.objectContaining({ badgeLabel: 'Pay' }));
  });

  it('清空输入框等于回到自动推导的名字', () => {
    const { onUpdateEntry } = renderPanel([makeEntry({ badgeLabel: 'GH' })]);
    const input = screen.getByRole('textbox', { name: 'GitHub 在工卡上的名字' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onUpdateEntry).toHaveBeenCalledWith(expect.objectContaining({ badgeLabel: null }));
  });

  it('工卡放不下的条目显示原因，并拦住整批推送', async () => {
    const { badge } = renderPanel([
      makeEntry({ id: 'a', name: '支付宝', issuer: '支付宝', account: null }),
    ]);
    await connect();

    expect(
      screen.getByText('这条在工卡上没有可显示的名字，请手动填一个 ASCII 名字'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '推送 1 条到工卡' }));
    await screen.findByText(/请先取消勾选或修正/);
    expect(badge.received).toHaveLength(0);
  });

  it('保存 Wi-Fi 凭据后工卡状态变成已配置，密码不留在页面上', async () => {
    const { badge } = renderPanel([makeEntry()]);
    await connect();

    fireEvent.change(screen.getByRole('textbox', { name: /Wi-Fi 名称/ }), {
      target: { value: 'my-ap' },
    });
    const password = screen.getByLabelText('密码');
    fireEvent.change(password, { target: { value: 'hunter2hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存到工卡' }));

    await screen.findByText(/已保存 Wi-Fi/);
    expect(badge.wifiSsid).toBe('my-ap');
    expect(badge.wifiPassword).toBe('hunter2hunter2');
    // 口令已经在工卡上了，页面上留着只是多一处泄露面。
    expect((password as HTMLInputElement).value).toBe('');
  });

  it('关闭联网会把工卡上的凭据清掉', async () => {
    const badge = new FakeBadge();
    badge.wifiSsid = 'old-ap';
    renderPanel([makeEntry()], badge);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: '关闭联网' }));
    await screen.findByText(/已关闭开机联网对时/);
    expect(badge.wifiSsid).toBe('');
  });

  it('推送时把浏览器时区带给工卡', async () => {
    const { badge } = renderPanel([makeEntry()]);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: '推送 1 条到工卡' }));
    await screen.findByText(/已推送 1 条/);
    // jsdom 默认 UTC，取反后仍是 0；关键是这个字段确实被写了。
    expect(badge.tzOffsetMin).toBe(-new Date().getTimezoneOffset());
  });

  it('设置里的时钟偏移会叠加到推给工卡的时间上', async () => {
    const badge = new FakeBadge();
    render(
      <BadgePanel
        entries={[makeEntry()]}
        onUpdateEntry={vi.fn()}
        onClose={() => undefined}
        connect={() => Promise.resolve(fakeConnection(badge))}
        nowSec={() => NOW}
        clockOffsetSec={6}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '连接工卡' }));
    await screen.findByText('FoloPass-TEST');

    fireEvent.click(screen.getByRole('button', { name: '推送 1 条到工卡' }));
    await screen.findByText(/已推送 1 条/);
    // 工卡上的时间要比浏览器快 6 秒——这正是"网页显示的码和工卡一致"的前提。
    expect(badge.timeSec).toBe(NOW + 6);
  });

  it('清空工卡需要二次确认', async () => {
    const { badge } = renderPanel([makeEntry()]);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: '清空工卡' }));
    expect(badge.wiped).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '确认清空工卡' }));
    await screen.findByText(/已全部清除/);
    expect(badge.wiped).toBe(true);
  });

  it('只对时不动条目', async () => {
    const { badge } = renderPanel([makeEntry()]);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: '只对时' }));
    await screen.findByText(/已把当前时间同步给工卡/);
    expect(badge.timeSec).toBe(NOW);
    expect(badge.received).toHaveLength(0);
  });

  it('连接失败时把原因显示出来，而不是停在"正在连接"', async () => {
    render(
      <BadgePanel
        entries={[makeEntry()]}
        onUpdateEntry={vi.fn()}
        onClose={() => undefined}
        connect={() => Promise.reject(new Error('没有选择工卡。'))}
        nowSec={() => NOW}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '连接工卡' }));
    await screen.findByText('没有选择工卡。');
    expect(screen.getByRole('button', { name: '连接工卡' })).toBeInTheDocument();
  });

  it('工卡走远断链后回到未连接状态', async () => {
    const badge = new FakeBadge();
    const disconnectListeners: (() => void)[] = [];
    render(
      <BadgePanel
        entries={[makeEntry()]}
        onUpdateEntry={vi.fn()}
        onClose={() => undefined}
        connect={() =>
          Promise.resolve({
            link: badge,
            name: 'FoloPass-TEST',
            disconnect: () => undefined,
            onDisconnected: (listener: () => void) => {
              disconnectListeners.push(listener);
              return () => undefined;
            },
          })
        }
        nowSec={() => NOW}
      />,
    );
    await connect();

    for (const listener of disconnectListeners) {
      listener();
    }
    await waitFor(() => {
      expect(screen.getByText('与工卡的连接已断开。')).toBeInTheDocument();
    });
  });
});
