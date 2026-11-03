import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { StatsOverlay, parseStatsHeader, statsAge, statsDraftFormat, statsRoute, statsSourceUrl, type StatsMeasurement } from '../src/stats-overlay';
import { type StatsCard, type StatsCardRequest, type StatsCatalog, type StatsPrefs, type StatsQuery, type StatsResponse } from '../src/stats-contract';

// Public printing UUIDs only; all page content and statistics are synthetic.
const FIRST = '9e72f397-2384-40f1-882b-f627664d97df';
const SECOND = 'd4ebed0b-8060-4a7b-a060-5cfcd2172b16';
const imageUrl = (id = FIRST, face = 'front') => `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`;
const catalog: StatsCatalog = {
  expansions: ['MID', 'VOW'], formats: ['PremierDraft', 'TradDraft'],
  formats_by_expansion: { MID: ['PremierDraft', 'TradDraft'], VOW: ['PremierDraft'] },
  start_dates: { MID: '2021-09-16', VOW: '2021-11-11' }, site_draft_expansions: ['MID', 'VOW'],
};
const grade = { grade: 'B+', rank: 12, n: 200 };
function card(overrides: Partial<StatsCard> = {}): StatsCard {
  return {
    mtga_id: 1, name: 'Synthetic Alpha', name_zh: '测试甲', color: 'WU', rarity: 'common', front: imageUrl(), back: null,
    seen_count: 1000, avg_seen: 3.5, pick_count: 800, avg_pick: 4.5,
    game_count: 900, pool_count: 1000, play_rate: .9, win_rate: .55,
    opening_hand_game_count: 300, opening_hand_win_rate: .6,
    drawn_game_count: 500, drawn_win_rate: .54, ever_drawn_game_count: 800, ever_drawn_win_rate: .56,
    never_drawn_game_count: 100, never_drawn_win_rate: .5, drawn_improvement_win_rate: .06,
    grades: { ever_drawn_win_rate: grade, opening_hand_win_rate: grade, drawn_win_rate: grade,
      drawn_improvement_win_rate: grade, win_rate: grade, avg_seen: grade, avg_pick: grade }, ...overrides,
  };
}
type Request = { type: '17lands-zh:stats'; query: StatsQuery; cards: StatsCardRequest[] };
function response(request: Request, overrides: Partial<StatsResponse> = {}): StatsResponse {
  return {
    catalog, context: { expansion: request.query.expansion ?? 'MID', resolvedBy: request.query.expansion ? 'explicit' : 'inferred',
      format: request.query.format, colors: request.query.colors, group: request.query.group },
    meta: { fetchedAt: Date.now(), stale: false, embargoUntil: null, cardCount: 200, error: null },
    cards: request.cards.map((identity) => card({ name: identity.name, front: imageUrl(identity.id), mtga_id: identity.id === FIRST ? 1 : 2 })),
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await tick(); }
  expect(predicate()).toBe(true);
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function setup(options: { path?: string; reply?: (request: Request, index: number) => Promise<unknown> | unknown; retry?: () => Promise<unknown> } = {}) {
  const window = new Window({ url: `https://www.17lands.com${options.path ?? '/draft/synthetic'}` });
  const document = window.document as unknown as Document;
  const view = document.defaultView!;
  document.body.innerHTML = `<h1>MID PremierDraft</h1><main><div id="pack">
    <div id="first" style="min-height: 17px !important"><img alt="Synthetic Alpha" src="${imageUrl()}"></div>
    <div id="second"><img alt="Synthetic Beta" src="${imageUrl(SECOND)}"></div>
  </div></main>`;
  const pack = document.querySelector<HTMLElement>('#pack')!;
  const requests: Request[] = []; const saved: StatsPrefs[] = []; const expansions: string[] = [];
  const measure = (image: HTMLImageElement): StatsMeasurement => ({
    width: image.dataset.kind === 'small' ? 40 : 140, height: 200,
    slotHeight: image.dataset.kind === 'pile' ? 25 : 200, overlay: image.dataset.kind === 'preview',
    pack: image.dataset.kind === 'unrelated' ? null : image.closest<HTMLElement>('[data-other-pack]') ?? pack,
  });
  const overlay = new StatsOverlay(document, {
    send: async (message) => {
      if ((message as { type: string }).type === '17lands-zh:stats-retry') return options.retry?.();
      const request = message as Request;
      if (!request.cards.length) return response(request);
      requests.push(request);
      return options.reply ? options.reply(request, requests.length - 1) : response(request);
    },
    originalSource: (image) => image.dataset.original ?? image.src,
    savePrefs: async (prefs) => { saved.push(prefs); },
    saveMockExpansion: async (expansion) => { expansions.push(expansion); }, measure,
  });
  cleanup.push(() => { overlay.dispose(); void window.happyDOM.abort(); });
  const hosts = (kind: string) => [...document.querySelectorAll<HTMLElement>(`[data-lands-zh-stats="${kind}"]`)];
  const strip = (index = 0) => hosts('strip')[index]!;
  const button = (index = 0) => strip(index).shadowRoot!.querySelector<HTMLButtonElement>('button')!;
  const toolbar = () => hosts('toolbar')[0]!.shadowRoot!;
  const popover = () => hosts('popover')[0]!;
  const navigate = (path: string) => { view.history.pushState(null, '', path); view.dispatchEvent(new view.Event('popstate')); };
  const change = (label: string, value: string) => {
    const select = toolbar().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect(select).not.toBeNull(); select.value = value;
    select.dispatchEvent(new view.Event('change', { bubbles: true }));
  };
  const ready = async () => { overlay.setEnabled(true); await until(() => !!hosts('strip')[0]?.shadowRoot?.querySelector('button')); };
  return { document, window: view, overlay, pack, requests, saved, expansions, hosts, strip, button, toolbar, popover, navigate, change, ready };
}

describe('colour menu ordering', () => {
  test('orders 套色 by the colours of picked cards and ignores Known Missing', async () => {
    const colors: Record<string, string> = { 'Pick Blue': 'U', 'Pick Black': 'B', 'Missing Red': 'R' };
    const f = setup({ reply: (request) => response(request, { cards: request.cards.map((identity) => card({ name: identity.name, color: colors[identity.name] ?? 'WU' })) }) });
    f.document.querySelector('main')!.insertAdjacentHTML('beforeend', `<h2>Known Missing</h2><div><div><img data-kind="pile" alt="Missing Red" src="${imageUrl(SECOND)}"></div></div>
      <h2>Possible Maindeck</h2><div><div><img data-kind="pile" alt="Pick Blue" src="${imageUrl()}"></div><div><img data-kind="pile" alt="Pick Black" src="${imageUrl(SECOND)}"></div>
      <div><img data-kind="pile" alt="Pick Blue" src="${imageUrl()}"></div></div>`);
    await f.ready(); await until(() => f.toolbar().querySelector('select[aria-label="套色"] option:nth-child(2)')?.textContent?.includes('已选') === true);
    expect(f.requests.at(-1)!.cards.map((identity) => identity.name)).toEqual(['Synthetic Alpha', 'Synthetic Beta', 'Pick Blue', 'Pick Black']);
    expect(f.hosts('strip')).toHaveLength(2);
    const labels = [...f.toolbar().querySelectorAll<HTMLOptionElement>('select[aria-label="套色"] option')].map((option) => option.textContent);
    expect(labels.slice(0, 5)).toEqual(['全部', '蓝黑 UB · 已选 3 张', '白蓝 WU · 已选 2 张', '蓝红 UR · 已选 2 张', '蓝绿 UG · 已选 2 张']);
    expect(labels.at(-1)).toBe('红绿 RG');
  });
});

describe('statistics route and source contract', () => {
  test('whitelists draft routes with a required identity', () => {
    for (const path of ['/site_draft/example', '/draft/example', '/site_draft_replay/example/2/3', '/submitted_draft/example', '/user/latest_draft/example/1']) expect(statsRoute(path)).toBe(true);
    for (const path of ['/', '/card_data', '/draft', '/draft/', '/site_draft/', '/user/latest_draft/', '/user/example', '/foo/draft/example', '/draftish/example']) expect(statsRoute(path)).toBe(false);
  });

  test('accepts only catalog expansion/format pairs from the header', () => {
    expect(parseStatsHeader('Draft | mid PremierDraft | Pack 1', catalog)).toEqual({ expansion: 'MID', format: 'PremierDraft' });
    expect(parseStatsHeader('VOW TradDraft | MID TradDraft', catalog)).toEqual({ expansion: 'MID', format: 'TradDraft' });
    for (const header of ['ZZZ PremierDraft', 'MID UnknownDraft', 'VOW TradDraft', 'XMID PremierDraft', 'MID PremierDraftSuffix']) expect(parseStatsHeader(header, catalog)).toBeNull();
    expect(parseStatsHeader('MID PremierDraft', { ...catalog, formats_by_expansion: {} })).toBeNull();
  });

  test('formats snapshot age without a zero-hour reading', () => {
    expect(statsAge(-5)).toBe(''); expect(statsAge(59_000)).toBe('');
    expect(statsAge(5 * 60_000)).toBe('5 分钟'); expect(statsAge(3 * 3_600_000 + 10)).toBe('3 小时'); expect(statsAge(72 * 3_600_000)).toBe('3 天');
  });
  test('uses public source page parameter names for both page and card links', () => {
    const query: StatsQuery = { expansion: 'MID', format: 'TradDraft', colors: 'WU', group: 'top' };
    const url = new URL(statsSourceUrl(query));
    expect(url.origin + url.pathname).toBe('https://www.17lands.com/card_data');
    expect(Object.fromEntries(url.searchParams)).toEqual({ expansion: 'MID', format: 'TradDraft', time_period: 'ALL_TIME', deck_color: 'WU', user_group: 'top' });
    const details = new URL(statsSourceUrl(query, 123));
    expect(details.pathname).toBe('/card_data/details'); expect(details.searchParams.get('card_id')).toBe('123');
    expect(new URL(statsSourceUrl({ format: 'PremierDraft', colors: '', group: '' })).search).toBe('?format=PremierDraft&time_period=ALL_TIME');
  });
});

describe('pack statistics lifecycle', () => {
  for (const section of ['Picked', 'Possible Maindeck', 'Known Missing']) test(`does not treat full-sized ${section} cards as an absent pack`, async () => {
    const f = setup();
    f.pack.remove();
    f.document.querySelector('main')!.insertAdjacentHTML('beforeend', `<h2>${section}</h2><div data-other-pack><div><img alt="Excluded ${section}" src="${imageUrl()}"></div></div>`);
    f.overlay.setEnabled(true); await tick(); await tick();
    expect(f.hosts('strip')).toHaveLength(0);
    expect(f.hosts('toolbar')).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test('selects the explicit current pack after full-sized picked cards and still counts their colours', async () => {
    const f = setup();
    f.pack.insertAdjacentHTML('beforebegin', `<h2>Picked</h2><div data-other-pack><div><img alt="Picked first" src="${imageUrl()}"></div></div><h2>Options</h2>`);
    await f.ready();
    expect(f.hosts('strip')).toHaveLength(2);
    expect(f.hosts('toolbar')[0]!.nextElementSibling === f.pack).toBe(true);
    expect(f.requests[0]!.cards.map((identity) => identity.name)).toEqual(['Synthetic Alpha', 'Synthetic Beta', 'Picked first']);
    expect(f.toolbar().querySelector('select[aria-label="套色"] option:nth-child(2)')!.textContent).toContain('已选 1 张');
  });

  test('prefers an explicit pack over an earlier unclassified full-sized card group', async () => {
    const f = setup();
    f.pack.insertAdjacentHTML('beforebegin', `<div data-other-pack><div><img alt="Unclassified earlier group" src="${imageUrl()}"></div></div><h2>Pack 1 Pick 2</h2>`);
    await f.ready();
    expect(f.hosts('toolbar')[0]!.nextElementSibling === f.pack).toBe(true);
    expect(f.requests[0]!.cards.map((identity) => identity.name)).toEqual(['Synthetic Alpha', 'Synthetic Beta']);
  });

  test('removes an old overlay when the pack disappears instead of moving it to remaining picks', async () => {
    const f = setup();
    f.pack.insertAdjacentHTML('beforebegin', '<h2>Options</h2>');
    f.document.querySelector('main')!.insertAdjacentHTML('beforeend', `<h2>Possible Maindeck</h2><div data-other-pack><div><img alt="Remaining pick" src="${imageUrl()}"></div></div>`);
    await f.ready();
    const requestsBefore = f.requests.length;
    f.pack.remove();
    await until(() => !f.document.querySelector('[data-lands-zh-stats]'));
    await tick();
    expect(f.hosts('toolbar')).toHaveLength(0);
    expect(f.requests).toHaveLength(requestsBefore);
  });

  test('adds strips only to eligible cards in the current pack and uses original image identities', async () => {
    const f = setup();
    f.document.body.insertAdjacentHTML('beforeend', ['pile', 'preview', 'small', 'unrelated'].map((kind) => `<div><img data-kind="${kind}" src="${imageUrl()}" alt="Excluded ${kind}"></div>`).join('') + `<div data-other-pack><div><img src="${imageUrl()}" alt="Other pack"></div></div>`);
    const first = f.document.querySelector<HTMLImageElement>('#first img')!;
    first.dataset.original = imageUrl(); first.src = 'https://images.mtgch.com/zhs/large/front/9/e/example.webp';
    await f.ready();
    expect(f.hosts('strip')).toHaveLength(2); expect(f.hosts('toolbar')).toHaveLength(1); expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.cards).toEqual([{ id: FIRST, face: 'front', name: 'Synthetic Alpha' }, { id: SECOND, face: 'front', name: 'Synthetic Beta' }]);
    expect(f.hosts('toolbar')[0]!.nextElementSibling).toBe(f.pack); expect(first.src).toContain('images.mtgch.com');
    expect(f.button().getAttribute('aria-label')).toContain('Synthetic Alpha：等级 B+，GIH WR 56.0%');
  });

  test('updates a reused image src/face and a replacement image in the same slot', async () => {
    const f = setup(); await f.ready();
    const slot = f.document.querySelector<HTMLElement>('#first')!;
    const originalHost = f.strip(); const image = slot.querySelector('img')!;
    image.src = imageUrl(SECOND, 'back'); image.alt = 'Synthetic reverse';
    await until(() => f.button()?.getAttribute('aria-label')?.includes('Synthetic reverse') === true);
    expect(f.strip()).toBe(originalHost); expect(f.requests.at(-1)!.cards[0]).toEqual({ id: SECOND, face: 'back', name: 'Synthetic reverse' });
    const replacement = f.document.createElement('img'); replacement.src = imageUrl(); replacement.alt = 'Synthetic replacement'; image.replaceWith(replacement);
    await until(() => f.button()?.getAttribute('aria-label')?.includes('Synthetic replacement') === true);
    expect(originalHost.isConnected).toBe(false); expect(f.hosts('strip')).toHaveLength(2); expect(f.requests.at(-1)!.cards[0]!.id).toBe(FIRST);
  });

  test('ignores a deferred result for the previous source after slot reuse', async () => {
    const old = deferred<StatsResponse>();
    const f = setup({ reply: (request, index) => index === 0 ? old.promise : response(request) });
    f.overlay.setEnabled(true); await until(() => f.requests.length === 1);
    const first = f.document.querySelector<HTMLImageElement>('#first img')!; first.src = imageUrl(SECOND); first.alt = 'Current source';
    await until(() => f.button()?.getAttribute('aria-label')?.includes('Current source') === true);
    old.resolve(response(f.requests[0]!, { cards: [card({ name: 'Stale source', ever_drawn_win_rate: .99 }), null] })); await tick();
    expect(f.button().getAttribute('aria-label')).toContain('Current source');
    expect(f.button().textContent).toContain('56.0%'); expect(f.button().textContent).not.toContain('99.0%'); expect(f.requests).toHaveLength(2);
  });

  test('ignores deferred results for previous toolbar filters', async () => {
    const old = deferred<StatsResponse>();
    const f = setup({ reply: (request, index) => index === 1 ? old.promise : response(request, { cards: request.cards.map(() => card({ ever_drawn_win_rate: .61 })) }) });
    await f.ready(); f.change('套色', 'WU'); await until(() => f.requests.length === 2);
    f.change('玩家', 'top'); await until(() => f.requests.length === 3 && f.button()?.textContent?.includes('61.0%') === true);
    old.resolve(response(f.requests[1]!, { cards: f.requests[1]!.cards.map(() => card({ ever_drawn_win_rate: .99 })) })); await tick();
    expect(f.button().textContent).toContain('61.0%'); expect(new URL(f.toolbar().querySelector('a')!.href).searchParams.get('user_group')).toBe('top');
  });

  test('removes nodes on route changes before an outstanding request resolves', async () => {
    const pending = deferred<StatsResponse>(); const f = setup({ reply: () => pending.promise });
    f.overlay.setEnabled(true); await until(() => f.requests.length === 1);
    const oldHost = f.strip(); f.navigate('/card_data'); await until(() => !f.document.querySelector('[data-lands-zh-stats]'));
    expect(oldHost.isConnected).toBe(false); expect(f.document.querySelector<HTMLElement>('#first')!.style.minHeight).toBe('17px');
    pending.resolve(response(f.requests[0]!)); await tick(); expect(f.document.querySelector('[data-lands-zh-stats]')).toBeNull();
  });

  for (const action of ['disable', 'dispose'] as const) test(`${action} removes all nodes, restores min-height and rejects pending work`, async () => {
    let pending: ReturnType<typeof deferred<StatsResponse>> | undefined;
    const f = setup({ reply: (request) => pending ? pending.promise : response(request) }); await f.ready();
    const first = f.document.querySelector<HTMLElement>('#first')!; const second = f.document.querySelector<HTMLElement>('#second')!;
    expect(first.style.minHeight).toBe('230px'); expect(second.style.minHeight).toBe('230px');
    // Pointer opening avoids happy-dom's sibling-ShadowRoot activeElement bug
    // during a refresh; keyboard focus is exercised separately below.
    f.button().dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 }));
    expect(f.hosts('popover')).toHaveLength(1);
    pending = deferred<StatsResponse>(); f.overlay.refresh(); await until(() => f.requests.length === 2);
    if (action === 'disable') f.overlay.setEnabled(false); else f.overlay.dispose();
    expect(f.document.querySelector('[data-lands-zh-stats]')).toBeNull();
    expect(first.style.minHeight).toBe('17px'); expect(first.style.getPropertyPriority('min-height')).toBe('important'); expect(second.style.minHeight).toBe('');
    pending.resolve(response(f.requests[1]!)); await tick(); expect(f.document.querySelector('[data-lands-zh-stats]')).toBeNull();
    if (action === 'disable') { await f.ready(); expect(f.hosts('strip')).toHaveLength(2); }
  });
});

describe('statistics interaction', () => {
  test('opening another strip keeps one dialog and does not restore the previous strip focus', async () => {
    const f = setup(); await f.ready(); f.button().click(); f.button(1).focus();
    f.button(1).dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 }));
    expect(f.hosts('popover')).toHaveLength(1); expect(f.popover().shadowRoot!.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('Synthetic Beta 的 17Lands 数据');
    expect(f.strip(1).shadowRoot!.activeElement).toBe(f.button(1)); expect(f.button().getAttribute('aria-expanded')).toBe('false');
  });
  test('manual retry waits for background invalidation and then uses the latest preferences', async () => {
    const pending = deferred<unknown>(); const f = setup({ retry: () => pending.promise }); await f.ready();
    f.overlay.refresh(true); f.change('套色', 'WU'); await tick();
    expect(f.requests).toHaveLength(1);
    pending.resolve({}); await until(() => f.requests.length === 2 && !!f.button());
    expect(f.requests[1]!.query.colors).toBe('WU');
  });
  test('navigation removes the overlay while a manual background retry is pending', async () => {
    const pending = deferred<unknown>(); const f = setup({ retry: () => pending.promise }); await f.ready();
    f.overlay.refresh(true); f.navigate('/card_data'); await until(() => !f.document.querySelector('[data-lands-zh-stats]'));
    pending.resolve({}); await tick(); expect(f.document.querySelector('[data-lands-zh-stats]')).toBeNull();
  });
  test('isolates strip pointerdown, mousedown and click from card pick handlers', async () => {
    const f = setup(); await f.ready(); const picked: string[] = []; const imageClicks: string[] = []; const slot = f.document.querySelector('#first')!;
    for (const type of ['pointerdown', 'mousedown', 'click']) slot.addEventListener(type, () => picked.push(type));
    slot.querySelector('img')!.addEventListener('click', () => imageClicks.push('click'));
    for (const type of ['pointerdown', 'mousedown', 'click']) f.button().dispatchEvent(new f.window.MouseEvent(type, { bubbles: true, composed: true, detail: 1 }));
    expect(picked).toEqual([]); expect(imageClicks).toEqual([]); expect(f.popover().hidden).toBe(false);
    slot.querySelector('img')!.click(); expect(picked).toEqual(['click']); expect(imageClicks).toEqual(['click']);
  });

  for (const dismissal of ['Escape', 'close', 'outside'] as const) test(`keyboard opening enters the dialog and ${dismissal} restores strip focus`, async () => {
    const f = setup(); await f.ready(); f.button().focus();
    f.button().dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, composed: true, detail: 0 }));
    const root = f.popover().shadowRoot!; const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('Synthetic Alpha 的 17Lands 数据'); expect(root.activeElement).toBe(dialog);
    expect(f.button().getAttribute('aria-expanded')).toBe('true');
    if (dismissal === 'Escape') dialog.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    else if (dismissal === 'close') root.querySelector<HTMLButtonElement>('button.close')!.click();
    else f.document.body.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, composed: true }));
    expect(f.popover().hidden).toBe(true); expect(f.strip().shadowRoot!.activeElement).toBe(f.button()); expect(f.button().getAttribute('aria-expanded')).toBe('false');
  });

  test('persists labeled filters, updates source links and changes metric without another request', async () => {
    const f = setup(); await f.ready();
    expect([...f.toolbar().querySelectorAll('select')].map((select) => select.getAttribute('aria-label'))).toEqual(['赛制', '套色', '玩家', '指标']);
    const format = f.toolbar().querySelector<HTMLSelectElement>('select[aria-label="赛制"]')!;
    expect(format.options[format.selectedIndex]!.textContent).toBe('竞技轮抽');
    expect([...format.options].map((option) => option.value)).toEqual(['PremierDraft', 'TradDraft']);
    expect(f.toolbar().querySelector('select[aria-label="玩家"] option[value="top"]')!.textContent).toBe('胜率前段');
    f.change('赛制', 'TradDraft'); await until(() => f.requests.length === 2 && !!f.button());
    f.change('套色', 'WU'); await until(() => f.requests.length === 3 && !!f.button());
    f.change('玩家', 'top'); await until(() => f.requests.length === 4 && !!f.button());
    expect(f.requests.at(-1)!.query).toEqual({ expansion: 'MID', format: 'TradDraft', colors: 'WU', group: 'top' });
    const source = f.toolbar().querySelector<HTMLAnchorElement>('a')!;
    expect(source.textContent).toBe('17Lands 卡牌数据 ↗'); expect(source.href).toBe(statsSourceUrl(f.requests.at(-1)!.query));
    f.change('指标', 'drawn_improvement_win_rate'); await tick();
    expect(f.requests).toHaveLength(4); expect(f.button().textContent).toContain('+6.0pp'); expect(f.button().getAttribute('aria-label')).toContain('IIH +6.0pp');
    expect(f.saved.at(-1)).toEqual({ format: 'TradDraft', colors: 'WU', group: 'top', metric: 'drawn_improvement_win_rate' });
    f.button().click(); expect(f.popover().shadowRoot!.querySelector('footer')!.textContent).toContain('MID 传统轮抽 · 胜率前段 · 白蓝套牌 · 全部时间');
    expect(f.toolbar().querySelector('select[aria-label="套色"] option[value="WU"]')!.textContent).toBe('白蓝 WU');
    // happy-dom throws on cross-shadow-root activeElement lookups; real browsers return null.
    f.button().click(); f.button().blur();
    f.change('赛制', 'PremierDraft'); await until(() => f.requests.length === 5 && !!f.button());
    expect(f.saved.at(-1)!.format).toBe('auto');
    const labels = [...f.toolbar().querySelectorAll<HTMLOptionElement>('select[aria-label="赛制"] option')].map((option) => option.textContent);
    expect(new Set(labels).size).toBe(labels.length);
  });
  test('offers only draft formats without duplicate labels', () => {
    expect(['PremierDraft', 'Sealed', 'TradSealed', 'ArenaDirect_Sealed', 'ContenderDraft', 'MidWeekQuickDraft'].filter(statsDraftFormat)).toEqual(['PremierDraft', 'ContenderDraft', 'MidWeekQuickDraft']);
  });

  test('offers catalog expansion choices for site drafts and persists an explicit selection', async () => {
    const f = setup({ path: '/site_draft/synthetic' }); await f.ready();
    expect(f.requests[0]!.query.expansion).toBeUndefined(); expect(f.expansions).toContain('MID');
    expect([...f.toolbar().querySelectorAll('select[aria-label="系列"] option')].map((option) => option.textContent)).toEqual(['请选择…', 'MID（自动识别）', 'VOW']);
    f.change('系列', 'VOW'); await until(() => f.requests.length === 2 && !!f.button());
    expect(f.requests.at(-1)!.query.expansion).toBe('VOW'); expect(f.expansions).toContain('VOW'); expect(f.saved).toEqual([]);
  });
});

describe('statistics unavailable and low sample states', () => {
  for (const state of ['unknown', 'embargo', 'error'] as const) test(`${state} hides strips and restores card slot space`, async () => {
    const f = setup({ path: '/site_draft/synthetic', reply: (request) => {
      const value = response(request);
      if (state === 'unknown') value.context = { ...value.context, expansion: null, resolvedBy: 'unknown' };
      if (state === 'embargo') value.meta.embargoUntil = Date.now() + 86_400_000;
      if (state === 'error') { value.meta.fetchedAt = null; value.meta.error = 'offline'; }
      return value;
    } });
    await f.ready(); expect(f.hosts('strip').every((host) => host.hidden)).toBe(true);
    expect(f.document.querySelector<HTMLElement>('#first')!.style.minHeight).toBe('17px'); expect(f.document.querySelector<HTMLElement>('#second')!.style.minHeight).toBe('');
    expect(f.toolbar().textContent).toContain(state === 'unknown' ? '未能识别当前系列' : state === 'embargo' ? '第 12 天' : '无法读取 17Lands 数据');
  });

  test('renders unmatched cards as disabled and null metrics as insufficient samples', async () => {
    const f = setup({ reply: (request) => response(request, { cards: [null, card({ name: 'Synthetic Beta', ever_drawn_win_rate: null, grades: { ...card().grades, ever_drawn_win_rate: null } })] }) });
    await f.ready(); expect(f.strip().hidden).toBe(false); expect(f.button().disabled).toBe(true);
    expect(f.button().getAttribute('aria-label')).toBe('Synthetic Alpha：17Lands 暂无数据'); f.button().click(); expect(f.hosts('popover')).toHaveLength(0);
    expect(f.button(1).disabled).toBe(false); expect(f.button(1).textContent).toContain('样本不足');
    f.button(1).click(); expect(f.popover().shadowRoot!.querySelector('.rank')!.textContent).toBe('GIH WR：样本不足');
  });

  test('turns a rejected transport request into the unavailable state', async () => {
    const f = setup({ reply: () => { throw new Error('synthetic offline'); } }); await f.ready();
    expect(f.hosts('strip').every((host) => host.hidden)).toBe(true); expect(f.toolbar().textContent).toContain('无法读取 17Lands 数据');
  });
});
