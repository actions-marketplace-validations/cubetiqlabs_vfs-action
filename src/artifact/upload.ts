import * as core from '@actions/core';
import { VFSError, executePreflight, type AttachmentResponse, type VFSClient } from '@cubis/vfsclient';
import * as tar from 'tar';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient, readConnection, type Connection } from '../connection';
import { runPool, type Pool } from './pool';
import {
  ARCHIVE_CONTENT_TYPE,
  MANIFEST_ENTRY,
  METADATA_KEY,
  PART_HEADER_SIZE,
  artifactMetadata,
  describeFailure,
  digestOf,
  encodePartHeader,
  formatBytes,
  groupArtifacts,
  listArtifactFiles,
  listArtifacts,
  logicalKey,
  partKey,
  partName,
  resolveScope,
  storedName,
  validateArtifactName,
  type ArtifactMetadata,
  type RunScope,
} from './common';
import { findFilesToUpload } from './search';

export interface UploadOptions {
  retryDelayMs?: number;
  // Test hooks: a part size below the 1 MiB the input allows, and how long to wait for a part
  // that a gateway timeout may still have stored.
  partSizeBytes?: number;
  recoveryWaitMs?: number;
  recoveryPollMs?: number;
}

export interface UploadResult {
  artifactId: string;
  // Empty when the artifact is stored in several parts: no single URL serves the archive.
  artifactUrl: string;
  artifactDigest: string;
  name: string;
  files: number;
  size: number;
  parts: number;
}

type NoFilesPolicy = 'warn' | 'error' | 'ignore';

const MAX_UPLOAD_ATTEMPTS = 4;
const MAX_RETENTION_DAYS = 3650;
const MIB = 1024 * 1024;
// Small requests finish well inside the 100 second limit of a proxy such as Cloudflare, retry
// cheaply, and upload side by side. An archive bigger than one part is split, even when the
// server would take it in a single request.
const DEFAULT_PART_MIB = 16;
const MAX_PART_MIB = 100;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;
const MAX_PARTS = 10_000;
// How long to wait for a part that a gateway timeout may still have stored, polling less often as it goes.
const RECOVERY_WAIT_MS = 120_000;
const RECOVERY_POLL_MS = 2_000;
const RECOVERY_POLL_MAX_MS = 10_000;
// A request is given at least this long, or enough for a connection of 256 KiB/s.
const MIN_REQUEST_TIMEOUT_MS = 120_000;
const SLOWEST_BYTES_PER_SECOND = 256 * 1024;

function parseIntegerInput(name: string, fallback: number, min: number, max: number): number {
  const raw = core.getInput(name).trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function booleanInput(name: string): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

function noFilesPolicy(): NoFilesPolicy {
  const raw = (core.getInput('if-no-files-found').trim() || 'warn').toLowerCase();
  if (raw !== 'warn' && raw !== 'error' && raw !== 'ignore') {
    throw new Error(`if-no-files-found must be one of warn, error or ignore (got "${raw}")`);
  }
  return raw;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// The manifest goes first in the archive. It names the repository, run, attempt and artifact, so
// two artifacts never share bytes even when their files are identical. A server that
// deduplicates by content hash would otherwise answer one artifact's upload with another's record.
async function createArchive(root: string, entries: string[], manifest: string, destination: string, level: number): Promise<void> {
  const pack = new tar.Pack({
    cwd: root,
    portable: true,
    follow: true,
    noDirRecurse: true,
    preservePaths: true,
    gzip: { level },
    onWriteEntry: (entry) => {
      if (entry.absolute === manifest) entry.path = MANIFEST_ENTRY;
    },
  });
  pack.add(manifest);
  for (const entry of entries) pack.add(entry);
  pack.end();
  await pipeline(pack as unknown as NodeJS.ReadableStream, createWriteStream(destination));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function statusOf(error: unknown): number {
  return error instanceof VFSError ? error.status : -1;
}

// Worth sending again: the connection dropped, the server or a proxy in front of it was
// overloaded, or the request timed out.
function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

// How long to wait for a request whose answer never came, by what the failure says about whether
// the origin got it. A gateway that timed out waiting (504, 524) or our own timeout means the origin
// was reached and is probably still working. A dropped connection or a 502 could be either, so
// give it a moment. When the origin was down or unreachable (521-523) the request never arrived.
const SHORT_RECOVERY_MS = 10_000;
function recoveryWindow(error: unknown, full: number): number {
  const status = statusOf(error);
  if (status === 504 || status === 524) return full;
  if (status === 0) return error instanceof Error && /timed out/i.test(error.message) ? full : Math.min(full, SHORT_RECOVERY_MS);
  if (status === 408 || status === 502 || status === 520) return Math.min(full, SHORT_RECOVERY_MS);
  return 0;
}

function isGatewayTimeout(error: unknown): boolean {
  const status = statusOf(error);
  return status === 0 || status === 408 || status === 504 || (status >= 522 && status <= 524);
}

function describe(error: unknown): string {
  if (error instanceof VFSError) return describeFailure(error.status, error.message);
  return error instanceof Error ? error.message : String(error);
}

interface Target {
  key: string;
  filename: string;
  hash: string;
  size: number;
  contentType: string;
  metadata: ArtifactMetadata;
  uploadToken?: string;
  body: () => Readable;
  label: string;
}

interface Context {
  client: VFSClient;
  connection: Connection;
  scope: RunScope;
  name: string;
  runAttempt: number;
  retentionDays: number;
  retryDelayMs: number;
  recoveryWaitMs: number;
  recoveryPollMs: number;
}

function check(uploaded: AttachmentResponse, t: Target): AttachmentResponse {
  const stored = artifactMetadata(uploaded);
  if (
    !uploaded.file_id ||
    stored?.run_id !== t.metadata.run_id ||
    stored.repository !== t.metadata.repository ||
    stored.name !== t.metadata.name ||
    stored.parts?.index !== t.metadata.parts?.index
  ) {
    throw new Error('The VFS server answered with a different stored object than the one that was uploaded');
  }
  if (uploaded.file_hash && uploaded.file_hash.toLowerCase() !== t.hash) {
    throw new Error('The VFS server stored different bytes than were uploaded (checksum mismatch)');
  }
  return uploaded;
}

async function sendOnce(ctx: Context, t: Target, signal?: AbortSignal): Promise<AttachmentResponse> {
  const query = new URLSearchParams({
    filename: t.filename,
    file_hash: t.hash,
    metadata: JSON.stringify({ [METADATA_KEY]: t.metadata }),
  });
  if (ctx.retentionDays > 0) query.set('exp', `${ctx.retentionDays * 24}h`);
  if (t.uploadToken) query.set('upload_token', t.uploadToken);
  const url = `/api/upload/${encodeURIComponent(ctx.connection.bucket)}/${t.key}?${query}`;
  const body = Readable.toWeb(t.body()) as unknown as ReadableStream<Uint8Array>;
  const res = await ctx.client.http.put<AttachmentResponse>(url, body as BodyInit, {
    headers: { 'Content-Type': t.contentType },
    timeout: Math.max(MIN_REQUEST_TIMEOUT_MS, Math.ceil(t.size / SLOWEST_BYTES_PER_SECOND) * 1000),
    signal,
  });
  return check(res.data, t);
}

// Looks for the object a timed-out request may have left behind: same artifact, attempt, part
// and, above all, the same bytes.
async function findStored(ctx: Context, t: Target): Promise<AttachmentResponse | undefined> {
  const files = await listArtifactFiles(ctx.client, ctx.connection.bucket, ctx.scope, ctx.name);
  return files.find((file) => {
    const m = artifactMetadata(file);
    return (
      m !== undefined &&
      m.run_attempt === ctx.runAttempt &&
      m.parts?.index === t.metadata.parts?.index &&
      m.parts?.archive_sha256 === t.metadata.parts?.archive_sha256 &&
      file.file_hash?.toLowerCase() === t.hash
    );
  });
}

// After a gateway gives up, the origin is often still working and finishes the upload a little
// later. Sending the same bytes again would only race it, so wait for the object to appear.
async function waitForStored(ctx: Context, t: Target, windowMs: number, signal?: AbortSignal): Promise<AttachmentResponse | undefined> {
  const deadline = Date.now() + windowMs;
  let poll = ctx.recoveryPollMs;
  while (Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
    try {
      const found = await findStored(ctx, t);
      if (found) return check(found, t);
    } catch {
      // The server may be busy; keep waiting until the deadline.
    }
    poll = Math.min(poll * 1.5, RECOVERY_POLL_MAX_MS);
  }
  return undefined;
}

async function uploadObject(ctx: Context, t: Target, pool?: Pool): Promise<AttachmentResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendOnce(ctx, t, pool?.signal);
    } catch (error) {
      if (pool?.signal.aborted) throw error;
      if (!isRetryable(error) || attempt >= MAX_UPLOAD_ATTEMPTS) {
        throw error instanceof Error && !(error instanceof VFSError)
          ? error
          : new Error(`Upload of ${t.label} failed after ${attempt} attempt${attempt > 1 ? 's' : ''}: ${describe(error)}`);
      }
      core.warning(`Upload of ${t.label} failed on attempt ${attempt} (${describe(error)})`);
      if (pool && isGatewayTimeout(error)) {
        core.warning('The server is slow to answer, so the remaining parts will upload one at a time');
        pool.limit(1);
      }
      const windowMs = recoveryWindow(error, ctx.recoveryWaitMs);
      if (windowMs > 0) {
        const found = await waitForStored(ctx, t, windowMs, pool?.signal);
        if (found) {
          core.info(`${t.label} was stored despite the failed response; continuing`);
          return found;
        }
      }
      await sleep(ctx.retryDelayMs * 2 ** (attempt - 1));
    }
  }
}

// Hashes the part header plus one slice of the archive without holding the slice in memory.
async function hashPart(archive: string, header: Buffer, start: number, end: number): Promise<string> {
  const hash = createHash('sha256').update(header);
  for await (const chunk of createReadStream(archive, { start, end })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function partBody(archive: string, header: Buffer, start: number, end: number): Readable {
  return Readable.from(
    (async function* () {
      yield header;
      for await (const chunk of createReadStream(archive, { start, end })) yield chunk as Buffer;
    })(),
  );
}

// Removes objects of this artifact that the upload just replaced or orphaned: a smaller archive
// than the previous attempt's leaves its last parts behind, and switching between one object
// and several leaves the other form behind.
async function removeStale(client: VFSClient, bucket: string, scope: RunScope, name: string, keep: Set<string>): Promise<void> {
  const stale = (await listArtifactFiles(client, bucket, scope, name)).filter((file) => !keep.has(file.file_id));
  for (const file of stale) {
    try {
      await client.deleteFile(bucket, file.file_id);
    } catch (error) {
      core.warning(`Could not remove a superseded object (${file.file_id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Reads the artifact back and confirms every object is there with the size and checksum that was
// sent, so an upload only counts as done once it can be downloaded complete.
async function verifyStored(
  ctx: Context,
  stored: AttachmentResponse[],
  expected: Array<{ size: number; digest: string }>,
  archiveSize: number,
  archiveHash: string,
): Promise<void> {
  const records = await listArtifactsOf(ctx);
  const record = records.find((r) => r.metadata.run_attempt === ctx.runAttempt && r.parts.length === expected.length);
  if (!record) throw new Error(`Verification failed: "${ctx.name}" is not fully stored on the server`);
  if (record.size !== archiveSize || record.digest !== digestOf(archiveHash)) {
    throw new Error(`Verification failed: the server holds a different archive for "${ctx.name}"`);
  }
  record.parts.forEach((part, i) => {
    if (part.id !== stored[i].file_id || part.size !== expected[i].size || part.digest !== digestOf(expected[i].digest)) {
      throw new Error(`Verification failed: part ${i + 1} of "${ctx.name}" does not match what was uploaded`);
    }
  });
}

async function listArtifactsOf(ctx: Context) {
  return groupArtifacts(await listArtifactFiles(ctx.client, ctx.connection.bucket, ctx.scope, ctx.name));
}

// Deletes the parts this attempt left behind after a failure. Requests that were aborted may still
// finish on the server, so everything stored under this attempt is removed, not only what was acknowledged.
async function sweep(ctx: Context): Promise<void> {
  try {
    const files = await listArtifactFiles(ctx.client, ctx.connection.bucket, ctx.scope, ctx.name);
    for (const file of files) {
      const m = artifactMetadata(file);
      if (m?.parts && m.run_attempt === ctx.runAttempt) {
        await ctx.client.deleteFile(ctx.connection.bucket, file.file_id).catch(() => undefined);
      }
    }
  } catch {
    // Cleanup is best effort: the original error is the one worth reporting.
  }
}

export async function uploadArtifact(options: UploadOptions = {}): Promise<UploadResult | undefined> {
  const name = validateArtifactName(core.getInput('name') || 'artifact');
  const patterns = core.getMultilineInput('path');
  if (patterns.every((line) => !line.trim())) {
    throw new Error('The "path" input is required: list one or more files, directories or glob patterns');
  }
  const policy = noFilesPolicy();
  const retentionDays = parseIntegerInput('retention-days', 0, 0, MAX_RETENTION_DAYS);
  const level = parseIntegerInput('compression-level', 6, 0, 9);
  const overwrite = booleanInput('overwrite');
  const includeHidden = booleanInput('include-hidden-files');
  const partBytes = options.partSizeBytes ?? parseIntegerInput('part-size-mb', DEFAULT_PART_MIB, 1, MAX_PART_MIB) * MIB;
  const concurrency = parseIntegerInput('upload-concurrency', DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);

  const connection = readConnection();
  const scope = resolveScope(process.env.GITHUB_REPOSITORY || '', process.env.GITHUB_RUN_ID || '');
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT) || 1;
  const workspace = await fs.realpath(path.resolve(process.env.GITHUB_WORKSPACE || process.cwd()));

  const found = await findFilesToUpload(patterns, workspace, includeHidden);
  if (found.files.length === 0) {
    const message = `No files were found with the provided path: ${patterns.map((p) => p.trim()).filter(Boolean).join(', ')}. No artifact will be uploaded.`;
    if (policy === 'error') throw new Error(message);
    if (policy === 'warn') core.warning(message);
    else core.info(message);
    return undefined;
  }
  core.info(`With the provided path, there will be ${found.files.length} file(s) uploaded`);
  core.info(`Artifact root directory: ${found.rootDirectory}`);

  const client = createClient(connection);

  if (overwrite) {
    core.info(`An artifact named "${name}" will be replaced if this run already has one`);
  } else {
    const [existing] = await listArtifacts(client, connection.bucket, scope, name);
    if (existing) {
      if (existing.metadata.run_attempt >= runAttempt) {
        throw new Error(
          `An artifact named "${name}" already exists for run ${scope.runId}. Give each job a unique name (for example "${name}-\${{ matrix.os }}") or set overwrite: true to replace it.`,
        );
      }
      core.info(`Replacing "${name}" from run attempt ${existing.metadata.run_attempt}`);
    }
  }

  const tempDir = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'vfs-artifact-'));
  try {
    const archive = path.join(tempDir, 'artifact.tgz');
    const manifest = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifest, JSON.stringify({ schema: 1, name, repository: scope.repository, run_id: scope.runId, run_attempt: runAttempt }));
    await fs.utimes(manifest, 0, 0);
    await createArchive(found.rootDirectory, found.entries, manifest, archive, level);
    const size = (await fs.stat(archive)).size;
    const hash = await sha256File(archive);
    core.info(`Archived ${found.files.length} file(s), ${formatBytes(found.bytes)} → ${formatBytes(size)} (gzip level ${level})`);

    const baseMetadata: ArtifactMetadata = {
      schema: 1,
      name,
      repository: scope.repository,
      run_id: scope.runId,
      run_attempt: runAttempt,
      format: 'tar+gzip',
      files: found.files.length,
      bytes: found.bytes,
      ...(process.env.GITHUB_WORKFLOW ? { workflow: process.env.GITHUB_WORKFLOW } : {}),
      ...(process.env.GITHUB_JOB ? { job: process.env.GITHUB_JOB } : {}),
      ...(process.env.GITHUB_REF ? { ref: process.env.GITHUB_REF } : {}),
      ...(process.env.GITHUB_SHA ? { sha: process.env.GITHUB_SHA } : {}),
    };

    const preflight = await executePreflight(client.http, {
      bucket_id: connection.bucket,
      name: storedName(name, scope.runId),
      size,
      content_type: ARCHIVE_CONTENT_TYPE,
      file_hash: hash,
    });
    // preflight.duplicate is ignored on purpose: reusing another object would leave this
    // artifact name unrecorded.
    const limit = preflight.max_upload_bytes || 0;
    const overLimit = limit > 0 && size > limit;
    if (!preflight.allowed && !overLimit) {
      throw new Error(`The VFS server rejected the upload: ${preflight.reason || 'not allowed'}`);
    }

    const started = Date.now();
    const ctx: Context = {
      client,
      connection,
      scope,
      name,
      runAttempt,
      retentionDays,
      retryDelayMs: options.retryDelayMs ?? 1000,
      recoveryWaitMs: options.recoveryWaitMs ?? RECOVERY_WAIT_MS,
      recoveryPollMs: options.recoveryPollMs ?? RECOVERY_POLL_MS,
    };
    const partLimit = limit > 0 ? Math.min(limit, partBytes) : partBytes;
    const split = size > partLimit;
    let stored: AttachmentResponse[];
    let expected: Array<{ size: number; digest: string }>;

    if (!split) {
      stored = [
        await uploadObject(ctx, {
          key: logicalKey(scope, name),
          filename: storedName(name, scope.runId),
          hash,
          size,
          contentType: ARCHIVE_CONTENT_TYPE,
          metadata: baseMetadata,
          uploadToken: preflight.upload_token,
          body: () => createReadStream(archive),
          label: `"${name}"`,
        }),
      ];
      expected = [{ size, digest: hash }];
    } else {
      if (partLimit <= PART_HEADER_SIZE) {
        throw new Error(`The part size of ${partLimit} bytes is too small to store an artifact in parts`);
      }
      const payload = partLimit - PART_HEADER_SIZE;
      const total = Math.ceil(size / payload);
      if (total > MAX_PARTS) {
        throw new Error(`The archive would need ${total} parts of ${formatBytes(partLimit)}; raise part-size-mb`);
      }
      core.info(
        `Uploading ${formatBytes(size)} as ${total} parts of up to ${formatBytes(partLimit)}, ${Math.min(concurrency, total)} at a time` +
          (overLimit ? ` (the server's per-upload limit is ${formatBytes(limit)})` : ''),
      );

      const prepare = async (index: number) => {
        const start = (index - 1) * payload;
        const end = Math.min(size, index * payload) - 1;
        const header = encodePartHeader({ repository: scope.repository, run_id: scope.runId, run_attempt: runAttempt, name, index, total });
        return { index, start, end, header, hash: await hashPart(archive, header, start, end), size: PART_HEADER_SIZE + (end - start + 1), filename: partName(name, scope.runId, index) };
      };
      const approve = async (part: Awaited<ReturnType<typeof prepare>>) => {
        const answer = await executePreflight(client.http, {
          bucket_id: connection.bucket,
          name: part.filename,
          size: part.size,
          content_type: 'application/octet-stream',
          file_hash: part.hash,
        });
        if (!answer.allowed) throw new Error(`The VFS server rejected part ${part.index} of ${total}: ${answer.reason || 'not allowed'}`);
        return answer;
      };

      // The first part is checked before anything is sent, so a bucket that cannot hold the whole
      // artifact fails now instead of after most of it has been uploaded.
      const first = await prepare(1);
      const firstAnswer = await approve(first);
      const needed = size + total * PART_HEADER_SIZE;
      if (firstAnswer.remaining_bytes !== undefined && firstAnswer.remaining_bytes < needed) {
        throw new Error(`The bucket has ${formatBytes(firstAnswer.remaining_bytes)} of quota left but this artifact needs ${formatBytes(needed)}`);
      }
      if (firstAnswer.remaining_files !== undefined && firstAnswer.remaining_files < total) {
        throw new Error(`The bucket has room for ${firstAnswer.remaining_files} more file(s) but this artifact is stored as ${total} parts`);
      }

      const sizes: number[] = [];
      const hashes: string[] = [];
      let done = 0;
      try {
        stored = await runPool(total, concurrency, async (index, pool) => {
          const part = index === 1 ? first : await prepare(index);
          const answer = index === 1 ? firstAnswer : await approve(part);
          sizes[index - 1] = part.size;
          hashes[index - 1] = part.hash;
          const began = Date.now();
          const uploaded = await uploadObject(
            ctx,
            {
              key: partKey(scope, name, index),
              filename: part.filename,
              hash: part.hash,
              size: part.size,
              contentType: 'application/octet-stream',
              metadata: { ...baseMetadata, parts: { index, total, archive_size: size, archive_sha256: hash } },
              uploadToken: answer.upload_token,
              body: () => partBody(archive, part.header, part.start, part.end),
              label: `part ${index}/${total}`,
            },
            pool,
          );
          const seconds = Math.max((Date.now() - began) / 1000, 0.001);
          core.info(`Uploaded part ${index}/${total} (${formatBytes(part.size)}, ${formatBytes(part.size / seconds)}/s), ${++done} of ${total} done`);
          return uploaded;
        });
      } catch (error) {
        await sweep(ctx);
        throw error;
      }
      expected = sizes.map((partSize, i) => ({ size: partSize, digest: hashes[i] }));
    }

    try {
      await verifyStored(ctx, stored, expected, size, hash);
    } catch (error) {
      await sweep(ctx);
      throw error;
    }
    await removeStale(client, connection.bucket, scope, name, new Set(stored.map((file) => file.file_id)));

    const single = !split;
    const result: UploadResult = {
      artifactId: stored[0].file_id,
      artifactUrl: single ? `${connection.endpoint}/v/${encodeURIComponent(connection.bucket)}/${encodeURIComponent(stored[0].file_id)}` : '',
      artifactDigest: digestOf(hash)!,
      name,
      files: found.files.length,
      size,
      parts: stored.length,
    };
    core.setOutput('artifact-id', result.artifactId);
    core.setOutput('artifact-url', result.artifactUrl);
    core.setOutput('artifact-digest', result.artifactDigest);
    core.info(
      `Uploaded artifact "${name}" (${formatBytes(size)}${stored.length > 1 ? `, ${stored.length} parts` : ''}) in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        `${retentionDays > 0 ? `, kept for ${retentionDays} day(s)` : ''}`,
    );
    core.info(`Artifact ID: ${result.artifactId}  ${result.artifactDigest}`);
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
