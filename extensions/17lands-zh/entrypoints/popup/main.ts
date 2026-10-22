import { browser } from 'wxt/browser';
import './style.css';
import type { ServiceStatus } from '../../src/cache-contract';

const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const service = document.querySelector<HTMLParagraphElement>('#service')!;

function render(value: boolean) {
  enabled.checked = value;
  retry.disabled = !value;
  status.textContent = value ? '已开启，对打开的 17Lands 页面即时生效。' : '已切回英文原图。';
}

async function initialize() {
  const settings = await browser.storage.local.get('enabled');
  render(settings.enabled !== false);
  enabled.disabled = false;
  await updateService();
}

async function updateService(force = false) {
  try {
    const value = await browser.runtime.sendMessage({ type: force ? '17lands-zh:retry-service' : '17lands-zh:status' }) as ServiceStatus;
    if (!['online', 'empty', 'offline'].includes(value.state)) throw new Error('Invalid status');
    const state = value.state === 'online' ? '卡库服务已连接' : value.state === 'empty' ? '卡库服务正在准备数据' : '卡库服务离线';
    const origin = { api: '卡库 API', cache: '持久缓存', stale: '离线／旧缓存', direct: '直接图源回退', unavailable: '暂无结果' };
    service.textContent = `${state} · 缓存 ${value.metadataCount} 张卡／${value.imageCount} 张图。${value.lastResult ? `最近结果：${origin[value.lastResult]}。` : ''}${value.state === 'offline' ? '可继续读取已有缓存；请确认卡库服务可用后重试。' : ''}`;
  } catch { service.textContent = '无法读取后台状态，请重新加载扩展。'; }
}

enabled.addEventListener('change', async () => {
  const value = enabled.checked;
  enabled.disabled = true;
  try {
    await browser.storage.local.set({ enabled: value });
    render(value);
  } catch {
    enabled.checked = !value;
    status.textContent = '设置未保存，请重试。';
  } finally {
    enabled.disabled = false;
  }
});

retry.addEventListener('click', async () => {
  retry.disabled = true;
  try {
    await updateService(true);
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab');
    await browser.tabs.sendMessage(tab.id, { type: '17lands-zh:retry' });
    status.textContent = '正在重试当前页面的中文卡图与文字。';
  } catch {
    status.textContent = '请先打开 17Lands 页面；刚安装时请刷新该页面。';
  } finally {
    retry.disabled = !enabled.checked;
  }
});

void initialize().catch(() => {
  status.textContent = '暂时无法读取设置，请重新打开扩展。';
});
