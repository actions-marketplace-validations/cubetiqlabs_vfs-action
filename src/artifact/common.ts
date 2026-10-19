import type { AttachmentResponse, VFSClient } from '@cubis/vfsclient';

export const METADATA_KEY = 'vfs_artifact';
export const ARCHIVE_EXTENSION = '.tgz';
export const ARCHIVE_CONTENT_TYPE = 'application/gzip';
export const MANIFEST_ENTRY = '.vfs-artifact.json';

const MAX_NAME_LENGTH = 200;
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 100;

export interface ArtifactMetadata {
  schema: 1;
  name: string;
  repository: string;
  run_id: string;
  run_attempt: number;
  format: 'tar+gzip';
  files: number;
  bytes: number;
  workflow?: string;
  job?: string;
  ref?: string;
  sha?: string;
}

export interface ArtifactRecord {
  id: string;
  name: string;
  size: number;
  digest?: string;
  createdAt: string;
  metadata: ArtifactMetadata;
}

export interface RunScope {
  repository: string;
  runId: string;
}

export function validateArtifactName(name: string): string {
  if (!name) throw new Error('Artifact name must not be empty');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Artifact name must be at most ${MAX_NAME_LENGTH} characters`);
  if (/[":<>|*?\\/\r\n]/.test(name) || name === '.' || name === '..') {
    throw new Error(`Artifact name "${name}" contains an invalid character. These are not allowed: " : < > | * ? \\ / and line breaks`);
  }
  return name;
}

export function resolveScope(repository: string, runId: string): RunScope {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`repository must look like "owner/name" (got "${repository}")`);
  }
  if (!/^[0-9]{1,20}$/.test(runId)) {
    throw new Error(`run-id must be a number (got "${runId}")`);
  }
  return { repository, runId };
}

// The server overwrites an object stored under the same key, which makes this the unit
// of "one artifact per name per run" without any server-side artifact concept.
export function logicalKey(scope: RunScope, name: string): string {
  return ['artifacts', ...scope.repository.split('/'), scope.runId, name].map(encodeURIComponent).join('/');
}

// Listing can only search the stored file name, so the run id is part of it. That keeps a
// lookup to one run's files instead of every artifact that ever shared the name.
export function storedName(name: string, runId: string): string {
  return `${name}-${runId}${ARCHIVE_EXTENSION}`;
}

export function digestOf(hash: string | undefined): string | undefined {
  return hash ? `sha256:${hash.toLowerCase()}` : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function artifactMetadata(file: Pick<AttachmentResponse, 'metadata'>): ArtifactMetadata | undefined {
  const meta = file.metadata?.[METADATA_KEY] as Partial<ArtifactMetadata> | undefined;
  if (!meta || typeof meta !== 'object' || meta.schema !== 1) return undefined;
  if (typeof meta.name !== 'string' || typeof meta.repository !== 'string' || typeof meta.run_id !== 'string') return undefined;
  return meta as ArtifactMetadata;
}

export function toRecord(file: AttachmentResponse): ArtifactRecord | undefined {
  const metadata = artifactMetadata(file);
  if (!metadata) return undefined;
  return {
    id: file.file_id,
    name: metadata.name,
    size: file.size,
    digest: digestOf(file.file_hash),
    createdAt: file.created_at,
    metadata,
  };
}

// Finds the artifacts a run produced. `name` narrows the server-side search; the exact
// repository, run and name are always re-checked against the stored metadata because the
// search is a substring match.
export async function listArtifacts(client: VFSClient, bucket: string, scope: RunScope, name?: string): Promise<ArtifactRecord[]> {
  const q = name ? storedName(name, scope.runId) : `-${scope.runId}${ARCHIVE_EXTENSION}`;
  const found: ArtifactRecord[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const res = await client.http.get<AttachmentResponse[]>('/api/upload', {
      params: { bucket_id: bucket, q, page, limit: LIST_PAGE_SIZE, sort: '-created_at' },
    });
    const items = Array.isArray(res.data) ? res.data : [];
    for (const item of items) {
      const record = toRecord(item);
      if (!record) continue;
      const m = record.metadata;
      if (m.repository === scope.repository && m.run_id === scope.runId && (name === undefined || m.name === name)) {
        found.push(record);
      }
    }
    if (items.length < LIST_PAGE_SIZE) break;
  }
  return found;
}
