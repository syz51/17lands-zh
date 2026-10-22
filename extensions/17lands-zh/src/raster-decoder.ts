import { MAX_IMAGE_BYTES } from './cache-contract';
import type { CachedImage } from './persistent-cache';

export type RasterDecoder = (image: CachedImage) => Promise<void>;

/** Available in both an MV3 service worker and Firefox's background. No DOM/image element is needed. */
export async function validateRaster(image: CachedImage, decode = globalThis.createImageBitmap): Promise<void> {
  if (!image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES || !/^image\/(jpeg|png|webp|avif)$/.test(image.mime)) throw new Error('图片响应无效');
  if (typeof decode !== 'function') throw new Error('浏览器不支持后台图片解码');
  const bitmap = await decode(new Blob([image.bytes.slice().buffer], { type: image.mime }));
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new Error('图片解码失败');
  } finally { bitmap.close(); }
}
