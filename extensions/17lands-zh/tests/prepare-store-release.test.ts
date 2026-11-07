import { afterAll, afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { checkedDigest, checkedJobs, checkedRun, compareStoreZips, inspectStoreZip, prepareStoreRelease, releaseAssets, releaseVersion } from '../scripts/prepare-store-release';

const SHA = 'a'.repeat(40), TAG_SHA = 'b'.repeat(40), TAG = 'v0.5.0', FILENAME = '17lands-zh-0.5.0-chrome-remote.zip';
const RUN = { id: 9, head_sha: SHA, head_branch: 'main', event: 'push', path: '.github/workflows/check.yml', name: 'Check', status: 'completed', conclusion: 'success' };
const JOBS = { jobs: ['rust', 'extension', 'container'].map((name) => ({ name, status: 'completed', conclusion: 'success' })) };
const RELEASE = { tag_name: TAG, draft: false, prerelease: false, assets: [{ id: 1, name: FILENAME, size: 3000, state: 'uploaded' }, { id: 2, name: 'SHA256SUMS', size: 300, state: 'uploaded' }] };
const manifest = () => ({ manifest_version: 3, version: '0.5.0', permissions: ['storage'], host_permissions: ['https://17lands.syzroy.com/*', 'https://images.mtgch.com/*', 'https://cards.scryfall.io/*', 'https://www.17lands.com/*'], content_scripts: [{ matches: ['https://17lands.com/*', 'https://www.17lands.com/*'], js: ['content-scripts/content.js'] }], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' }, icons: Object.fromEntries([16, 32, 48, 128].map((size) => [String(size), `icon/${size}.png`])) });
function runtime(value: unknown = manifest()) {
  return [['manifest.json', Buffer.from(JSON.stringify(value))], ['background.js', Buffer.from('background')], ['popup.html', Buffer.from('<script src="chunks/popup.js"></script>')], ['content-scripts/content.js', Buffer.from('content')], ['chunks/popup.js', Buffer.from('popup')], ...[16, 32, 48, 128].map((size) => {
    const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(size, 16); png.writeUInt32BE(size, 20); return [`icon/${size}.png`, png];
  })] as [string, Buffer][];
}
// A fixture ZIP writer supplies complete local/central records, CRCs and optional deflate.
function zip(files: [string, Buffer][], compressed = false) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, data] of files) {
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const payload = compressed ? deflateRawSync(data) : data, filename = Buffer.from(name), local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(compressed ? 8 : 0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26); locals.push(local, filename, payload);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(compressed ? 8 : 0, 10); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(payload.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42); central.push(entry, filename); offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
}
const directories: string[] = [];
const taskDirectory = await mkdtemp(join(tmpdir(), 'store-release-test-'));
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
afterAll(async () => { await rm(taskDirectory, { recursive: true, force: true }); });

test('stable tag and published release require canonical version and exact assets', () => {
  expect(releaseVersion(TAG)).toBe('0.5.0');
  for (const tag of ['v0.5.0-rc.1', 'v01.5.0', '0.5.0', 'v0.0.0', 'v65536.0.0', 'v0.5.0\nfoo=bar', 'v0.5.0;touch x']) expect(() => releaseVersion(tag)).toThrow();
  expect(releaseAssets(RELEASE, TAG, '0.5.0')).toEqual({ archive: 1, checksums: 2 });
  for (const value of [{ ...RELEASE, draft: true }, { ...RELEASE, prerelease: true }, { ...RELEASE, tag_name: 'v0.4.1' }, { ...RELEASE, assets: RELEASE.assets.slice(0, 1) }, { ...RELEASE, assets: [...RELEASE.assets, RELEASE.assets[0]] }, { ...RELEASE, assets: RELEASE.assets.map((a) => ({ ...a, state: 'new' })) }]) expect(() => releaseAssets(value, TAG, '0.5.0')).toThrow();
});
test('only exact successful main-push Check CI with all three successful jobs can deploy', () => {
  expect(checkedRun({ workflow_runs: [RUN] }, SHA)).toBe(9);
  for (const change of [{ head_sha: TAG_SHA }, { head_branch: 'topic' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { name: 'Other' }, { status: 'in_progress' }, { conclusion: 'failure' }]) expect(() => checkedRun({ workflow_runs: [{ ...RUN, ...change }] }, SHA)).toThrow();
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress', conclusion: null }]) expect(() => checkedRun({ workflow_runs: [RUN, { ...RUN, ...change, id: 10 }] }, SHA)).toThrow();
  expect(() => checkedJobs(JOBS)).not.toThrow();
  for (const conclusion of ['skipped', 'failure', 'cancelled', 'neutral']) expect(() => checkedJobs({ jobs: JOBS.jobs.map((job) => job.name === 'container' ? { ...job, conclusion } : job) })).toThrow();
  expect(() => checkedJobs({ jobs: JOBS.jobs.slice(0, 2) })).toThrow(); expect(() => checkedJobs({ jobs: [...JOBS.jobs, JOBS.jobs[0]] })).toThrow();
});
test('one checksum must match the exact remote filename and exact archive bytes', () => {
  const bytes = zip(runtime()), digest = createHash('sha256').update(bytes).digest('hex'), line = `${digest}  ${FILENAME}`;
  expect(checkedDigest(line, FILENAME, bytes)).toBe(digest);
  expect(() => checkedDigest(`${line}\n${line}`, FILENAME, bytes)).toThrow(); expect(() => checkedDigest(line.replace('remote', 'local'), FILENAME, bytes)).toThrow(); expect(() => checkedDigest(line, FILENAME, Buffer.from('changed'))).toThrow();
});
test('stored and deflated ZIPs require remote manifest, complete runtime and correct icons', () => {
  expect(inspectStoreZip(zip(runtime()), '0.5.0')).toBe(9); expect(inspectStoreZip(zip(runtime(), true), '0.5.0')).toBe(9);
  expect(() => inspectStoreZip(zip(runtime()), '0.5.1')).toThrow();
  for (const change of [{ host_permissions: ['http://127.0.0.1:17317/*'] }, { permissions: ['storage', 'tabs'] }, { optional_permissions: ['history'] }, { background: { service_worker: 'other.js' } }]) expect(() => inspectStoreZip(zip(runtime({ ...manifest(), ...change })), '0.5.0')).toThrow();
  expect(() => inspectStoreZip(zip(runtime().filter(([name]) => name !== 'background.js')), '0.5.0')).toThrow();
  expect(() => inspectStoreZip(zip(runtime().map(([name, bytes]) => [name, name === 'icon/16.png' ? Buffer.alloc(24) : bytes])), '0.5.0')).toThrow();
  expect(inspectStoreZip(zip(runtime({ ...manifest(), icons: Object.fromEntries([16, 32, 48, 128].map((size) => [String(size), `/icon/${size}.png`])) })), '0.5.0')).toBe(9);
  for (const path of ['//icon/16.png', '/other/16.png', 'icon/../icon/16.png']) expect(() => inspectStoreZip(zip(runtime({ ...manifest(), icons: { ...manifest().icons, 16: path } })), '0.5.0')).toThrow();
});
test('source equivalence ignores ZIP order and compression but rejects missing, added or changed runtime bytes', () => {
  const release = zip(runtime());
  expect(compareStoreZips(release, zip(runtime().reverse(), true), '0.5.0')).toBe(9);
  expect(() => compareStoreZips(release, zip(runtime().filter(([name]) => name !== 'chunks/popup.js')), '0.5.0')).toThrow('differs');
  expect(() => compareStoreZips(release, zip([...runtime(), ['chunks/extra.js', Buffer.from('extra')]]), '0.5.0')).toThrow('differs');
  expect(() => compareStoreZips(release, zip(runtime().map(([name, bytes]) => [name, name === 'background.js' ? Buffer.from('changed') : bytes])), '0.5.0')).toThrow('background.js');
});
test('ZIP traversal, extra sources, duplicate records, links, truncation and corruption are rejected', () => {
  for (const path of ['../manifest.json', '/manifest.json', 'tests/example.ts', 'cards.sqlite', 'icon\\16.png']) expect(() => inspectStoreZip(zip([...runtime(), [path, Buffer.from('x')]]), '0.5.0')).toThrow();
  expect(() => inspectStoreZip(zip([...runtime(), runtime()[0]!]), '0.5.0')).toThrow(); expect(() => inspectStoreZip(zip(runtime()).subarray(0, -2), '0.5.0')).toThrow();
  const bytes = zip(runtime()); bytes[30 + 'manifest.json'.length + 5]! ^= 1; expect(() => inspectStoreZip(bytes, '0.5.0')).toThrow();
  const symlink = zip(runtime()), central = symlink.indexOf(Buffer.from('504b0102', 'hex')); symlink.writeUInt32LE(0o120777 << 16 >>> 0, central + 38); expect(() => inspectStoreZip(symlink, '0.5.0')).toThrow();
});

async function fixture(options: { release?: unknown; remoteSha?: string; run?: unknown; jobs?: unknown; packageVersion?: string; ancestor?: boolean; redirect?: string; wrongDigest?: boolean; annotated?: boolean } = {}) {
  const directory = await mkdtemp(join(taskDirectory, 'case-')); directories.push(directory);
  const bytes = zip(runtime()), digest = createHash('sha256').update(bytes).digest('hex');
  const requests: { url: string; options: RequestInit | undefined }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, options: init });
    if (url.endsWith('/releases/tags/v0.5.0')) return Response.json(options.release ?? RELEASE);
    if (url.endsWith('/git/ref/tags/v0.5.0')) return Response.json({ object: { type: options.annotated ? 'tag' : 'commit', sha: options.annotated ? TAG_SHA : options.remoteSha ?? SHA } });
    if (url.endsWith(`/git/tags/${TAG_SHA}`)) return Response.json({ object: { type: 'commit', sha: options.remoteSha ?? SHA } });
    if (url.includes('/actions/workflows/check.yml/runs?')) return Response.json(options.run ?? { workflow_runs: [RUN] });
    if (url.includes('/actions/runs/9/jobs?')) return Response.json(options.jobs ?? JOBS);
    if (url.endsWith('/releases/assets/1')) return options.redirect ? new Response(null, { status: 302, headers: { location: options.redirect } }) : new Response(bytes);
    if (url === options.redirect) return new Response(bytes);
    if (url.endsWith('/releases/assets/2')) return new Response(`${options.wrongDigest ? '0'.repeat(64) : digest}  ${FILENAME}\n`);
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const git = async (args: string[]) => {
    if (args[0] === 'rev-parse') return SHA;
    if (args[0] === 'merge-base') { if (options.ancestor === false) throw new Error('not an ancestor'); return ''; }
    if (args[0] === 'show') return JSON.stringify({ version: options.packageVersion ?? '0.5.0' });
    throw new Error('Unexpected git command');
  };
  return { directory, bytes, requests, config: { repository: 'syz51/17lands-zh', tag: TAG, token: 'test-private-token', temporaryRoot: directory }, dependencies: { fetch: fetcher, git } };
}
test('complete gate resolves annotated tags and writes only a validated remote archive', async () => {
  const f = await fixture({ annotated: true }), output = await prepareStoreRelease(f.config, f.dependencies);
  expect(output.sha).toBe(SHA); expect(output.version).toBe('0.5.0'); expect(output.files).toBe(9); expect(await readFile(output.zip_path)).toEqual(f.bytes); expect(output.zip_path.startsWith(f.directory + '/')).toBe(true);
  expect(f.requests.every((r) => r.options?.redirect === 'manual' && r.options.credentials === 'omit')).toBe(true);
});
test('complete gate rejects remote tag drift, unmerged source, wrong version, unrelated CI and digest', async () => {
  for (const options of [{ remoteSha: TAG_SHA }, { ancestor: false }, { packageVersion: '0.5.1' }, { run: { workflow_runs: [{ ...RUN, head_sha: TAG_SHA }] } }, { jobs: { jobs: JOBS.jobs.slice(0, 2) } }, { wrongDigest: true }, { release: { ...RELEASE, draft: true } }]) {
    const f = await fixture(options); await expect(prepareStoreRelease(f.config, f.dependencies)).rejects.toThrow();
  }
});
test('asset redirect only follows GitHub download hosts and strips authorization on redirect', async () => {
  const f = await fixture({ redirect: 'https://release-assets.githubusercontent.com/synthetic/signed' }); await prepareStoreRelease(f.config, f.dependencies);
  const redirected = f.requests.find((r) => r.url.startsWith('https://release-assets.'))!;
  expect(redirected.options?.headers).toBeUndefined(); expect(redirected.options?.redirect).toBe('error'); expect(redirected.options?.credentials).toBe('omit');
  for (const redirect of ['https://attacker.invalid/archive', 'http://release-assets.githubusercontent.com/archive', 'https://release-assets.githubusercontent.com:8443/archive', 'https://user:password@release-assets.githubusercontent.com/archive']) {
    const bad = await fixture({ redirect }); await expect(prepareStoreRelease(bad.config, bad.dependencies)).rejects.toThrow('Unexpected release download redirect'); expect(bad.requests.some((r) => r.url === redirect)).toBe(false);
  }
});
test('network failures do not expose credentials or signed download URLs', async () => {
  const f = await fixture();
  const fetcher = Object.assign(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => { throw new Error('private-token https://signed.invalid/?secret=private-token'); }, { preconnect() {} });
  await expect(prepareStoreRelease(f.config, { ...f.dependencies, fetch: fetcher })).rejects.toThrow('GitHub release request failed');
  try { await prepareStoreRelease(f.config, { ...f.dependencies, fetch: fetcher }); }
  catch (error) { expect(String(error)).not.toContain('private-token'); expect(String(error)).not.toContain('signed.invalid'); }
});
