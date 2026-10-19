import * as core from '@actions/core';
import { VFSClient } from '@cubis/vfsclient';

export interface Connection {
  endpoint: string;
  apiKey: string;
  bucket: string;
}

export function parseEndpoint(raw: string): string {
  const endpoint = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('endpoint must be an HTTPS origin such as https://vfs.example.com');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('endpoint must be an HTTPS origin without credentials, a path, or query');
  }
  return endpoint;
}

// An input wins over its environment variable, so a workflow can set the connection
// once in `env:` and every VFS step in the job picks it up.
function inputOrEnv(input: string, env: string): string {
  return core.getInput(input).trim() || (process.env[env] || '').trim();
}

function requiredInputOrEnv(input: string, env: string): string {
  const value = inputOrEnv(input, env);
  if (!value) {
    throw new Error(`Missing "${input}": set the ${input} input or the ${env} environment variable`);
  }
  return value;
}

export function readConnection(): Connection {
  const endpoint = parseEndpoint(requiredInputOrEnv('endpoint', 'VFS_ENDPOINT'));
  const apiKey = requiredInputOrEnv('api-key', 'VFS_API_KEY');
  core.setSecret(apiKey);
  const bucket = requiredInputOrEnv('bucket', 'VFS_BUCKET');
  return { endpoint, apiKey, bucket };
}

export function createClient(connection: Connection): VFSClient {
  return new VFSClient({
    endpoint: connection.endpoint,
    apiKey: connection.apiKey,
    defaultBucket: connection.bucket,
    timeout: 30_000,
  });
}
