import { browser } from 'wxt/browser';
import './style.css';
import type { ServiceStatus } from '../../src/cache-contract';
import { isSiteUrl } from '../../src/site-url';

const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const statsEnabled = document.querySelector<HTMLInputElement>('#stats-enabled')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const service = document.querySelector<HTMLParagraphElement>('#service')!;

let retrying = false;

function activeFeatures() {
  if (enabled.checked && statsEnabled.checked) return '中文卡图、牌文和 17Lands 数据';
  return enabled.checked ? '中文卡图和牌文' : statsEnabled.checked ? '17Lands 数据' : '';
}

function render() {
  retry.disabled = retrying || (!enabled.checked && !statsEnabled.checked);
  status.textContent = activeFeatures() ? `已开启${activeFeatures()}，可用内容会自动加载。` : '已关闭中文显示和 17Lands 数据。';
}

async function initialize() {
  // Tab URLs are only visible for hosts the extension may access, so any other tab reads as "not 17Lands".
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!isSiteUrl(tab?.url)) {
    document.querySelector<HTMLElement>('#controls')!.hidden = true;
    document.querySelector<HTMLElement>('#elsewhere')!.hidden = false;
    return;
  }
  const settings = await browser.storage.local.get(['enabled', 'statsEnabled']);
  enabled.checked = settings.enabled !== false;
  statsEnabled.checked = settings.statsEnabled !== false;
  render();
  enabled.disabled = false;
  statsEnabled.disabled = false;
  await updateService();
}

async function updateService(force = false) {
  try {
    const value = await browser.runtime.sendMessage({ type: force ? '17lands-zh:retry-service' : '17lands-zh:status' }) as ServiceStatus;
    if (!['online', 'empty', 'offline'].includes(value.state)) throw new Error('Invalid status');
    service.textContent = value.state === 'online' ? '卡库连接正常。'
      : value.state === 'empty' ? '卡库数据尚未就绪，请稍后重试。'
      : '暂时无法连接卡库，仍可使用已保存的资料和图片。';
  } catch {
    service.textContent = '无法读取扩展状态，请重新打开弹窗；若仍失败，请到扩展管理页重新加载扩展。';
  }
}

for (const [control, key] of [[enabled, 'enabled'], [statsEnabled, 'statsEnabled']] as const) {
  control.addEventListener('change', async () => {
    const value = control.checked;
    control.disabled = true;
    try {
      await browser.storage.local.set({ [key]: value });
      render();
    } catch {
      control.checked = !value;
      render();
      status.textContent = '设置未保存，请重试。';
    } finally {
      control.disabled = false;
    }
  });
}

// Explanations open on hover or keyboard focus; a click pins them for touch, and Escape or an outside click closes them.
const infos = [...document.querySelectorAll<HTMLButtonElement>('.info')];
const closeInfos = (except?: HTMLButtonElement) => { for (const info of infos) if (info !== except) info.setAttribute('aria-expanded', 'false'); };
for (const info of infos) {
  info.addEventListener('click', () => {
    closeInfos(info); info.classList.remove('dismissed');
    info.setAttribute('aria-expanded', String(info.getAttribute('aria-expanded') !== 'true'));
  });
  // Escape hides the tip even while hover or focus would show it, until the pointer or focus leaves.
  for (const type of ['blur', 'mouseleave']) info.addEventListener(type, () => info.classList.remove('dismissed'));
}
document.addEventListener('click', (event) => { if (!infos.some((info) => info.contains(event.target as Node))) closeInfos(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeInfos();
  for (const info of infos) if (info.matches(':hover, :focus')) info.classList.add('dismissed');
});

retry.addEventListener('click', async () => {
  retrying = true;
  retry.disabled = true;
  status.textContent = `正在重新尝试加载当前页面的${activeFeatures()}…`;
  try {
    if (enabled.checked) {
      service.textContent = '正在检查卡库连接…';
      await updateService(true);
    }
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab');
    await browser.tabs.sendMessage(tab.id, { type: '17lands-zh:retry' });
    status.textContent = '已开始重试当前页面，加载可能需要几秒。';
  } catch {
    status.textContent = '请先打开 17Lands 页面；刚安装时请刷新该页面。';
  } finally {
    retrying = false;
    retry.disabled = !enabled.checked && !statsEnabled.checked;
  }
});

void initialize().catch(() => {
  status.textContent = '暂时无法读取设置，请重新打开扩展。';
});
