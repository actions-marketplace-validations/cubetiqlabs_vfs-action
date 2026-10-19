import type { AttachmentResponse, VFSClient } from '@cubis/vfsclient';

export const METADATA_KEY = 'vfs_artifact';
export const ARCHIVE_EXTENSION = '.tgz';
export const ARCHIVE_CONTENT_TYPE = 'application/gzip';
export const MANIFEST_ENTRY = '.vfs-artifact.json';

const MAX_NAME_LENGTH = 200;
const LIST_PAGE_SIZE = 1000;
const LIST_MAX_PAGES = 100;

// Present only when an archive was too large for one request and was stored as several objects.
export interface PartInfo {
  index: number;
  total: number;
  archive_size: number;
  archive_sha256: string;
}

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
  parts?: PartInfo;
}

export interface ArtifactPart {
  id: string;
  index: number;
  // Stored size, which includes the part header when the artifact is framed.
  size: number;
  digest?: string;
}

// One logical artifact. `size` and `digest` always describe the whole archive, whether it
// was stored as one object or as several parts.
export interface ArtifactRecord {
  id: string;
  name: string;
  size: number;
  digest?: string;
  createdAt: string;
  metadata: ArtifactMetadata;
  parts: ArtifactPart[];
  framed: boolean;
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
  if (meta.parts !== undefined) {
    const p = meta.parts;
    const valid =
      p && Number.isInteger(p.index) && Number.isInteger(p.total) && p.index >= 1 && p.index <= p.total &&
      Number.isInteger(p.archive_size) && p.archive_size > 0 && /^[0-9a-f]{64}$/.test(String(p.archive_sha256));
    if (!valid) return undefined;
  }
  return meta as ArtifactMetadata;
}

export function partName(name: string, runId: string, index: number): string {
  return `${storedName(name, runId)}.part${String(index).padStart(4, '0')}`;
}

export function partKey(scope: RunScope, name: string, index: number): string {
  return `${logicalKey(scope, name)}/part-${String(index).padStart(4, '0')}`;
}

// Every part starts with a fixed-size header naming the artifact, run, attempt and part.
// Besides making a part self-describing, it keeps the bytes of every part distinct, so a server
// that deduplicates by content hash cannot mistake two identical slices for one object.
export const PART_HEADER_SIZE = 4096;

export interface PartHeader {
  repository: string;
  run_id: string;
  run_attempt: number;
  name: string;
  index: number;
  total: number;
}

export function encodePartHeader(header: PartHeader): Buffer {
  const json = Buffer.from(JSON.stringify({ vfs: 'artifact-part', v: 1, ...header }));
  if (json.length >= PART_HEADER_SIZE) throw new Error('Artifact part header is too large');
  const out = Buffer.alloc(PART_HEADER_SIZE, 0x20);
  json.copy(out);
  out[PART_HEADER_SIZE - 1] = 0x0a;
  return out;
}

export function decodePartHeader(bytes: Buffer): PartHeader | undefined {
  if (bytes.length !== PART_HEADER_SIZE || bytes[PART_HEADER_SIZE - 1] !== 0x0a) return undefined;
  try {
    const parsed = JSON.parse(bytes.subarray(0, PART_HEADER_SIZE - 1).toString('utf8'));
    if (parsed?.vfs !== 'artifact-part' || parsed.v !== 1) return undefined;
    return parsed as PartHeader;
  } catch {
    return undefined;
  }
}

function newest(files: AttachmentResponse[]): string {
  return files.map((f) => f.created_at).sort().at(-1) || '';
}

// Turns stored objects into artifacts. A multi-part artifact only exists once every one of its
// parts has been stored, so a half-finished upload is invisible rather than corrupt.
export function groupArtifacts(files: AttachmentResponse[]): ArtifactRecord[] {
  const candidates: ArtifactRecord[] = [];
  const groups = new Map<string, AttachmentResponse[]>();

  for (const file of files) {
    const meta = artifactMetadata(file);
    if (!meta) continue;
    if (!meta.parts) {
      candidates.push({
        id: file.file_id,
        name: meta.name,
        size: file.size,
        digest: digestOf(file.file_hash),
        createdAt: file.created_at,
        metadata: meta,
        parts: [{ id: file.file_id, index: 1, size: file.size, digest: digestOf(file.file_hash) }],
        framed: false,
      });
      continue;
    }
    const key = [meta.repository, meta.run_id, meta.name, meta.run_attempt, meta.parts.archive_sha256, meta.parts.total].join('|');
    groups.set(key, [...(groups.get(key) || []), file]);
  }

  for (const members of groups.values()) {
    const meta = artifactMetadata(members[0])!;
    const byIndex = new Map<number, AttachmentResponse>();
    for (const member of members) {
      const index = artifactMetadata(member)!.parts!.index;
      const current = byIndex.get(index);
      if (!current || member.created_at > current.created_at) byIndex.set(index, member);
    }
    if (byIndex.size !== meta.parts!.total) continue;
    const ordered = [...byIndex.entries()].sort((a, b) => a[0] - b[0]);
    if (ordered.some(([index], i) => index !== i + 1)) continue;
    candidates.push({
      id: ordered[0][1].file_id,
      name: meta.name,
      size: meta.parts!.archive_size,
      digest: digestOf(meta.parts!.archive_sha256),
      createdAt: newest(members),
      metadata: meta,
      parts: ordered.map(([index, file]) => ({ id: file.file_id, index, size: file.size, digest: digestOf(file.file_hash) })),
      framed: true,
    });
  }

  // When a name has more than one candidate (an upload interrupted between replacing and
  // cleaning up) the latest attempt wins.
  const best = new Map<string, ArtifactRecord>();
  for (const record of candidates) {
    const current = best.get(record.name);
    const better =
      !current ||
      record.metadata.run_attempt > current.metadata.run_attempt ||
      (record.metadata.run_attempt === current.metadata.run_attempt && record.createdAt > current.createdAt);
    if (better) best.set(record.name, record);
  }
  return [...best.values()];
}

// Lists the stored objects that belong to a run's artifacts. `name` narrows the server-side
// search; repository, run and name are always re-checked against the stored metadata because
// the search is a substring match.
export async function listArtifactFiles(client: VFSClient, bucket: string, scope: RunScope, name?: string): Promise<AttachmentResponse[]> {
  const q = name ? storedName(name, scope.runId) : `-${scope.runId}${ARCHIVE_EXTENSION}`;
  const found: AttachmentResponse[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const res = await client.http.get<AttachmentResponse[]>('/api/upload', {
      params: { bucket_id: bucket, q, page, limit: LIST_PAGE_SIZE, sort: '-created_at' },
    });
    const items = Array.isArray(res.data) ? res.data : [];
    for (const item of items) {
      const m = artifactMetadata(item);
      if (m && m.repository === scope.repository && m.run_id === scope.runId && (name === undefined || m.name === name)) {
        found.push(item);
      }
    }
    if (items.length < LIST_PAGE_SIZE) break;
  }
  return found;
}

export async function listArtifacts(client: VFSClient, bucket: string, scope: RunScope, name?: string): Promise<ArtifactRecord[]> {
  return groupArtifacts(await listArtifactFiles(client, bucket, scope, name));
}
