import { browser } from 'wxt/browser';
import './style.css';
import type { ServiceStatus } from '../../src/cache-contract';

const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const service = document.querySelector<HTMLParagraphElement>('#service')!;
const cache = document.querySelector<HTMLParagraphElement>('#cache')!;
const origin = document.querySelector<HTMLParagraphElement>('#origin')!;

function render(value: boolean) {
  enabled.checked = value;
  retry.disabled = !value;
  status.textContent = value ? '已开启中文显示，可用内容会自动加载。' : '已关闭中文显示，保留英文原图。';
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
    service.textContent = value.state === 'online' ? '卡库连接正常。'
      : value.state === 'empty' ? '卡库数据尚未就绪，请稍后重试。'
      : '暂时无法连接卡库，仍可使用已保存的资料和图片。';
    cache.textContent = `本机缓存：${value.metadataCount} 条查询记录、${value.imageCount} 张图片。`;
    const sources = { api: '向卡库查询', cache: '浏览器已保存的查询结果', stale: '已保存的查询结果，可能需要更新', direct: '按卡牌 ID 尝试获取中文图', unavailable: '暂无可用结果' };
    origin.textContent = `最近数据来源：${value.lastResult ? sources[value.lastResult] ?? '未知' : '尚无记录'}。`;
  } catch {
    service.textContent = '无法读取扩展状态，请重新打开弹窗；若仍失败，请到扩展管理页重新加载扩展。';
    cache.textContent = '本机缓存：暂时无法读取。';
    origin.textContent = '最近数据来源：暂时无法读取。';
  }
}

enabled.addEventListener('change', async () => {
  const value = enabled.checked;
  enabled.disabled = true;
  try {
    await browser.storage.local.set({ enabled: value });
    render(value);
  } catch {
    render(!value);
    status.textContent = '设置未保存，请重试。';
  } finally {
    enabled.disabled = false;
  }
});

retry.addEventListener('click', async () => {
  retry.disabled = true;
  status.textContent = '正在重新尝试加载当前页面的中文卡图和牌文…';
  service.textContent = '正在检查卡库连接…';
  try {
    await updateService(true);
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab');
    await browser.tabs.sendMessage(tab.id, { type: '17lands-zh:retry' });
    status.textContent = '已开始重试当前页面，加载可能需要几秒。';
  } catch {
    status.textContent = '请先打开 17Lands 页面；刚安装时请刷新该页面。';
  } finally {
    retry.disabled = !enabled.checked;
  }
});

void initialize().catch(() => {
  status.textContent = '暂时无法读取设置，请重新打开扩展。';
});
