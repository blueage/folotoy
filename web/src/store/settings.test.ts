import { beforeEach, describe, expect, it } from 'vitest';

import { deleteDb } from './db';
import { createSettingsStore } from './settings';

describe('SettingsStore', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('clock offset defaults to 0', async () => {
    const store = createSettingsStore();
    await expect(store.getClockOffsetSec()).resolves.toBe(0);
  });

  it('clock offset persists across store instances', async () => {
    await createSettingsStore().setClockOffsetSec(42);
    await expect(createSettingsStore().getClockOffsetSec()).resolves.toBe(42);

    // 负偏移同样合法（本机时钟走快时）。
    await createSettingsStore().setClockOffsetSec(-17);
    await expect(createSettingsStore().getClockOffsetSec()).resolves.toBe(-17);
  });
});
