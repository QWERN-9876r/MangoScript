// The helpers of `go`: the pool of workers of a module, and the side of the worker. They work with
// Web Workers and with the worker threads of Node, whose API differs: `on("message")` instead of
// `onmessage`, and `unref()`, so that idle workers do not keep the program running.

export type GoHelper = 'go' | 'pool' | 'goLocal' | 'serve';

export const GO_HELPERS: Readonly<Record<GoHelper, readonly string[]>> = {
  /** `go` in a module: a call in a worker of its pool, started by $$startWorker of the module. */
  go: [
    'let $$goPool;',
    '',
    'function $$go(name, args) {',
    '  $$goPool ??= $$pool($$startWorker);',
    '  return $$goPool(name, args);',
    '}',
  ],
  /**
   * Up to one worker per processor, started when needed. A call goes to an idle worker, or to a new
   * one, or else to the one with the fewest calls: a worker runs several of them at once while
   * they wait. Until a worker has started, the calls wait for it with copies of their arguments.
   * The operations of channels in a worker come here too (chan-helpers.ts).
   */
  pool: [
    'function $$pool(start) {',
    '  const size = globalThis.navigator?.hardwareConcurrency ?? 4;',
    '  const workers = [];',
    '  const calls = new Map();',
    '  let ids = 0;',
    '  const fail = (worker, error) => {',
    '    workers.splice(workers.indexOf(worker), 1);',
    '    for (const [id, call] of calls) {',
    '      if (call.worker !== worker) continue;',
    '      calls.delete(id);',
    '      call.reject(error);',
    '    }',
    '  };',
    '  const answer = (thread, { op, channel, value, request }) => {',
    '    const reply = (result) => thread.postMessage({ request, ...result });',
    '    try {',
    '      const done =',
    '        op === "send"',
    '          ? $$send(channel, value)',
    '          : op === "receive"',
    '            ? $$receive(channel, true)',
    '            : $$close(channel);',
    '      Promise.resolve(done).then((value) => reply({ value }), (error) => reply({ error }));',
    '    } catch (error) {',
    '      reply({ error });',
    '    }',
    '  };',
    '  const receive = (worker, { id, ...result }) => {',
    '    if ("op" in result) return answer(worker.thread, result);',
    '    const call = calls.get(id);',
    '    if (!call) return;',
    '    calls.delete(id);',
    '    if (--worker.calls === 0) worker.thread.unref?.();',
    '    if ("error" in result) call.reject(result.error);',
    '    else call.resolve(result.value);',
    '  };',
    '  const add = () => {',
    '    const worker = { thread: null, calls: 0, waiting: [] };',
    '    workers.push(worker);',
    '    start().then(',
    '      (thread) => {',
    '        if (thread.on) {',
    '          thread.on("message", (data) => receive(worker, data));',
    '          thread.on("error", (error) => fail(worker, error));',
    '        } else {',
    '          thread.onmessage = (event) => receive(worker, event.data);',
    '          thread.onerror = (event) => fail(worker, new Error(event.message ?? "a worker failed"));',
    '        }',
    '        worker.thread = thread;',
    '        for (const message of worker.waiting) thread.postMessage(message);',
    '        if (worker.calls === 0) thread.unref?.();',
    '      },',
    '      (error) => fail(worker, error),',
    '    );',
    '    return worker;',
    '  };',
    '  return (name, args) =>',
    '    new Promise((resolve, reject) => {',
    '      const worker =',
    '        workers.find((each) => each.calls === 0) ??',
    '        (workers.length < size ? add() : workers.reduce((a, b) => (b.calls < a.calls ? b : a)));',
    '      const id = ids++;',
    '      if (worker.thread) {',
    '        worker.thread.ref?.();',
    '        worker.thread.postMessage({ id, name, args });',
    '      } else {',
    '        worker.waiting.push({ id, name, args: structuredClone(args) });',
    '      }',
    '      calls.set(id, { resolve, reject, worker });',
    '      worker.calls++;',
    '    });',
    '}',
  ],
  /** `go` inside a goroutine: the function runs in the same worker, with copies of the arguments. */
  goLocal: [
    'function $$go(name, args) {',
    '  const copies = structuredClone(args);',
    '  return Promise.resolve().then(() => $$goroutines[name](...copies));',
    '}',
  ],
  /**
   * The worker: runs the calls that the pool sends and sends back their results or errors; and
   * asks the main thread for the operations of channels, $$ask.
   */
  serve: [
    'let $$port;',
    'const $$asked = new Map();',
    'let $$asks = 0;',
    '',
    'function $$ask(op, channel, value) {',
    '  return new Promise((resolve, reject) => {',
    '    const request = $$asks++;',
    '    $$asked.set(request, { resolve, reject });',
    '    $$port.postMessage({ op, channel, value, request });',
    '  });',
    '}',
    '',
    'async function $$serve(functions) {',
    '  const threads = "node:worker_threads";',
    '  const port =',
    '    typeof postMessage === "function"',
    '      ? globalThis',
    '      : (await import(/* @vite-ignore */ threads)).parentPort;',
    '  $$port = port;',
    '  const receive = async ({ id, name, args, ...reply }) => {',
    '    if ("request" in reply) {',
    '      const asked = $$asked.get(reply.request);',
    '      $$asked.delete(reply.request);',
    '      if ("error" in reply) asked.reject(reply.error);',
    '      else asked.resolve(reply.value);',
    '      return;',
    '    }',
    '    try {',
    '      port.postMessage({ id, value: await functions[name](...args) });',
    '    } catch (error) {',
    '      try {',
    '        port.postMessage({ id, error });',
    '      } catch {',
    '        port.postMessage({ id, error: new Error(String(error)) });',
    '      }',
    '    }',
    '  };',
    '  if (port.on) port.on("message", receive);',
    '  else port.onmessage = (event) => receive(event.data);',
    '}',
  ],
};

/**
 * The start of a worker of a module: a Web Worker, or a worker thread of Node. Node takes only the
 * path of a `file:` URL, without the query of `app.mango?worker`, so its worker starts with a
 * module that imports the whole URL. An absolute URL, such as the Blob of the playground, is used
 * as it is.
 */
export function startWorker(url: string): string[] {
  const base = /^[a-z][a-z\d+.-]*:/i.test(url) ? '' : ', import.meta.url';
  const workerUrl = `new URL(${JSON.stringify(url)}${base})`;

  return [
    'async function $$startWorker() {',
    '  if (typeof Worker === "function") {',
    `    return new Worker(${workerUrl}, { type: "module" });`,
    '  }',
    '  const threads = "node:worker_threads";',
    '  const { Worker: NodeWorker } = await import(/* @vite-ignore */ threads);',
    `  const code = \`import \${JSON.stringify(${workerUrl}.href)};\`;`,
    '  return new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(code)}`));',
    '}',
  ];
}
