import * as core from '@actions/core';
import { VFSError } from '@cubis/vfsclient';
import { minimatch } from 'minimatch';
import * as tar from 'tar';
import { createHash, type Hash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient, readConnection, type Connection } from '../connection';
import {
  MANIFEST_ENTRY,
  PART_HEADER_SIZE,
  artifactMetadata,
  decodePartHeader,
  describeFailure,
  formatBytes,
  groupArtifacts,
  listArtifactFiles,
  listArtifacts,
  resolveScope,
  type ArtifactPart,
  type ArtifactRecord,
} from './common';

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
      throw new VFSError(describeFailure(res.status, detail || res.statusText), { status: res.status });
    }
    return res;
  }
  throw new VFSError('Too many redirects while downloading the artifact', { status: 0 });
}

// Drops the fixed-size header from the front of a part, checking that it belongs to the artifact
// being assembled so parts can never be stitched together out of order or from another upload.
function stripPartHeader(record: ArtifactRecord, part: ArtifactPart): Transform {
  let header = Buffer.alloc(0);
  let stripped = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (stripped) return callback(null, chunk);
      header = Buffer.concat([header, chunk]);
      if (header.length < PART_HEADER_SIZE) return callback();
      const parsed = decodePartHeader(header.subarray(0, PART_HEADER_SIZE));
      const m = record.metadata;
      if (!parsed || parsed.name !== m.name || parsed.repository !== m.repository || parsed.run_id !== m.run_id || parsed.run_attempt !== m.run_attempt || parsed.index !== part.index || parsed.total !== record.parts.length) {
        return callback(new Error(`Part ${part.index} of "${record.name}" does not belong to this artifact`));
      }
      stripped = true;
      const rest = header.subarray(PART_HEADER_SIZE);
      header = Buffer.alloc(0);
      callback(null, rest.length ? rest : undefined);
    },
    flush(callback) {
      callback(stripped ? undefined : new Error(`Part ${part.index} of "${record.name}" is shorter than its header`));
    },
  });
}

// Appends one part's payload to `destination` and returns how many archive bytes it added.
// `archiveHash` is updated as the bytes pass through; the caller passes a copy so a failed
// attempt leaves the running hash untouched.
async function fetchPart(connection: Connection, record: ArtifactRecord, part: ArtifactPart, destination: string, archiveHash: Hash): Promise<number> {
  const res = await openDownload(connection, part.id);
  if (!res.body) throw new VFSError('The VFS server returned an empty response', { status: 0 });
  const partHash = createHash('sha256');
  let stored = 0;
  let payload = 0;
  const countStored = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      partHash.update(chunk);
      stored += chunk.length;
      callback(null, chunk);
    },
  });
  const countPayload = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveHash.update(chunk);
      payload += chunk.length;
      callback(null, chunk);
    },
  });
  const stages: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [Readable.fromWeb(res.body as never), countStored];
  if (record.framed) stages.push(stripPartHeader(record, part));
  stages.push(countPayload, createWriteStream(destination, { flags: 'a' }));
  await pipeline(stages as [NodeJS.ReadableStream, ...Array<NodeJS.ReadWriteStream>, NodeJS.WritableStream]);

  const label = record.framed ? `part ${part.index}/${record.parts.length} of "${record.name}"` : `"${record.name}"`;
  if (stored !== part.size) throw new Error(`Downloaded ${stored} bytes for ${label} but expected ${part.size}`);
  const digest = `sha256:${partHash.digest('hex')}`;
  if (part.digest && digest !== part.digest) throw new Error(`Checksum mismatch for ${label}: expected ${part.digest}, got ${digest}`);
  return payload;
}

async function fetchToFile(connection: Connection, record: ArtifactRecord, destination: string, delayMs: number): Promise<void> {
  await fs.writeFile(destination, '');
  let archiveHash = createHash('sha256');
  let offset = 0;

  for (const part of record.parts) {
    for (let attempt = 1; ; attempt++) {
      const working = archiveHash.copy();
      try {
        await fs.truncate(destination, offset);
        offset += await fetchPart(connection, record, part, destination, working);
        archiveHash = working;
        break;
      } catch (error) {
        const transient = !(error instanceof VFSError) || error.status === 0 || error.status === 429 || error.status >= 500;
        if (attempt >= MAX_ATTEMPTS || !transient) throw error;
        const wait = delayMs * 2 ** (attempt - 1);
        core.warning(`Download of ${record.framed ? `part ${part.index} of ` : ''}"${record.name}" failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  if (offset !== record.size) throw new Error(`Assembled ${offset} bytes for "${record.name}" but expected ${record.size}`);
  const digest = `sha256:${archiveHash.digest('hex')}`;
  if (record.digest && digest !== record.digest) {
    throw new Error(`Checksum mismatch for "${record.name}": expected ${record.digest}, got ${digest}`);
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
      let file;
      try {
        file = await client.getFileMetadata(connection.bucket, id);
      } catch (error) {
        if (error instanceof VFSError && error.status === 404) throw new Error(`Artifact with ID "${id}" was not found in bucket "${connection.bucket}"`);
        throw error;
      }
      const meta = artifactMetadata(file as never);
      if (!meta) throw new Error(`"${id}" is not an artifact uploaded by vfs-action`);
      // A multi-part artifact is only usable as a whole, so find its sibling parts.
      const siblings = meta.parts
        ? await listArtifactFiles(client, connection.bucket, { repository: meta.repository, runId: meta.run_id }, meta.name)
        : [file as never];
      const record = groupArtifacts(siblings).find((candidate) => candidate.parts.some((part) => part.id === id));
      if (!record) throw new Error(`Artifact "${id}" is incomplete: not all of its parts are stored`);
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
      core.info(`Downloaded "${record.name}" (${formatBytes(record.size)}${record.framed ? `, ${record.parts.length} parts` : ''}) to ${destination} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
