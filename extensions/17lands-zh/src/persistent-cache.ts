import { API_ORIGIN, MAX_IMAGE_BYTES, MAX_IMAGE_CACHE_BYTES, MAX_IMAGES, MAX_METADATA, boundedBytes, type Card, type ServiceStatus } from './cache-contract';

export const METADATA_DB_NAME = API_ORIGIN === 'http://127.0.0.1:17317' ? '17lands-zh-metadata' : `17lands-zh-metadata@${API_ORIGIN}`;

export type MetadataEntry = { id: string; card: Card | null; revision: string; expires: number; used: number; etag: string | null };
export type Control = { status: ServiceStatus; nextAttempt: number };
export interface MetadataStore {
  get(ids: string[]): Promise<(MetadataEntry | undefined)[]>;
  put(entries: MetadataEntry[]): Promise<void>;
  control(): Promise<Control | undefined>;
  saveControl(value: Control): Promise<void>;
  count(): Promise<number>;
}

/** Only the extension background opens this origin's database. A schema bump replaces disposable caches. */
export class IndexedMetadataStore implements MetadataStore {
  private db?: Promise<IDBDatabase>;
  private open() {
    return this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(METADATA_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('cards', { keyPath: 'id' }).createIndex('used', 'used');
        db.createObjectStore('control');
      };
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.db = undefined; }; resolve(request.result); };
      request.onerror = () => { this.db = undefined; reject(request.error); };
      request.onblocked = () => { this.db = undefined; reject(new Error('缓存数据库升级被阻止')); };
    });
  }
  private async transaction<T>(store: string, mode: IDBTransactionMode, run: (object: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode); let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('缓存写入失败'));
      run(tx.objectStore(store), (v) => { value = v; });
    });
  }
  get(ids: string[]) {
    return this.transaction<(MetadataEntry | undefined)[]>('cards', 'readonly', (store, done) => {
      const result: (MetadataEntry | undefined)[] = new Array(ids.length); done(result);
      ids.forEach((id, index) => { store.get(id).onsuccess = (event) => { result[index] = (event.target as IDBRequest<MetadataEntry>).result; }; });
    });
  }
  async put(entries: MetadataEntry[]) {
    await this.transaction<void>('cards', 'readwrite', (store) => {
      for (const entry of entries) store.put(entry);
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_METADATA;
        if (excess <= 0) return;
        store.index('used').openCursor().onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor && excess-- > 0) { cursor.delete(); cursor.continue(); }
        };
      };
    });
  }
  control() { return this.transaction<Control | undefined>('control', 'readonly', (s, done) => { s.get('state').onsuccess = (e) => done((e.target as IDBRequest<Control>).result); }); }
  async saveControl(value: Control) { await this.transaction<void>('control', 'readwrite', (s) => { s.put(value, 'state'); }); }
  count() { return this.transaction<number>('cards', 'readonly', (s, done) => { s.count().onsuccess = (e) => done((e.target as IDBRequest<number>).result); }); }
}

export type CachedImage = { bytes: Uint8Array; mime: string };
export interface ImageStore {
  get(url: string): Promise<CachedImage | undefined>;
  put(url: string, image: CachedImage): Promise<void>;
  delete(url: string): Promise<void>;
  stats(): Promise<{ imageCount: number; imageBytes: number }>;
}
const CACHE_NAME = '17lands-zh-images-v1';
/** CacheStorage insertion order provides bounded FIFO eviction, avoiding unbounded blob retention. */
export class PersistentImageStore implements ImageStore {
  private serial: Promise<unknown> = Promise.resolve();
  private initialize?: Promise<Cache>;
  private sizes?: Map<string, number>;
  private open() {
    return this.initialize ??= (async () => {
      for (const name of await caches.keys()) if (name.startsWith('17lands-zh-images-') && name !== CACHE_NAME) await caches.delete(name);
      return caches.open(CACHE_NAME);
    })();
  }
  async get(url: string) {
    const response = await (await this.open()).match(url);
    if (!response) return undefined;
    return { bytes: await boundedBytes(response, MAX_IMAGE_BYTES), mime: response.headers.get('content-type') ?? 'image/webp' };
  }
  /** Stored sizes in cache insertion order. Reading every response again is only needed when the entry count disagrees. */
  private async index(cache: Cache) {
    const keys = await cache.keys();
    if (this.sizes?.size === keys.length) return this.sizes;
    const sizes = await Promise.all(keys.map(async (key) => Number((await cache.match(key))?.headers.get('content-length') ?? 0)));
    return this.sizes = new Map(keys.map((key, i) => [key.url, sizes[i]!]));
  }
  private enqueue<T>(run: (cache: Cache) => Promise<T>) {
    const operation = this.serial.catch(() => {}).then(async () => run(await this.open()));
    this.serial = operation;
    return operation;
  }
  async put(url: string, image: CachedImage) {
    await this.enqueue(async (cache) => {
      const sizes = await this.index(cache); const key = new Request(url).url;
      await cache.put(url, new Response(image.bytes.slice().buffer, { headers: { 'content-type': image.mime, 'content-length': String(image.bytes.byteLength) } }));
      // A replaced entry moves to the end of the cache, as it does in CacheStorage.
      sizes.delete(key); sizes.set(key, image.bytes.byteLength);
      let bytes = 0; for (const size of sizes.values()) bytes += size;
      for (const [oldest, size] of sizes) {
        if (sizes.size <= MAX_IMAGES && bytes <= MAX_IMAGE_CACHE_BYTES) break;
        await cache.delete(oldest); sizes.delete(oldest); bytes -= size;
      }
    });
  }
  async delete(url: string) {
    await this.enqueue(async (cache) => { await cache.delete(url); this.sizes?.delete(new Request(url).url); });
  }
  /** Reads never wait for queued writes: the status reply uses the index when one exists. */
  async stats() {
    let sizes: Iterable<number> | undefined = this.sizes?.values();
    if (!sizes) {
      const cache = await this.open();
      sizes = await Promise.all((await cache.keys()).map(async (key) => Number((await cache.match(key))?.headers.get('content-length') ?? 0)));
    }
    let imageCount = 0; let imageBytes = 0;
    for (const size of sizes) { imageCount++; imageBytes += size; }
    return { imageCount, imageBytes };
  }
}
