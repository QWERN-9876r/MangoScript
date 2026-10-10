import type * as ast from './ast.ts';
import { check, type ImportResult, type Library } from './checker/checker.ts';
import type { Type } from './checker/types.ts';
import type { ImportedDecorator } from './codegen/emitter.ts';
import { generateJs } from './codegen/js.ts';
import { printDeclarations } from './declarations.ts';
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
  /** The exports of other imports, from TypeScript declarations; without it, they are untyped. */
  importDeclarations?: ((specifier: string) => ImportResult) | undefined;
  /** Types of the standard library and the DOM beyond the built-in ones. */
  library?: Library | undefined;
  /** Also write a TypeScript declaration file; needs type checking. */
  declarations?: boolean;
}

export interface CompileResult {
  /** The generated ES module; empty when there are diagnostics. */
  code: string;
  diagnostics: Diagnostic[];
  /** Relative paths of the `.mango` modules this file imports, as written in the imports. */
  dependencies: string[];
  /** The `.d.ts` for the module, with the `declarations` option. */
  declarations?: string;
}

export function compileModule(source: string, options: CoreCompileOptions = {}): CompileResult {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return { code: '', diagnostics, dependencies: [] };

  const dependencies = mangoImports(program);

  let types: WeakMap<ast.Expression, Type> | undefined;
  let declarations: string | undefined;

  if (options.typeCheck ?? true) {
    const { importModule, importDeclarations, library } = options;
    const checked = check(program, {
      ...(importModule ? { importModule } : {}),
      ...(importDeclarations ? { importDeclarations } : {}),
      ...(library ? { library } : {}),
    });

    if (checked.diagnostics.length > 0) {
      return { code: '', diagnostics: checked.diagnostics, dependencies };
    }

    types = checked.types;
    if (options.declarations) declarations = printDeclarations(program, checked);
  }

  const code = generateJs(program, {
    source,
    rewriteImports: options.rewriteImports ?? true,
    types,
    ...importedCode(program, options.importModule),
  });

  return { code, diagnostics: [], dependencies, ...(declarations ? { declarations } : {}) };
}

/**
 * What the module imports from other `.mango` modules for the generator: decorators, whose code is
 * inlined, and components, which those modules export as functions.
 */
function importedCode(
  program: ast.Program,
  importModule: CoreCompileOptions['importModule'],
): {
  decorators: Map<string, ImportedDecorator>;
  components: Map<string, ast.ComponentDeclaration>;
} {
  const found = new Map<string, ImportedDecorator>();
  const components = new Map<string, ast.ComponentDeclaration>();

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration' || !statement.source.value.endsWith('.mango')) {
      continue;
    }

    const result = importModule?.(statement.source.value);
    const exports = result && 'exports' in result ? result.exports : undefined;
    const decorators = exports?.decorators;

    for (const specifier of statement.namedImports) {
      const component = exports?.components?.get(specifier.imported.name);

      if (component) components.set(specifier.local.name, component.node);

      const info = decorators?.get(specifier.imported.name);

      if (!info) continue;
      found.set(specifier.local.name, {
        node: info.node,
        moduleNames: info.moduleNames,
        types: info.expressionTypes,
      });
    }
  }

  return { decorators: found, components };
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
