import { defineConfig } from 'wxt';
import { resolveApiOrigin } from './src/api-origin';

const apiOrigin = resolveApiOrigin(process.env.WXT_API_ORIGIN);

export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: '17Lands 中文卡图',
    description: '在 17Lands 显示中文卡图与已有中文牌文，并在轮抽页显示公开卡牌等级、胜率和 ALSA，支持本机缓存。',
    homepage_url: 'https://github.com/syz51/17lands-zh',
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 128: '/icon/128.png' },
    permissions: ['storage'],
    host_permissions: [`${apiOrigin}/*`, 'https://images.mtgch.com/*', 'https://cards.scryfall.io/*', 'https://www.17lands.com/*'],
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
