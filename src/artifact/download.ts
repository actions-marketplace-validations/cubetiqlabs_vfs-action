import * as core from '@actions/core';
import { VFSError } from '@cubis/vfsclient';
import { minimatch } from 'minimatch';
import * as tar from 'tar';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient, readConnection, type Connection } from '../connection';
import { MANIFEST_ENTRY, formatBytes, listArtifacts, resolveScope, toRecord, type ArtifactRecord } from './common';

export interface DownloadOptions {
  retryDelayMs?: number;
}

export interface DownloadResult {
  downloadPath: string;
  artifacts: string[];
}

const MAX_ATTEMPTS = 3;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 3;

function booleanInput(name: string): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

function splitList(raw: string): string[] {
  return raw.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function expandHome(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2));
  return target;
}

async function openDownload(connection: Connection, fileId: string): Promise<Response> {
  const origin = new URL(connection.endpoint).origin;
  let url = new URL(`${connection.endpoint}/v/${encodeURIComponent(connection.bucket)}/${encodeURIComponent(fileId)}`);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // The API key only ever goes to the VFS origin; a CDN redirect gets a plain request.
    const headers: Record<string, string> = url.origin === origin ? { 'x-api-key': connection.apiKey } : {};
    const res = await fetch(url, { headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      if (url.protocol !== 'https:') throw new VFSError('Refusing to follow a redirect to a non-HTTPS URL', { status: res.status });
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new VFSError(detail || res.statusText || `Download failed with status ${res.status}`, { status: res.status });
    }
    return res;
  }
  throw new VFSError('Too many redirects while downloading the artifact', { status: 0 });
}

async function fetchToFile(connection: Connection, record: ArtifactRecord, destination: string, delayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await openDownload(connection, record.id);
      if (!res.body) throw new VFSError('The VFS server returned an empty response', { status: 0 });
      const hash = createHash('sha256');
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          received += chunk.length;
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(destination));
      if (received !== record.size) {
        throw new Error(`Downloaded ${received} bytes for "${record.name}" but expected ${record.size}`);
      }
      const digest = `sha256:${hash.digest('hex')}`;
      if (record.digest && digest !== record.digest) {
        throw new Error(`Checksum mismatch for "${record.name}": expected ${record.digest}, got ${digest}`);
      }
      return;
    } catch (error) {
      const transient = !(error instanceof VFSError) || error.status === 0 || error.status === 429 || error.status >= 500;
      if (attempt >= MAX_ATTEMPTS || !transient) throw error;
      const wait = delayMs * 2 ** (attempt - 1);
      core.warning(`Download of "${record.name}" failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function extractArtifact(archive: string, destination: string): Promise<number> {
  await fs.mkdir(destination, { recursive: true });
  let skipped = 0;
  await tar.x({
    file: archive,
    cwd: destination,
    strict: true,
    preserveOwner: false,
    filter: (entryPath, info) => {
      if (entryPath === MANIFEST_ENTRY || entryPath === `./${MANIFEST_ENTRY}`) return false;
      const type = (info as { type?: string }).type;
      if (type === 'File' || type === 'OldFile' || type === 'ContiguousFile' || type === 'Directory') return true;
      skipped++;
      return false;
    },
  });
  return skipped;
}

async function resolveArtifacts(connection: Connection, repository: string, runId: string): Promise<{ records: ArtifactRecord[]; single: boolean }> {
  const client = createClient(connection);
  const name = core.getInput('name').trim();
  const ids = splitList(core.getInput('artifact-ids'));
  const patterns = core.getMultilineInput('pattern').map((line) => line.trim()).filter(Boolean);

  if (ids.length > 0) {
    if (name || patterns.length > 0) core.warning('artifact-ids was given, so name and pattern are ignored');
    const records: ArtifactRecord[] = [];
    for (const id of ids) {
      let record: ArtifactRecord | undefined;
      try {
        const file = await client.getFileMetadata(connection.bucket, id);
        record = toRecord(file as never);
      } catch (error) {
        if (error instanceof VFSError && error.status === 404) throw new Error(`Artifact with ID "${id}" was not found in bucket "${connection.bucket}"`);
        throw error;
      }
      if (!record) throw new Error(`"${id}" is not an artifact uploaded by vfs-action`);
      records.push(record);
    }
    return { records, single: records.length === 1 };
  }

  const scope = resolveScope(repository, runId);
  if (name) {
    const [record] = await listArtifacts(client, connection.bucket, scope, name);
    if (!record) {
      const available = (await listArtifacts(client, connection.bucket, scope)).map((a) => a.name).sort();
      throw new Error(
        `Unable to find an artifact named "${name}" for run ${runId} of ${repository}. ` +
          (available.length ? `Available artifacts: ${available.join(', ')}` : 'This run has no artifacts.'),
      );
    }
    return { records: [record], single: true };
  }

  let records = await listArtifacts(client, connection.bucket, scope);
  if (patterns.length > 0) records = records.filter((record) => patterns.some((pattern) => minimatch(record.name, pattern)));
  return { records: records.sort((a, b) => a.name.localeCompare(b.name)), single: false };
}

export async function downloadArtifact(options: DownloadOptions = {}): Promise<DownloadResult> {
  const connection = readConnection();
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const target = path.resolve(workspace, expandHome(core.getInput('path').trim() || '.'));
  const mergeMultiple = booleanInput('merge-multiple');
  const repository = core.getInput('repository').trim() || process.env.GITHUB_REPOSITORY || '';
  const runId = core.getInput('run-id').trim() || process.env.GITHUB_RUN_ID || '';

  const { records, single } = await resolveArtifacts(connection, repository, runId);
  if (records.length === 0) {
    core.warning('No artifacts matched, nothing was downloaded');
    core.setOutput('download-path', target);
    return { downloadPath: target, artifacts: [] };
  }
  core.info(`Found ${records.length} artifact(s): ${records.map((r) => r.name).join(', ')}`);

  const flat = single || mergeMultiple;
  const tempDir = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'vfs-artifact-'));
  try {
    const download = async (record: ArtifactRecord, index: number): Promise<void> => {
      const archive = path.join(tempDir, `${index}.tgz`);
      const destination = flat ? target : path.join(target, record.name);
      const started = Date.now();
      await fetchToFile(connection, record, archive, options.retryDelayMs ?? 1000);
      const skipped = await extractArtifact(archive, destination);
      await fs.rm(archive, { force: true });
      if (skipped > 0) core.warning(`Skipped ${skipped} unsupported entr${skipped === 1 ? 'y' : 'ies'} (links or special files) in "${record.name}"`);
      core.info(`Downloaded "${record.name}" (${formatBytes(record.size)}) to ${destination} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    };

    // Merging must keep a stable order so a later artifact deterministically wins a conflict.
    if (flat) {
      for (const [index, record] of records.entries()) await download(record, index);
    } else {
      const queue = [...records.entries()];
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) await download(next[1], next[0]);
        }),
      );
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  core.setOutput('download-path', target);
  core.info(`Total of ${records.length} artifact(s) downloaded`);
  return { downloadPath: target, artifacts: records.map((r) => r.name) };
}
