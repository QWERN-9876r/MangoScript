import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { errors as syntaxErrors, first } from './parser-helpers.ts';

// `go for i, v in items { ... }`: the array is split into parts, one per processor, each part runs
// as a goroutine that writes its own elements, and the loop waits for all of them.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

function compiled(source: string): { code: string; worker: string } {
  const { code, worker, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return { code, worker: worker ?? '' };
}

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Builds a program, with or without checking its types, and runs it with Node. */
function run(source: string, check = true): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rook-go-for-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };
  const flags = check ? [] : ['--no-check'];

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.rk'), source);
  expect(spawnSync(process.execPath, [cli, 'build', ...flags, 'main.rk'], options).stderr).toBe('');

  return spawnSync(process.execPath, ['main.js'], options);
}

describe('parsing', () => {
  it('reads go before a for ... in loop', () => {
    const loop = first('go for i, v in pixels {\n    pixels[i] = 255 - v\n}', 'ForInStatement');

    expect(loop.go).toBe(true);
    expect(loop.key?.name).toBe('i');
    expect(first('for v in xs {}', 'ForInStatement').go).toBeUndefined();
  });

  it('lets the body skip an element, and loops inside it stop as usual', () => {
    expect(
      syntaxErrors(`go for i, v in xs {
    if v < 0 {
        continue
    }
    for x in v {
        break
    }
    const f = func() number {
        return 1
    }
}`),
    ).toEqual([]);
  });

  it.each([
    [
      'go for v in xs {\n    break\n}',
      '"break" cannot stop "go for": its parts run at once in workers',
    ],
    ['go for v in xs {\n    return\n}', '"return" cannot leave "go for": its body runs in workers'],
    [
      'async func f() {\n    go for v in xs {\n        defer g()\n    }\n}',
      '"defer" cannot be used in the body of "go for"',
    ],
    ['go for let i = 0; i < 3; i++ {}', '"go for" goes over an array: write "go for i, v in items'],
    ['const x = go for v in xs {}', '"go for" is a statement: it waits for its parts'],
    ['func f() {\n    go for v in xs {}\n}', '"go for" is allowed only in async functions'],
  ])('reports %j', (source, message) => {
    expect(syntaxErrors(source)).toEqual([expect.stringContaining(message)]);
  });
});

describe('types', () => {
  it('goes over an array or a typed array whose elements can be copied', () => {
    expect(
      errors(`const bytes = new Uint8Array(4)
const floats = new Float64Array(4)
const names = ["a", "b"]
const handlers = [() => 1]
go for i, b in bytes {
    bytes[i] = b + 1
}
go for i, f in floats {
    floats[i] = f / 2
}
go for i, name in names {
    names[i] = name.toUpperCase()
}
go for c in "text" {}
go for h in handlers {}
go for v in new Set([1]) {}`),
    ).toEqual([
      '"go for" splits an array among workers, but string is not an array; loop over a []T or a typed array, e.g. "go for i, v in pixels { ... }"',
      '"go for" copies the parts of the array to workers, but a function cannot be copied',
      expect.stringContaining('"go for" splits an array among workers, but Set<number> is not'),
    ]);
  });

  it('reaches the array only through its own element', () => {
    expect(
      errors(`const pixels = new Uint8Array(4)
go for i, v in pixels {
    pixels[i] = v + pixels[i]
    console.log(pixels.length)
    const f = func(pixels []number) number {
        return pixels.length
    }
}
go for v in pixels {
    console.log(pixels[0])
}`),
    ).toEqual([
      '"go for" gives each worker only its part of "pixels", so the body uses it only as pixels[i]; read other elements from another array, e.g. "go for i, _ in out { out[i] = src[i] + src[i + 1] }"',
      '"go for" gives each worker only its part of "pixels", so the body uses it only as its own element; name the index to write it, e.g. "go for i, v in pixels { pixels[i] = v * 2 }"',
    ]);
  });

  it('copies the names the body uses, which must be data and stay unchanged there', () => {
    expect(
      errors(`const results []number = []
async func blur(src []number, el HTMLElement) {
    let count = 0
    const out = src.map(_ => 0)
    const seen []number = []
    go for i, _ in out {
        out[i] = (src[i] + src[i + 1]) / 2
        count++
        seen[i] = 1
        results.push(1)
        el.textContent = "x"
    }
}`),
    ).toEqual([
      'the body of "go for" runs in workers, which get a copy of "count", so changing it there does not change it here; write the results into the array of the loop, or send them through a channel',
      'the body of "go for" runs in workers, which get a copy of "seen", so changing it there does not change it here; loop over the array you write, e.g. "go for i, _ in seen { seen[i] = ... }"',
      'the body of "go for" runs in workers, which get a copy of "el", but a copy of HTMLElement would lose its methods',
    ]);
  });

  it('reports the variables of the module that a worker does not share', () => {
    expect(
      errors(`let scale = 2
const data = [1, 2]
go for i, v in data {
    data[i] = v * scale
}`),
    ).toEqual([
      'the body of "go for" runs in a worker, which does not share the variables of the module, but its code uses "scale"; pass the value as an argument, or make it a const',
    ]);
  });
});

describe('generated code', () => {
  it('waits for the parts, which get the local names the body uses', () => {
    const { code, worker } = compiled(`async func scale(pixels Uint8Array, k number) {
    go for i, v in pixels {
        if v == 0 {
            continue
        }
        pixels[i] = v * k + i
    }
}`);

    expect(code).toContain('await $$goFor("$$goroutine0", pixels, k);');
    expect(worker).toContain(`async function $$goroutine0(pixels, $$from, k) {
  for (let $$i = 0; $$i < pixels.length; $$i++) {
    const i = $$from + $$i;
    const v = pixels[$$i];
    if (v === 0) {
      continue;
    }
    pixels[$$i] = v * k + i;
  }
  return $$transfer(pixels);
}`);
  });

  it('sends back an array that the body writes, and nothing otherwise', () => {
    const { worker } = compiled(`const names = ["a"]
go for i, name in names {
    names[i] = name + "!"
}
go for name in names {
    console.log(name)
}`);

    expect(worker).toContain(`    names[$$i] = name + "!";
  }
  return names;
}`);
    expect(worker).toContain(`    console.log(name);
  }
}`);
  });

  it('numbers its function with the literals of go, and keeps a name the body declares again', () => {
    const { code, worker } = compiled(`const xs = [1, 2]
const n = await go func() number {
    return 1
}()
go for i, x in xs {
    const x = 2
    xs[i] = x
}`);

    expect(code).toContain('$$go("$$goroutine0", [])');
    expect(code).toContain('await $$goFor("$$goroutine1", xs);');
    expect(worker).toContain(`    const x = xs[$$i];
    {
      const x = 2;
      xs[$$i] = x;
    }`);
  });
});

describe('running', () => {
  const program = `const pixels = new Uint8Array(1000)
for i, _ in pixels {
    pixels[i] = i % 256
}
go for i, v in pixels {
    pixels[i] = 255 - v
}
console.log(pixels[0], pixels[1], pixels[999], pixels.length)

const shared = new Float64Array(new SharedArrayBuffer(8 * 100))
const factor = 3
go for i, _ in shared {
    shared[i] = i * factor
}
console.log(shared[99], shared.buffer instanceof SharedArrayBuffer)

const words = ["a", "bb", "ccc", "dddd", "eeeee"]
go for i, w in words {
    words[i] = w.toUpperCase() + String(i)
}
console.log(words.join(" "))

const squares = await go async func() []number {
    const xs = [1, 2, 3, 4]
    go for i, x in xs {
        xs[i] = x * x
    }
    return xs
}()
console.log(squares.join(" "))

const empty []number = []
go for i, x in empty {
    empty[i] = x
}
console.log(empty.length)
`;
  const output = [
    '255 254 24 1000',
    '297 true',
    'A0 BB1 CCC2 DDDD3 EEEEE4',
    '1 4 9 16',
    '0',
    '',
  ].join('\n');

  it('writes the parts back: moved, shared, copied, nested', { timeout: 30_000 }, () => {
    const { stdout, stderr } = run(program);

    expect(stderr).toBe('');
    expect(stdout).toBe(output);
  });

  it('runs without checking the types', { timeout: 30_000 }, () => {
    const { stdout, stderr } = run(program, false);

    expect(stderr).toBe('');
    expect(stdout).toBe(output);
  });
});
