/**
 * Import `@webgame/shared` from a plain node script.
 *
 * The package ships TypeScript source with `const enum`s, which node's type
 * stripping cannot handle, so it goes through esbuild first. Cached per process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;

function esbuildBin() {
  const base = join(ROOT, 'node_modules/.pnpm');
  const candidates = execFileSync('ls', [base], { encoding: 'utf8' })
    .split('\n')
    .filter((d) => d.startsWith('esbuild@'))
    .map((d) => join(base, d, 'node_modules/esbuild/bin/esbuild'))
    .filter((p) => existsSync(p));
  if (candidates.length === 0) throw new Error('esbuild not found under node_modules/.pnpm');
  return candidates[candidates.length - 1];
}

let cached = null;

export async function loadShared() {
  if (cached) return cached;
  const out = join(mkdtempSync(join(tmpdir(), 'webgame-shared-')), 'shared.mjs');
  execFileSync(
    'node',
    [esbuildBin(), join(ROOT, 'packages/shared/src/index.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${out}`],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  cached = await import(pathToFileURL(out).href);
  return cached;
}
