import * as core from '@actions/core';
import {
  VFSClient,
  VFSError,
  signSoftwarePayload,
  softwareKeyPairFromSeed,
  parseKeyFile,
  detectAssetPlatform,
  type SoftwareAsset,
  type ReleasePayload,
  type HeadPayload,
} from '@cubis/vfsclient';
import { parse as parseYaml } from 'yaml';
import semver from 'semver';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface AssetMapping {
  path: string;
  os: string;
  arch: string;
  kind: string;
  filename?: string;
}

function required(name: string): string {
  return core.getInput(name, { required: true }).trim();
}

function slug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

function validTarget(value: string): boolean {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value);
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .replace(/___DOUBLE_STAR___/g, '.*');
  return new RegExp(`^${escaped}$`);
}

async function findFilesRecursively(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          results.push(...(await findFilesRecursively(full)));
        }
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  } catch {
    // Directory unreadable or doesn't exist
  }
  return results;
}

async function resolveFilePatterns(patterns: string[], workspace: string): Promise<AssetMapping[]> {
  const allWorkspaceFiles = await findFilesRecursively(workspace);
  const matched = new Set<string>();

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;

    // Check direct file path
    const directPath = path.resolve(workspace, pattern);
    try {
      const st = await fs.stat(directPath);
      if (st.isFile()) {
        matched.add(await fs.realpath(directPath));
        continue;
      }
    } catch {
      // Continue to glob search
    }

    const normPattern = pattern.replace(/\\/g, '/');
    const regex = globToRegex(normPattern.startsWith('/') ? normPattern.slice(1) : normPattern);

    for (const file of allWorkspaceFiles) {
      const relative = path.relative(workspace, file).replace(/\\/g, '/');
      if (regex.test(relative) || regex.test(path.basename(file))) {
        matched.add(await fs.realpath(file));
      }
    }
  }

  if (matched.size === 0) {
    throw new Error(`No files matched the specified patterns: ${patterns.join(', ')}`);
  }

  const assets: AssetMapping[] = [];
  const seenTargets = new Set<string>();

  for (const file of matched) {
    const filename = path.basename(file);
    const platform = detectAssetPlatform(filename);
    const key = `${platform.os}/${platform.arch}/${platform.kind}`;
    if (seenTargets.has(key)) {
      throw new Error(`Duplicate target and kind detected for ${filename}: ${key}`);
    }
    seenTargets.add(key);
    assets.push({
      path: file,
      filename,
      os: platform.os,
      arch: platform.arch,
      kind: platform.kind,
    });
  }

  return assets;
}

async function loadMappings(file: string, workspace: string): Promise<AssetMapping[]> {
  const mappingPath = await fs.realpath(path.resolve(workspace, file));
  if (!mappingPath.startsWith(`${workspace}${path.sep}`)) {
    throw new Error('assets-file must be inside the workspace');
  }
  const config = parseYaml(await fs.readFile(mappingPath, 'utf8')) as { assets?: AssetMapping[] };
  if (!Array.isArray(config?.assets) || config.assets.length === 0 || config.assets.length > 100) {
    throw new Error('assets-file must list 1 to 100 assets');
  }
  const seen = new Set<string>();
  for (const item of config.assets) {
    if (!item || !validTarget(item.os) || !validTarget(item.arch) || !slug(item.kind) || typeof item.path !== 'string' || !item.path) {
      throw new Error('Invalid asset mapping');
    }
    const key = `${item.os}/${item.arch}/${item.kind}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate target and kind: ${key}`);
    }
    seen.add(key);
    const requested = path.resolve(workspace, item.path);
    const target = await fs.realpath(requested);
    if (!target.startsWith(`${workspace}${path.sep}`)) {
      throw new Error(`Asset escapes workspace: ${item.path}`);
    }
    const stat = await fs.lstat(requested);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Asset is not a regular file: ${item.path}`);
    }
    if (stat.size > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Asset is too large for a signed JSON size: ${item.path}`);
    }
    item.path = target;
    item.filename = item.filename || path.basename(target);
    if (typeof item.filename !== 'string' || item.filename.length === 0 || item.filename.length > 255 || /[/\\\0\r\n]/.test(item.filename)) {
      throw new Error(`Invalid asset filename: ${item.path}`);
    }
  }
  return config.assets;
}

export async function publish(): Promise<void> {
  const endpoint = required('endpoint').replace(/\/+$/, '');
  const endpointURL = new URL(endpoint);
  if (endpointURL.protocol !== 'https:' || endpointURL.username || endpointURL.password || endpointURL.pathname !== '/' || endpointURL.search || endpointURL.hash) {
    throw new Error('endpoint must be an HTTPS origin without credentials, a path, or query');
  }
  const apiKey = required('api-key');
  const rawSeed = required('signing-key');
  core.setSecret(apiKey);
  core.setSecret(rawSeed);

  // Extract seed supporting raw base64url, JSON key file (.vfs-key), or .env format
  const parsedKey = parseKeyFile(rawSeed);
  const seed = parsedKey.seed;
  core.setSecret(seed);

  const bucket = required('bucket');
  const app = required('app');
  const channel = core.getInput('channel').trim() || 'stable';
  if (!slug(app) || !slug(channel)) {
    throw new Error('Invalid application or channel slug');
  }

  // Resolve version from input or GitHub tag
  let versionInput = core.getInput('version').trim();
  if (!versionInput) {
    if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME) {
      versionInput = process.env.GITHUB_REF_NAME;
    } else if (process.env.GITHUB_REF && process.env.GITHUB_REF.startsWith('refs/tags/')) {
      versionInput = process.env.GITHUB_REF.replace(/^refs\/tags\//, '');
    }
  }
  const version = versionInput.replace(/^v/, '');
  if (!semver.valid(version) || version !== semver.clean(version)) {
    throw new Error(`version must be SemVer 2.0 (got "${versionInput}")`);
  }

  // Resolve notes
  let notes = core.getInput('notes');
  if (!notes && process.env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      if (typeof event.release?.body === 'string') {
        notes = event.release.body;
      }
    } catch {
      // Ignore event reading errors
    }
  }

  const workspace = await fs.realpath(path.resolve(process.env.GITHUB_WORKSPACE || process.cwd()));

  // Resolve mappings: check files input first, then assets-file
  let mappings: AssetMapping[] = [];
  const filesInput = core.getInput('files');
  const assetsFileInput = core.getInput('assets-file').trim();

  if (filesInput && filesInput.trim()) {
    const patterns = filesInput.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    mappings = await resolveFilePatterns(patterns, workspace);
  } else if (assetsFileInput) {
    mappings = await loadMappings(assetsFileInput, workspace);
  } else {
    // Check default .vfs/assets.yaml
    const defaultYaml = path.resolve(workspace, '.vfs/assets.yaml');
    let hasDefault = false;
    try {
      hasDefault = (await fs.stat(defaultYaml)).isFile();
    } catch {
      hasDefault = false;
    }
    if (hasDefault) {
      mappings = await loadMappings('.vfs/assets.yaml', workspace);
    } else {
      throw new Error("No artifacts specified. Please specify 'files' (e.g. dist/*.exe) or provide an 'assets-file' YAML mapping.");
    }
  }

  const client = new VFSClient({ endpoint, apiKey, defaultBucket: bucket, timeout: 30_000 });
  const keys = softwareKeyPairFromSeed(seed);
  const before = await client.software.getManifest({ bucketId: bucket, app, channel, limit: 1 });
  if (before.application.active_key_id !== keys.keyId) {
    throw new Error('Action signing key is not the active application key');
  }

  const intent = await client.software.beginPublish(bucket, app, version);
  const assets: SoftwareAsset[] = [];
  for (const mapping of mappings) {
    core.info(`Uploading ${path.basename(mapping.path)} for ${mapping.os}/${mapping.arch}`);
    const uploaded = await client.upload({ file: mapping.path, bucketId: bucket, name: mapping.filename, preflight: true });
    if (!uploaded.file_hash || !/^[0-9a-f]{64}$/.test(uploaded.file_hash)) {
      throw new Error(`Server did not return a verified SHA-256 for ${mapping.path}`);
    }
    await client.software.registerAsset(bucket, app, intent.id, uploaded.file_id);
    assets.push({
      os: mapping.os,
      arch: mapping.arch,
      kind: mapping.kind,
      filename: mapping.filename!,
      file_id: uploaded.file_id,
      sha256: uploaded.file_hash,
      size: uploaded.size,
      download_path: `/v/${bucket}/${uploaded.file_id}`,
    });
  }

  const payload: ReleasePayload = { schema_version: 1, bucket_id: bucket, app, version, ...(notes ? { notes } : {}), assets };
  await client.software.publishRelease(bucket, app, intent.id, payload, signSoftwarePayload(payload, seed));

  for (let attempt = 0; attempt < 5; attempt++) {
    const manifest = await client.software.getManifest({ bucketId: bucket, app, channel, limit: 1 });
    const latest = { ...(manifest.head?.payload.latest || {}) };
    for (const asset of assets) {
      latest[`${asset.os}/${asset.arch}`] = version;
    }
    const head: HeadPayload = { schema_version: 1, bucket_id: bucket, app, channel, revision: (manifest.head?.payload.revision || 0) + 1, mode: 'promote', latest };
    try {
      await client.software.updateChannel(bucket, app, channel, head, signSoftwarePayload(head, seed));
      break;
    } catch (error) {
      if (attempt === 4 || !(error instanceof VFSError) || error.status !== 409) {
        throw error;
      }
    }
  }

  const manifestURL = `${endpoint}/api/software/${encodeURIComponent(bucket)}/${encodeURIComponent(app)}/manifest.json?channel=${encodeURIComponent(channel)}`;
  core.setOutput('manifest-url', manifestURL);
  core.setOutput('version', version);
  core.setOutput('release-id', `${bucket}:${app}:${version}`);
  core.info(`Published ${app} ${version}: ${manifestURL}`);
}

if (process.env.GITHUB_ACTIONS === 'true') {
  publish().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
}
