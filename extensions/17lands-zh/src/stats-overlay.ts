import { printingIn } from './card-images';
import { record } from './cache-contract';
import { DEFAULT_STATS_PREFS, colorLabel, METRIC_LABELS, SELECTABLE_METRICS, STATS_COLORS, STATS_GROUPS, formatLabel, formatMetric, parseStatsPrefs,
  type StatsCard, type StatsCardRequest, type StatsCatalog, type StatsPrefs, type StatsQuery, type StatsResponse } from './stats-contract';
import { STATS_CSS } from './stats-overlay.css';

export type StatsMeasurement = { width: number; height: number; slotHeight: number; overlay: boolean; pack: HTMLElement | null };
export type StatsOverlayOptions = {
  send: (message: unknown) => Promise<unknown>; originalSource: (image: HTMLImageElement) => string;
  savePrefs: (prefs: StatsPrefs) => Promise<void>; saveMockExpansion?: (expansion: string) => Promise<void>;
  measure?: (image: HTMLImageElement) => StatsMeasurement;
};
type Slot = { image: HTMLImageElement; slot: HTMLElement; host: HTMLElement; root: ShadowRoot; request: StatsCardRequest; identity: string;
  originalMinHeight: string; originalPriority: string; appliedMinHeight: string; card?: StatsCard | null };
const HOST = 'data-lands-zh-stats';
const COMMON_FORMATS = ['PremierDraft', 'TradDraft', 'QuickDraft', 'PickTwoDraft'];
export const statsDraftFormat = (format: string) => /Draft/.test(format) && !/Sealed/.test(format);
export function statsRoute(path: string) { return /^\/(?:site_draft|draft|site_draft_replay|submitted_draft)\/[^/]+(?:\/.*)?$/.test(path) || /^\/user\/latest_draft\/[^/]+(?:\/.*)?$/.test(path); }
export function parseStatsHeader(text: string, catalog: StatsCatalog): { expansion: string; format: string } | null {
  for (const expansion of catalog.expansions) {
    const escaped = expansion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?:^|[\\s|])${escaped}\\s+([A-Za-z][A-Za-z0-9_]{0,63})(?=\\s|\\||$)`, 'i').exec(text);
    const format = match?.[1];
    if (format && catalog.formats.includes(format) && catalog.formats_by_expansion[expansion]?.includes(format)) return { expansion, format };
  }
  return null;
}
export function measureStatsCard(image: HTMLImageElement): StatsMeasurement {
  const rect = image.getBoundingClientRect(); const slot = image.parentElement;
  let overlay = false;
  for (let element: Element | null = image; element; element = element.parentElement) {
    const position = image.ownerDocument.defaultView!.getComputedStyle(element).position;
    if (position === 'fixed' || position === 'absolute') { overlay = true; break; }
  }
  const parent = slot?.parentElement; const style = parent && image.ownerDocument.defaultView!.getComputedStyle(parent);
  const pack = parent && style?.display === 'flex' && style.flexWrap === 'wrap' ? parent : null;
  return { width: rect.width, height: rect.height, slotHeight: slot?.getBoundingClientRect().height ?? 0, overlay, pack };
}
function node<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;
}
function link(document: Document, text: string, url: string, className?: string) {
  const a = node(document, 'a', text, className); a.href = url; a.target = '_blank'; a.rel = 'noreferrer'; return a;
}
/** Coarse relative age for status copy; under a minute reads as just updated. */
export function statsAge(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
}
export function statsSourceUrl(query: StatsQuery, card?: number) {
  const url = new URL(card === undefined ? '/card_data' : '/card_data/details', 'https://www.17lands.com');
  if (query.expansion) url.searchParams.set('expansion', query.expansion);
  url.searchParams.set('format', query.format); url.searchParams.set('time_period', 'ALL_TIME');
  if (query.colors) url.searchParams.set('deck_color', query.colors);
  if (query.group) url.searchParams.set('user_group', query.group);
  if (card !== undefined) url.searchParams.set('card_id', String(card));
  return url.toString();
}

export class StatsOverlay {
  private enabled = false;
  private disposed = false;
  private epoch = 0;
  private prefs: StatsPrefs = { ...DEFAULT_STATS_PREFS };
  private path = '';
  private signature = '';
  private pack?: HTMLElement;
  private readonly slots = new Map<HTMLElement, Slot>();
  private catalog: StatsCatalog | null = null;
  private picks: { color: string; count: number }[] = [];
  private response?: StatsResponse;
  private toolbar?: HTMLElement;
  private toolbarRoot?: ShadowRoot;
  private popover?: HTMLElement;
  private popoverRoot?: ShadowRoot;
  private opened?: Slot;
  private readonly explicit = new Map<string, string>();
  private readonly observer: MutationObserver;
  private readonly interval: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private loading = false;
  private bootstrap?: Promise<StatsCatalog | null>;
  private retrying?: object;
  private readonly schedule = () => {
    if (this.timer || !this.enabled || this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.scan(); }, 0);
  };
  private readonly outside = (event: Event) => {
    if (!this.opened || event.composedPath().includes(this.popover!) || event.composedPath().includes(this.opened.host)) return;
    if (event.composedPath().some((target) => (target as Element).getAttribute?.(HOST) === 'strip')) return;
    this.close();
  };
  private readonly keydown = (event: KeyboardEvent) => { if (event.key === 'Escape' && this.opened) { event.preventDefault(); this.close(); } };
  private readonly reposition = () => this.positionPopover();

  constructor(private readonly document: Document, private readonly options: StatsOverlayOptions) {
    const view = document.defaultView!;
    this.observer = new view.MutationObserver(this.schedule);
    this.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'alt', 'style', 'class'] });
    view.addEventListener('popstate', this.schedule); view.addEventListener('resize', this.schedule);
    view.addEventListener('resize', this.reposition); view.addEventListener('scroll', this.reposition, true);
    document.addEventListener('click', this.outside, true); document.addEventListener('keydown', this.keydown);
    this.interval = setInterval(() => { if (view.location.pathname !== this.path) this.schedule(); }, 500);
  }
  setEnabled(enabled: boolean) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.schedule(); else this.clear();
  }
  setPrefs(value: unknown) {
    const prefs = parseStatsPrefs(value); const previous = this.prefs; this.prefs = prefs;
    if (previous.format !== prefs.format || previous.colors !== prefs.colors || previous.group !== prefs.group) this.refresh();
    else { this.renderToolbar(); this.renderStrips(); if (this.opened) this.open(this.opened, false); }
  }
  refresh(retry = false) {
    if (!this.enabled || this.disposed) return;
    this.epoch++; this.signature = ''; this.close(false);
    if (retry) {
      const operation = {}; this.retrying = operation;
      const current = this.query();
      this.catalog = null; this.bootstrap = undefined;
      this.loading = true; this.response = undefined; this.renderToolbar(); this.renderStrips();
      void this.options.send({ type: '17lands-zh:stats-retry', query: current }).catch(() => {}).finally(() => {
        if (this.retrying !== operation) return;
        this.retrying = undefined; this.signature = ''; this.schedule();
      });
    } else this.schedule();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.enabled = false; this.clear(); this.observer.disconnect(); clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    const view = this.document.defaultView!;
    view.removeEventListener('popstate', this.schedule); view.removeEventListener('resize', this.schedule);
    view.removeEventListener('resize', this.reposition); view.removeEventListener('scroll', this.reposition, true);
    this.document.removeEventListener('click', this.outside, true); this.document.removeEventListener('keydown', this.keydown);
  }
  private clear() {
    this.epoch++; this.signature = ''; this.loading = false; this.response = undefined; this.retrying = undefined; this.picks = []; this.close(false);
    for (const value of this.slots.values()) this.removeSlot(value); this.slots.clear();
    this.toolbar?.remove(); this.toolbar = undefined; this.toolbarRoot = undefined; this.pack = undefined;
    this.popover?.remove(); this.popover = undefined; this.popoverRoot = undefined;
  }
  private removeSlot(value: Slot) {
    value.host.remove();
    if (value.slot.style.minHeight === value.appliedMinHeight) {
      if (value.originalMinHeight) value.slot.style.setProperty('min-height', value.originalMinHeight, value.originalPriority);
      else value.slot.style.removeProperty('min-height');
    }
  }
  private createHost(kind: string) {
    const host = this.document.createElement('div'); host.setAttribute(HOST, kind);
    const root = host.attachShadow({ mode: 'open' }); const style = node(this.document, 'style', STATS_CSS); root.append(style);
    for (const type of ['click', 'pointerdown', 'mousedown']) host.addEventListener(type, (event) => event.stopPropagation());
    return { host, root };
  }
  private header() {
    if (!this.catalog || this.path.startsWith('/site_draft/')) return null;
    return parseStatsHeader(this.document.body.innerText ?? this.document.body.textContent ?? '', this.catalog);
  }
  private query(): StatsQuery {
    const header = this.header(); const expansion = header?.expansion ?? this.explicit.get(this.path);
    return { ...(expansion ? { expansion } : {}), format: this.prefs.format === 'auto' ? header?.format ?? 'PremierDraft' : this.prefs.format, colors: this.prefs.colors, group: this.prefs.group };
  }
  private async getCatalog() {
    if (this.catalog) return this.catalog;
    if (this.bootstrap) return this.bootstrap;
    const operation = this.options.send({ type: '17lands-zh:stats', query: { format: 'PremierDraft', colors: '', group: '' }, cards: [] }).then((value) => {
      if (!record(value) || !record(value.catalog) || !Array.isArray(value.catalog.expansions) || !Array.isArray(value.catalog.formats)) return null;
      return value.catalog as StatsCatalog;
    }).catch(() => null);
    this.bootstrap = operation;
    try { return await operation; } finally { if (this.bootstrap === operation) this.bootstrap = undefined; }
  }
  private async scan() {
    if (!this.enabled || this.disposed) return;
    const path = this.document.defaultView!.location.pathname;
    if (this.path !== path) { this.clear(); this.path = path; }
    if (!statsRoute(path)) { if (this.pack) this.clear(); return; }
    if (this.retrying) return;
    const candidates: { image: HTMLImageElement; slot: HTMLElement; measure: StatsMeasurement; request: StatsCardRequest }[] = [];
    const visible: { image: HTMLImageElement; request: StatsCardRequest }[] = [];
    for (const image of this.document.querySelectorAll<HTMLImageElement>('img')) {
      if (image.closest(`[${HOST}]`)) continue;
      const identity = printingIn(this.options.originalSource(image)); const slot = image.parentElement;
      if (!identity || !slot) continue;
      const measure = (this.options.measure ?? measureStatsCard)(image);
      if (measure.overlay) continue;
      const request = { ...identity, name: image.alt.slice(0, 200) };
      visible.push({ image, request });
      if (slot.querySelectorAll('img').length !== 1 || measure.width < 60 || measure.height <= 0 || measure.slotHeight < measure.height * .9 || !measure.pack) continue;
      candidates.push({ image, slot, measure, request });
    }
    const sections = this.imageSections(visible.map((item) => item.image));
    const eligible = candidates.filter(({ image }) => !['picked', 'missing'].includes(sections.get(image) ?? ''));
    const explicit = eligible.filter(({ image }) => sections.get(image) === 'pack');
    const pack = (explicit.length ? explicit : eligible)[0]?.measure.pack;
    const current = eligible.filter((candidate) => candidate.measure.pack === pack).slice(0, 64);
    // Picks only order the 套色 menu; at most 64 identities share one request with the pack.
    const pickCounts = new Map<string, { request: StatsCardRequest; count: number }>();
    for (const item of pack ? visible.filter(({ image }) => !pack.contains(image) && sections.get(image) === 'picked') : []) {
      const key = `${item.request.id}/${item.request.face}/${item.request.name}`;
      const entry = pickCounts.get(key); if (entry) entry.count++; else pickCounts.set(key, { request: item.request, count: 1 });
    }
    const picked = [...pickCounts.values()].slice(0, Math.max(0, 64 - current.length));
    if (!pack || !current.length) { if (this.pack) this.clear(); return; }
    if (this.pack && this.pack !== pack) this.clear();
    this.pack = pack;
    for (const [element, value] of this.slots) {
      if (!current.some((item) => item.slot === element && item.image === value.image)) { if (this.opened === value) this.close(false); this.removeSlot(value); this.slots.delete(element); }
    }
    for (const item of current) {
      const identity = `${item.request.id}/${item.request.face}/${item.request.name}`;
      let value = this.slots.get(item.slot);
      if (!value) {
        const { host, root } = this.createHost('strip'); host.style.cssText = 'display:block;width:100%;height:26px;margin-top:4px';
        value = { image: item.image, slot: item.slot, host, root, request: item.request, identity,
          originalMinHeight: item.slot.style.minHeight, originalPriority: item.slot.style.getPropertyPriority('min-height'), appliedMinHeight: '' };
        this.slots.set(item.slot, value); item.slot.append(host);
      } else if (value.identity !== identity) {
        if (this.opened === value) this.close(false);
        value.request = item.request; value.identity = identity; value.card = undefined;
      }
      // Fixed-height React slots need room for the independent strip; card styles stay untouched.
      const minHeight = `${item.measure.height + 30}px`;
      if (value.appliedMinHeight && item.slot.style.minHeight !== value.appliedMinHeight) {
        value.originalMinHeight = item.slot.style.minHeight; value.originalPriority = item.slot.style.getPropertyPriority('min-height');
      }
      if (!value.host.hidden && item.slot.style.minHeight !== minHeight) item.slot.style.minHeight = minHeight;
      value.appliedMinHeight = minHeight;
    }
    this.ensureToolbar();
    const pickKey = picked.map((item) => `${item.request.id}/${item.request.face}/${item.request.name}*${item.count}`).join('|');
    const signature = `${path}|${JSON.stringify(this.query())}|${current.map((item) => `${item.request.id}/${item.request.face}/${item.request.name}`).join('|')}|${pickKey}`;
    if (signature === this.signature) { this.positionPopover(); return; }
    this.signature = signature; const epoch = ++this.epoch; this.loading = true; this.response = undefined; this.close(false);
    this.renderToolbar(); this.renderStrips();
    const catalog = await this.getCatalog();
    if (!this.active(epoch, path)) return;
    this.catalog = catalog;
    const query = this.query();
    // Header discovery changes the query without starting a duplicate observer-driven request.
    this.signature = `${path}|${JSON.stringify(query)}|${current.map((item) => `${item.request.id}/${item.request.face}/${item.request.name}`).join('|')}|${pickKey}`;
    let value: unknown;
    const requests = [...current.map((item) => item.request), ...picked.map((item) => item.request)];
    try { value = await this.options.send({ type: '17lands-zh:stats', query, cards: requests }); } catch { value = null; }
    if (!this.active(epoch, path)) return;
    this.loading = false;
    if (record(value) && record(value.context) && record(value.meta) && Array.isArray(value.cards) && value.cards.length === requests.length) {
      const response = value as StatsResponse;
      this.picks = picked.flatMap((item, index) => { const color = response.cards[current.length + index]?.color; return color ? [{ color, count: item.count }] : []; });
      this.response = { ...response, cards: response.cards.slice(0, current.length) };
    }
    else this.response = { catalog, context: { expansion: query.expansion ?? null, resolvedBy: query.expansion ? 'explicit' : 'unknown', format: query.format, colors: query.colors, group: query.group }, meta: { fetchedAt: null, stale: false, embargoUntil: null, cardCount: 0, error: '无法读取 17Lands 数据。' }, cards: current.map(() => null) };
    for (let index = 0; index < current.length; index++) {
      const item = current[index]!; const slot = this.slots.get(item.slot);
      if (slot?.identity === `${item.request.id}/${item.request.face}/${item.request.name}`) slot.card = this.response.cards[index] ?? null;
    }
    if (!this.header() && this.response.context.expansion) void this.options.saveMockExpansion?.(this.response.context.expansion).catch(() => {});
    this.renderToolbar(); this.renderStrips();
  }
  /** Section labels distinguish the current pack from full-sized picks and known-missing cards. */
  private imageSections(images: HTMLImageElement[]) {
    const sections = new Map<HTMLImageElement, 'pack' | 'picked' | 'missing'>();
    if (!images.length) return sections;
    const markers = [...this.document.body.querySelectorAll<HTMLElement>('*')].filter((element) => element.childElementCount === 0 &&
      /^(?:Picked|Possible Maindeck|Known Missing|Options|Pack \d+ Pick \d+)$/.test(element.textContent?.trim() ?? ''));
    const Node = this.document.defaultView!.Node;
    for (const image of images) {
      const marker = markers.filter((element) => element.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
      if (!marker) continue;
      const label = marker.textContent!.trim();
      sections.set(image, /^(?:Picked|Possible Maindeck)$/.test(label) ? 'picked' : label === 'Known Missing' ? 'missing' : 'pack');
    }
    return sections;
  }
  private active(epoch: number, path: string) { return this.enabled && !this.disposed && epoch === this.epoch && path === this.document.defaultView!.location.pathname; }
  private ensureToolbar() {
    if (!this.toolbar) {
      const { host, root } = this.createHost('toolbar'); this.toolbar = host; this.toolbarRoot = root;
      host.style.cssText = 'display:block;width:100%';
    }
    if (this.pack && this.toolbar.nextSibling !== this.pack) this.pack.before(this.toolbar);
  }
  private control(label: string, value: string, choices: [string, string][], change: (value: string) => void) {
    const wrapper = node(this.document, 'label', label); const select = node(this.document, 'select'); select.setAttribute('aria-label', label);
    for (const [code, text] of choices) { const option = node(this.document, 'option', text); option.value = code; select.append(option); }
    select.value = value; select.addEventListener('change', () => change(select.value)); wrapper.append(select); return wrapper;
  }
  private updatePrefs(key: keyof StatsPrefs, value: string) {
    const next = parseStatsPrefs({ ...this.prefs, [key]: value }); this.setPrefs(next); void this.options.savePrefs(next).catch(() => {});
  }
  private renderToolbar() {
    if (!this.toolbarRoot || !this.enabled) return;
    const focused = this.toolbarRoot.activeElement?.getAttribute('aria-label');
    this.toolbarRoot.querySelector('.toolbar')?.remove();
    const bar = node(this.document, 'div', undefined, 'toolbar'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', '17Lands 卡牌数据');
    const query = this.query(); const context = this.response?.context; const expansion = context?.expansion ?? query.expansion;
    const sourceQuery = { ...query, ...(expansion ? { expansion } : {}), format: context?.format ?? query.format };
    bar.append(link(this.document, '17Lands 卡牌数据 ↗', statsSourceUrl(sourceQuery), 'src'));
    const header = this.header();
    if (header) bar.append(node(this.document, 'span', header.expansion, 'set'));
    else {
      const codes = [...(this.catalog?.site_draft_expansions ?? [])];
      if (expansion && !codes.includes(expansion)) codes.unshift(expansion);
      bar.append(this.control('系列', expansion ?? '', [['', '请选择…'], ...codes.map((code): [string, string] => [code, `${code}${code === expansion && context?.resolvedBy === 'inferred' ? '（自动识别）' : ''}`])], (value) => {
        if (value) this.explicit.set(this.path, value); else this.explicit.delete(this.path);
        if (value) void this.options.saveMockExpansion?.(value).catch(() => {});
        this.refresh();
      }));
    }
    const formats = expansion ? this.catalog?.formats_by_expansion[expansion] ?? [] : this.catalog?.formats ?? [];
    const effectiveFormat = sourceQuery.format;
    // Draft pages only offer draft formats, with the common queues first; the page's own format maps back to 'auto'.
    const automatic = header?.format ?? 'PremierDraft';
    const choices = [...new Set([effectiveFormat, automatic, ...formats.filter(statsDraftFormat)])];
    const rank = (format: string) => { const index = COMMON_FORMATS.indexOf(format); return index < 0 ? COMMON_FORMATS.length : index; };
    choices.sort((a, b) => rank(a) - rank(b) || formats.indexOf(a) - formats.indexOf(b));
    bar.append(this.control('赛制', effectiveFormat, choices.map((format): [string, string] => [format, formatLabel(format)]),
      (value) => this.updatePrefs('format', value === automatic ? 'auto' : value)));
    // Pairs that hold more of the cards already picked come first; ties keep 17Lands' order.
    const held = (pair: string) => this.picks.reduce((sum, pick) => sum + ([...pick.color].every((letter) => pair.includes(letter)) ? pick.count : 0), 0);
    const pairs = STATS_COLORS.filter(Boolean).map((pair) => ({ pair, count: held(pair) })).sort((a, b) => b.count - a.count);
    bar.append(this.control('套色', this.prefs.colors, [['', '全部'], ...pairs.map(({ pair, count }): [string, string] => [pair, `${colorLabel(pair)} ${pair}${count ? ` · 已选 ${count} 张` : ''}`])], (value) => this.updatePrefs('colors', value)));
    const groups = { '': '全部', top: '胜率前段', middle: '胜率中段', bottom: '胜率后段' };
    bar.append(this.control('玩家', this.prefs.group, STATS_GROUPS.map((group) => [group, groups[group]]), (value) => this.updatePrefs('group', value)));
    bar.append(this.control('指标', this.prefs.metric, SELECTABLE_METRICS.map((metric) => [metric, METRIC_LABELS[metric]]), (value) => this.updatePrefs('metric', value)));
    let status = '正在读取 17Lands 数据…'; let warning = false; let retry = false;
    const meta = this.response?.meta;
    if (!this.loading && this.response) {
      const age = statsAge(Date.now() - (meta?.fetchedAt ?? Date.now()));
      if (!expansion && !meta?.error?.includes('目录')) { status = '未能识别当前系列。'; warning = true; }
      else if (meta?.embargoUntil && Date.now() < meta.embargoUntil) {
        const date = new Date(meta.embargoUntil); status = `17Lands 请第三方工具在新系列上线第 12 天（${date.getMonth() + 1}月${date.getDate()}日）后再显示数据。`; warning = true;
        bar.append(link(this.document, '在 17Lands 查看 ↗', statsSourceUrl(sourceQuery)));
      } else if (meta?.fetchedAt === null) { status = meta.error?.includes('日期未知') ? '系列开始日期未知，暂不显示数据。' : '无法读取 17Lands 数据。'; warning = true; retry = true; }
      else if (meta?.stale) { status = `暂时无法更新，显示${age ? ` ${age}前` : '刚刚取得'}的数据。`; warning = true; retry = true; }
      else {
        const matched = this.response.cards.filter(Boolean).length; const total = this.response.cards.length;
        if (total && matched / total < .5) { status = `当前卡包只有 ${matched}/${total} 张出现在 ${expansion} 数据中，请确认系列。`; warning = true; }
        else status = age ? `${age}前更新` : '刚刚更新';
      }
    }
    bar.append(node(this.document, 'span', status, `status${warning ? ' warn' : ''}`));
    if (warning) bar.classList.add('attn');
    if (retry) { const button = node(this.document, 'button', '重试'); button.type = 'button'; button.addEventListener('click', () => this.refresh(true)); bar.append(button); }
    this.toolbarRoot.append(bar);
    if (focused) bar.querySelectorAll('select').forEach((select) => { if (select.getAttribute('aria-label') === focused) select.focus(); });
  }
  private renderStrips() {
    const hidden = !this.loading && (!this.response?.context.expansion || this.response.meta.fetchedAt === null || !!(this.response.meta.embargoUntil && Date.now() < this.response.meta.embargoUntil));
    for (const slot of this.slots.values()) {
      slot.host.hidden = hidden;
      if (hidden) {
        if (slot.slot.style.minHeight === slot.appliedMinHeight) {
          if (slot.originalMinHeight) slot.slot.style.setProperty('min-height', slot.originalMinHeight, slot.originalPriority);
          else slot.slot.style.removeProperty('min-height');
        }
      } else if (slot.slot.style.minHeight !== slot.appliedMinHeight) slot.slot.style.minHeight = slot.appliedMinHeight;
      slot.root.querySelector('.outer')?.remove();
      const outer = node(this.document, 'div', undefined, 'outer');
      if (this.loading) {
        const placeholder = node(this.document, 'div', undefined, 'strip loading'); placeholder.setAttribute('aria-hidden', 'true');
        placeholder.append(node(this.document, 'span', undefined, 'chip ph'), node(this.document, 'span', undefined, 'bar')); outer.append(placeholder);
      } else {
        const card = slot.card; const button = node(this.document, 'button', undefined, `strip${card ? '' : ' none'}`); button.type = 'button';
        button.setAttribute('aria-expanded', String(this.opened === slot));
        if (!card) { button.disabled = true; button.append(node(this.document, 'span', '17Lands 暂无数据', 'long'), node(this.document, 'span', '无数据', 'short')); button.setAttribute('aria-label', `${slot.request.name}：17Lands 暂无数据`); }
        else {
          const grade = card.grades[this.prefs.metric]?.grade ?? null;
          button.append(node(this.document, 'span', grade ?? '–', `chip g-${grade?.[0] ?? 'none'}`));
          const primary = node(this.document, 'span', undefined, `v${card[this.prefs.metric] === null ? ' muted' : ''}`);
          if (card[this.prefs.metric] === null) primary.textContent = '样本不足';
          else { primary.append(node(this.document, 'span', METRIC_LABELS[this.prefs.metric].replace(' WR', ''), 'lab wide-only'), node(this.document, 'span', formatMetric(this.prefs.metric, card[this.prefs.metric]))); }
          button.append(primary);
          if (card.avg_seen !== null) { const secondary = node(this.document, 'span', undefined, 'sec'); secondary.append(node(this.document, 'span', 'ALSA', `lab ${card[this.prefs.metric] === null ? 'wide-only' : 'mid-hide'}`), node(this.document, 'span', formatMetric('avg_seen', card.avg_seen))); button.append(secondary); }
          button.setAttribute('aria-label', `${slot.request.name}：等级 ${grade ?? '—'}，${METRIC_LABELS[this.prefs.metric]} ${card[this.prefs.metric] === null ? '样本不足' : formatMetric(this.prefs.metric, card[this.prefs.metric])}${card.avg_seen === null ? '' : `，ALSA ${formatMetric('avg_seen', card.avg_seen)}`}。查看 17Lands 详细数据`);
          button.addEventListener('click', (event) => { if (this.opened === slot) this.close(); else this.open(slot, event.detail === 0); });
        }
        outer.append(button);
      }
      slot.root.append(outer);
    }
  }
  private open(slot: Slot, keyboard: boolean) {
    const card = slot.card; const response = this.response;
    if (!card || !response || slot.host.hidden) return;
    this.close(false); this.opened = slot;
    if (!this.popover) {
      const { host, root } = this.createHost('popover'); this.popover = host; this.popoverRoot = root;
      host.style.cssText = 'position:fixed;z-index:2147483646;display:block'; this.document.documentElement.append(host);
    }
    this.popover.hidden = false; this.popoverRoot!.querySelector('.pop')?.remove();
    const dialog = node(this.document, 'section', undefined, 'pop'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', `${card.name} 的 17Lands 数据`); dialog.tabIndex = -1;
    const header = node(this.document, 'header'); const names = node(this.document, 'div'); names.append(node(this.document, 'strong', card.name));
    if (card.name_zh) names.append(node(this.document, 'span', card.name_zh, 'sub'));
    const rarity = ({ common: '普通', uncommon: '非普通', rare: '稀有', mythic: '秘稀' } as Record<string, string>)[card.rarity] ?? card.rarity;
    names.append(node(this.document, 'div', `${card.color ? colorLabel(card.color) : '无色'} · ${rarity}`, 'sub'));
    const grade = card.grades[this.prefs.metric]; header.append(names, node(this.document, 'span', grade?.grade ?? '–', `chip big g-${grade?.grade?.[0] ?? 'none'}`)); dialog.append(header);
    dialog.append(node(this.document, 'p', grade ? `${METRIC_LABELS[this.prefs.metric]} 在本系列 ${grade.n} 张有数据的卡中排第 ${grade.rank}` : `${METRIC_LABELS[this.prefs.metric]}：样本不足`, 'rank'));
    const table = node(this.document, 'table');
    const rows = [
      ['抓到手胜率', 'GIH WR', 'ever_drawn_win_rate', 'ever_drawn_game_count'], ['起手胜率', 'OH WR', 'opening_hand_win_rate'],
      ['抽到胜率', 'GD WR', 'drawn_win_rate'], ['未见胜率', 'GNS WR', 'never_drawn_win_rate'], ['在手提升', 'IIH', 'drawn_improvement_win_rate'],
      ['出场胜率', 'GP WR', 'win_rate', 'game_count'], ['出场率', '% GP', 'play_rate'], ['最后见到', 'ALSA', 'avg_seen'], ['平均被选', 'ATA', 'avg_pick'],
    ] as const;
    for (const row of rows) {
      const tr = node(this.document, 'tr'); const th = node(this.document, 'th', row[0]); th.scope = 'row'; th.append(node(this.document, 'span', row[1], 'en'));
      const td = node(this.document, 'td', formatMetric(row[2], card[row[2]]));
      if (row.length === 4) td.append(node(this.document, 'small', `n=${card[row[3]].toLocaleString('en-US')}`)); tr.append(th, td); table.append(tr);
    }
    dialog.append(table); const footer = node(this.document, 'footer'); const context = response.context;
    const group = ({ top: '胜率前段', middle: '胜率中段', bottom: '胜率后段' } as Record<string, string>)[context.group] ?? '全部玩家';
    footer.append(node(this.document, 'p', `数据：17Lands · ${context.expansion} ${formatLabel(context.format)} · ${group} · ${context.colors ? `${colorLabel(context.colors)}套牌` : '全部套色'} · 全部时间`),
      node(this.document, 'p', '等级按本系列有该指标数据的卡牌分布计算，与 17Lands 卡牌数据页一致。'));
    footer.append(link(this.document, '在 17Lands 查看此卡 ↗', statsSourceUrl({ expansion: context.expansion!, format: context.format, colors: context.colors, group: context.group }, card.mtga_id)));
    const close = node(this.document, 'button', '关闭', 'close'); close.type = 'button'; close.addEventListener('click', () => this.close()); footer.append(close); dialog.append(footer);
    this.popoverRoot!.append(dialog); slot.root.querySelector('button')?.setAttribute('aria-expanded', 'true'); this.positionPopover();
    if (keyboard) dialog.focus();
  }
  private close(focus = true) {
    const slot = this.opened; this.opened = undefined;
    if (this.popover) this.popover.hidden = true;
    slot?.root.querySelector('button')?.setAttribute('aria-expanded', 'false');
    if (focus && slot?.host.isConnected) slot.root.querySelector('button')?.focus();
  }
  private positionPopover() {
    if (!this.opened || !this.popover || this.popover.hidden) return;
    const rect = this.opened.host.getBoundingClientRect(); const view = this.document.defaultView!;
    const panel = this.popoverRoot?.querySelector<HTMLElement>('.pop'); if (!panel) return;
    const height = panel.getBoundingClientRect().height; const width = panel.getBoundingClientRect().width;
    const top = rect.bottom + 8 + height <= view.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8);
    this.popover.style.left = `${Math.max(8, Math.min(view.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
    this.popover.style.top = `${top}px`;
  }
}
