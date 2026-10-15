import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { displayPath } from './build.ts';
import { compileFile } from './compile-file.ts';

// `mango run` imports this module first (`node --import`): Node then imports `.mango` files,
// compiled when they load, and `app.mango?goroutines` is the worker module of `go` in app.mango.
// The worker threads of `go` import it too, since they get the `--import` of the process. The main
// thread compiles a module before any worker needs it, so it leaves the code of each module and
// of its worker module in MANGO_RUN_CACHE, a directory of the run, and the workers take it from
// there: compiling again, with the types, would take each of them as long. MANGO_NO_CHECK turns
// type checking off.

const typeCheck = process.env['MANGO_NO_CHECK'] === undefined;
const cache = process.env['MANGO_RUN_CACHE'];

/** The file of the cache for the code of a URL, query included. */
function cached(url: string): string | null {
  return cache ? join(cache, `${createHash('sha1').update(url).digest('hex')}.js`) : null;
}

registerHooks({
  load(url, context, nextLoad) {
    const { protocol, pathname, search } = new URL(url);

    if (protocol !== 'file:' || !pathname.endsWith('.mango')) return nextLoad(url, context);

    const file = cached(url);

    if (!isMainThread && file && existsSync(file)) {
      return { format: 'module', source: readFileSync(file, 'utf8'), shortCircuit: true };
    }

    const moduleUrl = new URL(pathname, url).href;
    const path = displayPath(fileURLToPath(moduleUrl));
    const result = compileFile(path, { rewriteImports: false, typeCheck, quiet: !isMainThread });

    if (isMainThread && cache) {
      writeFileSync(cached(moduleUrl)!, result.code);
      if (result.worker !== undefined) {
        writeFileSync(cached(`${moduleUrl}?goroutines`)!, result.worker);
      }
    }

    const source = search === '?goroutines' ? (result.worker ?? '') : result.code;

    return { format: 'module', source, shortCircuit: true };
  },
});
