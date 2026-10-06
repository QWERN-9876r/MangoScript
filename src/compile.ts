import type * as ast from './ast.ts';
import { check, type ImportResult } from './checker/checker.ts';
import type { Type } from './checker/types.ts';
import { generateJs } from './codegen/js.ts';
import type { Diagnostic } from './diagnostics.ts';
import { parse } from './parser/parser.ts';

// Compiling one module, without access to files: the browser uses this directly (src/browser.ts),
// Node adds reading imported modules from disk (src/index.ts).

export interface CoreCompileOptions {
  /** Replace `.mango` with `.js` in relative import paths. Defaults to `true`. */
  rewriteImports?: boolean;
  /** Check types before generating code. Defaults to `true`. */
  typeCheck?: boolean;
  /** The exports of an imported `.mango` module; without it, imports are untyped (`any`). */
  importModule?: ((specifier: string) => ImportResult) | undefined;
}

export interface CompileResult {
  /** The generated ES module; empty when there are diagnostics. */
  code: string;
  diagnostics: Diagnostic[];
  /** Relative paths of the `.mango` modules this file imports, as written in the imports. */
  dependencies: string[];
}

export function compileModule(source: string, options: CoreCompileOptions = {}): CompileResult {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return { code: '', diagnostics, dependencies: [] };
  const dependencies = mangoImports(program);

  let types: WeakMap<ast.Expression, Type> | undefined;
  if (options.typeCheck ?? true) {
    const { importModule } = options;
    const checked = check(program, importModule ? { importModule } : {});
    if (checked.diagnostics.length > 0) {
      return { code: '', diagnostics: checked.diagnostics, dependencies };
    }
    types = checked.types;
  }

  const code = generateJs(program, {
    source,
    rewriteImports: options.rewriteImports ?? true,
    types,
  });
  return { code, diagnostics: [], dependencies };
}

function mangoImports(program: ast.Program): string[] {
  const specifiers = new Set<string>();
  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration') continue;
    const path = statement.source.value;
    if (/^\.{1,2}\//.test(path) && path.endsWith('.mango')) specifiers.add(path);
  }
  return [...specifiers];
}
