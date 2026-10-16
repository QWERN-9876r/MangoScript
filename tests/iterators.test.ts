import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { first, ty } from './parser-helpers.ts';

// Iterators as in Go 1.23: a function whose one parameter is `yield`, `func(yield func(T) bool)`.
// They compile to JS generators: `for v in seq` goes over `seq()`, a lazy JS iterator, and when
// the loop stops, the generator is closed where it yields, so the iterator returns there.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

/** Runs compiled code; returns what it printed. */
function run(source: string): string[] {
  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const program = new Function('console', js(source)) as (console: { log: typeof log }) => void;

  program({ log });

  return output;
}

const COUNT = `func count(n number) func(yield func(number) bool) {
    return func(yield func(number) bool) {
        defer console.log("closed")
        for let i = 0; i < n; i++ {
            if !yield(i) {
                return
            }
        }
    }
}
`;

describe('iterator types', () => {
  it('name their parameter yield', () => {
    const declaration = first('let seq func(yield func(number) bool)', 'VariableDeclaration');

    expect(declaration.type).toMatchObject({ kind: 'FuncType', iterator: true });
    expect(ty(declaration.type!)).toBe('func(func(number) bool)');
    expect(
      first('let f func(test func(number) bool)', 'VariableDeclaration').type,
    ).not.toHaveProperty('iterator');
    expect(
      first('let seq (yield func(string, number) bool) => void', 'VariableDeclaration').type,
    ).toMatchObject({ kind: 'FuncType', iterator: true });
  });

  it('are not functions that take a callback', () => {
    expect(
      errors(`${COUNT}
const seq func(yield func(number) bool) = count(3)
const callback func(func(number) bool) = count(3)
const back func(yield func(number) bool) = func(test func(number) bool) {}
count(3)(func(n number) bool { return true })`),
    ).toEqual([
      'cannot use func(yield func(number) bool) as func(func(number) bool)',
      'cannot use func(func(number) bool) as func(yield func(number) bool)',
      'func(yield func(number) bool) is an iterator, gone over with "for": e.g. "for value in items"; it compiles to a JS generator, which takes no function, and seq() gives it',
    ]);
  });
});

describe('iterators', () => {
  it('compile to generators, and the way Go stops to a plain yield', () => {
    expect(js(COUNT)).toBe(`function count(n) {
  return function* () {
    try {
      for (let i = 0; i < n; i++) {
        yield i;
      }
    } finally {
      console.log("closed");
    }
  };
}
`);
    expect(
      js(`func pairs(yield func(string, number) bool) {
    yield("a", 1)
    const more = yield("b", 2)
}
for key, value in pairs {
    console.log(key, value)
}
for value in pairs {
    console.log(value)
}`),
    ).toBe(`function* pairs() {
  yield ["a", 1];
  const more = (yield ["b", 2], true);
}
for (const [key, value] of pairs()) {
  console.log(key, value);
}
for (const [, value] of pairs()) {
  console.log(value);
}
`);
  });

  it('stop where the loop stops, with their defers run', () => {
    expect(
      run(`${COUNT}
for i in count(10) {
    if i == 2 {
        break
    }
    console.log(i)
}
for i in count(1) {
    console.log("only", i)
}`),
    ).toEqual(['0', '1', 'closed', 'only 0', 'closed']);
  });

  it('may be methods, and literals keep this', () => {
    expect(
      run(`class Bag {
    items []string = ["x", "y"]
    all() func(yield func(string) bool) {
        return func(yield func(string) bool) {
            for item in this.items {
                if !yield(item) {
                    return
                }
            }
        }
    }
    each(yield func(number, string) bool) {
        for i, item in this.items {
            if !yield(i, item) {
                return
            }
        }
    }
}
const bag = new Bag()
for item in bag.all() {
    console.log(item)
}
for i, item in bag.each {
    console.log(i, item)
}`),
    ).toEqual(['x', 'y', '0 x', '1 y']);
  });

  it('give a lazy JS iterator when called without arguments', () => {
    expect(
      run(`${COUNT}
const firstThree []number = count(1_000_000)().take(3).toArray()
const doubled = count(3)().map(n => n * 2).toArray()
console.log(firstThree, doubled)`),
    ).toEqual(['closed', 'closed', '0,1,2 0,2,4']);
  });

  it('keep to what a generator can do', () => {
    expect(
      errors(`func bad(yield func(number) bool) number {
    const kept = yield
    [1].forEach(x => {
        yield(x)
    })
    return 1
}
async func later(yield func(number) bool) {
}
func wrong(yield func(number)) {
}
const arrow = (yield func(number) bool) => {}
func plain(test func(number) bool) {
}
for v in plain {
}`),
    ).toEqual([
      'an iterator returns nothing: it gives its values to yield',
      'an iterator only calls yield, e.g. "if !yield(v) { return }": it compiles to a JS generator, where yield is not a value',
      'yield is called in a function inside the iterator: a JS generator yields only in its own body, so loop there, e.g. for x in items { if !yield(x) { return } }',
      'an iterator cannot be async: it compiles to a JS generator, which yields at once; wait where it is gone over instead',
      'the yield of an iterator is func(T) bool or func(K, V) bool, e.g. func(yield func(number) bool)',
      'an iterator is written with func, not as an arrow function: JS has no arrow generators, e.g. func(yield func(number) bool) { ... }',
      'cannot iterate over func(func(number) bool): an iterator names its parameter yield, e.g. func(yield func(number) bool)',
    ]);
  });

  it('go into markup, the browser compiler and declarations for TypeScript', () => {
    expect(js(`${COUNT}const list = <ul>{for i in count(2) { <li>{i}</li> }}</ul>`)).toContain(
      'for (const i of count(2)())',
    );
    expect(
      compileInBrowser(`${COUNT}for i in count(2) {\n    const n number = i\n}`).diagnostics,
    ).toEqual([]);
    expect(
      compile(`export ${COUNT}export func pairs(yield func(string, number) bool) {\n}`, {
        declarations: true,
      }).declarations,
    ).toContain(
      'export declare function count(n: number): () => Generator<number, void, unknown>;\nexport declare function pairs(): Generator<[string, number], void, unknown>;',
    );
  });
});
