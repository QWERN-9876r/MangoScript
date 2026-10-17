import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile as compileInBrowser } from '../src/browser.ts';
import { compile } from '../src/index.ts';
import { errors as parseErrors, expr, sx } from './parser-helpers.ts';

// Streams and channels: `chan(stream, size)` receives the chunks of a ReadableStream into a
// channel, with a second channel for the error of the stream, and `stream(ch)` is a ReadableStream
// that reads a channel. The room of the channel is the backpressure of the stream.

function errors(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.message);
}

/** Runs a program in the main thread, with `globals`, streams made by the test, as `any`. */
async function run(program: string, globals: Record<string, unknown> = {}): Promise<string[]> {
  const names = Object.keys(globals);
  const preamble = names.map((name) => `const ${name} = (globalThis as any).${name}\n`).join('');
  const { code, diagnostics } = compile(preamble + program);
  const output: string[] = [];
  const log = (...args: unknown[]) => output.push(args.map(String).join(' '));
  const prototype = Object.getPrototypeOf(async () => {}) as { constructor: unknown };
  const AsyncFunction = prototype.constructor as new (
    ...args: string[]
  ) => (console: unknown) => Promise<void>;

  expect(diagnostics).toEqual([]);
  Object.assign(globalThis, globals);
  try {
    await new AsyncFunction('console', code)({ log });
  } finally {
    for (const name of names) Reflect.deleteProperty(globalThis, name);
  }

  return output;
}

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Builds a program and runs it with Node, with workers; returns what it printed. */
function runBuilt(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rook-streams-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.rk'), source);
  expect(spawnSync(process.execPath, [cli, 'build', 'main.rk'], options).stderr).toBe('');

  const { stdout, stderr } = spawnSync(process.execPath, ['main.js'], options);

  expect(stderr).toBe('');

  return stdout;
}

/** A source of `count` chunks that counts how many it was asked for. */
function counted(count: number) {
  const source = { pulls: 0, cancelled: false, stream: null as unknown };

  source.stream = new ReadableStream<string>(
    {
      pull(controller) {
        source.pulls++;
        if (source.pulls > count) controller.close();
        else controller.enqueue(`chunk ${source.pulls}`);
      },
      cancel() {
        source.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return source;
}

describe('syntax', () => {
  it('parses chan(stream) and chan(stream, size) beside chan<T>(size)', () => {
    expect(sx(expr('chan(res.body)'))).toBe('(chan-stream (. res body))');
    expect(sx(expr('chan(body, 4)'))).toBe('(chan-stream body 4)');
    expect(sx(expr('chan<number>(4)'))).toBe('(chan number 4)');
    expect(parseErrors('const a, b = chan(body, 4)')).toEqual([]);
    expect(parseErrors('const c = chan[number](4)')[0]).toContain('chan(stream, size)');
  });
});

describe('types', () => {
  it('gives a channel of the chunks and one of the error', () => {
    expect(
      errors(`const text = new Blob(["text"]).stream().pipeThrough(new TextDecoderStream())
const lines, _ = chan(text)
const n number = lines`),
    ).toEqual(['cannot use chan string as number']);
    expect(
      errors(`const response = new Response("text")
const chunks, failed = chan(response.body, 4)
const bytes chan []byte = chunks
const errs <-chan error = failed
const n number = chunks`),
    ).toEqual(['cannot use chan []byte as number']);
  });

  it('takes only a stream, and gives two values', () => {
    expect(errors('const ch = chan(5)')).toEqual([
      'chan(...) takes a ReadableStream, not number; a channel of values is made as chan<T>(size), e.g. chan<number>(10)',
    ]);
    expect(errors('const a, b = chan(5)')).toEqual([
      'chan(...) takes a ReadableStream, not number; a channel of values is made as chan<T>(size), e.g. chan<number>(10)',
    ]);
    expect(errors('const a, b = chan(new Response("x").body, "4")')).toEqual([
      'cannot use string as number',
    ]);
    expect(errors('const chunks = chan(new Response("x").body)')).toEqual([
      'chan(stream) returns 2 values: unpack them, e.g. "const a, b = ..."',
    ]);
    expect(errors('const a, b, c = chan(new Response("x").body)')).toEqual([
      'assignment mismatch: 3 variables but chan(stream) returns 2 values',
    ]);
  });

  it('makes a stream of the values of a channel that receives', () => {
    expect(
      errors(`const lines = chan<string>(4)
const body ReadableStream<string> = stream(lines)
const n number = stream(lines)`),
    ).toEqual(['cannot use ReadableStream<string> as number']);
    expect(
      errors(`func pipe(out chan<- string) any {
    return stream(out)
}`),
    ).toEqual([
      'stream() reads a channel, and chan<- string only sends; give it a "chan T" or a "<-chan T"',
    ]);
  });

  it('takes any stream in the browser, where the stream types are not known', () => {
    expect(
      compileInBrowser(`const response = await fetch("data.txt")
const chunks, failed = chan(response.body)
const s = stream(chunks)`).diagnostics,
    ).toEqual([]);
  });
});

describe('code', () => {
  it('calls the helpers with the zero value of the chunks', () => {
    const { code } = compile(`const chunks, failed = chan(new Response("x").body, 2)
const body = stream(chunks)`);

    expect(code).toContain(
      'const [chunks, failed] = $$fromStream(new Response("x").body, 2, new Uint8Array());',
    );
    expect(code).toContain('const body = $$stream(chunks);');
    expect(code).toContain('function $$fromStream(');
    expect(code).toContain('function $$chan(');
  });
});

describe('runtime', () => {
  it('receives the chunks of a stream, then null from the channel of the error', async () => {
    expect(
      await run(`const text = new Blob(["one ", "two ", "three"]).stream().pipeThrough(new TextDecoderStream())
const chunks, failed = chan(text)
let all = ""
for chunk in chunks {
    all += chunk
}
console.log(all, <-failed)
const v, ok = <-chunks
console.log(JSON.stringify(v), ok)`),
    ).toEqual(['one two three null', '"" false']);
  });

  it('reads the stream only as fast as the channel takes the chunks', async () => {
    const source = counted(100);

    expect(
      await run(
        `const chunks, failed = chan(source.stream, 2)
<-after(20)
console.log(source.pulls)
console.log(<-chunks)
<-after(20)
console.log(source.pulls)`,
        { source },
      ),
    ).toEqual(['3', 'chunk 1', '4']);
  });

  it('cancels the stream when the channel is closed', async () => {
    const source = counted(100);

    expect(
      await run(
        `const chunks, failed = chan(source.stream, 1)
console.log(<-chunks)
close(chunks)
console.log(<-failed)
<-after(10)
console.log(source.cancelled)`,
        { source },
      ),
    ).toEqual(['chunk 1', 'null', 'true']);
  });

  it('gives the error of a stream that fails, after its chunks', async () => {
    const broken = new ReadableStream<string>({
      start(controller) {
        controller.enqueue('first');
        setTimeout(() => controller.error(new Error('connection lost')), 5);
      },
    });

    expect(
      await run(
        `const chunks, failed = chan(broken, 4)
for chunk in chunks {
    console.log(chunk)
}
const err = <-failed
console.log(err?.message)`,
        { broken },
      ),
    ).toEqual(['first', 'connection lost']);
  });

  it('gives a closed channel for a null stream', async () => {
    expect(
      await run(`const chunks, failed = chan(new Response(null).body)
const _, ok = <-chunks
console.log(ok, <-failed)`),
    ).toEqual(['false null']);
  });

  it('makes a stream that reads a channel until it is closed', async () => {
    expect(
      await run(`const words = chan<string>(1)
async func say() {
    for word in ["streams", " and ", "channels"] {
        words <- word
    }
    close(words)
}
say()
console.log(await new Response(stream(words).pipeThrough(new TextEncoderStream())).text())`),
    ).toEqual(['streams and channels']);
  });

  it('passes the chunks to a goroutine in another thread', () => {
    expect(
      runBuilt(`async func count(chunks <-chan string) number {
    let words = 0
    for chunk in chunks {
        words += chunk.split(" ").filter(w => w != "").length
    }
    return words
}

const text = new Blob(["one two ", "three four ", "five"]).stream().pipeThrough(new TextDecoderStream())
const chunks, failed = chan(text, 2)
console.log(await go count(chunks), <-failed)
`),
    ).toBe('5 null\n');
  });
});
