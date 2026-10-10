import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The npm package ships dist/, built from src/ by `npm run build`: every entry point of
// package.json has to name a file that the build makes, or the published package breaks.

const root = new URL('..', import.meta.url).pathname;

interface PackageJson {
  bin: Record<string, string>;
  exports: Record<string, string | { types: string; default: string }>;
}

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as PackageJson;

/** The source file in src/ that the build turns into the given file of dist/. */
function sourceOf(target: string): string {
  return target.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts');
}

describe('package', () => {
  it('builds every entry point of package.json from src/', () => {
    const targets = [
      ...Object.values(pkg.bin),
      ...Object.entries(pkg.exports)
        .filter(([path]) => path !== './package.json')
        .flatMap(([, target]) =>
          typeof target === 'string' ? [target] : [target.types, target.default],
        ),
    ];
    const missing = targets.filter((target) => !existsSync(root + sourceOf(target)));

    expect(missing).toEqual([]);
  });

  it('starts the binary with a shebang', () => {
    for (const target of Object.values(pkg.bin)) {
      expect(readFileSync(root + sourceOf(target), 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
    }
  });
});
