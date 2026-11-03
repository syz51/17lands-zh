import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const API = 'https://api.github.com';
const ZIP_LIMIT = 16 * 1024 * 1024;
const HOSTS = ['https://17lands.syzroy.com/*', 'https://images.mtgch.com/*', 'https://cards.scryfall.io/*', 'https://www.17lands.com/*'];
const MATCHES = ['https://17lands.com/*', 'https://www.17lands.com/*'];
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (value: unknown, expected: string[]) => Array.isArray(value) && value.every((v) => typeof v === 'string') && JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort());
function fail(message: string): never { throw new Error(message); }
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function releaseVersion(tag: string): string {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) fail('Release tag must be a stable vA.B.C version');
  const version = tag.slice(1);
  if (version.split('.').some((part) => Number(part) > 65535) || version === '0.0.0') fail('Release version is outside Chrome manifest bounds');
  return version;
}

export function releaseAssets(value: unknown, tag: string, version: string) {
  if (!object(value) || value.tag_name !== tag || value.draft !== false || value.prerelease !== false || !Array.isArray(value.assets)) fail('Expected a published, stable GitHub Release for this tag');
  const assets = value.assets;
  const find = (name: string) => {
    const matches = assets.filter((item: unknown) => object(item) && item.name === name);
    if (matches.length !== 1) fail(`Release must contain exactly one ${name}`);
    const asset = matches[0];
    if (!object(asset) || !Number.isSafeInteger(asset.id) || (asset.id as number) < 1 || typeof asset.size !== 'number' || asset.size < 1 || asset.size > ZIP_LIMIT || asset.state !== 'uploaded') fail(`Invalid release asset ${name}`);
    return asset.id as number;
  };
  return { archive: find(`17lands-zh-${version}-chrome-remote.zip`), checksums: find('SHA256SUMS') };
}

export function checkedRun(value: unknown, sha: string): number {
  if (!object(value) || !Array.isArray(value.workflow_runs)) fail('Invalid Check workflow response');
  const candidates = value.workflow_runs.filter((item: unknown): item is Record<string, unknown> => object(item) && item.head_sha === sha && item.head_branch === 'main' && item.event === 'push' && item.path === '.github/workflows/check.yml' && item.name === 'Check');
  if (candidates.some((run) => !Number.isSafeInteger(run.id) || (run.id as number) < 1)) fail('Invalid Check workflow run identity');
  const run = candidates.sort((a, b) => (b.id as number) - (a.id as number))[0];
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') fail('This exact release commit needs its latest main-push Check workflow to succeed');
  return run.id as number;
}

export function checkedJobs(value: unknown) {
  if (!object(value) || !Array.isArray(value.jobs)) fail('Invalid Check jobs response');
  for (const name of ['rust', 'extension', 'container']) {
    const jobs = value.jobs.filter((job: unknown) => object(job) && job.name === name);
    if (jobs.length !== 1 || !object(jobs[0]) || jobs[0].status !== 'completed' || jobs[0].conclusion !== 'success') fail(`Required Check job ${name} did not succeed`);
  }
}

export function checkedDigest(text: string, filename: string, bytes: Uint8Array) {
  const matches = text.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);
    return match?.[2] === filename ? [match[1]!.toLowerCase()] : [];
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (matches.length !== 1 || matches[0] !== digest) fail('Release archive does not match its unique SHA256SUMS entry');
  return digest;
}

/** Read only the small, reviewed extension runtime; never extract archive-controlled paths. */
function storeZipFiles(input: Uint8Array, version: string) {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > ZIP_LIMIT) fail('Invalid release ZIP size');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail('Invalid or multi-disk release ZIP');
  const count = bytes.readUInt16LE(end + 10); const directory = bytes.readUInt32LE(end + 16);
  if (!count || count > 100 || bytes.readUInt16LE(end + 8) !== count || directory + bytes.readUInt32LE(end + 12) !== end) fail('Invalid release ZIP directory');
  const files = new Map<string, Buffer>(); let cursor = directory; let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid release ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8); const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20); const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28); const extra = bytes.readUInt16LE(cursor + 30); const comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42); const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if (cursor + 46 + nameLength + extra + comment > end || flags & 1 || ![0, 8].includes(method) || size > ZIP_LIMIT || ![0, 0o100000].includes(mode & 0o170000)) fail('Unsupported release ZIP entry');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!/^(?:manifest\.json|background\.js|popup\.html|content-scripts\/[A-Za-z0-9_-]+\.js|chunks\/[A-Za-z0-9_-]+\.js|assets\/[A-Za-z0-9_-]+\.css|icon\/(?:16|32|48|128)\.png)$/.test(name) || files.has(name)) fail('Release ZIP contains unexpected or duplicate runtime paths');
    if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) fail('Invalid release ZIP local entry');
    const localName = bytes.readUInt16LE(local + 26); const start = local + 30 + localName + bytes.readUInt16LE(local + 28);
    if (start + compressed > directory || bytes.subarray(local + 30, local + 30 + localName).toString('utf8') !== name) fail('Release ZIP local path or size mismatch');
    expanded += size;
    if (expanded > ZIP_LIMIT) fail('Expanded release ZIP exceeds limit');
    const payload = bytes.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: ZIP_LIMIT });
    if (content.length !== size || crc32(content) !== bytes.readUInt32LE(cursor + 16)) fail('Release ZIP expanded size or CRC mismatch');
    files.set(name, content); cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) fail('Release ZIP directory size mismatch');
  const manifest: unknown = JSON.parse(files.get('manifest.json')?.toString('utf8') ?? 'null');
  if (!object(manifest) || manifest.manifest_version !== 3 || manifest.version !== version || !same(manifest.permissions, ['storage']) || !same(manifest.host_permissions, HOSTS) || !Array.isArray(manifest.content_scripts) || !object(manifest.background) || manifest.background.service_worker !== 'background.js' || !object(manifest.action) || manifest.action.default_popup !== 'popup.html' || !object(manifest.icons)) fail('Release manifest must match the reviewed remote store build');
  const scripts = manifest.content_scripts;
  if (scripts.length !== 1 || !object(scripts[0]) || !same(scripts[0].matches, MATCHES) || !same(scripts[0].js, ['content-scripts/content.js'])) fail('Release content scripts must match the reviewed store build');
  for (const path of ['background.js', 'popup.html', 'content-scripts/content.js']) if (!files.has(path)) fail(`Release runtime file missing: ${path}`);
  for (const size of [16, 32, 48, 128]) {
    const path = manifest.icons[String(size)]; const normalized = typeof path === 'string' ? path.replace(/^\//, '') : undefined;
    const png = normalized ? files.get(normalized) : undefined;
    if (normalized !== `icon/${size}.png` || !png || png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) fail(`Invalid release ${size}px icon`);
  }
  // Reject extra API/remote execution entry points which the runtime allowlist does not cover.
  for (const key of ['optional_permissions', 'optional_host_permissions', 'externally_connectable', 'sandbox', 'devtools_page', 'chrome_url_overrides']) if (key in manifest) fail(`Unreviewed release manifest field: ${key}`);
  return files;
}

export function inspectStoreZip(input: Uint8Array, version: string) { return storeZipFiles(input, version).size; }

/** ZIP container metadata may vary; every deployed runtime byte must match the checked source build. */
export function compareStoreZips(release: Uint8Array, rebuilt: Uint8Array, version: string) {
  const expected = storeZipFiles(release, version); const actual = storeZipFiles(rebuilt, version);
  if (expected.size !== actual.size) fail('Release asset differs from the verified source build');
  for (const [name, bytes] of expected) if (!actual.get(name)?.equals(bytes)) fail(`Release asset differs from the verified source build: ${name}`);
  return actual.size;
}

export type PrepareConfig = { repository: string; tag: string; token: string; temporaryRoot: string };
export type PrepareDependencies = { fetch: typeof fetch; git: (args: string[]) => Promise<string> };

export async function prepareStoreRelease(config: PrepareConfig, dependencies: Partial<PrepareDependencies> = {}) {
  const { repository, tag, token, temporaryRoot } = config;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token || !temporaryRoot || /[\r\n]/.test(temporaryRoot)) fail('Missing or invalid release-gate configuration');
  const version = releaseVersion(tag);
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const git = dependencies.git ?? (async (args: string[]) => {
    const result = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(result.stdout).text();
    if (await result.exited !== 0) fail('Release git verification failed');
    return output.trim();
  });
  const safeFetch = async (url: string | URL, init: RequestInit) => {
    try { return await fetcher(url, init); }
    catch { fail('GitHub release request failed before a valid response was received'); }
  };
  const request = async (path: string, maximum = 1024 * 1024, media = false) => {
    const url = `${API}/repos/${repository}${path}`;
    let response = await safeFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: media ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (media && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); const next = location ? new URL(location) : undefined;
      if (!next || next.protocol !== 'https:' || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) || next.port || next.username || next.password) fail('Unexpected release download redirect');
      response = await safeFetch(next, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000) });
    }
    if (!response.ok) fail(`GitHub release verification failed (HTTP ${response.status})`);
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    if (!reader) fail('Empty GitHub response');
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        length += item.value.byteLength;
        if (length > maximum) { await reader.cancel(); fail('GitHub response exceeds release limit'); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  };
  const json = async (path: string): Promise<unknown> => JSON.parse((await request(path)).toString('utf8'));
  const release = releaseAssets(await json(`/releases/tags/${tag}`), tag, version);
  const local = await git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(local)) fail('Invalid release commit');
  let ref: unknown = await json(`/git/ref/tags/${tag}`);
  for (let depth = 0; depth < 5; depth++) {
    if (!object(ref) || !object(ref.object) || typeof ref.object.sha !== 'string' || !/^[a-f0-9]{40}$/.test(ref.object.sha)) fail('Invalid remote release tag');
    if (ref.object.type === 'commit') {
      if (ref.object.sha !== local) fail('Remote release tag changed after checkout');
      break;
    }
    if (ref.object.type !== 'tag' || depth === 4) fail('Unsupported remote release tag');
    ref = await json(`/git/tags/${ref.object.sha}`);
  }
  await git(['merge-base', '--is-ancestor', local, 'origin/main']);
  const pkg: unknown = JSON.parse(await git(['show', `${local}:extensions/17lands-zh/package.json`]));
  if (!object(pkg) || pkg.version !== version) fail('Release tag and package version differ');
  const run = checkedRun(await json(`/actions/workflows/check.yml/runs?head_sha=${local}&branch=main&event=push&per_page=100`), local);
  checkedJobs(await json(`/actions/runs/${run}/jobs?filter=latest&per_page=100`));
  const [archive, checksums] = await Promise.all([request(`/releases/assets/${release.archive}`, ZIP_LIMIT, true), request(`/releases/assets/${release.checksums}`, 16_384, true)]);
  const filename = `17lands-zh-${version}-chrome-remote.zip`;
  const digest = checkedDigest(checksums.toString('utf8'), filename, archive);
  const files = inspectStoreZip(archive, version);
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'chrome-web-store-'));
  const archivePath = join(directory, filename);
  await writeFile(archivePath, archive, { mode: 0o600 });
  return { tag, version, sha: local, zip_path: archivePath, sha256: digest, files };
}

if (import.meta.main) {
  try {
    let output: Record<string, string | number>;
    if (process.argv[2] === 'compare') {
      const version = releaseVersion(`v${process.env.CWS_VERSION ?? ''}`);
      const releasePath = process.env.CWS_RELEASE_ZIP; const rebuiltPath = process.env.CWS_REBUILT_ZIP;
      if (!releasePath || !rebuiltPath || /[\r\n]/.test(releasePath + rebuiltPath)) fail('Missing or invalid source comparison paths');
      const release = Bun.file(releasePath); const rebuilt = Bun.file(rebuiltPath);
      if (release.size > ZIP_LIMIT || rebuilt.size > ZIP_LIMIT) fail('Release ZIP exceeds limit');
      const files = compareStoreZips(new Uint8Array(await release.arrayBuffer()), new Uint8Array(await rebuilt.arrayBuffer()), version);
      output = { version, files, zip_path: resolve(rebuiltPath) };
    } else {
      output = await prepareStoreRelease({ repository: process.env.GITHUB_REPOSITORY ?? '', tag: process.env.RELEASE_TAG ?? '', token: process.env.GH_TOKEN ?? '', temporaryRoot: process.env.RUNNER_TEMP ?? '' });
    }
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(JSON.stringify(output));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release verification failed');
    process.exitCode = 1;
  }
}
