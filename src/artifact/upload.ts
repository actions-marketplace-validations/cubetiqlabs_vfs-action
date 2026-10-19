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
import {
  ARCHIVE_CONTENT_TYPE,
  MANIFEST_ENTRY,
  METADATA_KEY,
  PART_HEADER_SIZE,
  artifactMetadata,
  digestOf,
  encodePartHeader,
  formatBytes,
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

const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_RETENTION_DAYS = 3650;
// Smaller requests retry cheaply and stay under the request limits of proxies and CDNs in front
// of the server, so parts never grow past this even when the server would accept more.
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = 10_000;

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

function isTransient(error: unknown): boolean {
  return error instanceof VFSError && (error.status === 0 || error.status === 429 || error.status >= 500);
}

async function putWithRetry(send: () => Promise<AttachmentResponse>, delayMs: number, label: string): Promise<AttachmentResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= MAX_UPLOAD_ATTEMPTS || !isTransient(error)) throw error;
      const wait = delayMs * 2 ** (attempt - 1);
      core.warning(`Upload of ${label} failed on attempt ${attempt} (${error instanceof Error ? error.message : String(error)}); retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

interface Put {
  key: string;
  filename: string;
  hash: string;
  contentType: string;
  metadata: ArtifactMetadata;
  retentionDays: number;
  uploadToken?: string;
  body: () => Readable;
  label: string;
  retryDelayMs: number;
}

async function put(client: VFSClient, connection: Connection, p: Put): Promise<AttachmentResponse> {
  const query = new URLSearchParams({
    filename: p.filename,
    file_hash: p.hash,
    metadata: JSON.stringify({ [METADATA_KEY]: p.metadata }),
  });
  if (p.retentionDays > 0) query.set('exp', `${p.retentionDays * 24}h`);
  if (p.uploadToken) query.set('upload_token', p.uploadToken);
  const url = `/api/upload/${encodeURIComponent(connection.bucket)}/${p.key}?${query}`;

  const uploaded = await putWithRetry(
    async () => {
      const body = Readable.toWeb(p.body()) as unknown as ReadableStream<Uint8Array>;
      const res = await client.http.put<AttachmentResponse>(url, body as BodyInit, {
        headers: { 'Content-Type': p.contentType },
        timeout: 0,
      });
      return res.data;
    },
    p.retryDelayMs,
    p.label,
  );

  const stored = artifactMetadata(uploaded);
  const expectedIndex = p.metadata.parts?.index;
  if (
    !uploaded.file_id ||
    stored?.run_id !== p.metadata.run_id ||
    stored.repository !== p.metadata.repository ||
    stored.name !== p.metadata.name ||
    stored.parts?.index !== expectedIndex
  ) {
    throw new Error('The VFS server answered with a different stored object than the one that was uploaded');
  }
  if (uploaded.file_hash && uploaded.file_hash.toLowerCase() !== p.hash) {
    throw new Error('The VFS server stored different bytes than were uploaded (checksum mismatch)');
  }
  return uploaded;
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
    const retryDelayMs = options.retryDelayMs ?? 1000;
    const stored: AttachmentResponse[] = [];

    if (!overLimit) {
      const uploaded = await put(client, connection, {
        key: logicalKey(scope, name),
        filename: storedName(name, scope.runId),
        hash,
        contentType: ARCHIVE_CONTENT_TYPE,
        metadata: baseMetadata,
        retentionDays,
        uploadToken: preflight.upload_token,
        body: () => createReadStream(archive),
        label: `"${name}"`,
        retryDelayMs,
      });
      stored.push(uploaded);
    } else {
      const partLimit = Math.min(limit, MAX_PART_BYTES);
      if (partLimit <= PART_HEADER_SIZE) {
        throw new Error(`The server's upload limit of ${limit} bytes is too small to store an artifact in parts`);
      }
      const payload = partLimit - PART_HEADER_SIZE;
      const total = Math.ceil(size / payload);
      if (total > MAX_PARTS) {
        throw new Error(`The archive would need ${total} parts at the server's ${formatBytes(limit)} upload limit; raise the limit or upload less`);
      }
      core.info(`The archive (${formatBytes(size)}) is over the server's ${formatBytes(limit)} upload limit, so it will be uploaded in ${total} parts`);

      try {
        for (let index = 1; index <= total; index++) {
          const start = (index - 1) * payload;
          const end = Math.min(size, index * payload) - 1;
          const header = encodePartHeader({ repository: scope.repository, run_id: scope.runId, run_attempt: runAttempt, name, index, total });
          const partHash = await hashPart(archive, header, start, end);
          const partSize = PART_HEADER_SIZE + (end - start + 1);
          const filename = partName(name, scope.runId, index);

          const check = await executePreflight(client.http, {
            bucket_id: connection.bucket,
            name: filename,
            size: partSize,
            content_type: 'application/octet-stream',
            file_hash: partHash,
          });
          if (!check.allowed) throw new Error(`The VFS server rejected part ${index} of ${total}: ${check.reason || 'not allowed'}`);
          if (index === 1) {
            const needed = size + total * PART_HEADER_SIZE;
            if (check.remaining_bytes !== undefined && check.remaining_bytes < needed) {
              throw new Error(`The bucket has ${formatBytes(check.remaining_bytes)} of quota left but this artifact needs ${formatBytes(needed)}`);
            }
            if (check.remaining_files !== undefined && check.remaining_files < total) {
              throw new Error(`The bucket has room for ${check.remaining_files} more file(s) but this artifact is stored as ${total} parts`);
            }
          }

          core.info(`Uploading part ${index}/${total} (${formatBytes(partSize)})`);
          stored.push(
            await put(client, connection, {
              key: partKey(scope, name, index),
              filename,
              hash: partHash,
              contentType: 'application/octet-stream',
              metadata: { ...baseMetadata, parts: { index, total, archive_size: size, archive_sha256: hash } },
              retentionDays,
              uploadToken: check.upload_token,
              body: () => partBody(archive, header, start, end),
              label: `part ${index}/${total}`,
              retryDelayMs,
            }),
          );
        }
      } catch (error) {
        // Parts without their siblings are unusable and still count against the bucket.
        for (const part of stored) {
          await client.deleteFile(connection.bucket, part.file_id).catch(() => undefined);
        }
        throw error;
      }
    }

    await removeStale(client, connection.bucket, scope, name, new Set(stored.map((file) => file.file_id)));

    const single = stored.length === 1 && !overLimit;
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
