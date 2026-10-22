import { MAX_IMAGE_BYTES, parseCard, record, type CardFace, type LookupResult } from './cache-contract';
import { printingIn } from './card-images';

export type ImageResolution = { url?: string; face?: CardFace; origin?: string };
type Send = (message: unknown) => Promise<unknown>;
type Job = { id: string; epoch: number; resolve: (value: LookupResult | undefined) => void };

/** Content scripts only send identities. All fetches and persistent storage live in the background. */
export function createServiceClient(send: Send) {
  const pending = new Map<string, Promise<LookupResult | undefined>>();
  const resolutions = new Map<string, Promise<ImageResolution>>();
  const queue: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let epoch = 0;
  function lookup(id: string) {
    const existing = pending.get(id);
    if (existing) return existing;
    const result = new Promise<LookupResult | undefined>((resolve) => { queue.push({ id, epoch, resolve }); });
    pending.set(id, result);
    if (!timer) timer = setTimeout(flush, 8);
    return result;
  }
  function flush() {
    timer = undefined;
    while (queue.length) {
      const jobs = queue.splice(0, 100);
      void send({ type: '17lands-zh:lookup', ids: jobs.map((job) => job.id) }).then((response) => {
        if (!Array.isArray(response) || response.length !== jobs.length) throw new Error('无效查询响应');
        for (let i = 0; i < jobs.length; i++) {
          if (jobs[i]!.epoch === epoch) pending.delete(jobs[i]!.id);
          const value: unknown = response[i];
          try {
            if (!record(value) || value.id !== jobs[i]!.id || !['api', 'cache', 'stale', 'unavailable'].includes(String(value.origin)) ||
              typeof value.fallback !== 'boolean' || !(value.revision === null || typeof value.revision === 'string')) throw new Error('无效卡牌响应');
            const card = value.card === null ? null : parseCard(value.card);
            if (card && card.printing_id !== jobs[i]!.id) throw new Error('卡牌 ID 不符');
            jobs[i]!.resolve({ id: value.id as string, card, origin: value.origin as LookupResult['origin'], revision: value.revision as string | null, fallback: value.fallback });
          } catch { jobs[i]!.resolve(undefined); }
        }
      }).catch(() => { for (const job of jobs) { if (job.epoch === epoch) pending.delete(job.id); job.resolve(undefined); } });
    }
  }
  async function resolveImage(original: string): Promise<ImageResolution> {
    const identity = printingIn(original);
    if (!identity || disposed) return {};
    const key = `${identity.id}/${identity.face}`;
    const existing = resolutions.get(key);
    if (existing) return existing;
    const currentEpoch = epoch;
    const operation = (async (): Promise<ImageResolution> => {
      const result = await lookup(identity.id);
      if (disposed || currentEpoch !== epoch || !result) return {};
      const face = result.card?.faces.find((f) => f.face === identity.face);
      if (!face?.image_url && (!result.fallback || result.card)) return { face, origin: result.origin };
      let response: unknown;
      try { response = await send({ type: '17lands-zh:image', ...identity }); } catch { return { face, origin: result.origin }; }
      if (disposed || currentEpoch !== epoch) return {};
      if (record(response) && typeof response.dataUrl === 'string' && response.dataUrl.length <= Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 &&
        /^data:image\/(jpeg|png|webp|avif);base64,[A-Za-z0-9+/]+=*$/.test(response.dataUrl)) {
        return { url: response.dataUrl, face, origin: typeof response.origin === 'string' ? response.origin : result.origin };
      }
      return { face, origin: result.origin };
    })();
    if (resolutions.size >= 16) resolutions.delete(resolutions.keys().next().value!);
    resolutions.set(key, operation);
    return operation;
  }
  return {
    resolve: resolveImage,
    clear() {
      epoch++; resolutions.clear(); pending.clear();
      if (timer) { clearTimeout(timer); timer = undefined; }
      for (const job of queue.splice(0)) job.resolve(undefined);
    },
    dispose() {
      disposed = true; epoch++; resolutions.clear(); pending.clear();
      if (timer) clearTimeout(timer);
      for (const job of queue.splice(0)) job.resolve(undefined);
    },
  };
}
