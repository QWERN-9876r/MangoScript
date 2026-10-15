import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { errors as syntaxErrors, first, ty } from './parser-helpers.ts';

// Channels of one direction, as in Go: `chan<- T` only sends and `<-chan T` only receives; a
// `chan T` is both. And a null channel in `select`: its case never goes on.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

/** Runs a program in the main thread; returns what it printed. */
async function run(source: string): Promise<string[]> {
  const { code, diagnostics } = compile(source);
  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  const prototype = Object.getPrototypeOf(async () => {}) as { constructor: unknown };
  const AsyncFunction = prototype.constructor as new (
    ...args: string[]
  ) => (console: unknown) => Promise<void>;

  expect(diagnostics).toEqual([]);
  await new AsyncFunction('console', code)({ log });

  return output;
}

describe('channels of one direction', () => {
  it('parses chan<- T and <-chan T', () => {
    const declared = (source: string) => ty(first(source, 'VariableDeclaration').type!);

    expect(declared('let out chan<- number = ch')).toBe('chan<- number');
    expect(declared('let input <-chan []string = ch')).toBe('<-chan []string');
    // As in Go, `<-` goes with the leftmost `chan`: parentheses make a channel of `<-chan T`.
    expect(declared('let both chan <-chan number = ch')).toBe('chan<- chan number');
    expect(declared('let both chan (<-chan number) = ch')).toBe('chan <-chan number');
    expect(syntaxErrors('func f(out chan<- number, input <-chan number) <-chan bool {}')).toEqual(
      [],
    );
    expect(syntaxErrors('let c <-number = 1')).toEqual([
      expect.stringContaining('"chan" after "<-": a channel that only receives is <-chan T'),
    ]);
  });

  it('takes a chan T where one direction is expected, not the other way round', () => {
    expect(
      errors(`const ch = chan<number>(1)
const input <-chan number = ch
const out chan<- number = ch
const back chan number = input
const wrong chan<- number = input
const other <-chan string = ch`),
    ).toEqual([
      'cannot use <-chan number as chan number',
      'cannot use <-chan number as chan<- number',
      'cannot use chan number as <-chan string',
    ]);
  });

  it('sends only to a channel that sends, and receives only from one that receives', () => {
    expect(
      errors(`async func produce(out chan<- number) {
    out <- 1
    const x = <-out
    for v in out {
    }
    close(out)
}
async func consume(input <-chan number) number {
    input <- 2
    close(input)
    for v in input {
    }
    return <-input
}`),
    ).toEqual([
      '"<-" cannot receive from chan<- number: it only sends; receive from a "chan T" or a "<-chan T"',
      '"for ... in" cannot receive from chan<- number: it only sends; receive from a "chan T" or a "<-chan T"',
      '"<-" cannot send to <-chan number: it only receives; send to a "chan T" or a "chan<- T"',
      'cannot close <-chan number: it only receives, and a channel is closed by its sender',
    ]);
  });

  it('passes values through the directions of one channel', async () => {
    expect(
      await run(`async func produce(out chan<- number) {
    for let i = 1; i <= 3; i++ {
        out <- i
    }
    close(out)
}
async func sum(input <-chan number) number {
    let total = 0
    for n in input {
        total += n
    }
    return total
}
const ch = chan<number>(3)
await produce(ch)
console.log(await sum(ch))`),
    ).toEqual(['6']);
  });
});

describe('a null channel in select', () => {
  it('is allowed only as the channel of a case', () => {
    expect(
      errors(`let maybe ?chan number = null
const out = chan<number>()
select {
case v = <-maybe:
case maybe <- 1:
case out <- <-maybe:
}
const x = <-maybe`),
    ).toEqual([
      '"<-" receives from a channel, not from ?chan number',
      '"<-" receives from a channel, not from ?chan number',
    ]);
  });

  it('turns its case off', async () => {
    expect(
      await run(`let off ?chan string = null
const ready = chan<string>(1)
ready <- "ready"
select {
case text = <-off:
    console.log("never", text)
case off <- "x":
    console.log("never")
case text = <-ready:
    console.log(text)
}
select {
case <-off:
    console.log("never")
default:
    console.log("default")
}`),
    ).toEqual(['ready', 'default']);
  });
});
