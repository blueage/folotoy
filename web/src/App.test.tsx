import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import App from './App';
import type { ServiceEntry } from './lib/twofas/types';
import type { SettingsStore } from './store/settings';
import type { VaultStore } from './store/vault';

const ENTRY: ServiceEntry = {
  id: 'github',
  name: 'GitHub',
  issuer: 'GitHub',
  account: 'octocat',
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  algorithm: 'SHA1',
  digits: 6,
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

function fakeSettings(): SettingsStore {
  return {
    getClockOffsetSec: vi.fn<SettingsStore['getClockOffsetSec']>().mockResolvedValue(0),
    setClockOffsetSec: vi.fn<SettingsStore['setClockOffsetSec']>().mockResolvedValue(undefined),
  };
}

describe('App', () => {
  it('renders the empty state before any import', async () => {
    render(<App vault={fakeVault([])} settings={fakeSettings()} />);

    // 页面标题已按要求移除，不再有 h1。
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('token-card')).toBeNull();
  });

  it('exposes 导入备份 / 设置 as small footer links, not a header', async () => {
    render(<App vault={fakeVault([ENTRY])} settings={fakeSettings()} />);
    await waitFor(() => {
      expect(screen.getByTestId('token-card')).toBeInTheDocument();
    });

    const importLink = screen.getByRole('button', { name: '导入备份' });
    const settingsLink = screen.getByRole('button', { name: '设置' });

    // 两个入口都在页脚里，且是弱化的小号文字而非实心按钮。
    const footer = importLink.closest('footer');
    expect(footer).not.toBeNull();
    expect(settingsLink.closest('footer')).toBe(footer);
    expect(importLink.className).toContain('text-xs');
    expect(importLink.className).not.toContain('bg-sky-600');
  });

  it('renders the stored entries once the vault has loaded', async () => {
    render(<App vault={fakeVault([ENTRY])} settings={fakeSettings()} />);

    await waitFor(() => {
      expect(screen.getByTestId('token-card')).toBeInTheDocument();
    });
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('octocat')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state')).toBeNull();
  });

  it('deletes an entry through the vault and drops it from the list', async () => {
    const second: ServiceEntry = {
      ...ENTRY,
      id: 'gitlab',
      name: 'GitLab',
      issuer: 'GitLab',
      account: 'alice',
    };
    const vault = fakeVault([ENTRY, second]);
    render(<App vault={vault} settings={fakeSettings()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('token-row')).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByTestId('delete-button')[0]!);
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => {
      expect(vault.remove).toHaveBeenCalledWith('github');
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('token-row')).toHaveLength(1);
    });
    expect(screen.queryByText('octocat')).toBeNull();
  });

  it('persists a keyboard reorder through the vault', async () => {
    const second: ServiceEntry = {
      ...ENTRY,
      id: 'gitlab',
      name: 'GitLab',
      issuer: 'GitLab',
      account: 'alice',
    };
    const vault = fakeVault([ENTRY, second]);
    render(<App vault={vault} settings={fakeSettings()} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('drag-handle')).toHaveLength(2);
    });

    fireEvent.keyDown(screen.getAllByTestId('drag-handle')[0]!, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(vault.reorder).toHaveBeenCalledWith(['gitlab', 'github']);
    });
  });

  it('surfaces a banner when deleting fails, keeping the entry visible', async () => {
    const vault = fakeVault([ENTRY]);
    vault.remove = vi.fn<VaultStore['remove']>().mockRejectedValue(new Error('boom'));
    render(<App vault={vault} settings={fakeSettings()} />);

    await waitFor(() => {
      expect(screen.getByTestId('token-row')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('delete-button'));
    fireEvent.click(screen.getByTestId('delete-confirm'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('删除失败，条目仍在本地');
    });
    // 条目没有从界面上消失——不制造“删掉了”的假象。
    expect(screen.getByTestId('token-row')).toBeInTheDocument();
  });

  it('renders panels below the list, not above it', async () => {
    render(<App vault={fakeVault([ENTRY])} settings={fakeSettings()} />);
    await waitFor(() => {
      expect(screen.getByTestId('token-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    const list = screen.getByTestId('token-list');
    const panel = screen.getByRole('heading', { name: '设置' }).closest('section');
    expect(panel).not.toBeNull();

    // 面板出现在列表之后：放在前面会把整张列表往下推，视线和滚动位置都被打乱。
    const position = list.compareDocumentPosition(panel!);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('types straight into the search box without clicking it first', async () => {
    render(<App vault={fakeVault([ENTRY])} settings={fakeSettings()} />);
    await waitFor(() => {
      expect(screen.getByTestId('token-list')).toBeInTheDocument();
    });

    const search = screen.getByLabelText('搜索');
    expect(document.activeElement).not.toBe(search);

    fireEvent.keyDown(window, { key: 'g' });

    expect(document.activeElement).toBe(search);
  });

  it('does not hijack typing while a panel is open', async () => {
    render(<App vault={fakeVault([ENTRY])} settings={fakeSettings()} />);
    await waitFor(() => {
      expect(screen.getByTestId('token-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const search = screen.getByLabelText('搜索');
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(window, { key: 'g' });

    // 面板里有自己的输入框（时钟偏移），键盘要让给它。
    expect(document.activeElement).not.toBe(search);
  });

  it('opens the import dialog from the footer link', async () => {
    render(<App vault={fakeVault([])} settings={fakeSettings()} />);
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '导入备份' }));
    expect(screen.getByRole('dialog', { name: '导入 2FAS 备份' })).toBeInTheDocument();
  });
});
