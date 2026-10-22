type Result = { available: boolean; expires: number };
type Job = { url: string; resolve: (available: boolean) => void };

/** Shared probes avoid a failed Chinese image ever replacing a working English image. */
export function createImageLoader(options: {
  createImage?: () => HTMLImageElement;
  concurrency?: number;
  timeoutMs?: number;
} = {}) {
  const createImage = options.createImage ?? (() => new Image());
  const concurrency = options.concurrency ?? 6;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const cache = new Map<string, Result>();
  const pending = new Map<string, Promise<boolean>>();
  const queue: Job[] = [];
  const cancelActive = new Set<() => void>();
  let active = 0;
  let disposed = false;
  let cacheEpoch = 0;

  function pump() {
    while (!disposed && active < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      const epoch = cacheEpoch;
      active++;
      const image = createImage();
      let settled = false;
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, timeoutMs);
      cancelActive.add(cancel);

      function finish(available: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        cancelActive.delete(cancel);
        if (!available) image.removeAttribute('src');
        if (!disposed && epoch === cacheEpoch && !job.url.startsWith('data:')) {
          // Bound memory while keeping failures short-lived.
          if (cache.size >= 512) cache.delete(cache.keys().next().value!);
          cache.set(job.url, {
            available,
            expires: Date.now() + (available ? 3_600_000 : 300_000),
          });
        }
        pending.delete(job.url);
        active--;
        job.resolve(available);
        pump();
      }

      image.referrerPolicy = 'no-referrer';
      image.onload = () => finish(image.naturalWidth > 0);
      image.onerror = () => finish(false);
      image.src = job.url;
    }
  }

  function load(url: string): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.available);
    const existing = pending.get(url);
    if (existing) return existing;
    let resolve!: Job['resolve'];
    const promise = new Promise<boolean>((done) => { resolve = done; });
    pending.set(url, promise);
    queue.push({ url, resolve });
    pump();
    return promise;
  }

  return {
    load,
    clear() { cache.clear(); cacheEpoch++; },
    dispose() {
      disposed = true;
      cache.clear();
      for (const job of queue.splice(0)) job.resolve(false);
      for (const cancel of [...cancelActive]) cancel();
      pending.clear();
    },
  };
}
