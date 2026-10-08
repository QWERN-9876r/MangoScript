import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Rules for the repository itself.

const root = new URL('..', import.meta.url).pathname;

/** Files with code: what people write and read, not generated files or prose. */
const CODE = /\.(ts|js|mango|css|html|json)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git', '.vscode']);
const SKIPPED_FILES = new Set(['package-lock.json']);

function codeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')
        ? []
        : codeFiles(path);
    }
    return CODE.test(entry.name) && !SKIPPED_FILES.has(entry.name) ? [path] : [];
  });
}

describe('repository', () => {
  it('has no code file longer than 400 lines', () => {
    const long = codeFiles(root)
      .map((path) => ({
        path: relative(root, path),
        lines: readFileSync(path, 'utf8').split('\n').length - 1,
      }))
      .filter((file) => file.lines > 400)
      .map((file) => `${file.path}: ${file.lines} lines`);
    expect(long).toEqual([]);
  });
});
