import { expect, test } from 'bun:test';
import { MAX_STATS_BYTES, STATS_CATALOG_TTL, STATS_DATASET_TTL, StatsService, statsDatasetKey } from '../src/stats-service';
import { IndexedStatsStore, MAX_STATS_DATASETS, MemoryStatsStore } from '../src/stats-store';
import { parseStatsRecord, type StatsQuery } from '../src/stats-contract';
import { STATS_ID, STATS_OTHER, statsCards, statsFilters, statsFixture, statsImage, statsQuery, statsRow } from './stats-fixture';

const key = (query: StatsQuery) => statsDatasetKey(query as StatsQuery & { expansion: string });

test('empty-card bootstrap returns catalog/context only; explicit pack avoids card lookup', async () => {
  const f = statsFixture(); const service = f.create(); f.settings({ statsMockExpansion: 'OLD' });
  const bootstrap = await service.query({ format: 'auto', colors: '', group: '' }, []);
  expect(bootstrap.catalog?.site_draft_expansions).toEqual(['TST', 'OLD']);
  expect(bootstrap.context).toEqual({ expansion: null, resolvedBy: 'unknown', format: 'PremierDraft', colors: '', group: '' });
  expect(bootstrap.cards).toEqual([]); expect(f.lookupCalls).toBe(0); expect(f.datasetRequests()).toHaveLength(0);
  expect((await service.query(statsQuery, [])).context.resolvedBy).toBe('explicit');
  expect(f.datasetRequests()).toHaveLength(0);
  expect((await service.query(statsQuery, statsCards)).cards[0]?.name).toBe('Example');
  expect(f.lookupCalls).toBe(0); expect((await f.store.meta())?.lastExpansion).toBeUndefined();
});

test('fixed endpoint/options, fresh cache and restart reuse dataset without network', async () => {
  const f = statsFixture(); const service = f.create();
  const query: StatsQuery = { ...statsQuery, colors: 'WU', group: 'top' };
  const first = await service.query(query, statsCards);
  expect(first.meta).toMatchObject({ cardCount: 1, stale: false, error: null });
  expect(f.datasetRequests()[0]!.url).toBe('https://www.17lands.com/api/card_data?expansion=TST&event_type=PremierDraft&colors=WU&user_group=top');
  expect(f.requests.every((request) => request.init?.method === 'GET' && request.init.credentials === 'omit' && request.init.redirect === 'error')).toBe(true);
  const count = f.requests.length;
  expect((await service.query(query, statsCards)).cards).toEqual(first.cards);
  expect((await f.create().query(query, statsCards)).meta.fetchedAt).toBe(first.meta.fetchedAt);
  expect(f.requests).toHaveLength(count);
});

test('explicit context adds an already-cached Chinese name without calling inference lookup', async () => {
  const f = statsFixture();
  const service = new StatsService(f.store, async () => { throw new Error('must not query card service'); }, async () => ({}), f.fetcher, () => f.time, f.lookup);
  expect((await service.query(statsQuery, statsCards)).cards[0]?.name_zh).toBe('平原');
  expect(f.lookupCalls).toBe(1);
});

test('expired datasets retain their actual timestamp on error and back off across restarts', async () => {
  const f = statsFixture(); const service = f.create(); const first = await service.query(statsQuery, statsCards);
  f.advance(STATS_DATASET_TTL + 1); f.datasetOffline();
  const stale = await service.query(statsQuery, statsCards);
  expect(stale.cards[0]?.name).toBe('Example'); expect(stale.meta.stale).toBe(true);
  expect(stale.meta.fetchedAt).toBe(first.meta.fetchedAt); expect(stale.meta.error).toContain('offline');
  const count = f.requests.length;
  expect((await f.create().query(statsQuery, statsCards)).meta.stale).toBe(true); expect(f.requests).toHaveLength(count);
  f.advance(60_001); f.datasetOffline(false);
  expect((await service.query(statsQuery, statsCards)).meta.stale).toBe(false); expect(f.datasetRequests()).toHaveLength(3);
});

test('catalog has 24h TTL, shared flight and durable failure backoff with stale fallback', async () => {
  const f = statsFixture(); const service = f.create();
  await Promise.all(Array.from({ length: 10 }, () => service.query(statsQuery, []))); expect(f.requests).toHaveLength(2);
  f.advance(STATS_CATALOG_TTL + 1); f.offline();
  const stale = await service.query(statsQuery, []);
  expect(stale.catalog?.expansions).toContain('TST'); expect(stale.meta.error).toBe('offline');
  const count = f.requests.length;
  expect((await f.create().query(statsQuery, [])).catalog).not.toBeNull(); expect(f.requests).toHaveLength(count);
  const empty = statsFixture(); empty.offline();
  expect((await empty.create().query(statsQuery, statsCards)).catalog).toBeNull();
  expect((await empty.create().query(statsQuery, statsCards)).meta.error).toBe('offline'); expect(empty.requests).toHaveLength(1);
});

test('single flight per dataset and one global lane across concurrent keys', async () => {
  const f = statsFixture(); const service = f.create();
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => service.query({ ...statsQuery, group: index % 2 ? 'top' : '' }, statsCards)));
  expect(results.every((result) => result.cards[0]?.name === 'Example')).toBe(true);
  expect(f.datasetRequests()).toHaveLength(2); expect(f.maximum).toBe(1);
});

test('inference uses accepted majority and matching zh face, then settings or persisted expansion', async () => {
  const f = statsFixture(); const service = f.create(); const query: StatsQuery = { format: 'auto', colors: '', group: '' };
  const inferred = await service.query(query, statsCards);
  expect(inferred.context).toMatchObject({ expansion: 'TST', resolvedBy: 'inferred' });
  expect(inferred.cards[0]?.name_zh).toBe('平原'); expect((await f.store.meta())?.lastExpansion).toBe('TST');
  f.lookupSets([]); f.settings({ statsMockExpansion: 'OLD' });
  expect((await service.query(query, statsCards)).context).toMatchObject({ expansion: 'OLD', resolvedBy: 'remembered' });
  f.settings({ statsMockExpansion: 'INVALID' });
  expect((await f.create().query(query, statsCards)).context).toMatchObject({ expansion: 'TST', resolvedBy: 'remembered' });
  const empty = statsFixture(); empty.lookupSets([]);
  const unknown = await empty.create().query(query, statsCards);
  expect(unknown.context.resolvedBy).toBe('unknown'); expect(unknown.cards).toEqual([null]); expect(empty.datasetRequests()).toHaveLength(0);
});

test('embargo, missing date and unsupported filters prevent fetching or displaying cached data', async () => {
  const f = statsFixture(); const service = f.create();
  await f.store.put({ key: key({ ...statsQuery, expansion: 'NEW' }), fetchedAt: f.time, used: f.time, records: [parseStatsRecord(statsRow())!] });
  for (const query of [{ ...statsQuery, expansion: 'NEW' }, { ...statsQuery, expansion: 'BAD' }, { ...statsQuery, expansion: 'MISSING' },
    { ...statsQuery, expansion: 'OLD', format: 'TradDraft' }, { ...statsQuery, format: 'Invented' }]) {
    const result = await service.query(query, statsCards); expect(result.cards).toEqual([null]); expect(result.meta.error).not.toBeNull();
  }
  expect(f.datasetRequests()).toHaveLength(0); expect(f.lookupCalls).toBe(0);
  const filters = statsFilters(); delete (filters.start_dates as Record<string, string>).TST;
  const missing = statsFixture(); missing.filters(filters);
  expect((await missing.create().query(statsQuery, statsCards)).meta.embargoUntil).toBeNull(); expect(missing.datasetRequests()).toHaveLength(0);
  const ready = statsFixture(); ready.advance(10 * 24 * 60 * 60_000);
  expect((await ready.create().query({ ...statsQuery, expansion: 'NEW' }, statsCards)).cards[0]).not.toBeNull();
});

test('front/back UUID wins over name; valid UUID mismatch falls back to exact dataset name', async () => {
  const f = statsFixture();
  f.rows([statsRow({ name: 'By identity', url_back: statsImage(STATS_ID, 'back') }), statsRow({ name: 'Exact', url: statsImage(STATS_OTHER), win_rate: .7 })]);
  const result = await f.create().query(statsQuery, [
    { id: STATS_ID, face: 'back', name: 'Exact' }, { id: '00000000-0000-0000-0000-000000000003', face: 'front', name: 'Exact' },
    { id: '00000000-0000-0000-0000-000000000004', face: 'front', name: 'exact' },
  ]);
  expect(result.cards.map((card) => card?.name ?? null)).toEqual(['By identity', 'Exact', null]); expect(result.cards[1]?.win_rate).toBe(.7);
});

test('retry is limited across restart, and failed revalidation preserves real fetchedAt', async () => {
  const f = statsFixture(); let service = f.create(); const original = await service.query(statsQuery, statsCards);
  f.advance(1000); f.datasetOffline(); await service.retry(statsQuery);
  service = f.create();
  expect((await service.query(statsQuery, statsCards)).meta).toMatchObject({ fetchedAt: original.meta.fetchedAt, stale: true });
  const count = f.requests.length;
  await Promise.all(Array.from({ length: 5 }, () => service.retry(statsQuery))); await service.query(statsQuery, statsCards); await f.create().retry(statsQuery);
  expect(f.requests).toHaveLength(count);
  f.advance(5000); f.datasetOffline(false); await service.retry(statsQuery);
  expect((await service.query(statsQuery, statsCards)).meta.stale).toBe(false); expect(f.datasetRequests()).toHaveLength(3);
});

test('bad JSON, oversized streams and corrupt persisted snapshots cannot replace good data', async () => {
  const f = statsFixture(); const service = f.create(); const first = await service.query(statsQuery, statsCards);
  f.advance(STATS_DATASET_TTL + 1); f.response(() => new Response('bad JSON', { headers: { 'content-type': 'text/html' } }));
  expect((await service.query(statsQuery, statsCards)).meta.fetchedAt).toBe(first.meta.fetchedAt);
  f.advance(60_001); let cancelled = false;
  f.response(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_STATS_BYTES)); controller.enqueue(new Uint8Array(1));
  }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }));
  expect((await service.query(statsQuery, statsCards)).meta.error).toContain('过大'); expect(cancelled).toBe(true);
  const broken = statsFixture();
  await broken.store.put({ key: key(statsQuery), records: [{ ...parseStatsRecord(statsRow())!, win_rate: 'bad' } as never], fetchedAt: broken.time, used: broken.time });
  broken.datasetOffline(); expect((await broken.create().query(statsQuery, statsCards)).cards).toEqual([null]);
});

test('dataset LRU evicts at twelve and an evicted dataset refetches', async () => {
  const f = statsFixture(); const service = f.create();
  const colors = ['', 'WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'] as const;
  const queries: StatsQuery[] = colors.map((color) => ({ ...statsQuery, colors: color })); queries.push({ ...statsQuery, group: 'top' });
  for (const query of queries) { await service.query(query, statsCards); f.advance(1); }
  await service.query(queries[0]!, statsCards); f.advance(1); await service.query({ ...statsQuery, group: 'bottom' }, statsCards);
  expect(f.store.datasets.size).toBe(MAX_STATS_DATASETS); expect(f.store.datasets.has(key(queries[0]!))).toBe(true); expect(f.store.datasets.has(key(queries[1]!))).toBe(false);
  const count = f.datasetRequests().length; await service.query(queries[1]!, statsCards); expect(f.datasetRequests()).toHaveLength(count + 1);
});

test('unavailable IndexedDB falls back to bounded memory datasets and metadata', async () => {
  const store = new IndexedStatsStore();
  for (let index = 0; index < 13; index++) await store.put({ key: `key-${index}`, records: [], fetchedAt: 1, used: index });
  expect(await store.get('key-0')).toBeUndefined(); expect((await store.get('key-12'))?.fetchedAt).toBe(1);
  await store.saveMeta({ lastExpansion: 'TST' }); expect((await store.meta())?.lastExpansion).toBe('TST');
});

test('default fetch binding retains native global receiver', async () => {
  const original = globalThis.fetch; const f = statsFixture(); const receivers: unknown[] = [];
  globalThis.fetch = (async function(this: unknown, input: string | URL | Request, init?: RequestInit) {
    receivers.push(this); if (this !== globalThis) throw new TypeError('Illegal invocation'); return f.fetcher(input, init);
  }) as typeof fetch;
  try {
    const service = new StatsService(new MemoryStatsStore(), f.lookup, async () => ({}));
    expect((await service.query(statsQuery, statsCards)).cards[0]).not.toBeNull(); expect(receivers).toHaveLength(3); expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
  } finally { globalThis.fetch = original; }
});
