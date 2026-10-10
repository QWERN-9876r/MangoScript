import { dirname, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { formatDiagnostic } from './diagnostics.ts';
import { compile } from './index.ts';
import { SourceFile } from './source.ts';

// A Vite plugin for MangoScript: `.mango` modules are compiled when Vite loads them, with type
// checking, so `import { App } from "./app.mango"` works in a Vite project. Type errors stop the
// build and show up in the browser overlay of the dev server.

export interface MangoPluginOptions {
  /** Check types before generating code. Defaults to `true`. */
  typeCheck?: boolean;
}

export function mango(options: MangoPluginOptions = {}): Plugin {
  const typeCheck = options.typeCheck ?? true;
  let root = process.cwd();

  return {
    name: 'mangoscript',
    configResolved(config) {
      root = config.root;
    },
    transform(source, id) {
      // `app.mango?raw` and the like are left to Vite.
      if (!id.endsWith('.mango')) return null;

      // Imports keep `.mango`: Vite resolves them and gives them to this plugin again.
      const result = compile(source, { filename: id, rewriteImports: false, typeCheck });

      if (result.diagnostics.length > 0) {
        const file = new SourceFile(relative(root, id), source);
        const { line, column } = file.position(result.diagnostics[0]!.start);

        this.error({
          message: result.diagnostics.map((d) => formatDiagnostic(file, d)).join('\n\n'),
          id,
          // Vite counts columns from 0.
          loc: { line, column: column - 1 },
        });
      }

      // The code of imported decorators is inlined here, and their types are used: when an
      // imported module changes, this one is compiled again.
      for (const dependency of result.dependencies) {
        this.addWatchFile(resolve(dirname(id), dependency));
      }

      return { code: result.code, map: null };
    },
  };
}
