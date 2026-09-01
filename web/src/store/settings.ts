// 设置持久化：目前只有时钟偏移（D16）。设置不含敏感信息，因此明文存放。

import { SETTINGS_STORE, openDb, requestResult, txDone } from './db';

/** 设置的读写接口（契约 C）。 */
export interface SettingsStore {
  getClockOffsetSec(): Promise<number>;
  setClockOffsetSec(sec: number): Promise<void>;
}

/** 时钟偏移在设置仓库中的键名。 */
export const CLOCK_OFFSET_KEY = 'clockOffsetSec';

/** 从未设置过时的默认偏移（秒）。 */
export const DEFAULT_CLOCK_OFFSET_SEC = 0;

class IndexedDbSettingsStore implements SettingsStore {
  async getClockOffsetSec(): Promise<number> {
    const db = await openDb();
    const stored = await requestResult<unknown>(
      db.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get(CLOCK_OFFSET_KEY),
    );
    // 没写过、或被外部写坏成非数字，都退回默认值，不抛错。
    if (typeof stored !== 'number' || !Number.isFinite(stored)) {
      return DEFAULT_CLOCK_OFFSET_SEC;
    }
    return stored;
  }

  async setClockOffsetSec(sec: number): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(SETTINGS_STORE, 'readwrite');
    tx.objectStore(SETTINGS_STORE).put(sec, CLOCK_OFFSET_KEY);
    await txDone(tx);
  }
}

/** 构造一个设置存储实例。 */
export function createSettingsStore(): SettingsStore {
  return new IndexedDbSettingsStore();
}

/** 应用共用的设置存储实例。 */
export const settingsStore: SettingsStore = createSettingsStore();
