import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { formatDiagnostic } from './diagnostics.ts';
import { compile } from './index.ts';
import { SourceFile } from './source.ts';

// A Vite plugin for MangoScript: `.mango` modules are compiled when Vite loads them, with type
// checking, so `import { App } from "./app.mango"` works in a Vite project. Type errors stop the
// build and show up in the browser overlay of the dev server. `app.mango.goroutines.js` is the
// worker module of `go` in app.mango, which Vite bundles as a worker: it is not a file, and its
// path has no query, since Vite drops the query of a worker's URL.

const GOROUTINES = '.goroutines.js';

export interface MangoPluginOptions {
  /** Check types before generating code. Defaults to `true`. */
  typeCheck?: boolean;
}

export function mango(options: MangoPluginOptions = {}): Plugin {
  const typeCheck = options.typeCheck ?? true;
  let root = process.cwd();

  return {
    name: 'mangoscript',
    // Vite bundles workers with plugins of their own: the worker modules of `go` need this one too,
    // and they are ES modules.
    config(config) {
      const plugins = config.worker?.plugins;

      return {
        worker: { format: 'es', plugins: () => [...(plugins?.() ?? []), mango(options)] },
      };
    },
    configResolved(config) {
      root = config.root;
    },
    resolveId(source, importer) {
      const [path = source] = source.split('?');

      if (!path.endsWith(`.mango${GOROUTINES}`)) return null;
      if (!isAbsolute(path)) return resolve(dirname(importer ?? join(root, 'index.html')), path);

      // `/app.mango.goroutines.js` from the dev server is a path in the root.
      return path.startsWith(root) ? path : join(root, path);
    },
    load(id) {
      const [path = id] = id.split('?');

      if (!path.endsWith(`.mango${GOROUTINES}`)) return null;

      return readFileSync(path.slice(0, -GOROUTINES.length), 'utf8');
    },
    transform(source, id) {
      const [name = id, query] = id.split('?');
      const worker = name.endsWith(`.mango${GOROUTINES}`);
      const path = worker ? name.slice(0, -GOROUTINES.length) : name;

      // `app.mango?raw` and the like are left to Vite; it adds queries of its own to workers.
      if (!path.endsWith('.mango') || (query !== undefined && !worker)) return null;

      // Imports keep `.mango`: Vite resolves them and gives them to this plugin again.
      const result = compile(source, {
        filename: path,
        rewriteImports: false,
        typeCheck,
        workerUrl: `./${basename(path)}${GOROUTINES}`,
      });
      const file = new SourceFile(relative(root, path), source);
      // Vite counts columns from 0.
      const loc = (start: number) => {
        const { line, column } = file.position(start);

        return { line, column: column - 1 };
      };

      for (const warning of result.warnings) {
        this.warn({
          message: formatDiagnostic(file, warning, 'warning'),
          id,
          loc: loc(warning.start),
        });
      }

      if (result.diagnostics.length > 0) {
        this.error({
          message: result.diagnostics.map((d) => formatDiagnostic(file, d)).join('\n\n'),
          id,
          loc: loc(result.diagnostics[0]!.start),
        });
      }

      // The code of imported decorators is inlined here, and their types are used: when an
      // imported module changes, this one is compiled again.
      for (const dependency of result.dependencies) {
        this.addWatchFile(resolve(dirname(path), dependency));
      }

      return { code: worker ? (result.worker ?? '') : result.code, map: null };
    },
  };
}
