import * as glob from '@actions/glob';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface FoundFiles {
  rootDirectory: string;
  // Absolute paths of the files to archive.
  files: string[];
  // The same files relative to rootDirectory, always with forward slashes.
  entries: string[];
  bytes: number;
}

function resolvePattern(pattern: string, workspace: string): string {
  if (pattern.startsWith('~')) return pattern;
  return path.resolve(workspace, pattern);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasHiddenSegment(relative: string): boolean {
  return relative.split(/[\\/]/).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

function commonAncestor(directories: string[]): string {
  const split = directories.map((dir) => path.resolve(dir).split(path.sep));
  const first = split[0];
  let length = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < length && i < parts.length && parts[i] === first[i]) i++;
    length = i;
  }
  const joined = first.slice(0, length).join(path.sep);
  return joined === '' ? path.sep : joined;
}

async function directoryOf(searchPath: string): Promise<string> {
  try {
    return (await fs.stat(searchPath)).isDirectory() ? searchPath : path.dirname(searchPath);
  } catch {
    return path.dirname(searchPath);
  }
}

// Mirrors actions/upload-artifact: one pattern per line, `!` excludes, directories include
// their contents, and the archive is rooted at the least common ancestor of the search
// paths, so `dist/**` extracts as the contents of `dist` and a lone file as just its name.
export async function findFilesToUpload(patterns: string[], workspace: string, includeHidden: boolean): Promise<FoundFiles> {
  const lines = patterns.map((line) => line.trim()).filter(Boolean);
  const positives = lines.map((line, index) => ({ line, index })).filter(({ line }) => !line.startsWith('!'));
  const negatives = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('!'))
    .map(({ line, index }) => ({ index, pattern: `!${resolvePattern(line.slice(1).trim(), workspace)}` }));

  const files = new Set<string>();
  const roots = new Set<string>();

  for (const positive of positives) {
    const applicable = negatives.filter((negative) => negative.index > positive.index).map((negative) => negative.pattern);
    const globber = await glob.create([resolvePattern(positive.line, workspace), ...applicable].join('\n'), {
      followSymbolicLinks: true,
      implicitDescendants: true,
      matchDirectories: false,
      omitBrokenSymbolicLinks: true,
    });
    const searchPaths = globber.getSearchPaths();
    for (const searchPath of searchPaths) roots.add(searchPath);

    for (const file of await globber.glob()) {
      // Hidden files are judged below the search path, so naming `.build/` explicitly still works.
      if (!includeHidden) {
        let hidden = false;
        for (const searchPath of searchPaths) {
          if (isInside(searchPath, file) && hasHiddenSegment(path.relative(searchPath, file))) hidden = true;
        }
        if (hidden) continue;
      }
      files.add(path.resolve(file));
    }
  }

  const regular: string[] = [];
  let bytes = 0;
  for (const file of [...files].sort()) {
    const stat = await fs.stat(file);
    if (!stat.isFile()) continue;
    regular.push(file);
    bytes += stat.size;
  }

  if (regular.length === 0) {
    return { rootDirectory: workspace, files: [], entries: [], bytes: 0 };
  }

  const rootDirectory = commonAncestor(await Promise.all([...roots].map(directoryOf)));
  const entries = regular.map((file) => path.relative(rootDirectory, file).split(path.sep).join('/'));
  return { rootDirectory, files: regular, entries, bytes };
}
