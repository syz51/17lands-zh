import { API_ORIGIN, MAX_IMAGE_BYTES, UUID_RE, allowedImage, boundedBytes, boundedJson, parseCard, parseStatus, record, type Card, type FaceSide, type LookupResult, type ServiceStatus } from './cache-contract';
import { chineseImageUrl } from './card-images';
import type { CachedImage, ImageStore, MetadataEntry, MetadataStore } from './persistent-cache';
import { validateRaster, type RasterDecoder } from './raster-decoder';

const STATUS_TTL = 5 * 60_000;
const POSITIVE_TTL = 24 * 60 * 60_000;
const NEGATIVE_TTL = 5 * 60_000;
const OFFLINE_BACKOFF = 60_000;
type Job = { id: string; resolve: (result: LookupResult) => void };

export class CardService {
  private status: ServiceStatus = { state: 'offline', revision: null, checkedAt: 0, lastError: null, metadataCount: 0, imageCount: 0, imageBytes: 0 };
  private nextAttempt = 0;
  private readonly initialized: Promise<void>;
  private checking?: Promise<void>;
  private readonly pending = new Map<string, Promise<LookupResult>>();
  private readonly queue: Job[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active = 0;
  private readonly imagesPending = new Map<string, Promise<CachedImage | undefined>>();
  private readonly imageFailures = new Map<string, number>();
  private imageActive = 0;
  private readonly imageWaiters: (() => void)[] = [];
  private lastRetry = 0;

  constructor(private readonly metadata: MetadataStore, private readonly images: ImageStore,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly now: () => number = Date.now,
    private readonly decode: RasterDecoder = validateRaster) {
    this.initialized = metadata.control().then((saved) => {
      if (saved && saved.status && ['online', 'offline', 'empty'].includes(saved.status.state) &&
        Number.isFinite(saved.status.checkedAt) && Number.isFinite(saved.nextAttempt) &&
        (saved.status.revision === null || typeof saved.status.revision === 'string')) {
        this.status = saved.status; this.nextAttempt = saved.nextAttempt;
      }
    }).catch(() => {});
  }

  private async request(path: string, headers?: HeadersInit) {
    return this.fetcher(`${API_ORIGIN}${path}`, { headers, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(6000) });
  }
  private async persist() { await this.metadata.saveControl({ status: this.status, nextAttempt: this.nextAttempt }).catch(() => {}); }
  private offline(error: unknown) {
    this.status = { ...this.status, state: 'offline', checkedAt: this.now(), lastError: error instanceof Error ? error.message.slice(0, 256) : '本地服务不可用' };
    this.nextAttempt = this.now() + OFFLINE_BACKOFF;
  }
  private async checkStatus() {
    await this.initialized;
    if (this.now() < this.nextAttempt || (this.status.state !== 'offline' && this.status.checkedAt > 0 && this.now() - this.status.checkedAt < STATUS_TTL)) return;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        const response = await this.request('/v1/status');
        if (!response.ok) throw new Error(`本地服务 HTTP ${response.status}`);
        const api = parseStatus(await boundedJson(response, 32_768));
        this.status = { ...this.status, state: api.ready ? 'online' : 'empty', revision: api.revision, checkedAt: this.now(), lastError: api.last_error, api };
        this.nextAttempt = 0;
      } catch (error) { this.offline(error); }
      await this.persist();
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  async getStatus(retry = false): Promise<ServiceStatus> {
    await this.initialized;
    // A popup retry cannot turn messages into an unbounded network retry loop.
    if (retry && this.now() - this.lastRetry >= 5000) {
      this.lastRetry = this.now(); this.nextAttempt = 0; this.status.checkedAt = 0; this.imageFailures.clear();
    }
    await this.checkStatus();
    const [metadataCount, imageStats] = await Promise.all([
      this.metadata.count().catch(() => 0), this.images.stats().catch(() => ({ imageCount: 0, imageBytes: 0 })),
    ]);
    return { ...this.status, metadataCount, ...imageStats };
  }

  lookup(ids: string[]): Promise<LookupResult[]> {
    if (ids.length < 1 || ids.length > 100 || ids.some((id) => !UUID_RE.test(id))) return Promise.reject(new Error('无效的卡牌 ID'));
    return Promise.all(ids.map((id) => this.enqueue(id.toLowerCase())));
  }
  private enqueue(id: string) {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const result = new Promise<LookupResult>((resolve) => { this.queue.push({ id, resolve }); });
    this.pending.set(id, result);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 12);
    return result;
  }
  private pump() {
    while (this.active < 2 && this.queue.length > 0) {
      const jobs = this.queue.splice(0, 100); this.active++;
      void this.batch(jobs.map((job) => job.id)).then((results) => {
        for (let i = 0; i < jobs.length; i++) { this.pending.delete(jobs[i]!.id); jobs[i]!.resolve(results[i]!); }
      }).catch(() => {
        for (const job of jobs) { this.pending.delete(job.id); job.resolve({ id: job.id, card: null, origin: 'unavailable', revision: null, fallback: true }); }
      }).finally(() => {
        this.active--; this.pump();
      });
    }
  }
  private async batch(ids: string[]): Promise<LookupResult[]> {
    await this.checkStatus();
    const entries = await this.metadata.get(ids).catch(() => ids.map(() => undefined));
    const now = this.now();
    // Cache data is untrusted on read as well; discard incompatible/corrupt entries.
    const cached = entries.map((entry, i) => {
      try {
        if (!entry || entry.id !== ids[i] || typeof entry.revision !== 'string' || !Number.isFinite(entry.expires)) return undefined;
        const card = entry.card === null ? null : parseCard(entry.card);
        if (card && card.printing_id !== entry.id) return undefined;
        return { ...entry, card };
      } catch { return undefined; }
    });
    const needed = ids.filter((_, i) => {
      const entry = cached[i];
      return !entry || entry.expires <= now || entry.revision !== this.status.revision;
    });
    const updated = new Map<string, MetadataEntry>();
    let fetched = false;
    if (needed.length && this.status.state === 'online' && now >= this.nextAttempt) {
      try {
        const previous = needed.map((id) => cached[ids.indexOf(id)]);
        const etag = previous[0]?.etag;
        const conditional = !!etag && previous.every((entry) => entry?.etag === etag && entry.revision === previous[0]!.revision);
        const response = await this.request(`/v1/cards?ids=${needed.join(',')}&lang=zhs`, conditional ? { 'If-None-Match': etag } : undefined);
        if (response.status === 304) {
          if (!conditional) throw new Error('无缓存的 304 响应');
          for (const entry of previous) updated.set(entry!.id, { ...entry!, expires: now + (entry!.card ? POSITIVE_TTL : NEGATIVE_TTL), used: now });
        } else {
          if (!response.ok) throw new Error(`卡牌查询 HTTP ${response.status}`);
          const body = await boundedJson(response);
          if (!record(body) || body.schema_version !== 1 || typeof body.revision !== 'string' || body.revision.length > 256 ||
            !Array.isArray(body.cards) || !Array.isArray(body.missing) || body.cards.length + body.missing.length !== needed.length) throw new Error('批量响应格式无效');
          const seen = new Set<string>();
          const add = (id: string, card: Card | null) => {
            if (!needed.includes(id) || seen.has(id)) throw new Error('批量响应 ID 不匹配');
            seen.add(id);
            updated.set(id, { id, card, revision: body.revision as string, expires: now + (card ? POSITIVE_TTL : NEGATIVE_TTL), used: now, etag: response.headers.get('etag') });
          };
          for (const value of body.cards) { const card = parseCard(value); add(card.printing_id, card); }
          for (const id of body.missing) { if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('缺失 ID 格式无效'); add(id.toLowerCase(), null); }
          // A publish may occur between status and lookup; adopt the complete lookup's revision.
          if (this.status.revision !== body.revision) this.status = { ...this.status, revision: body.revision };
        }
        fetched = true;
        await this.metadata.put([...updated.values()]).catch(() => {});
      } catch (error) { updated.clear(); this.offline(error); await this.persist(); }
    }
    const touches: MetadataEntry[] = [];
    const results = ids.map((id, i): LookupResult => {
      const entry = updated.get(id) ?? cached[i];
      if (entry && !updated.has(id)) touches.push({ ...entry, used: now });
      const stale = !!entry && (entry.expires <= now || entry.revision !== this.status.revision || this.status.state !== 'online');
      const origin = updated.has(id) && fetched ? 'api' : entry ? stale ? 'stale' : 'cache' : 'unavailable';
      this.status.lastResult = origin;
      return { id, card: entry?.card ?? null, origin, revision: entry?.revision ?? null, fallback: this.status.state === 'offline' || this.status.state === 'empty' };
    });
    await this.metadata.put(touches).catch(() => {});
    await this.persist();
    return results;
  }

  async image(id: string, face: FaceSide): Promise<{ dataUrl: string | null; origin: string }> {
    const [result] = await this.lookup([id]);
    const localized = result!.card?.faces.find((f) => f.face === face);
    const apiUrl = localized?.image_url;
    // Direct mapping is only a service-unavailable fallback, never a replacement for API data.
    const directUrl = result!.fallback && !result!.card
      ? chineseImageUrl(`https://cards.scryfall.io/large/${face}/${id[0]}/${id[1]}/${id}.jpg`) : undefined;
    const url = apiUrl ?? directUrl;
    if (!url || !allowedImage(url)) return { dataUrl: null, origin: result!.origin };
    const image = await this.loadImage(url);
    if (!image) return { dataUrl: null, origin: result!.origin };
    const origin = directUrl ? 'direct' : result!.origin;
    this.status.lastResult = origin as ServiceStatus['lastResult'];
    await this.persist();
    // Chrome runtime messaging uses JSON serialization, so transport one bounded blob as a data URL.
    let binary = '';
    for (let i = 0; i < image.bytes.length; i += 8192) binary += String.fromCharCode(...image.bytes.subarray(i, i + 8192));
    return { dataUrl: `data:${image.mime};base64,${btoa(binary)}`, origin };
  }
  private async loadImage(url: string): Promise<CachedImage | undefined> {
    const pending = this.imagesPending.get(url);
    if (pending) return pending;
    const operation = this.readOrFetchImage(url).finally(() => { this.imagesPending.delete(url); });
    this.imagesPending.set(url, operation);
    return operation;
  }
  private async readOrFetchImage(url: string): Promise<CachedImage | undefined> {
    if (this.imageActive >= 4) await new Promise<void>((resolve) => this.imageWaiters.push(resolve));
    this.imageActive++;
    try {
      // Validate pre-fix v1 entries on read instead of discarding good offline images during upgrade.
      try {
        const cached = await this.images.get(url);
        if (cached) { await this.decode(cached); return cached; }
      } catch { await this.images.delete(url).catch(() => {}); }
      if ((this.imageFailures.get(url) ?? 0) > this.now()) return undefined;
      const response = await this.fetcher(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000) });
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!response.ok || !mime || !/^image\/(jpeg|png|webp|avif)$/.test(mime)) throw new Error('图片响应无效');
      const bytes = await boundedBytes(response, MAX_IMAGE_BYTES);
      if (!bytes.length) throw new Error('空图片');
      const image = { bytes, mime };
      // No unvalidated raster bytes may enter persistent cache or be returned through runtime messaging.
      await this.decode(image);
      await this.images.put(url, image).catch(() => {});
      return image;
    } catch {
      if (this.imageFailures.size >= 512) this.imageFailures.delete(this.imageFailures.keys().next().value!);
      this.imageFailures.set(url, this.now() + NEGATIVE_TTL);
      return undefined;
    } finally { this.imageActive--; this.imageWaiters.shift()?.(); }
  }
}
