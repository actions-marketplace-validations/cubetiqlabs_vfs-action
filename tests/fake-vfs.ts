import { createHash } from 'node:crypto';

export interface StoredFile {
  file_id: string;
  bucket_id: string;
  name: string;
  size: number;
  file_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
  logicalKey: string;
  exp?: string;
  bytes: Uint8Array;
}

export interface FakeVFS {
  files: StoredFile[];
  requests: Array<{ method: string; url: URL; headers: Headers }>;
  failNextPuts: number;
  // Mirrors UPLOAD_NODUPLICATED_ENABLED: an upload whose hash is already in the bucket returns that record.
  dedupe: boolean;
  redirectDownloadsTo?: string;
  cdn: Map<string, Uint8Array>;
  fetch: typeof fetch;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function view(file: StoredFile) {
  const { bytes: _bytes, logicalKey: _key, ...rest } = file;
  return { ...rest, id: file.file_id, extension: 'tgz', type: 'application/gzip', url: '', key: file.logicalKey };
}

// Behaves like the parts of VFS Server the artifact actions rely on: listing with `q`,
// preflight, a keyed PUT that overwrites the previous object, and /v/ reads.
export function createFakeVFS(): FakeVFS {
  const fake: FakeVFS = {
    files: [],
    requests: [],
    failNextPuts: 0,
    dedupe: false,
    cdn: new Map(),
    fetch: async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method || 'GET';
      const headers = new Headers(init?.headers);
      fake.requests.push({ method, url, headers });

      if (url.host === 'cdn.example.test') {
        const bytes = fake.cdn.get(url.pathname);
        return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
      }
      if (url.host !== 'vfs.example.test') throw new Error(`Unexpected host ${url.host}`);
      if (url.pathname.startsWith('/api/') && headers.get('x-api-key') !== 'test-api-key') return json({ detail: 'unauthorized' }, 401);

      if (url.pathname === '/api/upload' && method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const page = Number(url.searchParams.get('page') || 1);
        const limit = Number(url.searchParams.get('limit') || 50);
        const bucket = url.searchParams.get('bucket_id');
        const matches = fake.files
          .filter((f) => f.bucket_id === bucket && (!q || f.name.toLowerCase().includes(q)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return json(matches.slice((page - 1) * limit, page * limit).map(view));
      }
      if (url.pathname === '/api/upload/preflight' && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        return json({ allowed: true, bucket_id: body.bucket_id, size: body.size, max_upload_bytes: 0, upload_token: 'ticket' });
      }
      if (url.pathname.startsWith('/api/upload/') && method === 'PUT') {
        if (fake.failNextPuts > 0) {
          fake.failNextPuts--;
          return json({ detail: 'storage unavailable' }, 503);
        }
        const [, , , bucket, ...keyParts] = url.pathname.split('/');
        const logicalKey = keyParts.join('/');
        const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (url.searchParams.get('file_hash') !== hash) return json({ detail: 'file_hash does not match the uploaded content' }, 400);
        if (fake.dedupe) {
          const existing = fake.files.find((f) => f.bucket_id === bucket && f.file_hash === hash);
          if (existing) return json(view(existing));
        }
        fake.files = fake.files.filter((f) => !(f.bucket_id === bucket && f.logicalKey === logicalKey));
        const file: StoredFile = {
          file_id: `fid${fake.files.length + 1}x${Math.random().toString(16).slice(2, 8)}`,
          bucket_id: bucket,
          name: url.searchParams.get('filename') || keyParts.at(-1) || '',
          size: bytes.length,
          file_hash: hash,
          metadata: JSON.parse(url.searchParams.get('metadata') || '{}'),
          created_at: new Date(Date.now() + fake.files.length).toISOString(),
          logicalKey,
          exp: url.searchParams.get('exp') || undefined,
          bytes,
        };
        fake.files.push(file);
        return json(view(file));
      }
      const read = url.pathname.match(/^\/v\/([^/]+)\/([^/]+)$/);
      if (read && method === 'GET') {
        const file = fake.files.find((f) => f.bucket_id === read[1] && f.file_id === read[2]);
        if (!file) return json({ detail: 'not found' }, 404);
        if (url.searchParams.get('output') === 'json') return json(view(file));
        if (fake.redirectDownloadsTo) {
          fake.cdn.set(`/blob/${file.file_id}`, file.bytes);
          return new Response(null, { status: 302, headers: { Location: `${fake.redirectDownloadsTo}/blob/${file.file_id}` } });
        }
        return new Response(file.bytes, { headers: { 'Content-Type': 'application/gzip' } });
      }
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    },
  };
  return fake;
}
