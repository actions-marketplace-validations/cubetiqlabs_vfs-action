import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as tar from 'tar';
import { uploadArtifact } from '../src/artifact/upload';
import { downloadArtifact } from '../src/artifact/download';
import { createFakeVFS, type FakeVFS } from './fake-vfs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

let workspace: string;
let vfs: FakeVFS;

function inputs(values: Record<string, string>) {
  for (const key of Object.keys(process.env)) if (key.startsWith('INPUT_')) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[`INPUT_${key.toUpperCase()}`] = value;
}

function runAs(runId: string, attempt = '1') {
  process.env.GITHUB_REPOSITORY = 'acme/web';
  process.env.GITHUB_RUN_ID = runId;
  process.env.GITHUB_RUN_ATTEMPT = attempt;
  process.env.GITHUB_WORKSPACE = workspace;
}

const connection = { endpoint: 'https://vfs.example.test', 'api-key': 'test-api-key', bucket: 'ci' };

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'vfs-artifact-test-'));
  process.env.RUNNER_TEMP = await mkdtemp(path.join(os.tmpdir(), 'vfs-artifact-tmp-'));
  vfs = createFakeVFS();
  globalThis.fetch = vfs.fetch;
  runAs('1001');
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(workspace, { recursive: true, force: true });
  await rm(process.env.RUNNER_TEMP!, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('upload-artifact', () => {
  it('uploads the README example and downloads it back into another directory', async () => {
    await writeFile(path.join(workspace, 'next-build.tgz'), 'pretend this is a build');
    inputs({ ...connection, name: 'nextjs-build-tar', path: 'next-build.tgz', 'if-no-files-found': 'error', 'retention-days': '1' });

    const uploaded = await uploadArtifact();
    expect(uploaded?.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(uploaded?.files).toBe(1);

    expect(vfs.files).toHaveLength(1);
    const stored = vfs.files[0];
    expect(stored.exp).toBe('24h');
    expect(stored.name).toBe('nextjs-build-tar-1001.tgz');
    expect(stored.logicalKey).toBe('artifacts/acme/web/1001/nextjs-build-tar');
    expect(uploaded?.artifactDigest).toBe(`sha256:${stored.file_hash}`);

    const target = path.join(workspace, 'out');
    inputs({ ...connection, name: 'nextjs-build-tar', path: 'out' });
    const downloaded = await downloadArtifact();
    expect(downloaded.downloadPath).toBe(target);
    expect(await readFile(path.join(target, 'next-build.tgz'), 'utf8')).toBe('pretend this is a build');
  });

  it('roots the archive at the common ancestor, honours excludes and skips hidden files', async () => {
    await mkdir(path.join(workspace, 'dist/assets'), { recursive: true });
    await mkdir(path.join(workspace, 'dist/.cache'), { recursive: true });
    await writeFile(path.join(workspace, 'dist/index.html'), '<html>');
    await writeFile(path.join(workspace, 'dist/assets/app.js'), 'js');
    await writeFile(path.join(workspace, 'dist/assets/app.js.map'), 'map');
    await writeFile(path.join(workspace, 'dist/.env'), 'SECRET=1');
    await writeFile(path.join(workspace, 'dist/.cache/x'), 'x');
    inputs({ ...connection, name: 'site', path: 'dist\n!dist/**/*.map' });

    const uploaded = await uploadArtifact();
    expect(uploaded?.files).toBe(2);

    inputs({ ...connection, name: 'site', path: 'restored' });
    await downloadArtifact();
    const root = path.join(workspace, 'restored');
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('<html>');
    expect(await readFile(path.join(root, 'assets/app.js'), 'utf8')).toBe('js');
    await expect(stat(path.join(root, 'assets/app.js.map'))).rejects.toThrow();
    await expect(stat(path.join(root, '.env'))).rejects.toThrow();
    await expect(stat(path.join(root, '.cache'))).rejects.toThrow();
  });

  it('includes hidden files on request and keeps an explicitly named hidden directory', async () => {
    await mkdir(path.join(workspace, '.build'), { recursive: true });
    await writeFile(path.join(workspace, '.build/out.txt'), 'out');
    await writeFile(path.join(workspace, '.build/.dot'), 'dot');

    inputs({ ...connection, name: 'explicit', path: '.build' });
    expect((await uploadArtifact())?.files).toBe(1);

    inputs({ ...connection, name: 'all', path: '.build', 'include-hidden-files': 'true' });
    expect((await uploadArtifact())?.files).toBe(2);
  });

  it('preserves executable permissions', async () => {
    if (process.platform === 'win32') return;
    await writeFile(path.join(workspace, 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(path.join(workspace, 'run.sh'), 0o755);
    inputs({ ...connection, name: 'script', path: 'run.sh' });
    await uploadArtifact();

    inputs({ ...connection, name: 'script', path: 'bin' });
    await downloadArtifact();
    expect((await stat(path.join(workspace, 'bin/run.sh'))).mode & 0o111).not.toBe(0);
  });

  it('follows if-no-files-found', async () => {
    inputs({ ...connection, name: 'none', path: 'missing/*.txt', 'if-no-files-found': 'error' });
    await expect(uploadArtifact()).rejects.toThrow('No files were found');

    inputs({ ...connection, name: 'none', path: 'missing/*.txt', 'if-no-files-found': 'warn' });
    expect(await uploadArtifact()).toBeUndefined();
    inputs({ ...connection, name: 'none', path: 'missing/*.txt', 'if-no-files-found': 'ignore' });
    expect(await uploadArtifact()).toBeUndefined();
    expect(vfs.files).toHaveLength(0);
  });

  it('refuses to clobber an artifact unless overwrite is set', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'first');
    inputs({ ...connection, name: 'dup', path: 'a.txt' });
    await uploadArtifact();

    await writeFile(path.join(workspace, 'a.txt'), 'second');
    await expect(uploadArtifact()).rejects.toThrow('already exists');
    expect(vfs.files).toHaveLength(1);

    inputs({ ...connection, name: 'dup', path: 'a.txt', overwrite: 'true' });
    await uploadArtifact();
    expect(vfs.files).toHaveLength(1);

    inputs({ ...connection, name: 'dup', path: 'restored' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'restored/a.txt'), 'utf8')).toBe('second');
  });

  it('replaces an artifact left by an earlier attempt of the same run', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'attempt one');
    inputs({ ...connection, name: 'build', path: 'a.txt' });
    await uploadArtifact();

    runAs('1001', '2');
    await writeFile(path.join(workspace, 'a.txt'), 'attempt two');
    await uploadArtifact();
    expect(vfs.files).toHaveLength(1);
    expect((vfs.files[0].metadata.vfs_artifact as { run_attempt: number }).run_attempt).toBe(2);
  });

  it('stores artifacts with the same bytes under their own names', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'same');
    inputs({ ...connection, name: 'one', path: 'a.txt' });
    await uploadArtifact();
    inputs({ ...connection, name: 'two', path: 'a.txt' });
    await uploadArtifact();
    expect(vfs.files.map((f) => f.name).sort()).toEqual(['one-1001.tgz', 'two-1001.tgz']);
    expect(vfs.requests.some((r) => r.url.searchParams.has('skip_duplicate'))).toBe(false);
  });

  it('keeps artifacts distinct on a server that deduplicates by content hash', async () => {
    vfs.dedupe = true;
    await writeFile(path.join(workspace, 'a.txt'), 'identical everywhere');
    inputs({ ...connection, name: 'one', path: 'a.txt' });
    const first = await uploadArtifact();
    inputs({ ...connection, name: 'two', path: 'a.txt' });
    const second = await uploadArtifact();
    runAs('1002');
    inputs({ ...connection, name: 'one', path: 'a.txt' });
    const nextRun = await uploadArtifact();
    expect(new Set([first?.artifactId, second?.artifactId, nextRun?.artifactId]).size).toBe(3);

    inputs({ ...connection, name: 'two', path: 'restored', 'run-id': '1001' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'restored/a.txt'), 'utf8')).toBe('identical everywhere');
    await expect(stat(path.join(workspace, 'restored/.vfs-artifact.json'))).rejects.toThrow();
  });

  it('retries a transient server failure', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'retry me');
    vfs.failNextPuts = 2;
    inputs({ ...connection, name: 'flaky', path: 'a.txt' });
    await uploadArtifact({ retryDelayMs: 1 });
    expect(vfs.files).toHaveLength(1);
  });

  it('validates names and settings', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'x');
    inputs({ ...connection, name: 'bad/name', path: 'a.txt' });
    await expect(uploadArtifact()).rejects.toThrow('invalid character');
    inputs({ ...connection, name: 'ok', path: 'a.txt', 'compression-level': '12' });
    await expect(uploadArtifact()).rejects.toThrow('compression-level');
    inputs({ ...connection, name: 'ok', path: 'a.txt', 'retention-days': '-1' });
    await expect(uploadArtifact()).rejects.toThrow('retention-days');
    inputs({ ...connection, endpoint: 'http://vfs.example.test', name: 'ok', path: 'a.txt' });
    await expect(uploadArtifact()).rejects.toThrow('HTTPS');
  });

  it('reads the connection from environment variables', async () => {
    await writeFile(path.join(workspace, 'a.txt'), 'env');
    inputs({ name: 'from-env', path: 'a.txt' });
    process.env.VFS_ENDPOINT = connection.endpoint;
    process.env.VFS_API_KEY = connection['api-key'];
    process.env.VFS_BUCKET = connection.bucket;
    await uploadArtifact();
    expect(vfs.files).toHaveLength(1);

    inputs({ name: 'from-env', path: 'a.txt' });
    delete process.env.VFS_BUCKET;
    await expect(uploadArtifact()).rejects.toThrow('VFS_BUCKET');
  });
});

describe('download-artifact', () => {
  async function publish(name: string, files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(workspace, 'src', name, file)), { recursive: true });
      await writeFile(path.join(workspace, 'src', name, file), content);
    }
    inputs({ ...connection, name, path: `src/${name}` });
    return uploadArtifact();
  }

  it('puts each artifact in its own directory, filtered by pattern', async () => {
    await publish('build-linux', { 'app.txt': 'linux' });
    await publish('build-macos', { 'app.txt': 'macos' });
    await publish('docs', { 'index.md': 'docs' });

    inputs({ ...connection, pattern: 'build-*', path: 'dl' });
    const result = await downloadArtifact();
    expect(result.artifacts).toEqual(['build-linux', 'build-macos']);
    expect(await readFile(path.join(workspace, 'dl/build-linux/app.txt'), 'utf8')).toBe('linux');
    expect(await readFile(path.join(workspace, 'dl/build-macos/app.txt'), 'utf8')).toBe('macos');
    await expect(stat(path.join(workspace, 'dl/docs'))).rejects.toThrow();

    inputs({ ...connection, path: 'all' });
    expect((await downloadArtifact()).artifacts).toHaveLength(3);
  });

  it('merges every artifact into one directory with merge-multiple', async () => {
    await publish('part-a', { 'a.txt': 'A' });
    await publish('part-b', { 'b.txt': 'B' });
    inputs({ ...connection, pattern: 'part-*', 'merge-multiple': 'true', path: 'merged' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'merged/a.txt'), 'utf8')).toBe('A');
    expect(await readFile(path.join(workspace, 'merged/b.txt'), 'utf8')).toBe('B');
  });

  it('downloads by artifact id', async () => {
    const up = await publish('by-id', { 'x.txt': 'x' });
    inputs({ ...connection, 'artifact-ids': up!.artifactId, path: 'ids' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'ids/x.txt'), 'utf8')).toBe('x');

    inputs({ ...connection, 'artifact-ids': 'nope', path: 'ids' });
    await expect(downloadArtifact()).rejects.toThrow('was not found');
  });

  it('reads another run when run-id and repository are given', async () => {
    await publish('release', { 'v.txt': 'from run 1001' });
    runAs('2002');
    inputs({ ...connection, name: 'release', path: 'other', 'run-id': '1001', repository: 'acme/web' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'other/v.txt'), 'utf8')).toBe('from run 1001');

    inputs({ ...connection, name: 'release', path: 'other' });
    await expect(downloadArtifact()).rejects.toThrow('Unable to find an artifact named "release" for run 2002');
  });

  it('lists what exists when a name is missing', async () => {
    await publish('alpha', { 'a.txt': 'a' });
    inputs({ ...connection, name: 'beta' });
    await expect(downloadArtifact()).rejects.toThrow('Available artifacts: alpha');
  });

  it('does not mix runs or repositories that share a name', async () => {
    await publish('shared', { 'f.txt': 'run 1001' });
    process.env.GITHUB_REPOSITORY = 'acme/other';
    await publish('shared', { 'f.txt': 'other repo' });
    runAs('1001');
    inputs({ ...connection, name: 'shared', path: 'mine' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'mine/f.txt'), 'utf8')).toBe('run 1001');
  });

  it('detects a corrupted download', async () => {
    await publish('sealed', { 'a.txt': 'original' });
    const damaged = vfs.files[0].bytes.slice();
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    vfs.files[0].bytes = damaged;
    inputs({ ...connection, name: 'sealed', path: 'bad' });
    await expect(downloadArtifact({ retryDelayMs: 1 })).rejects.toThrow('Checksum mismatch');
    await expect(stat(path.join(workspace, 'bad'))).rejects.toThrow();
  });

  it('follows a CDN redirect without leaking the API key', async () => {
    await publish('cdn', { 'a.txt': 'via cdn' });
    vfs.redirectDownloadsTo = 'https://cdn.example.test';
    inputs({ ...connection, name: 'cdn', path: 'cdn-out' });
    await downloadArtifact();
    expect(await readFile(path.join(workspace, 'cdn-out/a.txt'), 'utf8')).toBe('via cdn');
    const cdnCalls = vfs.requests.filter((r) => r.url.host === 'cdn.example.test');
    expect(cdnCalls).toHaveLength(1);
    expect(cdnCalls[0].headers.get('x-api-key')).toBeNull();
  });

  it('never extracts outside the destination', async () => {
    const dir = path.join(workspace, 'evil');
    await mkdir(dir);
    await writeFile(path.join(dir, 'ok.txt'), 'ok');
    await symlink('/etc/passwd', path.join(dir, 'link'));
    await writeFile(path.join(workspace, 'outside.txt'), 'outside');
    const archive = path.join(workspace, 'evil.tgz');
    await tar.c({ file: archive, cwd: dir, gzip: true, preservePaths: true }, ['ok.txt', 'link', '../outside.txt']);
    const bytes = new Uint8Array(await readFile(archive));
    const { createHash } = await import('node:crypto');
    vfs.files.push({
      file_id: 'evil1', bucket_id: 'ci', name: 'evil-1001.tgz', size: bytes.length,
      file_hash: createHash('sha256').update(bytes).digest('hex'),
      metadata: { vfs_artifact: { schema: 1, name: 'evil', repository: 'acme/web', run_id: '1001', run_attempt: 1, format: 'tar+gzip', files: 3, bytes: 0 } },
      created_at: new Date().toISOString(), logicalKey: 'artifacts/acme/web/1001/evil', bytes,
    });
    inputs({ ...connection, name: 'evil', path: 'safe' });
    await expect(downloadArtifact()).rejects.toThrow(/outside|\.\./i);
    expect(await readFile(path.join(workspace, 'outside.txt'), 'utf8')).toBe('outside');
    await expect(stat(path.join(workspace, 'safe/link'))).rejects.toThrow();
    await expect(stat(path.join(workspace, 'outside.txt.1'))).rejects.toThrow();
  });
});

describe('artifacts larger than the server upload limit', () => {
  const LIMIT = 20_000;

  async function uploadBig(name: string, content: Buffer, extra: Record<string, string> = {}) {
    await writeFile(path.join(workspace, `${name}.bin`), content);
    inputs({ ...connection, name, path: `${name}.bin`, 'compression-level': '0', ...extra });
    return uploadArtifact({ retryDelayMs: 1 });
  }

  async function restored(name: string, dir: string, extra: Record<string, string> = {}) {
    inputs({ ...connection, name, path: dir, ...extra });
    await downloadArtifact({ retryDelayMs: 1 });
    return readFile(path.join(workspace, dir, `${name}.bin`));
  }

  it('splits the archive into parts under the limit and reassembles it', async () => {
    vfs.limit = LIMIT;
    const content = randomBytes(60_000);
    const uploaded = await uploadBig('big', content);

    expect(uploaded!.parts).toBeGreaterThan(1);
    expect(uploaded!.artifactUrl).toBe('');
    expect(uploaded!.artifactId).toBe(vfs.files.find((f) => f.name.endsWith('.part0001'))!.file_id);
    expect(vfs.files).toHaveLength(uploaded!.parts);
    for (const file of vfs.files) expect(file.size).toBeLessThanOrEqual(LIMIT);
    expect(vfs.files.map((f) => f.logicalKey).sort()[0]).toBe('artifacts/acme/web/1001/big/part-0001');

    expect(Buffer.compare(await restored('big', 'out'), content)).toBe(0);
  });

  it('uploads small artifacts as a single object even when the server has a limit', async () => {
    vfs.limit = LIMIT;
    const uploaded = await uploadBig('small', randomBytes(2_000));
    expect(uploaded!.parts).toBe(1);
    expect(uploaded!.artifactUrl).toContain('/v/ci/');
    expect(vfs.files).toHaveLength(1);
  });

  it('keeps parts with identical bytes distinct on a deduplicating server', async () => {
    vfs.limit = LIMIT;
    vfs.dedupe = true;
    const content = Buffer.alloc(90_000);
    const uploaded = await uploadBig('zeros', content);
    expect(uploaded!.parts).toBeGreaterThan(3);
    expect(new Set(vfs.files.map((f) => f.file_id)).size).toBe(uploaded!.parts);
    expect(Buffer.compare(await restored('zeros', 'out'), content)).toBe(0);
  });

  it('removes parts left over when a smaller upload replaces a larger one, and the reverse', async () => {
    vfs.limit = LIMIT;
    const large = randomBytes(60_000);
    await uploadBig('flip', large, { overwrite: 'true' });
    expect(vfs.files.length).toBeGreaterThan(1);

    const small = randomBytes(1_500);
    await uploadBig('flip', small, { overwrite: 'true' });
    expect(vfs.files).toHaveLength(1);
    expect(Buffer.compare(await restored('flip', 'one'), small)).toBe(0);

    const medium = randomBytes(30_000);
    const again = await uploadBig('flip', medium, { overwrite: 'true' });
    expect(vfs.files).toHaveLength(again!.parts);
    expect(vfs.files.every((f) => f.name.includes('.part'))).toBe(true);
    expect(Buffer.compare(await restored('flip', 'two'), medium)).toBe(0);
  });

  it('removes the parts it stored when a later part fails', async () => {
    vfs.limit = LIMIT;
    vfs.failPutsAfter = 1;
    await expect(uploadBig('doomed', randomBytes(60_000))).rejects.toThrow('storage unavailable');
    expect(vfs.files).toHaveLength(0);
  });

  it('fails before sending anything when the bucket cannot hold every part', async () => {
    vfs.limit = LIMIT;
    vfs.remainingFiles = 1;
    await expect(uploadBig('crowded', randomBytes(60_000))).rejects.toThrow('room for 1 more file');
    expect(vfs.puts).toBe(0);

    vfs.remainingFiles = undefined;
    vfs.remainingBytes = 1000;
    await expect(uploadBig('crowded', randomBytes(60_000))).rejects.toThrow('quota left');
    expect(vfs.puts).toBe(0);
  });

  it('explains a limit too small to split into', async () => {
    vfs.limit = 3_000;
    await expect(uploadBig('tiny-limit', randomBytes(20_000))).rejects.toThrow('too small');
  });

  it('downloads by artifact id and merges with other artifacts', async () => {
    vfs.limit = LIMIT;
    const content = randomBytes(50_000);
    const uploaded = await uploadBig('ided', content);
    expect(Buffer.compare(await restored('ided', 'by-id', { name: '', 'artifact-ids': uploaded!.artifactId }), content)).toBe(0);
  });

  it('treats an artifact with a missing part as not uploaded', async () => {
    vfs.limit = LIMIT;
    const uploaded = await uploadBig('holey', randomBytes(60_000));
    vfs.files = vfs.files.filter((f) => !f.name.endsWith('.part0002'));

    inputs({ ...connection, name: 'holey', path: 'holey-out' });
    await expect(downloadArtifact()).rejects.toThrow('Unable to find an artifact named "holey"');
    inputs({ ...connection, 'artifact-ids': uploaded!.artifactId, path: 'holey-out' });
    await expect(downloadArtifact()).rejects.toThrow('incomplete');
  });

  it('detects a corrupted part', async () => {
    vfs.limit = LIMIT;
    await uploadBig('rotten', randomBytes(60_000));
    const part = vfs.files.find((f) => f.name.endsWith('.part0002'))!;
    const damaged = part.bytes.slice();
    damaged[10_000] ^= 0xff;
    part.bytes = damaged;
    inputs({ ...connection, name: 'rotten', path: 'rotten-out' });
    await expect(downloadArtifact({ retryDelayMs: 1 })).rejects.toThrow(/Checksum mismatch for part 2\//);
  });

  it('refuses parts that were swapped around', async () => {
    vfs.limit = LIMIT;
    await uploadBig('shuffled', randomBytes(60_000));
    const two = vfs.files.find((f) => f.name.endsWith('.part0002'))!;
    const three = vfs.files.find((f) => f.name.endsWith('.part0003'))!;
    [two.bytes, three.bytes] = [three.bytes, two.bytes];
    inputs({ ...connection, name: 'shuffled', path: 'shuffled-out' });
    await expect(downloadArtifact({ retryDelayMs: 1 })).rejects.toThrow('does not belong to this artifact');
  });
});

describe('fast and reliable part uploads', () => {
  const FAST = { retryDelayMs: 1, recoveryWaitMs: 400, recoveryPollMs: 5 };

  async function send(name: string, content: Buffer, options = {}, extra: Record<string, string> = {}) {
    await writeFile(path.join(workspace, `${name}.bin`), content);
    inputs({ ...connection, name, path: `${name}.bin`, 'compression-level': '0', ...extra });
    return uploadArtifact({ ...FAST, partSizeBytes: 12_000, ...options });
  }

  async function restore(name: string, dir: string) {
    inputs({ ...connection, name, path: dir });
    await downloadArtifact({ retryDelayMs: 1 });
    return readFile(path.join(workspace, dir, `${name}.bin`));
  }

  it('splits by part size even when the server would accept one request', async () => {
    const content = randomBytes(60_000);
    const uploaded = await send('sized', content);
    expect(vfs.limit).toBe(0);
    expect(uploaded!.parts).toBeGreaterThan(4);
    for (const file of vfs.files) expect(file.size).toBeLessThanOrEqual(12_000);
    expect(Buffer.compare(await restore('sized', 'out'), content)).toBe(0);
  });

  it('uploads parts side by side without exceeding the concurrency setting', async () => {
    vfs.putDelayMs = 15;
    await send('parallel', randomBytes(80_000), {}, { 'upload-concurrency': '3' });
    expect(vfs.maxConcurrentPuts).toBeGreaterThan(1);
    expect(vfs.maxConcurrentPuts).toBeLessThanOrEqual(3);

    vfs.maxConcurrentPuts = 0;
    await send('serial', randomBytes(40_000), {}, { 'upload-concurrency': '1' });
    expect(vfs.maxConcurrentPuts).toBe(1);
  });

  it('does not resend a part that a gateway timeout still let the server store', async () => {
    vfs.faults = ['store-then-524'];
    const content = randomBytes(60_000);
    const uploaded = await send('late', content);
    expect(vfs.putRequests).toBe(uploaded!.parts);
    expect(vfs.files).toHaveLength(uploaded!.parts);
    expect(Buffer.compare(await restore('late', 'out'), content)).toBe(0);
  });

  it('resends a part the server never stored after a gateway timeout', async () => {
    vfs.faults = ['524', '502'];
    const content = randomBytes(60_000);
    const uploaded = await send('lost', content, { recoveryWaitMs: 30 });
    expect(vfs.putRequests).toBe(uploaded!.parts + 2);
    expect(Buffer.compare(await restore('lost', 'out'), content)).toBe(0);
  });

  it('resends at once when the origin was unreachable, since the request never arrived', async () => {
    vfs.faults = ['522'];
    const uploaded = await send('unreachable', randomBytes(30_000), { recoveryWaitMs: 60_000 });
    expect(vfs.putRequests).toBe(uploaded!.parts + 1);
  });

  it('reports a persistent gateway timeout in one line and leaves nothing behind', async () => {
    vfs.faults = ['524', '524', '524', '524'];
    let message = '';
    try {
      await send('dead', randomBytes(60_000), { recoveryWaitMs: 20 }, { 'upload-concurrency': '1' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('part 1/');
    expect(message).toContain('after 4 attempts');
    expect(message).toContain('HTTP 524');
    expect(message).not.toContain('<');
    expect(vfs.files).toHaveLength(0);
  });

  it('refuses to finish when a stored part has gone missing', async () => {
    vfs.afterPut = (file) => {
      if ((file.metadata.vfs_artifact as { parts?: { index: number } }).parts?.index === 2) vfs.files = vfs.files.filter((f) => f !== file);
    };
    await expect(send('vanished', randomBytes(60_000))).rejects.toThrow('Verification failed');
    expect(vfs.files).toHaveLength(0);
  });
});
