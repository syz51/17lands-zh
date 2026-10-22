import { expect, test } from 'bun:test';
import { validateRaster } from '../src/raster-decoder';
import { validRaster } from './cache-fixture';

test('native raster adapter passes the complete blob and releases ImageBitmap on success or invalid dimensions', async () => {
  for (const width of [1, 0]) {
    let closed = false;
    const decode = (async (blob: Blob) => {
      expect(blob.type).toBe('image/png');
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...validRaster().bytes]);
      return { width, height: 1, close() { closed = true; } } as ImageBitmap;
    }) as typeof createImageBitmap;
    if (width) await validateRaster(validRaster(), decode);
    else await expect(validateRaster(validRaster(), decode)).rejects.toThrow('图片解码失败');
    expect(closed).toBe(true);
  }
});
