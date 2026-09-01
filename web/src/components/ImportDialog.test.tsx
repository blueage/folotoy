import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { encryptField } from '../lib/twofas/crypto';
import { joinEncryptedField } from '../lib/twofas/parse';
import { TWOFAS_REFERENCE_PLAINTEXT } from '../lib/twofas/reference';
import type { VaultStore } from '../store/vault';
import ImportDialog, { REPLACE_WARNING } from './ImportDialog';

const PASSWORD = '合成夹具密码 correct-horse';

/** 合成备份：条目全部由测试自己造，仓库里没有任何真实密钥（D17）。 */
const SYNTHETIC_SERVICES: readonly unknown[] = [
  {
    name: 'GitHub',
    secret: 'JBSWY3DPEHPK3PXP',
    otp: { account: 'octocat', issuer: 'GitHub', tokenType: 'TOTP' },
  },
];

const PLAINTEXT_BACKUP = JSON.stringify({
  services: SYNTHETIC_SERVICES,
  groups: [],
  schemaVersion: 4,
  appOrigin: 'android',
});

let encryptedBackup = '';

beforeAll(async () => {
  const [services, reference] = await Promise.all([
    encryptField(PASSWORD, JSON.stringify(SYNTHETIC_SERVICES)),
    encryptField(PASSWORD, TWOFAS_REFERENCE_PLAINTEXT),
  ]);
  encryptedBackup = JSON.stringify({
    services: [],
    groups: [],
    schemaVersion: 4,
    appOrigin: 'android',
    servicesEncrypted: joinEncryptedField(services),
    reference: joinEncryptedField(reference),
  });
});

/** 一个只记录调用的保险库：断言失败的导入不会碰它（D8）。 */
function fakeVault(): VaultStore {
  return {
    load: vi.fn<VaultStore['load']>().mockResolvedValue([]),
    replaceAll: vi.fn<VaultStore['replaceAll']>().mockResolvedValue(undefined),
    remove: vi.fn<VaultStore['remove']>().mockResolvedValue(undefined),
    reorder: vi.fn<VaultStore['reorder']>().mockResolvedValue(undefined),
    update: vi.fn<VaultStore['update']>().mockResolvedValue(undefined),
    erase: vi.fn<VaultStore['erase']>().mockResolvedValue(undefined),
  };
}

function renderDialog(vault: VaultStore) {
  const onClose = vi.fn();
  render(
    <ImportDialog
      onImport={async (entries) => {
        await vault.replaceAll(entries);
      }}
      onClose={onClose}
    />,
  );
  return { onClose };
}

function chooseFile(text: string, name = 'backup.2fas'): void {
  const input = screen.getByLabelText('选择备份文件');
  const file = new File([text], name, { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('ImportDialog', () => {
  it('prompts for a password for an encrypted backup', async () => {
    const vault = fakeVault();
    renderDialog(vault);

    chooseFile(encryptedBackup, 'encrypted.2fas');
    await waitFor(() => {
      expect(screen.getByLabelText('备份密码')).toBeInTheDocument();
    });
    expect(vault.replaceAll).not.toHaveBeenCalled();
  });

  it('does not prompt for a password for a plaintext backup', async () => {
    const vault = fakeVault();
    renderDialog(vault);

    chooseFile(PLAINTEXT_BACKUP);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认导入并替换' })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('备份密码')).toBeNull();
  });

  it('shows a specific message for WRONG_PASSWORD and keeps the existing vault', async () => {
    const vault = fakeVault();
    renderDialog(vault);

    chooseFile(encryptedBackup, 'encrypted.2fas');
    await waitFor(() => {
      expect(screen.getByLabelText('备份密码')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('备份密码'), { target: { value: '错误的密码' } });
    fireEvent.click(screen.getByRole('button', { name: '解密备份' }));

    await waitFor(() => {
      expect(screen.getByTestId('import-error')).toHaveTextContent('备份密码不正确，请重新输入');
    });
    // 密码错误不写库，也不把界面清空：密码框还在（D8）。
    expect(vault.replaceAll).not.toHaveBeenCalled();
    expect(screen.getByLabelText('备份密码')).toBeInTheDocument();

    // 输入正确密码后即可继续。
    fireEvent.change(screen.getByLabelText('备份密码'), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: '解密备份' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认导入并替换' })).toBeInTheDocument();
    });
  });

  it('warns that import replaces the whole vault before committing', async () => {
    const vault = fakeVault();
    const { onClose } = renderDialog(vault);

    // 打开时警告就在，选完文件、确认之前依然在（D3）。
    expect(screen.getByText(REPLACE_WARNING)).toBeInTheDocument();

    chooseFile(PLAINTEXT_BACKUP);
    const confirm = await screen.findByRole('button', { name: '确认导入并替换' });
    expect(screen.getByText(REPLACE_WARNING)).toBeInTheDocument();
    expect(vault.replaceAll).not.toHaveBeenCalled();

    fireEvent.click(confirm);
    await waitFor(() => {
      expect(vault.replaceAll).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(vault.replaceAll).mock.calls[0]?.[0]).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('accepts a backup dropped on the page', async () => {
    const vault = fakeVault();
    renderDialog(vault);

    // jsdom 没有 DataTransfer，构造一个只带 files 的替身即可覆盖拖放入口（D1）。
    fireEvent.drop(screen.getByTestId('drop-zone'), {
      dataTransfer: { files: [new File([PLAINTEXT_BACKUP], 'dropped.2fas')] },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认导入并替换' })).toBeInTheDocument();
    });
    expect(vault.replaceAll).not.toHaveBeenCalled();
  });

  it('shows a specific message for INVALID_JSON / NOT_A_BACKUP', async () => {
    const vault = fakeVault();
    renderDialog(vault);

    chooseFile('这不是 JSON', 'broken.2fas');
    await waitFor(() => {
      expect(screen.getByTestId('import-error')).toHaveTextContent(
        '文件不是有效的 JSON，请选择 2FAS 导出的 .2fas 或 .json 备份文件',
      );
    });

    chooseFile(JSON.stringify({ schemaVersion: 4, groups: [] }), 'empty.2fas');
    await waitFor(() => {
      expect(screen.getByTestId('import-error')).toHaveTextContent(
        '文件里既没有 services 也没有 servicesEncrypted，这不是 2FAS 备份文件',
      );
    });

    chooseFile(JSON.stringify({ schemaVersion: 99, services: [] }), 'newer.2fas');
    await waitFor(() => {
      expect(screen.getByTestId('import-error')).toHaveTextContent(
        '备份版本不受支持，请使用 2FAS 导出的 schemaVersion 2 至 4 的备份文件',
      );
    });

    expect(vault.replaceAll).not.toHaveBeenCalled();
  });
});
