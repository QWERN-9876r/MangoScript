import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markupProject } from './project.ts';

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

function rook(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function node(cwd: string, file: string) {
  return spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });
}

/** A temporary project: `files` maps relative paths to contents. */
function project(files: Record<string, string>): string {
  const dir = markupProject('rook-cli-');

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

describe('rook run', () => {
  it('runs a program that imports another .rk module', () => {
    const dir = project({ 'geom.rk': geom, 'main.rk': main('./geom.rk') });
    const result = rook(dir, 'run', 'main.rk');

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('5\n');
  });

  it('reports compile errors and exits with code 1', () => {
    const dir = project({ 'bad.rk': 'let = 1\n' });
    const result = rook(dir, 'run', 'bad.rk');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bad.rk:1:5: error: expected variable name, found "="');
  });
});

describe('rook build', () => {
  it('writes .js files next to the sources, with the modules they import', () => {
    const dir = project({ 'lib/geom.rk': geom, 'main.rk': main('./lib/geom.rk') });
    const result = rook(dir, 'build', 'main.rk');

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('main.rk → main.js + .d.ts\nlib/geom.rk → lib/geom.js + .d.ts\n');
    expect(readFileSync(join(dir, 'main.js'), 'utf8')).toContain(
      'import { dist } from "./lib/geom.js";',
    );
    expect(node(dir, 'main.js').stdout).toBe('5\n');
    expect(readFileSync(join(dir, 'lib/geom.d.ts'), 'utf8')).toBe(`export interface Point {
    x: number;
    y: number;
}
export declare function dist(p: Point): number;
`);
  });

  it('writes no .d.ts without type checking', () => {
    const dir = project({ 'geom.rk': geom });
    const result = rook(dir, 'build', 'geom.rk', '--no-check');

    expect(result.stdout).toBe('geom.rk → geom.js\n');
    expect(existsSync(join(dir, 'geom.d.ts'))).toBe(false);
  });

  it('writes to --out-dir, keeping the folder structure', () => {
    const dir = project({ 'src/lib/geom.rk': geom, 'src/main.rk': main('./lib/geom.rk') });

    rook(dir, 'build', 'src/main.rk', '--out-dir', 'build');
    expect(existsSync(join(dir, 'build/main.js'))).toBe(true);
    expect(existsSync(join(dir, 'build/lib/geom.js'))).toBe(true);
    expect(existsSync(join(dir, 'src/main.js'))).toBe(false);
    expect(node(dir, 'build/main.js').stdout).toBe('5\n');
  });

  it('builds every .rk file in a directory, except node_modules', () => {
    const dir = project({
      'src/a.rk': 'console.log("a")\n',
      'src/nested/b.rk': 'console.log("b")\n',
      'src/node_modules/c.rk': 'console.log("c")\n',
    });

    rook(dir, 'build', 'src', '--out-dir', 'out');
    expect(existsSync(join(dir, 'out/a.js'))).toBe(true);
    expect(existsSync(join(dir, 'out/nested/b.js'))).toBe(true);
    expect(existsSync(join(dir, 'out/node_modules/c.js'))).toBe(false);
  });

  it('writes nothing when a module has errors', () => {
    const dir = project({
      'geom.rk': 'export func dist(p any) number {\n    return "x"\n}\n',
      'main.rk': 'import { dist } from "./geom.rk"\nconsole.log(dist(1))\n',
    });
    const result = rook(dir, 'build', 'main.rk');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('geom.rk:2:12: error: cannot use string as number');
    expect(existsSync(join(dir, 'main.js'))).toBe(false);
    expect(existsSync(join(dir, 'geom.js'))).toBe(false);
  });

  it('prints warnings and still writes the files', () => {
    const dir = project({
      'card.rk':
        'comp Card() {\n    style {\n        h1 { margin: 0 }\n    }\n    return <p />\n}\ndocument.body.append(<Card />)\n',
    });
    const result = rook(dir, 'build', 'card.rk');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'card.rk:3:9: warning: selector "h1" matches no element of Card',
    );
    expect(existsSync(join(dir, 'card.js'))).toBe(true);
  });

  it('prints the JS of one file with --stdout', () => {
    const dir = project({ 'hello.rk': 'console.log("hi")\n' });
    const result = rook(dir, 'build', 'hello.rk', '--stdout');

    expect(result.stdout).toBe('console.log("hi");\n');
    expect(existsSync(join(dir, 'hello.js'))).toBe(false);
  });

  it('rejects files that are not .rk', () => {
    const dir = project({ 'notes.txt': 'hi' });
    const result = rook(dir, 'build', 'notes.txt');

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('rook: not a .rk file: notes.txt\n');
  });
});
