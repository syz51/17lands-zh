import { MemoryStatsStore } from '../src/stats-store';
import { StatsService } from '../src/stats-service';
import { card } from './cache-fixture';
import type { LookupResult } from '../src/cache-contract';
import type { StatsCardRequest, StatsQuery } from '../src/stats-contract';

export const STATS_ID = '00000000-0000-0000-0000-000000000001';
export const STATS_OTHER = '00000000-0000-0000-0000-000000000002';
export const statsImage = (id = STATS_ID, face = 'front') => `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`;
export const statsQuery: StatsQuery = { expansion: 'TST', format: 'PremierDraft', colors: '', group: '' };
export const statsCards: StatsCardRequest[] = [{ id: STATS_ID, face: 'front', name: 'Example' }];
export const statsRow = (overrides: Record<string, unknown> = {}) => ({
  mtga_id: 1, name: 'Example', color: 'WU', rarity: 'common', url: statsImage(), url_back: '',
  seen_count: 100, avg_seen: 3.5, pick_count: 80, avg_pick: 4.5,
  game_count: 90, pool_count: 100, play_rate: .9, win_rate: .55,
  opening_hand_game_count: 30, opening_hand_win_rate: .6,
  drawn_game_count: 50, drawn_win_rate: .54, ever_drawn_game_count: 80, ever_drawn_win_rate: .56,
  never_drawn_game_count: 10, never_drawn_win_rate: .5, drawn_improvement_win_rate: .06, ...overrides,
});
export const statsFilters = () => ({
  expansions: ['TST', 'OLD', 'NEW', 'BAD'], formats: ['PremierDraft', 'TradDraft'],
  formats_by_expansion: { TST: ['PremierDraft', 'TradDraft'], OLD: ['PremierDraft'], NEW: ['PremierDraft'], BAD: ['PremierDraft'] },
  start_dates: { TST: '2025-01-01', OLD: '2024-01-01', NEW: '2026-10-20', BAD: '2026-02-30' },
});
export function statsFixture(store = new MemoryStatsStore()) {
  let time = Date.parse('2026-10-22T00:00:00Z'); let offline = false; let datasetOffline = false;
  let rows = [statsRow()]; let filters = statsFilters(); let settings: { statsMockExpansion?: string } = {};
  let lookupSets: string[] = ['tst']; let lookupCalls = 0;
  let response: (() => Response) | undefined;
  const requests: { url: string; init?: RequestInit }[] = [];
  let active = 0; let maximum = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    active++; maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (offline) throw new Error('offline');
      let body: unknown;
      if (url.endsWith('/data/filters')) body = filters;
      else if (url.endsWith('/data/site_draft_expansions')) body = { TST: {}, OLD: {}, NOT_IN_CATALOG: {} };
      else if (url.startsWith('https://www.17lands.com/api/card_data?')) {
        if (datasetOffline) throw new Error('dataset offline');
        if (response) return response();
        body = { copyright: 'Public test fixture', notes: [], data: rows };
      } else throw new Error(`Unexpected stats URL ${url}`);
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'text/html' } });
    } finally { active--; }
  }) as typeof fetch;
  const lookup = async (ids: string[]): Promise<LookupResult[]> => {
    lookupCalls++;
    return ids.map((id, index) => ({ id, card: lookupSets[index] ? { ...card(id), set_code: lookupSets[index]! } : null, origin: 'cache', revision: 'r1', fallback: false }));
  };
  return { store, requests, fetcher, lookup, create: () => new StatsService(store, lookup, async () => settings, fetcher, () => time),
    get time() { return time; }, get lookupCalls() { return lookupCalls; }, get maximum() { return maximum; },
    advance: (ms: number) => { time += ms; }, offline: (value = true) => { offline = value; }, datasetOffline: (value = true) => { datasetOffline = value; },
    rows: (value: typeof rows) => { rows = value; }, filters: (value: typeof filters) => { filters = value; },
    settings: (value: typeof settings) => { settings = value; }, lookupSets: (value: string[]) => { lookupSets = value; },
    response: (value: () => Response) => { response = value; }, datasetRequests: () => requests.filter((request) => request.url.includes('/api/card_data?')) };
}
