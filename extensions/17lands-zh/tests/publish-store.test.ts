import { describe, expect, test } from 'bun:test';
import { publishStore, type StorePublishConfig } from '../scripts/publish-store';

const ITEM = 'jfdiaanapkhbgjcphnlanhhddioeibem';
const NAME = `publishers/publisher-123/items/${ITEM}`;
const TOKEN = 'secret-test-access-token';
const archive = new Blob([new Uint8Array([80, 75, 3, 4, ...new Array<number>(30).fill(0)])], { type: 'application/zip' });
const config: StorePublishConfig = { publisherId: 'publisher-123', itemId: ITEM, version: '0.5.0', accessToken: TOKEN, archive, dryRun: false };
const rev = (version: string, state = 'PUBLISHED') => ({ state, distributionChannels: [{ crxVersion: version, deployPercentage: 100 }] });
const state = (extra: Record<string, unknown> = {}) => ({ name: NAME, itemId: ITEM, publishedItemRevisionStatus: rev('0.4.1'), ...extra });
const upload = (extra: Record<string, unknown> = {}) => ({ name: NAME, itemId: ITEM, uploadState: 'SUCCEEDED', crxVersion: '0.5.0', ...extra });
const accepted = (value = 'PENDING_REVIEW') => ({ name: NAME, itemId: ITEM, state: value });
const confirmed = (value = 'PENDING_REVIEW') => state({ submittedItemRevisionStatus: rev('0.5.0', value) });
function fixture(replies: (unknown | Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init! });
    if (!replies.length) throw new Error('No test response remains');
    const response = replies.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  }) as typeof fetch;
  return { calls, waits, dependencies: { fetch: fetcher, sleep: async (ms: number) => { waits.push(ms); }, pollAttempts: 3, pollIntervalMs: 5 } };
}

describe('Chrome Web Store deployment', () => {
  test('uploads once to the fixed v2 API, submits normal review and confirms the target version', async () => {
    const f = fixture([state(), upload(), accepted(), confirmed()]);
    expect(await publishStore(config, f.dependencies)).toEqual({ outcome: 'submitted', itemId: ITEM, version: '0.5.0', state: 'PENDING_REVIEW' });
    expect(f.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`],
      ['POST', `https://chromewebstore.googleapis.com/upload/v2/${NAME}:upload`],
      ['POST', `https://chromewebstore.googleapis.com/v2/${NAME}:publish`],
      ['GET', `https://chromewebstore.googleapis.com/v2/${NAME}:fetchStatus`],
    ]);
    expect(f.calls[1]!.init.body).toBe(archive);
    expect(f.calls[2]!.init.body).toBe(JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }));
    for (const { init } of f.calls) {
      expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
    expect(new Headers(f.calls[1]!.init.headers).get('content-type')).toBe('application/zip');
  });

  test('a first store publication can have neither a published nor submitted revision', async () => {
    const f = fixture([state({ publishedItemRevisionStatus: undefined }), upload(), accepted(), confirmed()]);
    expect((await publishStore(config, f.dependencies)).state).toBe('PENDING_REVIEW');
  });

  for (const stateName of ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']) {
    test(`accepted ${stateName} upload is polled to success before publishing`, async () => {
      const f = fixture([state(), upload({ uploadState: stateName, crxVersion: undefined }), state({ lastAsyncUploadState: 'IN_PROGRESS' }), state({ lastAsyncUploadState: 'SUCCEEDED' }), accepted(), confirmed()]);
      expect((await publishStore(config, f.dependencies)).outcome).toBe('submitted');
      expect(f.waits).toEqual([5, 5]);
      expect(f.calls.filter((c) => c.url.endsWith(':upload'))).toHaveLength(1);
      expect(f.calls.findIndex((c) => c.url.endsWith(':publish'))).toBe(4);
    });
  }

  test('readback may lag submission, but confirms publication accurately once visible', async () => {
    const f = fixture([state(), upload(), accepted('PUBLISHED'), state(), state({ publishedItemRevisionStatus: rev('0.5.0') })]);
    expect((await publishStore(config, f.dependencies)).state).toBe('PUBLISHED');
    expect(f.waits).toEqual([5]);
  });

  for (const cwsState of ['PUBLISHED', 'PUBLISHED_TO_TESTERS'] as const) {
    test(`matching ${cwsState} release skips all mutations`, async () => {
      const f = fixture([state({ publishedItemRevisionStatus: rev('0.5.0.0', cwsState) })]);
      expect(await publishStore(config, f.dependencies)).toEqual({ outcome: 'already-published', itemId: ITEM, version: '0.5.0', state: cwsState });
      expect(f.calls).toHaveLength(1);
    });
  }

  for (const cwsState of ['PENDING_REVIEW', 'STAGED'] as const) {
    test(`matching ${cwsState} release is reported without changing its submission`, async () => {
      const f = fixture([confirmed(cwsState)]);
      expect((await publishStore(config, f.dependencies))).toEqual({ outcome: 'already-submitted', itemId: ITEM, version: '0.5.0', state: cwsState });
      expect(f.calls).toHaveLength(1);
    });
    test(`different ${cwsState} release cannot be overwritten`, async () => {
      const f = fixture([state({ submittedItemRevisionStatus: rev('0.4.2', cwsState) })]);
      await expect(publishStore(config, f.dependencies)).rejects.toThrow('Another version');
      expect(f.calls).toHaveLength(1);
    });
  }

  test('Chrome versions compare numerically rather than lexically', async () => {
    const f = fixture([state({ publishedItemRevisionStatus: rev('0.10.0') })]);
    await expect(publishStore(config, f.dependencies)).rejects.toThrow('newer version');
    expect(f.calls).toHaveLength(1);
    const pending = fixture([state({ submittedItemRevisionStatus: rev('0.6.0', 'REJECTED') })]);
    await expect(publishStore(config, pending.dependencies)).rejects.toThrow('newer version');
  });

  test('read-only dry run validates local ZIP and store preflight without a POST', async () => {
    const f = fixture([state()]);
    expect(await publishStore({ ...config, dryRun: true }, f.dependencies)).toEqual({ outcome: 'dry-run', itemId: ITEM, version: '0.5.0', state: 'NOT_SUBMITTED' });
    expect(f.calls).toHaveLength(1);
    const already = fixture([confirmed()]);
    expect((await publishStore({ ...config, dryRun: true }, already.dependencies)).outcome).toBe('dry-run');
  });

  test('configuration and ZIP failures never contact the API', async () => {
    for (const invalid of [
      { publisherId: '../outside' }, { itemId: 'invalid' }, { accessToken: '' }, { accessToken: 'bad\nheader' },
      { version: '00.5.0' }, { version: '65536.0' }, { version: '0.0.0.0' }, { version: '0.5.0-beta' },
      { archive: new Blob() }, { archive: new Blob(['not a zip package even though large enough']) },
    ]) {
      const f = fixture([]);
      await expect(publishStore({ ...config, ...invalid }, f.dependencies)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });

  test('policy restrictions, wrong item identity and malformed revision data fail closed', async () => {
    for (const invalid of [state({ warned: true }), state({ takenDown: true }), state({ name: 'other' }), state({ itemId: 'different' }), state({ submittedItemRevisionStatus: rev('broken') }), state({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [] } }), state({ publishedItemRevisionStatus: { state: 'UNKNOWN', distributionChannels: [] } })]) {
      const f = fixture([invalid]);
      await expect(publishStore(config, f.dependencies)).rejects.toThrow();
      expect(f.calls).toHaveLength(1);
    }
  });

  test('wrong synchronous upload version or identity never reaches publish', async () => {
    for (const invalid of [upload({ crxVersion: '0.4.1' }), upload({ crxVersion: undefined }), upload({ name: 'other' }), upload({ itemId: 'other' })]) {
      const f = fixture([state(), invalid]);
      await expect(publishStore(config, f.dependencies)).rejects.toThrow();
      expect(f.calls).toHaveLength(2);
    }
  });

  for (const uploadState of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', 'unexpected']) {
    test(`upload state ${uploadState} never publishes`, async () => {
      const f = fixture([state(), upload({ uploadState })]);
      await expect(publishStore(config, f.dependencies)).rejects.toThrow('upload failed');
      expect(f.calls).toHaveLength(2);
      const async = fixture([state(), upload({ uploadState: 'IN_PROGRESS' }), state({ lastAsyncUploadState: uploadState })]);
      await expect(publishStore(config, async.dependencies)).rejects.toThrow('async upload did not succeed');
      expect(async.calls).toHaveLength(3);
    });
  }

  test('async upload timeout is bounded and never retries upload or publishes', async () => {
    const f = fixture([state(), upload({ uploadState: 'IN_PROGRESS' }), ...Array.from({ length: 3 }, () => state({ lastAsyncUploadState: 'IN_PROGRESS' }))]);
    await expect(publishStore(config, f.dependencies)).rejects.toThrow('timed out');
    expect(f.waits).toEqual([5, 5, 5]);
    expect(f.calls.filter((c) => c.init.method === 'POST')).toHaveLength(1);
  });

  test('elapsed upload deadline prevents a long response sequence from extending the budget', async () => {
    const f = fixture([state(), upload({ uploadState: 'IN_PROGRESS' })]);
    let time = 0;
    await expect(publishStore(config, { ...f.dependencies, now: () => time, sleep: async () => { time += 120_001; } })).rejects.toThrow('timed out');
    expect(f.calls).toHaveLength(2);
  });

  test('an intervening review while an upload is processing cannot be overwritten', async () => {
    const f = fixture([state(), upload({ uploadState: 'IN_PROGRESS' }), state({ lastAsyncUploadState: 'SUCCEEDED', submittedItemRevisionStatus: rev('0.4.2', 'PENDING_REVIEW') })]);
    await expect(publishStore(config, f.dependencies)).rejects.toThrow('Another version');
    expect(f.calls).toHaveLength(3);
    const submitted = fixture([state(), upload({ uploadState: 'IN_PROGRESS' }), confirmed()]);
    expect((await publishStore(config, submitted.dependencies)).outcome).toBe('already-submitted');
    expect(submitted.calls.filter((call) => call.url.endsWith(':publish'))).toHaveLength(0);
  });

  test('HTTP and transport errors do not leak credentials or retry mutations', async () => {
    for (const response of [new Response(JSON.stringify({ error: TOKEN }), { status: 401 }), new Error(`network failure includes ${TOKEN}`)]) {
      const f = fixture([state(), response]);
      let message = '';
      try { await publishStore(config, f.dependencies); } catch (error) { message = String(error); }
      expect(message).not.toContain(TOKEN); expect(message).toContain('before retrying'); expect(f.calls).toHaveLength(2);
    }
    const publishFailure = fixture([state(), upload(), new Error(TOKEN)]);
    await expect(publishStore(config, publishFailure.dependencies)).rejects.toThrow('outcome is unknown');
    expect(publishFailure.calls).toHaveLength(3);
  });

  test('invalid, oversized and interrupted responses cannot trigger publishing', async () => {
    for (const response of [new Response('{bad json'), new Response('x'.repeat(128 * 1024 + 1)), new Response(new ReadableStream({ start(controller) { controller.error(new Error(TOKEN)); } }))]) {
      const f = fixture([state(), response]);
      let message = '';
      try { await publishStore(config, f.dependencies); } catch (error) { message = String(error); }
      expect(message).not.toContain(TOKEN); expect(message.length).toBeGreaterThan(0); expect(f.calls).toHaveLength(2);
    }
  });

  test('publish API rejection and wrong identity are not reported as submitted', async () => {
    for (const invalid of [accepted('REJECTED'), accepted('STAGED'), { ...accepted(), itemId: 'other' }]) {
      const f = fixture([state(), upload(), invalid]);
      await expect(publishStore(config, f.dependencies)).rejects.toThrow();
      expect(f.calls).toHaveLength(3);
    }
  });

  test('a post-publish conflicting version, rejection or unconfirmed target fails truthfully', async () => {
    const conflict = fixture([state(), upload(), accepted(), state({ submittedItemRevisionStatus: rev('0.6.0', 'PENDING_REVIEW') })]);
    await expect(publishStore(config, conflict.dependencies)).rejects.toThrow('newer version');
    for (const rejection of ['REJECTED', 'CANCELLED']) {
      const f = fixture([state(), upload(), accepted(), confirmed(rejection)]);
      await expect(publishStore(config, f.dependencies)).rejects.toThrow('rejected or cancelled');
    }
    const missing = fixture([state(), upload(), accepted(), state(), state(), state()]);
    await expect(publishStore(config, missing.dependencies)).rejects.toThrow('could not be confirmed');
    expect(missing.waits).toHaveLength(2);
  });
});
