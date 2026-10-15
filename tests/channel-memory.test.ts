import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';

// What channels keep: a `select` that has gone on leaves the queues of its other channels, and a
// channel that no value holds any more, in any thread, is forgotten by the registry.

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** What the registry has for each channel after a program runs in the main thread. */
async function queues(source: string): Promise<{ receivers: number; senders: number }[]> {
  const { code, diagnostics } = compile(source);
  const key = Symbol.for('mangoscript.channels');
  const prototype = Object.getPrototypeOf(async () => {}) as { constructor: unknown };
  const AsyncFunction = prototype.constructor as new (...args: string[]) => () => Promise<void>;

  expect(diagnostics).toEqual([]);
  Reflect.deleteProperty(globalThis, key);
  await new AsyncFunction(code)();

  const registry = Reflect.get(globalThis, key) as {
    states: Map<string, { receivers: unknown[]; senders: unknown[] }>;
  };

  return [...registry.states.values()].map(({ receivers, senders }) => ({
    receivers: receivers.length,
    senders: senders.length,
  }));
}

/**
 * Builds a program and runs it with collections forced in both threads; the program prints how many
 * channels the registry has left.
 */
function channelsLeft(source: string): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mango-hold-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.mango'), source);
  expect(spawnSync(process.execPath, [cli, 'build', 'main.mango'], options).stderr).toBe('');
  appendFileSync(join(dir, 'main.worker.js'), 'setInterval(() => globalThis.gc(), 10).unref();\n');
  appendFileSync(
    join(dir, 'main.js'),
    `for (let i = 0; i < 10; i++) {
  globalThis.gc();
  await new Promise((resolve) => setTimeout(resolve, 30));
}
console.log(globalThis[Symbol.for("mangoscript.channels")].states.size);
`,
  );

  return spawnSync(process.execPath, ['--expose-gc', 'main.js'], options);
}

describe('select', () => {
  it('takes its waiting cases off the other channels', async () => {
    const left = await queues(`const jobs = chan<number>()
const quit = chan<bool>()
async func produce() {
    for let i = 0; i < 100; i++ {
        await Promise.resolve(0)
        jobs <- i
    }
}
produce()
for let i = 0; i < 100; i++ {
    select {
    case <-jobs:
    case <-quit:
    case quit <- true:
    }
}`);

    expect(left).toEqual([
      { receivers: 0, senders: 0 },
      { receivers: 0, senders: 0 },
    ]);
  });
});

describe('the registry', { timeout: 30_000 }, () => {
  it('forgets channels that no thread holds', () => {
    const { stdout, stderr } = channelsLeft(`func after(ms number) chan bool {
    const ch = chan<bool>(1)
    setTimeout(async () => {
        ch <- true
    }, ms)
    return ch
}
async func echo(input chan number, out chan number) {
    out <- <-input
}
async func run() {
    for let i = 0; i < 100; i++ {
        select {
        case <-after(0):
        }
    }
    for let i = 0; i < 10; i++ {
        const a = chan<number>(1)
        const b = chan<number>(1)
        a <- i
        await go echo(a, b)
        <-b
    }
}
const kept = chan<number>(1)
await run()
`);

    expect(stderr).toBe('');
    expect(stdout).toBe('1\n');
  });
});
