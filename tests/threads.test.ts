import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pool of workers and the threads of channels: calls wait in one queue for a free worker, the
// modules of a program share the pool, a channel lives in the thread that made it, and the other
// threads talk to that thread directly, also while the main thread is busy.

const cli = new URL('../src/cli.ts', import.meta.url).pathname;

/** Builds the files of a program, `main.rk` first, and runs it with Node. */
function run(files: Record<string, string>): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rook-threads-'));
  const options = { cwd: dir, encoding: 'utf8' as const, timeout: 30_000 };

  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
  expect(spawnSync(process.execPath, [cli, 'build', ...Object.keys(files)], options).stderr).toBe(
    '',
  );

  return spawnSync(process.execPath, ['main.js'], options);
}

const spin = `func spin(ms number) []number {
    const start = Date.now()
    for Date.now() < start + ms {
    }
    return [start, Date.now()]
}
`;

describe('the pool', { timeout: 60_000 }, () => {
  it('gives a call to the first worker that is free, not to one that is still busy', () => {
    const { stdout, stderr } = run({
      'main.rk': `${spin}
const order []string = []
const calls []Promise<number> = [(go spin(2000)).then(() => order.push("long"))]
for let i = 1; i < navigator.hardwareConcurrency; i++ {
    calls.push((go spin(300)).then(() => 0))
}
calls.push((go spin(10)).then(() => order.push("short")))
for call in calls {
    await call
}
console.log(order.join(" "))
`,
    });

    expect(stderr).toBe('');
    expect(stdout).toBe('short long\n');
  });

  it('is shared by the modules of a program: no more workers than processors', () => {
    const work = `${spin}
export async func spinAll(count number) [][]number {
    const calls []Promise<[]number> = []
    for let i = 0; i < count; i++ {
        calls.push(go spin(150))
    }
    const spans [][]number = []
    for call in calls {
        spans.push(await call)
    }
    return spans
}
`;
    const { stdout, stderr } = run({
      'main.rk': `import { spinAll as other } from "./other.rk"
${work}
const size = navigator.hardwareConcurrency
const first = spinAll(size)
const second = other(size)
const spans = [...(await spinAll(size)), ...(await first), ...(await second)]
let most = 0
// How many calls ran when each one started.
for span in spans {
    const running = spans.filter(other => other[0] <= span[0] && span[0] < other[1])
    most = Math.max(most, running.length)
}
console.log(most <= size)
`,
      'other.rk': work,
    });

    expect(stderr).toBe('');
    expect(stdout).toBe('true\n');
  });
});

describe('channels between threads', { timeout: 60_000 }, () => {
  it('connects workers directly, also while the main thread is busy', () => {
    const { stdout, stderr } = run({
      'main.rk': `async func produce(out chan chan number) {
    const pipe = chan<number>()
    out <- pipe
    for let i = 1; i <= 100; i++ {
        pipe <- i
    }
    close(pipe)
}
async func consume(pipe chan number, ready chan bool) []number {
    ready <- true
    let sum = 0
    for n in pipe {
        sum += n
    }
    return [sum, Date.now()]
}
const out = chan<chan number>(1)
const ready = chan<bool>(1)
go produce(out)
const pipe = <-out
if pipe == null {
    throw error("no pipe")
}
const total = go consume(pipe, ready)
<-ready
const busyUntil = Date.now() + 1500
for Date.now() < busyUntil {
}
const result = await total
console.log(result[0], result[1] < busyUntil)
`,
    });

    expect(stderr).toBe('');
    expect(stdout).toBe('5050 true\n');
  });

  it('runs selects whose cases wait in channels of several threads', () => {
    const { stdout, stderr } = run({
      'main.rk': `async func sender(link chan number, own chan chan bool, count number) {
    const quit = chan<bool>()
    own <- quit
    for let i = 0; i < count; i++ {
        select {
        case link <- i:
        case <-quit:
            return
        }
    }
}
async func receiver(link chan number, own chan chan bool, count number) number {
    const quit = chan<bool>()
    own <- quit
    let sum = 0
    for let i = 0; i < count; i++ {
        select {
        case n = <-link:
            sum += n
        case <-quit:
            return -1
        }
    }
    return sum
}
const link = chan<number>()
const own = chan<chan bool>(2)
go sender(link, own, 200)
const sum = go receiver(link, own, 200)
const quits = [<-own, <-own]
console.log(await sum)

// The main thread selects over a channel of a worker and one of its own.
const tick = chan<number>(1)
tick <- 7
for quit in quits {
    if quit == null {
        continue
    }
    setTimeout(() => close(quit), 50)
    select {
    case <-quit:
        console.log("quit")
    case n = <-tick:
        console.log("tick", n)
    }
}
`,
    });

    expect(stderr).toBe('');
    expect(stdout).toBe('19900\ntick 7\nquit\n');
  });
});
