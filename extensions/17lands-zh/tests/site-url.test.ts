import { expect, test } from 'bun:test';
import { isSiteUrl } from '../src/site-url';

test('only 17Lands HTTPS pages count as the site', () => {
  for (const url of ['https://www.17lands.com/', 'https://17lands.com/site_draft/abc', 'https://www.17lands.com/draft/x/1/1?y=1']) expect(isSiteUrl(url)).toBe(true);
  for (const url of [undefined, '', 'http://www.17lands.com/', 'https://www.17lands.com:8443/', 'https://u:p@www.17lands.com/',
    'https://17lands.com.example.com/', 'https://example.com/?u=https://www.17lands.com/', 'chrome://extensions/']) expect(isSiteUrl(url)).toBe(false);
});
