import * as core from '@actions/core';
import { VFSError, executePreflight, type AttachmentResponse } from '@cubis/vfsclient';
import * as tar from 'tar';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient, readConnection } from '../connection';
import {
  ARCHIVE_CONTENT_TYPE,
  MANIFEST_ENTRY,
  METADATA_KEY,
  artifactMetadata,
  digestOf,
  formatBytes,
  listArtifacts,
  logicalKey,
  resolveScope,
  storedName,
  validateArtifactName,
  type ArtifactMetadata,
} from './common';
import { findFilesToUpload } from './search';

export interface UploadOptions {
  retryDelayMs?: number;
}

export interface UploadResult {
  artifactId: string;
  artifactUrl: string;
  artifactDigest: string;
  name: string;
  files: number;
  size: number;
}

type NoFilesPolicy = 'warn' | 'error' | 'ignore';

const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_RETENTION_DAYS = 3650;

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

async function putWithRetry(
  send: () => Promise<AttachmentResponse>,
  delayMs: number,
): Promise<AttachmentResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= MAX_UPLOAD_ATTEMPTS || !isTransient(error)) throw error;
      const wait = delayMs * 2 ** (attempt - 1);
      core.warning(`Upload attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
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

    const filename = storedName(name, scope.runId);
    const preflight = await executePreflight(client.http, {
      bucket_id: connection.bucket,
      name: filename,
      size,
      content_type: ARCHIVE_CONTENT_TYPE,
      file_hash: hash,
    });
    if (!preflight.allowed) {
      throw new Error(`The VFS server rejected the upload: ${preflight.reason || 'not allowed'}`);
    }
    // preflight.duplicate is ignored on purpose: reusing another object would leave this
    // artifact name unrecorded.

    const metadata: ArtifactMetadata = {
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
    const query = new URLSearchParams({
      filename,
      file_hash: hash,
      metadata: JSON.stringify({ [METADATA_KEY]: metadata }),
    });
    if (retentionDays > 0) query.set('exp', `${retentionDays * 24}h`);
    if (preflight.upload_token) query.set('upload_token', preflight.upload_token);
    const key = `/api/upload/${encodeURIComponent(connection.bucket)}/${logicalKey(scope, name)}?${query}`;

    const started = Date.now();
    const uploaded = await putWithRetry(async () => {
      const body = Readable.toWeb(createReadStream(archive)) as unknown as ReadableStream<Uint8Array>;
      const res = await client.http.put<AttachmentResponse>(key, body as BodyInit, {
        headers: { 'Content-Type': ARCHIVE_CONTENT_TYPE },
        timeout: 0,
      });
      return res.data;
    }, options.retryDelayMs ?? 1000);

    const stored = artifactMetadata(uploaded);
    if (!uploaded.file_id || stored?.run_id !== scope.runId || stored.repository !== scope.repository || stored.name !== name) {
      throw new Error(
        'The VFS server answered with a different stored object than the artifact that was uploaded',
      );
    }
    if (uploaded.file_hash && uploaded.file_hash.toLowerCase() !== hash) {
      throw new Error('The VFS server stored different bytes than were uploaded (checksum mismatch)');
    }

    const result: UploadResult = {
      artifactId: uploaded.file_id,
      artifactUrl: `${connection.endpoint}/v/${encodeURIComponent(connection.bucket)}/${encodeURIComponent(uploaded.file_id)}`,
      artifactDigest: digestOf(hash)!,
      name,
      files: found.files.length,
      size,
    };
    core.setOutput('artifact-id', result.artifactId);
    core.setOutput('artifact-url', result.artifactUrl);
    core.setOutput('artifact-digest', result.artifactDigest);
    core.info(
      `Uploaded artifact "${name}" (${formatBytes(size)}) in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        `${retentionDays > 0 ? `, kept for ${retentionDays} day(s)` : ''}`,
    );
    core.info(`Artifact ID: ${result.artifactId}  ${result.artifactDigest}`);
    return result;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
