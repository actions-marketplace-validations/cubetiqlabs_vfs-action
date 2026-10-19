import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
