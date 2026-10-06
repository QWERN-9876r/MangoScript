import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

function mango(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function node(cwd: string, file: string) {
  return spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });
}

/** A temporary project: `files` maps relative paths to contents. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mango-cli-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const geom = `export interface Point {
    x, y number
}

export func dist(p Point) number {
    return Math.sqrt(p.x ** 2 + p.y ** 2)
}
`;

const main = (path: string) => `import { Point, dist } from "${path}"

const p Point = { x: 3, y: 4 }
console.log(dist(p))
`;

describe('mango run', () => {
  it('runs a program that imports another .mango module', () => {
    const dir = project({ 'geom.mango': geom, 'main.mango': main('./geom.mango') });
    const result = mango(dir, 'run', 'main.mango');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('5\n');
  });

  it('reports compile errors and exits with code 1', () => {
    const dir = project({ 'bad.mango': 'let = 1\n' });
    const result = mango(dir, 'run', 'bad.mango');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad.mango:1:5: error: expected variable name, found "="');
  });
});

describe('mango build', () => {
  it('writes .js files next to the sources, with the modules they import', () => {
    const dir = project({ 'lib/geom.mango': geom, 'main.mango': main('./lib/geom.mango') });
    const result = mango(dir, 'build', 'main.mango');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('main.mango → main.js\nlib/geom.mango → lib/geom.js\n');
    expect(readFileSync(join(dir, 'main.js'), 'utf8')).toContain(
      'import { dist } from "./lib/geom.js";',
    );
    expect(node(dir, 'main.js').stdout).toBe('5\n');
  });

  it('writes to --out-dir, keeping the folder structure', () => {
    const dir = project({ 'src/lib/geom.mango': geom, 'src/main.mango': main('./lib/geom.mango') });
    mango(dir, 'build', 'src/main.mango', '--out-dir', 'build');
    expect(existsSync(join(dir, 'build/main.js'))).toBe(true);
    expect(existsSync(join(dir, 'build/lib/geom.js'))).toBe(true);
    expect(existsSync(join(dir, 'src/main.js'))).toBe(false);
    expect(node(dir, 'build/main.js').stdout).toBe('5\n');
  });

  it('builds every .mango file in a directory, except node_modules', () => {
    const dir = project({
      'src/a.mango': 'console.log("a")\n',
      'src/nested/b.mango': 'console.log("b")\n',
      'src/node_modules/c.mango': 'console.log("c")\n',
    });
    mango(dir, 'build', 'src', '--out-dir', 'out');
    expect(existsSync(join(dir, 'out/a.js'))).toBe(true);
    expect(existsSync(join(dir, 'out/nested/b.js'))).toBe(true);
    expect(existsSync(join(dir, 'out/node_modules/c.js'))).toBe(false);
  });

  it('writes nothing when a module has errors', () => {
    const dir = project({
      'geom.mango': 'export func dist(p any) number {\n    return "x"\n}\n',
      'main.mango': 'import { dist } from "./geom.mango"\nconsole.log(dist(1))\n',
    });
    const result = mango(dir, 'build', 'main.mango');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('geom.mango:2:12: error: cannot use string as number');
    expect(existsSync(join(dir, 'main.js'))).toBe(false);
    expect(existsSync(join(dir, 'geom.js'))).toBe(false);
  });

  it('prints the JS of one file with --stdout', () => {
    const dir = project({ 'hello.mango': 'console.log("hi")\n' });
    const result = mango(dir, 'build', 'hello.mango', '--stdout');
    expect(result.stdout).toBe('console.log("hi");\n');
    expect(existsSync(join(dir, 'hello.js'))).toBe(false);
  });

  it('rejects files that are not .mango', () => {
    const dir = project({ 'notes.txt': 'hi' });
    const result = mango(dir, 'build', 'notes.txt');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('mango: not a .mango file: notes.txt\n');
  });
});
