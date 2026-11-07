import { appendFile } from 'node:fs/promises';

const API = 'https://chromewebstore.googleapis.com';
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const STATES = ['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'REJECTED', 'CANCELLED'] as const;
type ItemState = typeof STATES[number];
type ChromeVersion = readonly [number, number, number, number];
type Revision = { state: ItemState; versions: ChromeVersion[] };
type Status = { published?: Revision; submitted?: Revision; uploadState?: string };
export type StorePublishConfig = {
  publisherId: string; itemId: string; version: string; accessToken: string; archive: Blob; dryRun: boolean;
};
export type StorePublishResult = {
  outcome: 'dry-run' | 'already-published' | 'already-submitted' | 'submitted';
  itemId: string; version: string; state: ItemState | 'NOT_SUBMITTED';
};
type Dependencies = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; pollAttempts?: number; pollIntervalMs?: number };

class StorePublishError extends Error {}
function fail(message: string): never { throw new StorePublishError(message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function versionParts(version: string): ChromeVersion {
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version)) fail('Invalid Chrome extension version.');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) fail('Invalid Chrome extension version.');
  return [parts[0]!, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}
function compareVersions(left: ChromeVersion, right: ChromeVersion) {
  for (let index = 0; index < 4; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}
function revision(value: unknown): Revision | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || !STATES.includes(value.state as ItemState) || !Array.isArray(value.distributionChannels) || value.distributionChannels.length > 16) fail('Invalid Chrome Web Store revision status.');
  const versions = value.distributionChannels.map((channel) => {
    if (!object(channel) || typeof channel.crxVersion !== 'string') fail('Invalid Chrome Web Store revision version.');
    return versionParts(channel.crxVersion);
  });
  if (!versions.length) fail('Chrome Web Store revision has no verifiable version.');
  return { state: value.state as ItemState, versions };
}
function identity(value: unknown, name: string, itemId: string): asserts value is Record<string, unknown> {
  if (!object(value) || value.name !== name || value.itemId !== itemId) fail('Chrome Web Store response identifies a different item.');
}
function parseStatus(value: unknown, name: string, itemId: string): Status {
  identity(value, name, itemId);
  if (value.takenDown === true || value.warned === true) fail('Chrome Web Store reports a policy warning or takedown. Resolve it in the Developer Dashboard.');
  if ((value.takenDown !== undefined && typeof value.takenDown !== 'boolean') || (value.warned !== undefined && typeof value.warned !== 'boolean') ||
      (value.lastAsyncUploadState !== undefined && typeof value.lastAsyncUploadState !== 'string')) fail('Invalid Chrome Web Store item status.');
  return { published: revision(value.publishedItemRevisionStatus), submitted: revision(value.submittedItemRevisionStatus), uploadState: value.lastAsyncUploadState as string | undefined };
}
function existing(status: Status, expected: ChromeVersion): { outcome: 'already-published' | 'already-submitted'; state: ItemState } | undefined {
  for (const entry of [status.published, status.submitted]) {
    if (entry?.versions.some((version) => compareVersions(version, expected) > 0)) fail('A newer version already exists in Chrome Web Store. Refusing to deploy an older release.');
  }
  const active = status.submitted && ['PENDING_REVIEW', 'STAGED'].includes(status.submitted.state) ? status.submitted : undefined;
  if (active) {
    if (active.versions.some((version) => compareVersions(version, expected) !== 0)) fail('Another version is awaiting review or staged. Wait for it to finish, then rerun this release deployment.');
    return { outcome: 'already-submitted', state: active.state };
  }
  if (status.published && ['PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(status.published.state) && status.published.versions.some((version) => compareVersions(version, expected) === 0)) {
    return { outcome: 'already-published', state: status.published.state };
  }
  return undefined;
}

/** Uploads once and submits for normal review; mutation failures are never blindly retried. */
export async function publishStore(config: StorePublishConfig, dependencies: Dependencies = {}): Promise<StorePublishResult> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.publisherId) || !/^[a-p]{32}$/.test(config.itemId)) fail('Invalid Chrome Web Store publisher or extension ID.');
  if (!config.accessToken || /[\s\r\n]/.test(config.accessToken) || config.accessToken.length > 16_384) fail('Missing or invalid Chrome Web Store access token.');
  if (typeof config.dryRun !== 'boolean') fail('CWS_DRY_RUN must be true or false.');
  const expectedVersion = versionParts(config.version);
  if (config.archive.size < 22 || config.archive.size > MAX_PACKAGE_BYTES || new Uint8Array(await config.archive.slice(0, 4).arrayBuffer()).join(',') !== '80,75,3,4') fail('Expected a verified extension ZIP between 22 bytes and 32 MiB.');
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const attempts = dependencies.pollAttempts ?? 24;
  const interval = dependencies.pollIntervalMs ?? 5000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120 || !Number.isFinite(interval) || interval < 0 || interval > 10_000) fail('Invalid Chrome Web Store polling configuration.');
  const name = `publishers/${config.publisherId}/items/${config.itemId}`;
  const result = (outcome: StorePublishResult['outcome'], state: StorePublishResult['state']): StorePublishResult => ({ outcome, itemId: config.itemId, version: config.version, state });
  async function request(operation: string, method: 'GET' | 'POST', body?: Blob | string, deadline?: number): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${API}${operation}`, { method, body, headers: { Authorization: `Bearer ${config.accessToken}`, ...(body instanceof Blob ? { 'Content-Type': 'application/zip' } : body ? { 'Content-Type': 'application/json' } : {}) }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(deadline === undefined ? 30_000 : Math.max(1, Math.min(30_000, deadline - now()))) });
    } catch {
      fail(method === 'POST' ? 'Chrome Web Store mutation did not return a response. Its outcome is unknown; inspect the Developer Dashboard before retrying.' : 'Chrome Web Store status request failed.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(`Chrome Web Store ${method} request failed with HTTP ${response.status}.${method === 'POST' ? ' Inspect the Developer Dashboard before retrying; this mutation was not retried.' : ''}`);
    }
    const reader = response.body?.getReader();
    if (!reader) fail('Chrome Web Store returned an empty response.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('Chrome Web Store response exceeded its size limit.'); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof StorePublishError) throw error;
      fail(method === 'POST' ? 'Chrome Web Store mutation response was interrupted. Inspect the Developer Dashboard before retrying.' : 'Chrome Web Store status response was interrupted.');
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { fail('Chrome Web Store returned invalid JSON. Inspect the Developer Dashboard before retrying a mutation.'); }
  }
  const status = async (deadline?: number) => parseStatus(await request(`/v2/${name}:fetchStatus`, 'GET', undefined, deadline), name, config.itemId);
  const before = await status();
  const prior = existing(before, expectedVersion);
  if (config.dryRun) return result('dry-run', prior?.state ?? 'NOT_SUBMITTED');
  if (prior) return result(prior.outcome, prior.state);
  const uploaded = await request(`/upload/v2/${name}:upload`, 'POST', config.archive);
  identity(uploaded, name, config.itemId);
  if (uploaded.uploadState === 'SUCCEEDED') {
    if (typeof uploaded.crxVersion !== 'string' || compareVersions(versionParts(uploaded.crxVersion), expectedVersion) !== 0) fail('Uploaded Chrome Web Store version does not match the release. Nothing was submitted.');
  } else if (uploaded.uploadState === 'IN_PROGRESS' || uploaded.uploadState === 'UPLOAD_IN_PROGRESS') {
    let complete = false;
    const deadline = now() + 120_000;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(interval);
      if (now() >= deadline) break;
      const current = await status(deadline);
      const arrived = existing(current, expectedVersion);
      if (arrived) return result(arrived.outcome, arrived.state);
      if (current.uploadState === 'SUCCEEDED') { complete = true; break; }
      if (current.uploadState !== 'IN_PROGRESS' && current.uploadState !== 'UPLOAD_IN_PROGRESS') fail('Chrome Web Store async upload did not succeed. Inspect the Developer Dashboard; nothing was submitted.');
    }
    if (!complete) fail('Chrome Web Store upload processing timed out. Inspect the Developer Dashboard before rerunning; nothing was submitted.');
  } else fail('Chrome Web Store upload failed or returned an unknown state. Nothing was submitted.');
  const published = await request(`/v2/${name}:publish`, 'POST', JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }));
  identity(published, name, config.itemId);
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(String(published.state))) fail('Chrome Web Store did not accept normal publication. Inspect the Developer Dashboard.');
  // Submission can become visible after the POST response. Confirm both version and state.
  const deadline = now() + 120_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (now() >= deadline) break;
    const current = await status(deadline);
    const confirmed = existing(current, expectedVersion);
    if (confirmed) return result('submitted', confirmed.state);
    if (current.submitted?.versions.some((version) => compareVersions(version, expectedVersion) === 0) && ['REJECTED', 'CANCELLED'].includes(current.submitted.state)) fail('Chrome Web Store rejected or cancelled the submitted release. Inspect the Developer Dashboard.');
    if (attempt + 1 < attempts) await sleep(interval);
  }
  fail('Chrome Web Store accepted the submission but its target version could not be confirmed. Inspect the Developer Dashboard before retrying.');
}

if (import.meta.main) {
  try {
    const dryRun = process.env.CWS_DRY_RUN ?? 'false';
    if (!['true', 'false'].includes(dryRun)) fail('CWS_DRY_RUN must be true or false.');
    const value = await publishStore({ publisherId: process.env.CWS_PUBLISHER_ID ?? '', itemId: process.env.CWS_EXTENSION_ID ?? '', version: process.env.CWS_VERSION ?? '', accessToken: process.env.CWS_ACCESS_TOKEN ?? '', archive: Bun.file(process.env.CWS_ZIP_PATH ?? ''), dryRun: dryRun === 'true' });
    const summary = JSON.stringify(value);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Chrome Web Store\n\n\`\`\`json\n${summary}\n\`\`\`\n\nSubmission for review is not confirmation of public availability.\n`);
  } catch (error) {
    console.error(error instanceof StorePublishError ? error.message : 'Chrome Web Store deployment failed. No credentials or response bodies were logged.');
    process.exitCode = 1;
  }
}
