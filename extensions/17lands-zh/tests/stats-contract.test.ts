import { expect, test } from 'bun:test';
import { DEFAULT_STATS_PREFS, GRADED_METRICS, colorLabel, deriveGrades, formatMetric, parseStatsCards, parseStatsCatalog, parseStatsData,
  parseStatsPrefs, parseStatsQuery, parseStatsRecord, statsEmbargoUntil, statsImageIdentity, voteStatsExpansion } from '../src/stats-contract';
import { STATS_ID, STATS_OTHER, statsCards, statsFilters, statsImage, statsQuery, statsRow } from './stats-fixture';

const parsedRow = (overrides: Record<string, unknown> = {}) => parseStatsRecord(statsRow(overrides))!;

test('stats query/cards validate exact keys and bounds without accepting arbitrary URLs', () => {
  expect(parseStatsQuery({ ...statsQuery, expansion: 'tst' }).expansion).toBe('TST');
  for (const query of [{ ...statsQuery, url: 'https://evil.test' }, { ...statsQuery, colors: 'UW' }, { ...statsQuery, group: 'all' },
    { ...statsQuery, format: '' }, { ...statsQuery, expansion: undefined }, { ...statsQuery, expansion: 'TST&colors=WU' }, {}]) expect(() => parseStatsQuery(query)).toThrow();
  expect(parseStatsCards([])).toEqual([]);
  expect(parseStatsCards(Array(64).fill(statsCards[0]))).toHaveLength(64);
  for (const cards of [Array(65).fill(statsCards[0]), [{ ...statsCards[0], name: 'x'.repeat(201) }], [{ ...statsCards[0], face: 'side' }],
    [{ ...statsCards[0], id: 'not-a-uuid' }], [{ ...statsCards[0], url: statsImage() }], [{ id: STATS_ID, face: 'front' }]]) expect(() => parseStatsCards(cards)).toThrow();
  expect(parseStatsPrefs(null)).toEqual(DEFAULT_STATS_PREFS);
  expect(parseStatsPrefs({ format: 'TradDraft', metric: 'avg_seen', colors: 'WU', group: 'top' })).toEqual({ ...DEFAULT_STATS_PREFS, format: 'TradDraft', colors: 'WU', group: 'top' });
});

test('catalog reads object keys, accepts only filter expansions and fails closed on dates', () => {
  const catalog = parseStatsCatalog(statsFilters(), { TST: {}, OLD: 'anything', UNKNOWN: {} });
  expect(catalog.site_draft_expansions).toEqual(['TST', 'OLD']);
  expect(statsEmbargoUntil(catalog, 'TST')).toBe(Date.parse('2025-01-13T00:00:00Z'));
  expect(statsEmbargoUntil(catalog, 'BAD')).toBeNull();
  expect(statsEmbargoUntil(catalog, 'MISSING')).toBeNull();
  expect(statsEmbargoUntil({ ...catalog, start_dates: { TST: 'yesterday' } }, 'TST')).toBeNull();
  expect(() => parseStatsCatalog({ ...statsFilters(), expansions: ['../bad'] }, {})).toThrow();
});

test('expansion vote ignores non-catalog sets, ties have no winner', () => {
  expect(voteStatsExpansion(['tst', 'OLD', 'tst', 'junk'], ['TST', 'OLD'])).toBe('TST');
  expect(voteStatsExpansion(['TST', 'OLD'], ['TST', 'OLD'])).toBeNull();
  expect(voteStatsExpansion([undefined, null, 'junk'], ['TST'])).toBeNull();
});

test('catalog accepts named expansions and resolves mock variants to their data expansion', () => {
  const filters = statsFilters();
  const catalog = parseStatsCatalog({ ...filters, expansions: [...filters.expansions, 'Cube - Powered'],
    formats_by_expansion: { ...filters.formats_by_expansion, 'Cube - Powered': ['PremierDraft'] },
    start_dates: { ...filters.start_dates, 'Cube - Powered': '2020-01-01' } }, { WEEK1: { expansion: 'TST' }, WEEK2: { expansion: 'TST' } });
  expect(catalog.expansions).toContain('Cube - Powered');
  expect(catalog.formats_by_expansion['Cube - Powered']).toEqual(['PremierDraft']);
  expect(catalog.site_draft_expansions).toEqual(['TST']);
  expect(parseStatsQuery({ ...statsQuery, expansion: 'Cube - Powered' }).expansion).toBe('CUBE - POWERED');
});

test('record parsing requires every numeric field, rejects malformed fields and preserves all metrics compactly', () => {
  const raw = statsRow(); const parsed = parseStatsRecord(raw)!;
  expect(parsed.front).toBe(raw.url); expect(parsed.back).toBeNull();
  expect(Object.hasOwn(parsed, 'url')).toBe(false);
  expect(parseStatsRecord(parsed, true)).toEqual(parsed);
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number') continue;
    expect(parseStatsRecord({ ...raw, [key]: '1' })).toBeNull();
    expect(parseStatsRecord({ ...raw, [key]: Infinity })).toBeNull();
    const missing: Record<string, unknown> = { ...raw }; delete missing[key];
    expect(parseStatsRecord(missing)).toBeNull();
  }
  for (const change of [{ seen_count: -1 }, { game_count: 1.5 }, { pool_count: null }, { win_rate: 1.01 },
    { avg_seen: -.1 }, { drawn_improvement_win_rate: -1.01 }, { rarity: 'invented' }, { color: 'WW' },
    { url: 'https://evil.test/a.jpg' }, { url_back: 'broken' }, { url: undefined }]) expect(parseStatsRecord({ ...raw, ...change })).toBeNull();
  const nullable = { ...raw, ...Object.fromEntries([...GRADED_METRICS, 'play_rate', 'never_drawn_win_rate'].map((key) => [key, null])) };
  expect(parseStatsRecord(nullable)).not.toBeNull();
  expect(parseStatsData({ copyright: 'fixture', notes: [], data: [raw, { ...raw, pool_count: 'bad' }] })).toEqual([parsed]);
  expect(() => parseStatsData({ copyright: 'fixture', notes: [], data: Array(1501).fill(raw) })).toThrow();
  expect(() => parseStatsData([raw])).toThrow();
  expect(() => parseStatsData({ copyright: 'fixture', notes: [], data: [{ ...raw, seen_count: null }] })).toThrow();
});

test('Scryfall identity retains physical face and validates path/origin', () => {
  expect(statsImageIdentity(statsImage(STATS_ID, 'back'))).toEqual({ id: STATS_ID, face: 'back' });
  expect(statsImageIdentity(`${statsImage(STATS_OTHER)}?v=1`)).toEqual({ id: STATS_OTHER, face: 'front' });
  for (const url of [statsImage().replace('https:', 'http:'), statsImage().replace('cards.scryfall.io', 'cards.scryfall.io.evil'),
    statsImage().replace('/0/0/', '/a/b/'), statsImage().replace('.jpg', '.svg'), `${statsImage()}#bad`]) expect(statsImageIdentity(url)).toBeNull();
});

test('grades use population SD, exact buckets, inverted averages, sorted ranks, and nonnull n', () => {
  const rows = Array.from({ length: 15 }, (_, index) => parsedRow({ win_rate: .3 + .02 * index, avg_seen: index + 1 }));
  const graded = deriveGrades(rows);
  const expected = ['F', 'D-', 'D', 'D', 'D+', 'C-', 'C-', 'C', 'C+', 'C+', 'B-', 'B', 'B', 'B+', 'A-'];
  expect(graded.map((row) => row.grades.win_rate?.grade)).toEqual(expected);
  expect(graded[14]!.grades.win_rate).toEqual({ grade: 'A-', rank: 1, n: 15 });
  expect(graded[0]!.grades.avg_seen).toEqual({ grade: 'A-', rank: 1, n: 15 });
  expect(graded[14]!.grades.avg_seen?.grade).toBe('F');
  const small = deriveGrades([...rows.slice(0, 14), parsedRow({ win_rate: null })]);
  expect(small[0]!.grades.win_rate).toEqual({ grade: null, rank: 14, n: 14 });
  expect(small[14]!.grades.win_rate).toBeNull();
  expect(deriveGrades(Array(15).fill(parsedRow()))[0]!.grades.win_rate?.grade).toBeNull();
});

test('metric formatting preserves percentage-point difference and average precision', () => {
  expect(formatMetric('avg_seen', 3.125)).toBe('3.13');
  expect(formatMetric('ever_drawn_win_rate', .5625)).toBe('56.3%');
  expect(formatMetric('drawn_improvement_win_rate', .023)).toBe('+2.3pp');
  expect(formatMetric('drawn_improvement_win_rate', -.023)).toBe('-2.3pp');
  expect(formatMetric('win_rate', null)).toBe('—');
});

test('grade outliers clamp at F and A+ for rates and inverted averages', () => {
  const rows = Array.from({ length: 100 }, (_, index) => parsedRow({ win_rate: index === 0 ? 0 : index === 1 ? 1 : .5,
    avg_pick: index === 0 ? 1 : index === 1 ? 15 : 8 }));
  const graded = deriveGrades(rows);
  expect(graded[0]!.grades.win_rate?.grade).toBe('F');
  expect(graded[1]!.grades.win_rate?.grade).toBe('A+');
  expect(graded[0]!.grades.avg_pick).toEqual({ grade: 'A+', rank: 1, n: 100 });
  expect(graded[1]!.grades.avg_pick?.grade).toBe('F');
});
test('names deck and card colours in Chinese', () => {
  expect(colorLabel('WU')).toBe('白蓝'); expect(colorLabel('BG')).toBe('黑绿'); expect(colorLabel('WUBRG')).toBe('白蓝黑红绿'); expect(colorLabel('')).toBe('');
});
