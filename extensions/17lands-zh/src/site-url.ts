/** The extension only operates on 17Lands' own HTTPS origins, without ports or embedded credentials. */
export function isSiteUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && ['17lands.com', 'www.17lands.com'].includes(url.hostname);
  } catch { return false; }
}
