import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { check, type ImportResult, type ModuleExports } from './checker/checker.ts';
import { markupFor } from './config.ts';
import { parse } from './parser/parser.ts';
import { importDeclarations, libraryFor } from './typescript/importer.ts';

/** Exports of checked modules, by path; reused while the file does not change. */
const cache = new Map<string, { version: string; exports: ModuleExports }>();
const loading = new Set<string>();

/** Finds the types exported by a `.rk` module imported from the file `fromFile`. */
export function loadModuleExports(
  fromFile: string,
  specifier: string,
  markup?: boolean,
): ImportResult {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;

  const path = resolve(dirname(fromFile), specifier);

  let version: string;

  try {
    const stats = statSync(path);

    version = `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return { error: `cannot find module "${specifier}"` };
  }

  const cached = cache.get(path);

  if (cached?.version === version) return { exports: cached.exports };

  // An import cycle: the module is being checked further up the chain, so it is untyped here.
  if (loading.has(path)) return undefined;
  loading.add(path);
  try {
    // The markup of the CLI or the Vite plugin, else that of the package of the module.
    const { program, diagnostics } = parse(readFileSync(path, 'utf8'), {
      markup: markup ?? markupFor(path),
    });

    // Syntax errors in the imported module are reported when that module itself is compiled.
    if (diagnostics.length > 0) return undefined;

    const { exports } = check(program, {
      importModule: (next) => loadModuleExports(path, next, markup),
      importDeclarations: (next) => importDeclarations(path, next),
      library: libraryFor(path),
    });

    cache.set(path, { version, exports });

    return { exports };
  } finally {
    loading.delete(path);
  }
}
