import type { StatsCatalog, StatsRecord } from './stats-contract';

export const STATS_DB_NAME = '17lands-zh-stats';
export const MAX_STATS_DATASETS = 12;
export type StatsDataset = { key: string; records: StatsRecord[]; fetchedAt: number; used: number };
export type StatsFailure = { nextAttempt: number; error: string };
export type StatsMeta = {
  catalog?: { value: StatsCatalog; fetchedAt: number };
  catalogFailure?: StatsFailure;
  lastExpansion?: string;
  failures?: Record<string, StatsFailure>;
  lastRetry?: number;
  revalidate?: string[];
  catalogRevalidate?: boolean;
};
export interface StatsStore {
  get(key: string): Promise<StatsDataset | undefined>;
  put(value: StatsDataset): Promise<void>;
  meta(): Promise<StatsMeta | undefined>;
  saveMeta(value: StatsMeta): Promise<void>;
}

/** Also used when IndexedDB is unavailable: bounded caching still works for this worker lifetime. */
export class MemoryStatsStore implements StatsStore {
  readonly datasets = new Map<string, StatsDataset>();
  private state?: StatsMeta;
  async get(key: string) { return this.datasets.get(key); }
  async put(value: StatsDataset) {
    this.datasets.set(value.key, value);
    while (this.datasets.size > MAX_STATS_DATASETS) {
      const oldest = [...this.datasets.values()].sort((a, b) => a.used - b.used)[0]!;
      this.datasets.delete(oldest.key);
    }
  }
  async meta() { return this.state; }
  async saveMeta(value: StatsMeta) { this.state = structuredClone(value); }
}

/** A separate DB leaves the existing card metadata schema/version untouched. */
export class IndexedStatsStore implements StatsStore {
  private readonly memory = new MemoryStatsStore();
  private database?: Promise<IDBDatabase>;
  private disabled = false;
  private serial: Promise<unknown> = Promise.resolve();
  private open(): Promise<IDBDatabase> {
    if (this.disabled) return Promise.reject(new Error('统计缓存不可用'));
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(STATS_DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('datasets', { keyPath: 'key' }).createIndex('used', 'used');
        request.result.createObjectStore('meta');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('统计缓存数据库被阻止'));
    });
  }
  private async transaction<T>(name: string, mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(name, mode); let value: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('统计缓存事务失败'));
      try { run(transaction.objectStore(name), (result) => { value = result; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }
  private disable() {
    this.disabled = true;
    void this.database?.then((db) => db.close()).catch(() => {});
  }
  private write(operation: () => Promise<void>) {
    const result = this.serial.catch(() => {}).then(operation);
    this.serial = result;
    return result;
  }
  async get(key: string) {
    await this.serial.catch(() => {});
    try {
      const value = await this.transaction<StatsDataset | undefined>('datasets', 'readonly', (store, done) => {
        store.get(key).onsuccess = (event) => done((event.target as IDBRequest<StatsDataset>).result);
      });
      if (value) await this.memory.put(value);
      return value;
    } catch { this.disable(); return this.memory.get(key); }
  }
  put(value: StatsDataset) {
    return this.write(async () => {
      await this.memory.put(value);
      try {
        await this.transaction<void>('datasets', 'readwrite', (store) => {
          store.put(value);
          const count = store.count();
          count.onsuccess = () => {
            let excess = count.result - MAX_STATS_DATASETS;
            if (excess <= 0) return;
            store.index('used').openCursor().onsuccess = (event) => {
              const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
              if (cursor && excess-- > 0) { cursor.delete(); cursor.continue(); }
            };
          };
        });
      } catch { this.disable(); }
    });
  }
  async meta() {
    await this.serial.catch(() => {});
    try {
      const value = await this.transaction<StatsMeta | undefined>('meta', 'readonly', (store, done) => {
        store.get('state').onsuccess = (event) => done((event.target as IDBRequest<StatsMeta>).result);
      });
      if (value) await this.memory.saveMeta(value);
      return value;
    } catch { this.disable(); return this.memory.meta(); }
  }
  saveMeta(value: StatsMeta) {
    // Snapshot before queueing so subsequent service updates cannot alter an earlier write.
    const snapshot = structuredClone(value);
    return this.write(async () => {
      await this.memory.saveMeta(snapshot);
      try { await this.transaction<void>('meta', 'readwrite', (store) => { store.put(snapshot, 'state'); }); }
      catch { this.disable(); }
    });
  }
}
