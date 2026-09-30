import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../src/main';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('publish action', () => {
  it('uploads from a workspace mapping and merges a concurrent channel update', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'vfs-action-test-'));
    try {
      await mkdir(path.join(workspace, '.vfs'));
      await writeFile(path.join(workspace, 'app.bin'), 'artifact');
      await writeFile(path.join(workspace, '.vfs/assets.yaml'), 'assets:\n  - path: app.bin\n    os: linux\n    arch: x64\n    kind: archive\n');
      process.env.GITHUB_WORKSPACE = workspace;
      process.env.INPUT_ENDPOINT = 'https://vfs.example.test';
      process.env['INPUT_API-KEY'] = 'test-api-key';
      process.env['INPUT_SIGNING-KEY'] = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
      process.env.INPUT_BUCKET = 'desktop';
      process.env.INPUT_APP = 'my-app';
      process.env.INPUT_CHANNEL = 'stable';
      process.env.INPUT_VERSION = '1.2.3';
      process.env['INPUT_ASSETS-FILE'] = '.vfs/assets.yaml';
      let manifests = 0;
      let channelWrites = 0;
      let published = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method || 'GET';
        if (url.pathname.endsWith('/manifest.json')) {
          manifests++;
          return reply({ schema_version: 1, application: { bucket_id: 'desktop', app: 'my-app', active_key_id: '56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c' }, channel: 'stable', head: manifests >= 3 ? { payload: { revision: 1, latest: { 'darwin/arm64': '1.2.2' } } } : undefined, latest_releases: [], releases: [] });
        }
        if (url.pathname.endsWith('/intents') && method === 'POST') return reply({ id: 'intent-1', version: '1.2.3', file_ids: [], state: 'open' }, 201);
        if (url.pathname === '/api/upload/preflight') return reply({ allowed: true, bucket_id: 'desktop', size: 8, max_upload_bytes: 0 });
        if (url.pathname.startsWith('/api/upload/desktop/') && method === 'PUT') return reply({ file_id: 'abc123', file_hash: 'c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c', size: 8 });
        if (url.pathname.endsWith('/assets') && method === 'PUT') return reply({ id: 'intent-1', version: '1.2.3', file_ids: ['abc123'], state: 'open' });
        if (url.pathname.endsWith('/releases') && method === 'POST') { published = true; return reply({}, 201); }
        if (url.pathname.endsWith('/channels/stable') && method === 'PUT') {
          channelWrites++;
          const body = JSON.parse(String(init?.body));
          if (channelWrites === 1) return reply({ detail: 'channel changed concurrently' }, 409);
          expect(body.payload.revision).toBe(2);
          expect(body.payload.latest['darwin/arm64']).toBe('1.2.2');
          expect(body.payload.latest['linux/x64']).toBe('1.2.3');
          return reply({});
        }
        throw new Error(`Unexpected ${method} ${url.pathname}`);
      };
      await publish();
      expect(published).toBe(true);
      expect(channelWrites).toBe(2);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it('uploads artifacts matched from glob files input with auto-detected platform and tag version', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'vfs-action-glob-test-'));
    try {
      const dist = path.join(workspace, 'dist');
      await mkdir(dist);
      await writeFile(path.join(dist, 'my-app-setup-x64.exe'), 'windows-exe');
      await writeFile(path.join(dist, 'my-app-universal.dmg'), 'macos-dmg');

      process.env.GITHUB_WORKSPACE = workspace;
      process.env.GITHUB_REF_TYPE = 'tag';
      process.env.GITHUB_REF_NAME = 'v2.0.0';
      process.env.INPUT_ENDPOINT = 'https://vfs.example.test';
      process.env['INPUT_API-KEY'] = 'test-api-key';
      process.env['INPUT_SIGNING-KEY'] = JSON.stringify({
        vfs_key_version: 1,
        app: 'my-app',
        signing_seed: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      });
      process.env.INPUT_BUCKET = 'desktop';
      process.env.INPUT_APP = 'my-app';
      process.env.INPUT_CHANNEL = 'stable';
      process.env.INPUT_FILES = 'dist/*.exe\ndist/*.dmg';

      const uploadedFiles: string[] = [];
      let registeredTargets: string[] = [];
      let publishedVersion = '';

      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method || 'GET';
        if (url.pathname.endsWith('/manifest.json')) {
          return reply({
            schema_version: 1,
            application: { bucket_id: 'desktop', app: 'my-app', active_key_id: '56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c' },
            channel: 'stable',
            head: undefined,
            latest_releases: [],
            releases: [],
          });
        }
        if (url.pathname.endsWith('/intents') && method === 'POST') {
          const body = JSON.parse(String(init?.body));
          publishedVersion = body.version;
          return reply({ id: 'intent-glob', version: body.version, file_ids: [], state: 'open' }, 201);
        }
        if (url.pathname === '/api/upload/preflight') return reply({ allowed: true, bucket_id: 'desktop', size: 10, max_upload_bytes: 0 });
        if (url.pathname.startsWith('/api/upload/desktop/') && method === 'PUT') {
          const filename = url.searchParams.get('filename') || '';
          uploadedFiles.push(filename);
          return reply({ file_id: `fid-${filename}`, file_hash: 'a'.repeat(64), size: 10 });
        }
        if (url.pathname.endsWith('/assets') && method === 'PUT') {
          return reply({ id: 'intent-glob', version: '2.0.0', file_ids: [], state: 'open' });
        }
        if (url.pathname.endsWith('/releases') && method === 'POST') {
          const body = JSON.parse(String(init?.body));
          registeredTargets = body.payload.assets.map((a: any) => `${a.os}/${a.arch}/${a.kind}`);
          return reply({}, 201);
        }
        if (url.pathname.endsWith('/channels/stable') && method === 'PUT') {
          return reply({});
        }
        throw new Error(`Unexpected ${method} ${url.pathname}`);
      };

      await publish();
      expect(publishedVersion).toBe('2.0.0');
      expect(uploadedFiles).toContain('my-app-setup-x64.exe');
      expect(uploadedFiles).toContain('my-app-universal.dmg');
      expect(registeredTargets).toContain('windows/x64/installer');
      expect(registeredTargets).toContain('darwin/universal/installer');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
