// 保险库：条目在 IndexedDB 中一律以密文存放，密钥不可导出（D10）。
// 没有解锁密码、没有锁屏——load() 在页面加载时直接返回条目（D10）。
// 这里的“加密”防的是离线翻取浏览器数据目录，不是防同源脚本；README 已如实说明。

import type { ServiceEntry } from '../lib/twofas/types';
import {
  ENTRY_STORE,
  KEY_STORE,
  StoreError,
  VAULT_KEY_ID,
  deleteDb,
  openDb,
  requestResult,
  txDone,
} from './db';

/** 保险库的读写接口（契约 C）。 */
export interface VaultStore {
  /** 按显示顺序返回全部条目。 */
  load(): Promise<ServiceEntry[]>;
  /** 用一批新条目整体替换保险库；数组次序即显示顺序。 */
  replaceAll(entries: ServiceEntry[]): Promise<void>;
  /** 删除单条条目。id 不存在时静默返回（幂等）。 */
  remove(id: string): Promise<void>;
  /** 按给定的 id 次序重排显示顺序；未列出的 id 保持原有顺序值。 */
  reorder(orderedIds: string[]): Promise<void>;
  /**
   * 重写单条条目（目前只用于工卡显示名与"是否推送"）。
   * 条目已被删除时静默返回：重写不该把一条已删的记录复活。
   */
  update(entry: ServiceEntry): Promise<void>;
  erase(): Promise<void>;
}

/** 包裹密钥的算法参数。 */
const KEY_ALGORITHM = { name: 'AES-GCM', length: 256 } as const;
/** AES-GCM 初始化向量长度（字节）；每条记录一枚新 IV。 */
const IV_LENGTH_BYTES = 12;

// 二进制字段写成 Uint8Array<ArrayBuffer>（而非默认的 ArrayBufferLike）：
// crypto.subtle 的 BufferSource 不接受可能落在 SharedArrayBuffer 上的视图。
/** 落库的一条记录：明文只有主键 id 与显示顺序，密文里才有 secret 等全部字段。 */
interface EncryptedEntryRecord {
  id: string;
  /**
   * 显示顺序。刻意放在密文之外：重排只改这个数字，既不需要包裹密钥，
   * 也不必重新加密任何条目。顺序本身不是秘密（id 早已是明文主键）。
   *
   * 可选是为了兼容引入排序之前写入的记录——那些记录没有这个字段，
   * load() 会退回 getAll 的返回顺序。
   */
  order?: number;
  iv: Uint8Array<ArrayBuffer>;
  cipher: Uint8Array<ArrayBuffer>;
}

/**
 * 取密钥的接缝（seam）。生产路径就是 getOrCreateKey；
 * 测试可以注入自己的密钥提供者，而无需改动 VaultStore 的公开形状。
 */
export type VaultKeyProvider = (db: IDBDatabase) => Promise<CryptoKey>;

/**
 * 读出已有的包裹密钥；没有就现生成一枚并存进 IndexedDB。
 *
 * extractable 传 false：密钥材料永远不会以 JS 值的形式出现，
 * 结构化克隆算法让 CryptoKey 句柄本身可以被 put 进 IndexedDB（设计 §3.3）。
 */
export async function getOrCreateKey(db: IDBDatabase): Promise<CryptoKey> {
  const existing = await requestResult<unknown>(
    db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(VAULT_KEY_ID),
  );
  if (existing instanceof CryptoKey) {
    return existing;
  }

  const key = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ['encrypt', 'decrypt']);
  const tx = db.transaction(KEY_STORE, 'readwrite');
  tx.objectStore(KEY_STORE).put(key, VAULT_KEY_ID);
  await txDone(tx);
  return key;
}

async function encryptEntry(
  key: CryptoKey,
  entry: ServiceEntry,
  order: number,
): Promise<EncryptedEntryRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(entry));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { id: entry.id, order, iv, cipher: new Uint8Array(cipher) };
}

async function decryptEntry(key: CryptoKey, record: EncryptedEntryRecord): Promise<ServiceEntry> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.cipher);
  } catch (cause) {
    throw new StoreError('本地数据已损坏或无法解密，请重新导入备份', { cause });
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as ServiceEntry;
}

class IndexedDbVaultStore implements VaultStore {
  // 同一实例内缓存取密钥的 Promise：避免并发首写各自生成一枚密钥、后写覆盖先写。
  #keyPromise: Promise<CryptoKey> | null = null;

  readonly #keyProvider: VaultKeyProvider;

  constructor(keyProvider: VaultKeyProvider) {
    this.#keyProvider = keyProvider;
  }

  #key(db: IDBDatabase): Promise<CryptoKey> {
    this.#keyPromise ??= this.#keyProvider(db).catch((error: unknown) => {
      this.#keyPromise = null;
      throw error;
    });
    return this.#keyPromise;
  }

  async load(): Promise<ServiceEntry[]> {
    const db = await openDb();
    const records = await requestResult<EncryptedEntryRecord[]>(
      db.transaction(ENTRY_STORE, 'readonly').objectStore(ENTRY_STORE).getAll(),
    );
    // 从未写入过：直接返回空数组，不生成密钥、不报错（要求 7）。
    if (records.length === 0) {
      return [];
    }

    const key = await this.#key(db);
    // getAll 按主键（id）字典序返回，不是显示顺序，因此必须按 order 重排。
    // 缺 order 的旧记录退回它在 getAll 里的位置；sort 是稳定的，所以同值不会乱序。
    const ordered = records
      .map((record, index) => ({
        record,
        order: typeof record.order === 'number' ? record.order : index,
      }))
      .sort((a, b) => a.order - b.order)
      .map(({ record }) => record);

    return Promise.all(ordered.map((record) => decryptEntry(key, record)));
  }

  async replaceAll(entries: ServiceEntry[]): Promise<void> {
    const db = await openDb();
    const key = await this.#key(db);
    // 先把加密全部做完再开事务：IndexedDB 事务在事件循环空转一轮后就会自动提交，
    // 中间 await crypto.subtle 会让事务失效。
    // 数组下标即显示顺序：这样备份文件里的排列会被保留下来。
    const records = await Promise.all(
      entries.map((entry, index) => encryptEntry(key, entry, index)),
    );

    // clear + put 同处一个事务：任一步失败即整体回滚，不会留下半新半旧的保险库（D3）。
    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    const store = tx.objectStore(ENTRY_STORE);
    store.clear();
    for (const record of records) {
      store.put(record);
    }
    await txDone(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    // delete 对不存在的主键也算成功，因此天然幂等。
    tx.objectStore(ENTRY_STORE).delete(id);
    await txDone(tx);
  }

  async update(entry: ServiceEntry): Promise<void> {
    const db = await openDb();
    const key = await this.#key(db);
    const existing = await requestResult<EncryptedEntryRecord | undefined>(
      db
        .transaction(ENTRY_STORE, 'readonly')
        .objectStore(ENTRY_STORE)
        .get(entry.id) as IDBRequest<EncryptedEntryRecord | undefined>,
    );
    if (existing === undefined) {
      return;
    }

    // 条目的内容在密文里，所以这里必须重新加密整条；顺序在密文之外，
    // 原样带过去即可，重写一个字段不该让条目跳到列表开头。
    const record = await encryptEntry(key, entry, existing.order ?? 0);
    if (existing.order === undefined) {
      delete record.order;
    }

    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    tx.objectStore(ENTRY_STORE).put(record);
    await txDone(tx);
  }

  async reorder(orderedIds: string[]): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(ENTRY_STORE, 'readwrite');
    const store = tx.objectStore(ENTRY_STORE);

    // 顺序在密文之外，所以这里不取密钥、不解密、不重新加密。
    // get 的回调在事务内触发，紧接着发出的 put 会让事务保持存活，
    // 整批要么一起提交要么一起回滚。
    orderedIds.forEach((id, index) => {
      const request = store.get(id) as IDBRequest<EncryptedEntryRecord | undefined>;
      request.onsuccess = () => {
        const record = request.result;
        // id 已被删除时跳过：重排不该复活一条记录。
        if (record !== undefined) {
          store.put({ ...record, order: index });
        }
      };
    });

    await txDone(tx);
  }

  async erase(): Promise<void> {
    await deleteDb();
    // 密钥随库一起没了，下次写入会重新生成一枚（D12）。
    this.#keyPromise = null;
  }
}

/** 构造一个保险库实例。keyProvider 只为测试预留，生产调用不传。 */
export function createVaultStore(keyProvider: VaultKeyProvider = getOrCreateKey): VaultStore {
  return new IndexedDbVaultStore(keyProvider);
}

/** 应用共用的保险库实例。 */
export const vaultStore: VaultStore = createVaultStore();
