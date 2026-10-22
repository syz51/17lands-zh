// Exercise the production decoder and persistent cache in a native worker, with no DOM Image fallback.
import { runRasterQA } from './storage-browser';

self.onmessage = () => {
  void runRasterQA().then((result) => self.postMessage(result)).catch((error: unknown) => self.postMessage({ error: String(error) }));
};
