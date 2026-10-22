export function resolveApiOrigin(value?: string): string {
  const url = new URL(value ?? 'http://127.0.0.1:17317');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && url.origin !== 'http://127.0.0.1:17317')) {
    throw new Error('API origin must be HTTPS or the fixed local service');
  }
  return url.origin;
}
