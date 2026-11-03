import { boundedBytes, record, type LookupResult } from './cache-contract';
import { deriveGrades, parseStatsCards, parseStatsCatalog, parseStatsData, parseStatsQuery, parseStatsRecord, statsEmbargoUntil, statsImageIdentity, voteStatsExpansion,
  type StatsCard, type StatsCardRequest, type StatsCatalog, type StatsQuery, type StatsResponse } from './stats-contract';
import { MAX_STATS_DATASETS, type StatsDataset, type StatsFailure, type StatsMeta, type StatsStore } from './stats-store';

export const STATS_CATALOG_TTL = 24 * 60 * 60_000;
export const STATS_DATASET_TTL = 6 * 60 * 60_000;
export const STATS_FAILURE_BACKOFF = 60_000;
export const MAX_STATS_BYTES = 4 * 1024 * 1024;
export type StatsSettingsAdapter = () => Promise<{ statsMockExpansion?: string | null }>;
export type StatsLookup = (ids: string[]) => Promise<LookupResult[]>;
type LoadedDataset = { entry: StatsDataset; cards: StatsCard[]; byIdentity: Map<string, StatsCard>; byName: Map<string, StatsCard> };
// Catalog and dataset responses share a single network lane, including bounded body reads.
let networkTail: Promise<unknown> = Promise.resolve();
const errorText = (error: unknown) => error instanceof Error ? error.message.slice(0, 256) : '统计服务不可用';
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function failure(value: unknown): value is StatsFailure {
  return record(value) && timestamp(value.nextAttempt) && typeof value.error === 'string' && value.error.length <= 256;
}
export function statsDatasetKey(query: StatsQuery & { expansion: string }) {
  return [query.expansion, query.format, query.colors, query.group].join('|');
}

export class StatsService {
  private state: StatsMeta = {};
  private readonly initialized: Promise<void>;
  private checking?: Promise<StatsCatalog | null>;
  private readonly pending = new Map<string, Promise<LoadedDataset | undefined>>();
  private readonly loaded = new Map<string, LoadedDataset>();

  constructor(private readonly store: StatsStore, private readonly lookup: StatsLookup,
    private readonly getSettings: StatsSettingsAdapter,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly now: () => number = Date.now,
    private readonly cachedLookup: StatsLookup = async () => []) {
    this.initialized = this.restore();
  }
  private async restore() {
    try {
      const saved: unknown = await this.store.meta();
      if (!record(saved)) return;
      if (record(saved.catalog) && timestamp(saved.catalog.fetchedAt) && record(saved.catalog.value)) {
        try { this.state.catalog = { value: parseStatsCatalog(saved.catalog.value, saved.catalog.value.site_draft_expansions), fetchedAt: saved.catalog.fetchedAt }; } catch { /* Ignore incompatible cache. */ }
      }
      if (failure(saved.catalogFailure)) this.state.catalogFailure = saved.catalogFailure;
      if (typeof saved.lastExpansion === 'string' && /^[A-Z0-9]{2,16}$/.test(saved.lastExpansion)) this.state.lastExpansion = saved.lastExpansion;
      if (timestamp(saved.lastRetry)) this.state.lastRetry = saved.lastRetry;
      if (Array.isArray(saved.revalidate)) this.state.revalidate = saved.revalidate.filter((key): key is string => typeof key === 'string' && key.length <= 128).slice(-64);
      if (saved.catalogRevalidate === true) this.state.catalogRevalidate = true;
      if (record(saved.failures)) this.state.failures = Object.fromEntries(Object.entries(saved.failures).filter(([key, value]) => key.length <= 128 && failure(value)).slice(-64)) as Record<string, StatsFailure>;
    } catch { /* Storage failure must not prevent fetching or displaying available data. */ }
  }
  private async persist() { await this.store.saveMeta(structuredClone(this.state)).catch(() => {}); }
  private request(path: string): Promise<unknown> {
    const operation = networkTail.catch(() => {}).then(async () => {
      const response = await this.fetcher(`https://www.17lands.com${path}`, {
        method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`统计服务 HTTP ${response.status}`); }
      // 17Lands may serve JSON as text/html. Bound bytes before parsing, independently of MIME.
      return JSON.parse(new TextDecoder().decode(await boundedBytes(response, MAX_STATS_BYTES))) as unknown;
    });
    networkTail = operation;
    return operation;
  }
  private async catalog(): Promise<StatsCatalog | null> {
    await this.initialized;
    const cached = this.state.catalog;
    if (cached && !this.state.catalogRevalidate && this.now() >= cached.fetchedAt && this.now() - cached.fetchedAt < STATS_CATALOG_TTL) return cached.value;
    if (this.checking) return this.checking;
    if (this.now() < (this.state.catalogFailure?.nextAttempt ?? 0)) return cached?.value ?? null;
    this.checking = (async () => {
      try {
        const filters = await this.request('/data/filters');
        const site = await this.request('/data/site_draft_expansions');
        const value = parseStatsCatalog(filters, site);
        this.state.catalog = { value, fetchedAt: this.now() };
        delete this.state.catalogRevalidate;
        delete this.state.catalogFailure;
      } catch (error) { this.state.catalogFailure = { nextAttempt: this.now() + STATS_FAILURE_BACKOFF, error: errorText(error) }; }
      await this.persist();
      return this.state.catalog?.value ?? null;
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private prepare(entry: StatsDataset): LoadedDataset {
    const cards = deriveGrades(entry.records);
    const byIdentity = new Map<string, StatsCard>(); const byName = new Map<string, StatsCard>();
    for (const card of cards) {
      for (const url of [card.front, card.back]) {
        const identity = statsImageIdentity(url);
        if (identity && !byIdentity.has(`${identity.id}/${identity.face}`)) byIdentity.set(`${identity.id}/${identity.face}`, card);
      }
      if (!byName.has(card.name)) byName.set(card.name, card);
    }
    const loaded = { entry, cards, byIdentity, byName };
    this.loaded.set(entry.key, loaded);
    while (this.loaded.size > MAX_STATS_DATASETS) {
      const oldest = [...this.loaded.values()].sort((a, b) => a.entry.used - b.entry.used)[0]!;
      this.loaded.delete(oldest.entry.key);
    }
    return loaded;
  }
  private async read(key: string): Promise<LoadedDataset | undefined> {
    const existing = this.loaded.get(key);
    if (existing) return existing;
    const raw: unknown = await this.store.get(key).catch(() => undefined);
    if (!record(raw) || raw.key !== key || !timestamp(raw.fetchedAt) || !timestamp(raw.used) ||
      !Array.isArray(raw.records) || raw.records.length > 1500) return undefined;
    const records = raw.records.map((row) => parseStatsRecord(row, true));
    // A corrupt persisted snapshot is not a published dataset; do not invent or partially repair it.
    if (records.some((row) => row === null)) return undefined;
    return this.prepare({ key, fetchedAt: raw.fetchedAt, used: raw.used, records: records as StatsDataset['records'] });
  }
  private dataset(query: StatsQuery & { expansion: string }): Promise<LoadedDataset | undefined> {
    const key = statsDatasetKey(query);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = (async () => {
      let cached = await this.read(key);
      const fresh = cached && !this.state.revalidate?.includes(key) && this.now() >= cached.entry.fetchedAt && this.now() - cached.entry.fetchedAt < STATS_DATASET_TTL;
      if (!fresh && this.now() >= (this.state.failures?.[key]?.nextAttempt ?? 0)) {
        try {
          const parameters = new URLSearchParams({ expansion: query.expansion, event_type: query.format });
          if (query.colors) parameters.set('colors', query.colors);
          if (query.group) parameters.set('user_group', query.group);
          const records = parseStatsData(await this.request(`/api/card_data?${parameters}`));
          cached = this.prepare({ key, records, fetchedAt: this.now(), used: this.now() });
          this.state.revalidate = this.state.revalidate?.filter((value) => value !== key);
          if (this.state.failures) delete this.state.failures[key];
        } catch (error) {
          const failures = this.state.failures ??= {};
          delete failures[key]; failures[key] = { nextAttempt: this.now() + STATS_FAILURE_BACKOFF, error: errorText(error) };
          while (Object.keys(failures).length > 64) delete failures[Object.keys(failures)[0]!];
        }
        await this.persist();
      }
      if (cached) {
        cached.entry.used = this.now();
        await this.store.put(cached.entry).catch(() => {});
      }
      return cached;
    })().finally(() => { this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }
  private async remembered(catalog: StatsCatalog): Promise<string | null> {
    const settings = await this.getSettings().catch(() => ({} as Awaited<ReturnType<StatsSettingsAdapter>>));
    const value = typeof settings.statsMockExpansion === 'string' ? catalog.expansions.find((code) => code.toUpperCase() === settings.statsMockExpansion?.toUpperCase()) : undefined;
    if (value && catalog.expansions.includes(value)) return value;
    return this.state.lastExpansion && catalog.expansions.includes(this.state.lastExpansion) ? this.state.lastExpansion : null;
  }
  private resolveFormat(query: StatsQuery, catalog: StatsCatalog | null, expansion: string | null) {
    if (query.format !== 'auto') return query.format;
    const formats = expansion ? catalog?.formats_by_expansion[expansion] : catalog?.formats;
    return formats?.includes('PremierDraft') ? 'PremierDraft' : formats?.[0] ?? 'auto';
  }
  async query(input: StatsQuery, inputCards: StatsCardRequest[]): Promise<StatsResponse> {
    const query = parseStatsQuery(input); const requests = parseStatsCards(inputCards);
    const catalog = await this.catalog();
    let expansion = catalog?.expansions.find((code) => code.toUpperCase() === query.expansion?.toUpperCase()) ?? query.expansion ?? null;
    let resolvedBy: StatsResponse['context']['resolvedBy'] = expansion ? 'explicit' : 'unknown';
    let lookups: LookupResult[] = [];
    if (requests.length && expansion) {
      const ids = [...new Set(requests.map((card) => card.id))];
      lookups = (await this.cachedLookup(ids).catch(() => [])).filter((result) => ids.includes(result.id) && result.card?.printing_id === result.id);
    }
    if (requests.length && catalog && !expansion) {
      const ids = [...new Set(requests.map((card) => card.id))];
      lookups = await this.lookup(ids).catch(() => []);
      // Lookup IDs must match the requested printing before using either set or localized name.
      lookups = lookups.filter((result) => ids.includes(result.id) && result.card?.printing_id === result.id);
      if (!expansion) {
        expansion = voteStatsExpansion(lookups.map((result) => result.card?.set_code), catalog.expansions);
        if (expansion) {
          resolvedBy = 'inferred'; this.state.lastExpansion = expansion; await this.persist();
        } else {
          expansion = await this.remembered(catalog);
          if (expansion) resolvedBy = 'remembered';
        }
      }
    }
    const format = this.resolveFormat(query, catalog, expansion);
    const until = expansion ? statsEmbargoUntil(catalog, expansion) : null;
    const result: StatsResponse = { catalog, context: { expansion, resolvedBy, format, colors: query.colors, group: query.group },
      meta: { fetchedAt: null, stale: false, embargoUntil: until, cardCount: 0, error: this.state.catalogFailure?.error ?? null }, cards: requests.map(() => null) };
    if (!catalog) { result.meta.error ??= '统计目录不可用'; return result; }
    if (expansion && !catalog.expansions.includes(expansion)) { result.meta.error = '统计系列不在目录中'; return result; }
    if (query.format !== 'auto' && !catalog.formats.includes(format)) { result.meta.error = '统计赛制不在目录中'; return result; }
    // Bootstrap deliberately does not infer, remember, look up cards, or load any dataset.
    if (!requests.length) return result;
    if (!expansion) { result.meta.error = '无法确定统计系列'; return result; }
    if (!catalog.formats_by_expansion[expansion]?.includes(format)) { result.meta.error = '该系列不支持此赛制'; return result; }
    if (until === null || this.now() < until) {
      result.meta.error = until === null ? '系列开始日期未知，暂不提供统计' : '系列统计仍在禁用期';
      return result;
    }
    const resolved = { ...query, expansion, format };
    const key = statsDatasetKey(resolved);
    const loaded = await this.dataset(resolved);
    result.meta.error = this.state.failures?.[key]?.error ?? result.meta.error;
    if (!loaded) { result.meta.error ??= '统计数据不可用'; return result; }
    result.meta.fetchedAt = loaded.entry.fetchedAt;
    result.meta.stale = this.now() < loaded.entry.fetchedAt || this.now() - loaded.entry.fetchedAt >= STATS_DATASET_TTL || !!this.state.failures?.[key];
    result.meta.cardCount = loaded.cards.length;
    result.cards = requests.map((request) => {
      const row = loaded.byIdentity.get(`${request.id}/${request.face}`) ?? loaded.byName.get(request.name);
      if (!row) return null;
      const card = lookups.find((lookup) => lookup.id === request.id)?.card;
      const name = card?.faces.find((face) => face.face === request.face)?.name_zh;
      return { ...row, ...(name ? { name_zh: name } : {}) };
    });
    return result;
  }
  async retry(input: StatsQuery): Promise<unknown> {
    const query = parseStatsQuery(input);
    await this.initialized;
    if (this.state.lastRetry !== undefined && this.now() - this.state.lastRetry < 5000) return this.query(query, []);
    this.state.lastRetry = this.now();
    delete this.state.catalogFailure;
    this.state.catalogRevalidate = true;
    const catalog = this.state.catalog?.value;
    const requested = query.expansion ?? (catalog ? await this.remembered(catalog) : null);
    const expansion = catalog?.expansions.find((code) => code.toUpperCase() === requested?.toUpperCase());
    if (expansion && catalog?.expansions.includes(expansion)) {
      const key = statsDatasetKey({ ...query, expansion, format: this.resolveFormat(query, catalog, expansion) });
      if (this.state.failures) delete this.state.failures[key];
      // Persist invalidation separately: fetchedAt always reports the real snapshot age.
      this.state.revalidate = [...new Set([...(this.state.revalidate ?? []), key])].slice(-64);
    }
    await this.persist();
    return this.query(query, []);
  }
}
