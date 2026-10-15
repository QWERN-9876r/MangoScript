import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';

// `after(ms)` and `tick(ms)`, channels of time as in Go, and `cancel(task)`, which stops a
// goroutine of `go`.

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

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Builds a program and runs it with Node, with workers. */
function runBuilt(source: string): { stdout: string; stderr: string; time: number } {
  const dir = mkdtempSync(join(tmpdir(), 'mango-timers-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 20_000 };

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, 'main.mango'), source);
  expect(spawnSync(process.execPath, [cli, 'build', 'main.mango'], options).stderr).toBe('');

  const started = Date.now();
  const { stdout, stderr } = spawnSync(process.execPath, ['main.js'], options);

  return { stdout, stderr, time: Date.now() - started };
}

const spin = `func spin() number {
    let n = 0
    for {
        n++
    }
    return n
}
`;

describe('types', () => {
  it('gives after a channel that only receives, tick one that can be closed', () => {
    expect(
      errors(`const once <-chan number = after(10)
const ticks chan number = tick(10)
close(ticks)
close(after(10))
after(10) <- 1`),
    ).toEqual([
      'cannot close <-chan number: it only receives, and a channel is closed by its sender',
      '"<-" cannot send to <-chan number: it only receives; send to a "chan T" or a "chan<- T"',
    ]);
  });

  it('cancels only the Promise of a goroutine', () => {
    expect(errors('cancel(5)')).toEqual([
      'cancel() stops a goroutine: give it the Promise of "go", not number, e.g. "const task = go work(x)" and "cancel(task)"',
    ]);
  });

  it('lets declarations hide them', () => {
    const { code, diagnostics } = compile(`func after(ms number) string {
    return "later"
}
console.log(after(1))`);

    expect(diagnostics).toEqual([]);
    expect(code).toContain('console.log(after(1));');
    expect(code).not.toContain('$$after');
  });
});

describe('timers', () => {
  it('sends the time once after a while, and every while until close', async () => {
    expect(
      await run(`const started = Date.now()
const at = <-after(30)
console.log(at - started >= 25)
const ticks = tick(5)
let count = 0
for count < 3 {
    <-ticks
    count++
}
close(ticks)
select {
case <-after(50):
    console.log("timeout")
case <-chan<bool>():
}`),
    ).toEqual(['true', 'timeout']);
  });
});

describe('cancel', { timeout: 30_000 }, () => {
  it('stops a worker in the middle of a loop', () => {
    const { stdout, stderr, time } = runBuilt(`${spin}
func square(n number) number {
    return n * n
}
const task = go spin()
<-after(100)
cancel(task)
try {
    await task
} catch e {
    console.log(e.message)
}
console.log(await go square(4))
cancel(task)
`);

    expect(stderr).toBe('');
    expect(stdout).toBe('goroutine cancelled\n16\n');
    expect(time).toBeLessThan(10_000);
  });

  it('takes a call that waits for a worker off the queue', () => {
    const { stdout, stderr } = runBuilt(`${spin}
func square(n number) number {
    return n * n
}
const spinning []Promise<number> = []
for let i = 0; i < navigator.hardwareConcurrency; i++ {
    spinning.push(go spin())
}
const waiting = go square(3)
cancel(waiting)
try {
    await waiting
} catch e {
    console.log(e.message)
}
for task in spinning {
    cancel(task)
}
console.log("done")
`);

    expect(stderr).toBe('');
    expect(stdout).toBe('goroutine cancelled\ndone\n');
  });

  it('fails the Promise of a goroutine in the same worker', () => {
    const { stdout, stderr } = runBuilt(`async func outer() string {
    const inner = go async func() number {
        <-after(10_000)
        return 1
    }()
    cancel(inner)
    try {
        await inner
        return "not cancelled"
    } catch e {
        return e.message
    }
}
console.log(await go outer())
`);

    expect(stderr).toBe('');
    expect(stdout).toBe('goroutine cancelled\n');
  });
});
