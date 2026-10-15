import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { displayPath } from './build.ts';
import { compileFile } from './compile-file.ts';

// `mango run` imports this module first (`node --import`): Node then imports `.mango` files,
// compiled when they load, and `app.mango?worker` is the worker module of `go` in app.mango. The
// worker threads of `go` import it too, since they get the `--import` of the process; the main
// thread has printed the warnings already. They check the types again, since the code depends on
// them (`for v in ch` over a channel). MANGO_NO_CHECK turns type checking off.

const typeCheck = process.env['MANGO_NO_CHECK'] === undefined;

registerHooks({
  load(url, context, nextLoad) {
    const { protocol, pathname, search } = new URL(url);

    if (protocol !== 'file:' || !pathname.endsWith('.mango')) return nextLoad(url, context);

    const path = displayPath(fileURLToPath(new URL(pathname, url)));
    const result = compileFile(path, { rewriteImports: false, typeCheck, quiet: !isMainThread });
    const source = search === '?worker' ? (result.worker ?? '') : result.code;

    return { format: 'module', source, shortCircuit: true };
  },
});
