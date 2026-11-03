import type { FaceSide } from './cache-contract';

export const STATS_COLORS = ['', 'WU', 'WB', 'WR', 'WG', 'UB', 'UR', 'UG', 'BR', 'BG', 'RG'] as const;
export const STATS_GROUPS = ['', 'top', 'middle', 'bottom'] as const;
export const SELECTABLE_METRICS = ['ever_drawn_win_rate', 'opening_hand_win_rate', 'drawn_win_rate', 'drawn_improvement_win_rate', 'win_rate'] as const;
export const GRADED_METRICS = [...SELECTABLE_METRICS, 'avg_seen', 'avg_pick'] as const;
export const METRIC_LABELS = { ever_drawn_win_rate: 'GIH WR', opening_hand_win_rate: 'OH WR', drawn_win_rate: 'GD WR', drawn_improvement_win_rate: 'IIH', win_rate: 'GP WR', avg_seen: 'ALSA', avg_pick: 'ATA' } as const;
export type StatsMetric = typeof SELECTABLE_METRICS[number];
export type GradedMetric = typeof GRADED_METRICS[number];
export type StatsPrefs = { format: string; colors: typeof STATS_COLORS[number]; group: typeof STATS_GROUPS[number]; metric: StatsMetric };
export const DEFAULT_STATS_PREFS: StatsPrefs = { format: 'auto', colors: '', group: '', metric: 'ever_drawn_win_rate' };
export type StatsQuery = { expansion?: string; format: string; colors: StatsPrefs['colors']; group: StatsPrefs['group'] };
export type StatsCardRequest = { id: string; face: FaceSide; name: string };
export type StatsCatalog = { expansions: string[]; formats: string[]; formats_by_expansion: Record<string, string[]>; start_dates: Record<string, string>; site_draft_expansions: string[] };
export type StatsRecord = {
  mtga_id: number; name: string; color: string; rarity: string; front: string; back: string | null;
  seen_count: number; avg_seen: number | null; pick_count: number; avg_pick: number | null;
  game_count: number; pool_count: number; play_rate: number | null; win_rate: number | null;
  opening_hand_game_count: number; opening_hand_win_rate: number | null;
  drawn_game_count: number; drawn_win_rate: number | null;
  ever_drawn_game_count: number; ever_drawn_win_rate: number | null;
  never_drawn_game_count: number; never_drawn_win_rate: number | null;
  drawn_improvement_win_rate: number | null;
};
export type MetricGrade = { grade: string | null; rank: number; n: number };
export type StatsCard = StatsRecord & { grades: Record<GradedMetric, MetricGrade | null>; name_zh?: string };
export type StatsResponse = {
  catalog: StatsCatalog | null;
  context: { expansion: string | null; resolvedBy: 'explicit' | 'inferred' | 'remembered' | 'unknown'; format: string; colors: StatsPrefs['colors']; group: StatsPrefs['group'] };
  meta: { fetchedAt: number | null; stale: boolean; embargoUntil: number | null; cardCount: number; error: string | null };
  cards: (StatsCard | null)[];
};

export function formatLabel(format: string) { return ({ PremierDraft: '竞技轮抽', TradDraft: '传统轮抽', QuickDraft: '快速轮抽', PickTwoDraft: '双选轮抽', MidWeekQuickDraft: '周中快速轮抽' } as Record<string, string>)[format] ?? format; }
/** Chinese colour names in WUBRG order, e.g. "BG" → "黑绿"; unknown letters are kept as-is. */
export function colorLabel(code: string) { return [...code].map((letter) => ({ W: '白', U: '蓝', B: '黑', R: '红', G: '绿' } as Record<string, string>)[letter] ?? letter).join(''); }
export function formatMetric(metric: GradedMetric | 'never_drawn_win_rate' | 'play_rate', value: number | null) {
  if (value === null) return '—';
  if (metric === 'avg_seen' || metric === 'avg_pick') return value.toFixed(2);
  if (metric === 'drawn_improvement_win_rate') return `${value >= 0 ? '+' : ''}${(100 * value).toFixed(1)}pp`;
  return `${(100 * value).toFixed(1)}%`;
}

// Runtime messages carry only a bounded identity list and public filter values.
import { UUID_RE, record } from './cache-contract';

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
const expansionCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9 _-]{1,63}$/i.test(value);
const formatCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(value);
export function parseStatsQuery(value: unknown): StatsQuery {
  if (!record(value) || !exactKeys(value, ['format', 'colors', 'group'], ['expansion']) ||
    !formatCode(value.format) || !STATS_COLORS.includes(value.colors as StatsPrefs['colors']) ||
    !STATS_GROUPS.includes(value.group as StatsPrefs['group']) ||
    (Object.hasOwn(value, 'expansion') && !expansionCode(value.expansion))) throw new Error('统计查询格式无效');
  return { ...(typeof value.expansion === 'string' ? { expansion: value.expansion.toUpperCase() } : {}),
    format: value.format, colors: value.colors as StatsPrefs['colors'], group: value.group as StatsPrefs['group'] };
}
export function parseStatsCards(value: unknown): StatsCardRequest[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('统计卡牌格式无效');
  return value.map((card) => {
    if (!record(card) || !exactKeys(card, ['id', 'face', 'name']) || typeof card.id !== 'string' || !UUID_RE.test(card.id) ||
      (card.face !== 'front' && card.face !== 'back') || typeof card.name !== 'string' || card.name.length > 200) throw new Error('统计卡牌格式无效');
    return { id: card.id.toLowerCase(), face: card.face, name: card.name };
  });
}
export function parseStatsPrefs(value: unknown): StatsPrefs {
  if (!record(value)) return { ...DEFAULT_STATS_PREFS };
  return { format: formatCode(value.format) ? value.format : DEFAULT_STATS_PREFS.format,
    colors: STATS_COLORS.includes(value.colors as StatsPrefs['colors']) ? value.colors as StatsPrefs['colors'] : '',
    group: STATS_GROUPS.includes(value.group as StatsPrefs['group']) ? value.group as StatsPrefs['group'] : '',
    metric: SELECTABLE_METRICS.includes(value.metric as StatsMetric) ? value.metric as StatsMetric : DEFAULT_STATS_PREFS.metric };
}
function strings(value: unknown, valid: (value: unknown) => value is string): string[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every(valid)) throw new Error('统计目录格式无效');
  return [...new Set(value)];
}
export function parseStatsCatalog(filters: unknown, siteDraftExpansions: unknown): StatsCatalog {
  if (!record(filters) || !record(filters.formats_by_expansion) || !record(filters.start_dates)) throw new Error('统计目录格式无效');
  const expansions = strings(filters.expansions, expansionCode);
  const formats = strings(filters.formats, formatCode);
  const formats_by_expansion: Record<string, string[]> = {};
  const start_dates: Record<string, string> = {};
  for (const code of expansions) {
    const rawKey = Object.keys(filters.formats_by_expansion).find((key) => key.toUpperCase() === code.toUpperCase());
    const values = rawKey ? filters.formats_by_expansion[rawKey] : undefined;
    // Missing per-expansion formats fail closed; never silently allow every format.
    formats_by_expansion[code] = values === undefined ? [] : strings(values, formatCode).filter((format) => formats.includes(format));
    const dateKey = Object.keys(filters.start_dates).find((key) => key.toUpperCase() === code.toUpperCase());
    const date = dateKey ? filters.start_dates[dateKey] : undefined;
    if (typeof date === 'string' && date.length <= 64) start_dates[code] = date;
  }
  const site = Array.isArray(siteDraftExpansions) ? strings(siteDraftExpansions, expansionCode)
    : record(siteDraftExpansions) ? Object.entries(siteDraftExpansions).map(([key, value]) => record(value) && expansionCode(value.expansion) ? value.expansion : key).filter(expansionCode) : (() => { throw new Error('轮抽系列目录格式无效'); })();
  return { expansions: [...new Set(expansions)], formats, formats_by_expansion, start_dates,
    site_draft_expansions: [...new Set(site.map((code) => expansions.find((item) => item.toUpperCase() === code.toUpperCase())).filter((code): code is string => !!code))] };
}

/** No date means no release permission. Date-only values are interpreted at UTC midnight. */
export function statsEmbargoUntil(catalog: StatsCatalog | null, expansion: string): number | null {
  const date = catalog?.start_dates[expansion];
  if (!date || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)) return null;
  const time = Date.parse(date);
  const day = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(time) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date.slice(0, 10)) return null;
  return time + 12 * 24 * 60 * 60_000;
}
/** A tied vote has no majority winner. Only catalog-accepted codes may participate. */
export function voteStatsExpansion(codes: (string | null | undefined)[], accepted: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of codes) {
    const code = value && accepted.find((item) => item.toUpperCase() === value.toUpperCase());
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked[0] && (!ranked[1] || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
}

const COUNTS = ['seen_count', 'pick_count', 'game_count', 'pool_count', 'opening_hand_game_count', 'drawn_game_count', 'ever_drawn_game_count', 'never_drawn_game_count'] as const;
const RATES = ['play_rate', 'win_rate', 'opening_hand_win_rate', 'drawn_win_rate', 'ever_drawn_win_rate', 'never_drawn_win_rate', 'drawn_improvement_win_rate'] as const;
/** Extract an identity only from a Scryfall raster URL with its actual physical face. */
export function statsImageIdentity(value: unknown): { id: string; face: FaceSide } | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'cards.scryfall.io' || url.port || url.username || url.password || url.hash) return null;
    const match = /^\/(?:small|normal|large|png|art_crop|border_crop)\/(front|back)\/([a-f0-9])\/([a-f0-9])\/([a-f0-9-]{36})\.(?:jpg|png|webp)$/i.exec(url.pathname);
    if (!match || !UUID_RE.test(match[4]!) || match[2]!.toLowerCase() !== match[4]![0]!.toLowerCase() || match[3]!.toLowerCase() !== match[4]![1]!.toLowerCase()) return null;
    return { id: match[4]!.toLowerCase(), face: match[1]!.toLowerCase() as FaceSide };
  } catch { return null; }
}
export function parseStatsRecord(value: unknown, compact = false): StatsRecord | null {
  if (!record(value) || !Number.isSafeInteger(value.mtga_id) || (value.mtga_id as number) < 0 ||
    typeof value.name !== 'string' || !value.name.length || value.name.length > 200 ||
    typeof value.color !== 'string' || !/^[WUBRG]*$/.test(value.color) || value.color.length > 5 ||
    new Set(value.color).size !== value.color.length || !['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'].includes(String(value.rarity))) return null;
  const result: Record<string, unknown> = { mtga_id: value.mtga_id, name: value.name, color: value.color, rarity: value.rarity };
  for (const field of COUNTS) {
    if (!Object.hasOwn(value, field) || !Number.isSafeInteger(value[field]) || (value[field] as number) < 0) return null;
    result[field] = value[field];
  }
  for (const field of [...RATES, 'avg_seen', 'avg_pick'] as const) {
    const number = value[field];
    if (!Object.hasOwn(value, field) || (number !== null && (typeof number !== 'number' || !Number.isFinite(number) ||
      (field === 'drawn_improvement_win_rate' ? number < -1 || number > 1 : number < 0 || (RATES.includes(field as typeof RATES[number]) && number > 1))))) return null;
    result[field] = number ?? null;
  }
  const front = compact ? value.front : value.url;
  const back = compact ? value.back : value.url_back;
  if (statsImageIdentity(front)?.face !== 'front' ||
    !(back === null || back === '' || statsImageIdentity(back)?.face === 'back')) return null;
  result.front = front;
  result.back = back || null;
  return result as StatsRecord;
}
export function parseStatsData(value: unknown): StatsRecord[] {
  if (!record(value) || typeof value.copyright !== 'string' || value.copyright.length > 16_384 ||
    !(typeof value.notes === 'string' || (Array.isArray(value.notes) && value.notes.length <= 100 && value.notes.every((note) => typeof note === 'string' && note.length <= 16_384))) ||
    !Array.isArray(value.data) || value.data.length > 1500) throw new Error('统计数据格式无效');
  const rows = value.data.map((row) => parseStatsRecord(row)).filter((row): row is StatsRecord => row !== null);
  if (value.data.length && !rows.length) throw new Error('统计数据没有有效记录');
  return rows;
}
const GRADE_SCALE = ['F', 'D-', 'D', 'D+', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];
/** All seven metrics are ranked/graded once over the full dataset, never the visible pack. */
export function deriveGrades(records: readonly StatsRecord[]): StatsCard[] {
  const cards: StatsCard[] = records.map((row) => ({ ...row, grades: Object.fromEntries(GRADED_METRICS.map((metric) => [metric, null])) as StatsCard['grades'] }));
  for (const metric of GRADED_METRICS) {
    const inverted = metric === 'avg_seen' || metric === 'avg_pick';
    const values = cards.map((card, index) => ({ index, value: card[metric] })).filter((entry): entry is { index: number; value: number } => entry.value !== null);
    const n = values.length;
    if (!n) continue;
    // Welford's population variance avoids creating a tiny artificial SD for equal values.
    let mean = 0; let squared = 0;
    values.forEach((entry, index) => {
      const delta = entry.value - mean;
      mean += delta / (index + 1);
      squared += delta * (entry.value - mean);
    });
    const sd = Math.sqrt(Math.max(0, squared / n));
    values.sort((a, b) => inverted ? a.value - b.value : b.value - a.value);
    values.forEach((entry, index) => {
      const z = sd > 0 ? (entry.value - mean) / sd * (inverted ? -1 : 1) : 0;
      const grade = n >= 15 && sd > 0 ? GRADE_SCALE[Math.max(0, Math.min(12, Math.floor(3 * (z + 2 - 1 / 6))))]! : null;
      cards[entry.index]!.grades[metric] = { grade, rank: index + 1, n };
    });
  }
  return cards;
}
