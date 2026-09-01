// IndexedDB 的打开/升级/删除，以及把 IDBRequest、IDBTransaction 变成 Promise 的小工具。
// 整个应用只有 src/store/ 允许触碰 IndexedDB（设计 §3.1），本文件是这一层唯一的数据库入口。

/** 数据库名。erase() 直接删除同名数据库（D12）。 */
export const DB_NAME = 'folopass2fa';
/** 当前 schema 版本。新增对象仓库时递增，并在 onupgradeneeded 里补齐。 */
export const DB_VERSION = 1;

/** 条目仓库：一条记录 = 一条加密后的 ServiceEntry，主键为明文 id。 */
export const ENTRY_STORE = 'entries';
/** 密钥仓库：只存一条记录，即不可导出的 AES-GCM 包裹密钥（D10）。 */
export const KEY_STORE = 'keys';
/** 设置仓库：键值对，目前只有时钟偏移（D16）。 */
export const SETTINGS_STORE = 'settings';

/** 包裹密钥在 KEY_STORE 中的固定主键。 */
export const VAULT_KEY_ID = 'vault';

/** 存储层的失败。上层据此提示用户，而不是把 DOMException 直接抛到界面。 */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
    Object.setPrototypeOf(this, StoreError.prototype);
  }
}

// 连接缓存：整页共用一个 IDBDatabase 连接，避免每次读写都走一次 open。
// erase() 必须先关闭它，否则 deleteDatabase 会被自己的连接挡住（blocked）。
let connection: Promise<IDBDatabase> | null = null;

function createStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(ENTRY_STORE)) {
    db.createObjectStore(ENTRY_STORE, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(KEY_STORE)) {
    db.createObjectStore(KEY_STORE);
  }
  if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
    db.createObjectStore(SETTINGS_STORE);
  }
}

/** 打开（必要时创建）数据库；同一页面内复用同一个连接。 */
export function openDb(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      createStores(request.result);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 另一个标签页要升级或删除数据库时，让出连接，否则对方会一直 blocked。
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      connection = null;
      reject(new StoreError('无法打开本地数据库', { cause: request.error }));
    };
    request.onblocked = () => {
      connection = null;
      reject(new StoreError('本地数据库被其他标签页占用，请关闭其他标签页后重试'));
    };
  });
  return connection;
}

/** 关闭并丢弃缓存的连接。删除数据库前必须调用。 */
export async function closeDb(): Promise<void> {
  const pending = connection;
  connection = null;
  if (pending === null) {
    return;
  }
  try {
    (await pending).close();
  } catch {
    // 连接本来就没建立成功，无需处理。
  }
}

/** 删除整个数据库（条目、包裹密钥、设置一并消失）——D12。 */
export async function deleteDb(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(new StoreError('无法清除本地数据', { cause: request.error }));
    };
    // 已经关掉了自己的连接，此时仍被挡住说明还有别的标签页开着：
    // 数据并未删除，必须如实报错，不能假装成功。
    request.onblocked = () => {
      reject(new StoreError('本地数据库被其他标签页占用，请关闭其他标签页后重试'));
    };
  });
}

/** 把 IDBRequest 包成 Promise。 */
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(new StoreError('本地数据库读写失败', { cause: request.error }));
    };
  });
}

/** 等待事务提交。任一写入失败都会让事务 abort，从而整体回滚（D3）。 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(new StoreError('本地数据库事务失败', { cause: tx.error }));
    };
    tx.onabort = () => {
      reject(new StoreError('本地数据库事务被中止', { cause: tx.error }));
    };
  });
}
