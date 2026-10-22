import { describe, expect, test } from 'bun:test';
import { createImageLoader } from '../src/image-loader';

function fixture(options: { concurrency?: number; timeoutMs?: number } = {}) {
  const images: HTMLImageElement[] = [];
  const loader = createImageLoader({
    ...options,
    createImage: () => {
      const image = { naturalWidth: 672, onload: null, onerror: null, removeAttribute() {} } as unknown as HTMLImageElement;
      images.push(image);
      return image;
    },
  });
  return { loader, images };
}

describe('Chinese image availability probes', () => {
  test('deduplicates in-flight loads, limits concurrency, caches and retries failures', async () => {
    const { loader, images } = fixture({ concurrency: 1 });
    const a = loader.load('a');
    expect(loader.load('a')).toBe(a);
    const b = loader.load('b');
    expect(images).toHaveLength(1);
    images[0]!.onerror!(new Event('error'));
    expect(await a).toBe(false);
    expect(images).toHaveLength(2);
    images[1]!.onload!(new Event('load'));
    expect(await b).toBe(true);
    expect(await loader.load('a')).toBe(false);
    expect(images).toHaveLength(2);
    loader.clear();
    const retry = loader.load('a');
    images[2]!.onload!(new Event('load'));
    expect(await retry).toBe(true);
    loader.dispose();
  });

  test('times out a stalled server and releases queued work', async () => {
    const { loader } = fixture({ concurrency: 1, timeoutMs: 5 });
    expect(await Promise.all([loader.load('a'), loader.load('b')])).toEqual([false, false]);
    loader.dispose();
  });

  test('disposal settles active and queued loads and prevents future requests', async () => {
    const { loader, images } = fixture({ concurrency: 1 });
    const results = [loader.load('a'), loader.load('b')];
    loader.dispose();
    expect(await Promise.all(results)).toEqual([false, false]);
    expect(await loader.load('c')).toBe(false);
    expect(images).toHaveLength(1);
  });
});
