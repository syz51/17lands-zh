import { defineConfig } from 'wxt';
import { resolveApiOrigin } from './src/api-origin';

const apiOrigin = resolveApiOrigin(process.env.WXT_API_ORIGIN);

export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: '17Lands 中文卡图',
    description: '在 17Lands 显示中文卡图；缺图时可阅读已有中文牌文，支持本机或远程卡库与离线缓存。',
    homepage_url: 'https://github.com/syz51/17lands-zh',
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    permissions: ['storage'],
    host_permissions: [`${apiOrigin}/*`, 'https://images.mtgch.com/*', 'https://cards.scryfall.io/*'],
    action: {
      default_title: '17Lands 中文卡图',
      default_icon: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    },
    ...(browser === 'firefox' ? { browser_specific_settings: {
      gecko: {
        id: '17lands-zh@local.invalid',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['websiteContent'] },
      },
    } } : {}),
  }),
});
