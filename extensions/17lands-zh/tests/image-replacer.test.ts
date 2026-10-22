import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { chineseImageUrl } from '../src/card-images';
import { ImageReplacer } from '../src/image-replacer';
import type { ImageResolution } from '../src/service-client';
import { PNG_DATA_URL, card } from './cache-fixture';

const a = 'https://cards.scryfall.io/large/front/9/e/9e72f397-2384-40f1-882b-f627664d97df.jpg?123';
const b = 'https://cards.scryfall.io/large/front/d/4/d4ebed0b-8060-4a7b-a060-5cfcd2172b16.jpg?456';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const cleanup: (() => void)[] = [];

function setup(load: (url: string) => Promise<boolean> = async () => true, resolve?: (original: string) => Promise<ImageResolution>) {
  const window = new Window({ url: 'https://www.17lands.com/site_draft/example' });
  const document = window.document as unknown as Document;
  const replacer = new ImageReplacer(document, load, resolve);
  cleanup.push(() => { replacer.dispose(); void window.happyDOM.abort(); });
  return { document, replacer };
}

afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

describe('live card image replacement', () => {
  test('translates and restores exact attributes while preserving names and clicks', async () => {
    const { document, replacer } = setup();
    document.body.innerHTML = `<img alt="Return to the Light Realms" src="${a}" srcset="${a} 1x, ${b} 2x">`;
    const image = document.querySelector('img')!;
    let clicks = 0;
    image.addEventListener('click', () => clicks++);
    expect(image.getAttribute('src')).toBe(a);
    replacer.setEnabled(true);
    await tick();
    expect(image.getAttribute('src')).toBe(chineseImageUrl(a)!);
    expect(image.srcset).toBe(`${chineseImageUrl(a)} 1x, ${chineseImageUrl(b)} 2x`);
    expect(image.alt).toBe('Return to the Light Realms');
    image.click();
    expect(clicks).toBe(1);
    replacer.setEnabled(false);
    await tick();
    expect(image.getAttribute('src')).toBe(a);
    expect(image.srcset).toBe(`${a} 1x, ${b} 2x`);
  });

  test('ignores a stale load when the same DOM node becomes the next card', async () => {
    const deferred = new Map<string, (value: boolean) => void>();
    const { document, replacer } = setup((url) => new Promise((resolve) => deferred.set(url, resolve)));
    document.body.innerHTML = `<img src="${a}">`;
    const image = document.querySelector('img')!;
    replacer.setEnabled(true);
    image.src = b;
    await tick();
    deferred.get(chineseImageUrl(a)!)!(true);
    await tick();
    expect(image.src).toBe(b);
    deferred.get(chineseImageUrl(b)!)!(true);
    await tick();
    expect(image.src).toBe(chineseImageUrl(b)!);
    // The already translated node can be reused again after another pick.
    image.src = a;
    await tick();
    deferred.get(chineseImageUrl(a)!)!(true);
    await tick();
    expect(image.src).toBe(chineseImageUrl(a)!);
  });

  test('discovers newly added hover images, picture sources and inline backgrounds', async () => {
    const { document, replacer } = setup();
    replacer.setEnabled(true);
    const hover = document.createElement('div');
    hover.innerHTML = `<picture><source srcset="${a} 1x"><img src="${b}"></picture><div style='background-image: url("${a}")'></div>`;
    document.body.append(hover);
    await tick();
    expect(hover.querySelector('img')!.src).toBe(chineseImageUrl(b)!);
    expect(hover.querySelector('source')!.srcset).toBe(`${chineseImageUrl(a)} 1x`);
    expect(hover.lastElementChild!.getAttribute('style')).toContain(chineseImageUrl(a)!);
  });

  test('keeps English images on failures and allows a later explicit retry', async () => {
    let available = false;
    const { document, replacer } = setup(async () => { if (!available) throw new Error('Offline'); return true; });
    document.body.innerHTML = `<img src="${a}">`;
    replacer.setEnabled(true);
    await tick();
    expect(document.querySelector('img')!.src).toBe(a);
    available = true;
    replacer.refresh();
    await tick();
    expect(document.querySelector('img')!.src).toBe(chineseImageUrl(a)!);
  });

  test('does not apply pending work after disabling or overwrite a non-card URL', async () => {
    let resolve!: (value: boolean) => void;
    const { document, replacer } = setup(() => new Promise((done) => { resolve = done; }));
    document.body.innerHTML = `<img src="${a}">`;
    const image = document.querySelector('img')!;
    replacer.setEnabled(true);
    replacer.setEnabled(false);
    resolve(true);
    await tick();
    expect(image.src).toBe(a);
    replacer.setEnabled(true);
    image.src = 'https://example.com/other.jpg';
    await tick();
    resolve(true);
    await tick();
    expect(image.src).toBe('https://example.com/other.jpg');
  });

  test('preserves page style changes while restoring only its own image changes', async () => {
    const { document, replacer } = setup();
    document.body.innerHTML = `<div style='background-image: url("${a}"); width: 200px'></div>`;
    const card = document.querySelector('div')!;
    replacer.setEnabled(true);
    await tick();
    card.style.width = '300px';
    await tick();
    replacer.setEnabled(false);
    await tick();
    expect(card.style.width).toBe('300px');
    expect(card.style.backgroundImage).toContain(a);
    expect(card.style.backgroundImage).not.toContain('mtgch');
  });

  test('restores detached nodes and handles re-insertion without retaining stale state', async () => {
    const { document, replacer } = setup();
    document.body.innerHTML = `<img src="${a}">`;
    const image = document.querySelector('img')!;
    replacer.setEnabled(true);
    await tick();
    image.remove();
    await tick();
    expect(image.src).toBe(a);
    image.src = b;
    document.body.append(image);
    await tick();
    expect(image.src).toBe(chineseImageUrl(b)!);
    replacer.dispose();
    expect(image.src).toBe(b);
    image.src = a;
    await tick();
    expect(image.src).toBe(a);
  });

  test('Chinese text fallback uses safe text, opens by click/keyboard/hover, and never consumes picks', async () => {
    const face = { ...card().faces[0]!, image_url: null, image_kind: 'unavailable' as const, oracle_text_zh: '<img onerror="alert(1)">\n中文规则' };
    const { document, replacer } = setup(async () => false, async () => ({ face, origin: 'api' }));
    document.body.innerHTML = `<button id="pick"><img alt="Plains" src="${a}"></button>`;
    const image = document.querySelector('img')!;
    let picks = 0; document.querySelector('#pick')!.addEventListener('click', () => picks++);
    replacer.setEnabled(true); await tick();
    expect(image.src).toBe(a); expect(image.alt).toBe('Plains');
    const host = document.querySelector<HTMLElement>('[data-lands-zh-reader]')!;
    const root = host.shadowRoot!;
    const launcher = root.querySelector<HTMLButtonElement>('button[aria-controls]')!;
    const section = root.querySelector('section')!;
    expect(section.hidden).toBe(true);
    launcher.focus(); launcher.click();
    expect(section.hidden).toBe(false);
    expect(root.querySelector('select')!.options[0]!.textContent).toBe('平原');
    expect(section.textContent).toContain('<img onerror="alert(1)">'); expect(section.querySelector('img')).toBeNull();
    section.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(section.hidden).toBe(true);
    image.dispatchEvent(new document.defaultView!.Event('pointerenter'));
    expect(section.hidden).toBe(false);
    image.click(); expect(picks).toBe(1);
    replacer.setEnabled(false); await tick();
    expect(host.hidden).toBe(true); expect(image.src).toBe(a); expect(image.alt).toBe('Plains');
  });

  test('text fallback on a recycled card never displays a stale face or creates a pick handler', async () => {
    const resolve = new Map<string, (value: ImageResolution) => void>();
    const { document, replacer } = setup(async () => true, (url) => new Promise((done) => resolve.set(url, done)));
    document.body.innerHTML = `<img alt="English" src="${a}">`;
    const image = document.querySelector('img')!; replacer.setEnabled(true);
    image.src = b; await tick();
    resolve.get(a)!({ face: card().faces[0]! }); await tick();
    expect(document.querySelector('[data-lands-zh-reader]')).toBeNull();
    resolve.get(b)!({ url: PNG_DATA_URL }); await tick();
    expect(image.src).toBe(PNG_DATA_URL);
    expect(document.querySelector('[data-lands-zh-reader]')).toBeNull();
    image.remove(); await tick(); expect(image.src).toBe(b);
  });

  test('keeps the reading selection aligned with its text as fallback cards appear and disappear', async () => {
    const { document, replacer } = setup(async () => false, async (url) => ({
      face: { ...card().faces[0]!, name_zh: url === a ? '平原' : '沼泽', oracle_text_zh: url === a ? '白色法术力' : '黑色法术力' },
    }));
    document.body.innerHTML = `<img src="${a}"><img src="${b}">`;
    replacer.setEnabled(true); await tick();
    const root = document.querySelector('[data-lands-zh-reader]')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('button[aria-controls]')!.click();
    const select = root.querySelector('select')!;
    select.selectedIndex = 1;
    select.dispatchEvent(new document.defaultView!.Event('change'));
    const panel = root.querySelector('section')!;
    expect(panel.textContent).toContain('黑色法术力');
    const hover = document.createElement('img'); hover.src = a; document.body.append(hover);
    await tick();
    expect(select.selectedOptions[0]!.textContent).toBe('沼泽');
    expect(panel.textContent).toContain('黑色法术力');
    document.body.querySelector('img')!.remove(); await tick();
    expect(select.selectedOptions[0]!.textContent).toBe('沼泽');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('黑色法术力');
  });

  test('text remains openable after repeated refresh and disable/enable, and final disposal removes the host', async () => {
    let text = '第一次中文规则';
    const { document, replacer } = setup(async () => false, async () => ({ face: { ...card().faces[0]!, image_url: null, image_kind: 'unavailable', oracle_text_zh: text } }));
    document.body.innerHTML = `<button id="pick"><img alt="Plains" src="${a}"></button>`;
    let picks = 0; document.querySelector('#pick')!.addEventListener('click', () => picks++);
    const image = document.querySelector('img')!;
    replacer.setEnabled(true); await tick();
    const host = document.querySelector<HTMLElement>('[data-lands-zh-reader]')!;
    function openAndRead(expected: string) {
      expect(host.isConnected).toBe(true); expect(host.hidden).toBe(false);
      expect(document.querySelectorAll('[data-lands-zh-reader]')).toHaveLength(1);
      const root = host.shadowRoot!; const panel = root.querySelector('section')!;
      root.querySelector<HTMLButtonElement>('button[aria-controls]')!.click();
      expect(panel.hidden).toBe(false); expect(panel.textContent).toContain(expected);
      expect(image.src).toBe(a); expect(image.alt).toBe('Plains');
      image.click();
    }
    openAndRead(text);
    for (let i = 0; i < 3; i++) { text = `刷新中文规则 ${i}`; replacer.refresh(); await tick(); openAndRead(text); }
    replacer.setEnabled(false); await tick(); expect(host.hidden).toBe(true);
    text = '重新开启中文规则'; replacer.setEnabled(true); await tick(); openAndRead(text);
    expect(picks).toBe(5);
    replacer.dispose(); expect(document.querySelector('[data-lands-zh-reader]')).toBeNull();
  });
});
