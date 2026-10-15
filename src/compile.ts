import type * as ast from './ast.ts';
import { check, type ImportResult, type Library, type ModuleExports } from './checker/checker.ts';
import { property, STRING, type Type } from './checker/types.ts';
import type { ImportedDecorator } from './codegen/emitter.ts';
import type { ImportedComponent } from './codegen/imported.ts';
import { generateJs } from './codegen/js.ts';
import { printDeclarations } from './declarations.ts';
import type { Diagnostic } from './diagnostics.ts';
import { goExpressions, goTarget, workerProgram } from './goroutines.ts';
import { parse } from './parser/parser.ts';
import { isStyleModule, styleModule, unusedClasses, type StyleModule } from './style-modules.ts';

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
  /** The text of an imported CSS module, `./button.module.css`, or null if it cannot be read. */
  readStyleModule?: ((specifier: string) => string | null) | undefined;
  /** Where the worker module of `go` is, relative to the module; see workerUrl(). */
  workerUrl?: string | undefined;
}

/**
 * Where the worker module of a module is: a `.worker.js` next to its `.js`, or, where `.mango`
 * files are imported as they are (`mango run`, Vite), the module itself with `?worker`.
 */
export function workerUrl(file: string, rewriteImports: boolean): string {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.mango$/, '');

  return rewriteImports ? `./${base}.worker.js` : `./${base}.mango?worker`;
}

export interface CompileResult {
  /** The generated ES module; empty when there are diagnostics. */
  code: string;
  diagnostics: Diagnostic[];
  /** Problems that do not stop compilation, sorted by position. */
  warnings: Diagnostic[];
  /** Relative paths of the `.mango` modules and CSS modules this file imports, as written. */
  dependencies: string[];
  /** The `.d.ts` for the module, with the `declarations` option. */
  declarations?: string;
  /** The worker module that runs the functions `go` calls, when the module has `go`. */
  worker?: string;
}

export function compileModule(source: string, options: CoreCompileOptions = {}): CompileResult {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return { code: '', diagnostics, warnings: [], dependencies: [] };

  const dependencies = localImports(program);
  const { styleModules, problems } = readStyleModules(program, options.readStyleModule);

  if (problems.length > 0) return { code: '', diagnostics: problems, warnings: [], dependencies };

  let types: WeakMap<ast.Expression, Type> | undefined;
  let declarations: string | undefined;
  let warnings: Diagnostic[] = [];

  if (options.typeCheck ?? true) {
    const { importModule, importDeclarations, library } = options;
    // A CSS module has a default export: an object with a string for each of its classes.
    const importStyles = (specifier: string): ImportResult => {
      const module = styleModules.get(specifier);

      return module
        ? { exports: styleModuleExports(specifier, module) }
        : importDeclarations?.(specifier);
    };
    const checked = check(program, {
      ...(importModule ? { importModule } : {}),
      importDeclarations: importStyles,
      ...(library ? { library } : {}),
    });

    warnings = [...checked.warnings, ...unusedStyleClasses(program, styleModules)].sort(
      (a, b) => a.start - b.start,
    );
    if (checked.diagnostics.length > 0) {
      return { code: '', diagnostics: checked.diagnostics, warnings, dependencies };
    }

    types = checked.types;
    if (options.declarations) declarations = printDeclarations(program, checked);
  }

  const rewriteImports = options.rewriteImports ?? true;
  const jsOptions = {
    source,
    rewriteImports,
    types,
    styleModules,
    ...importedCode(program, options.importModule),
  };
  const code = generateJs(program, {
    ...jsOptions,
    goroutines: { workerUrl: options.workerUrl ?? workerUrl('main.mango', rewriteImports) },
  });
  const targets = [...new Set(goExpressions(program).flatMap((node) => goTarget(node) ?? []))];
  const worker =
    targets.length > 0
      ? generateJs(workerProgram(program, targets), { ...jsOptions, goroutines: { targets } })
      : undefined;

  return {
    code,
    diagnostics: [],
    warnings,
    dependencies,
    ...(declarations ? { declarations } : {}),
    ...(worker === undefined ? {} : { worker }),
  };
}

/**
 * What the module imports from other `.mango` modules for the generator: decorators, whose code is
 * inlined, and components, which are called or inlined.
 */
function importedCode(
  program: ast.Program,
  importModule: CoreCompileOptions['importModule'],
): {
  decorators: Map<string, ImportedDecorator>;
  components: Map<string, ImportedComponent>;
} {
  const found = new Map<string, ImportedDecorator>();
  const components = new Map<string, ImportedComponent>();

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration' || !statement.source.value.endsWith('.mango')) {
      continue;
    }

    const result = importModule?.(statement.source.value);
    const exports = result && 'exports' in result ? result.exports : undefined;
    const decorators = exports?.decorators;

    for (const specifier of statement.namedImports) {
      const component = exports?.components?.get(specifier.imported.name);

      if (component) {
        components.set(specifier.local.name, {
          node: component.node,
          inline: component.inline,
          types: component.expressionTypes,
          root: component.root ?? 'is not known in advance',
        });
      }

      const info = decorators?.get(specifier.imported.name);

      if (!info) continue;
      found.set(specifier.local.name, {
        node: info.node,
        moduleNames: info.moduleNames,
        types: info.expressionTypes,
        inline: info.inline,
      });
    }
  }

  return { decorators: found, components };
}

/** The CSS modules that the program imports, read and parsed, or what is wrong with them. */
function readStyleModules(
  program: ast.Program,
  read: CoreCompileOptions['readStyleModule'],
): { styleModules: Map<string, StyleModule>; problems: Diagnostic[] } {
  const styleModules = new Map<string, StyleModule>();
  const problems: Diagnostic[] = [];

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration' || !isStyleModule(statement.source.value)) continue;

    const { source } = statement;
    const text = read?.(source.value) ?? null;
    const problem = (message: string) =>
      problems.push({ message, start: source.start, end: source.end });

    if (text === null) {
      problem(
        read
          ? `cannot read the CSS module "${source.value}"`
          : 'CSS modules need files: build the program with mango build or Vite',
      );
      continue;
    }

    const module = styleModule(text);

    for (const message of module.problems) problem(`${source.value}: ${message}`);
    styleModules.set(source.value, module);
  }

  return { styleModules, problems };
}

function styleModuleExports(specifier: string, module: StyleModule): ModuleExports {
  const members = new Map([...module.classes.keys()].map((name) => [name, property(STRING)]));
  const name = specifier.split('/').at(-1)!;

  return {
    values: new Map([['default', { kind: 'object', name, members, call: null }]]),
    types: new Map(),
  };
}

function unusedStyleClasses(
  program: ast.Program,
  styleModules: ReadonlyMap<string, StyleModule>,
): Diagnostic[] {
  const found: Diagnostic[] = [];

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration' || !statement.defaultImport) continue;

    const module = styleModules.get(statement.source.value);

    if (!module) continue;
    for (const name of unusedClasses(program, statement.defaultImport.name, module)) {
      found.push({
        message: `class "${name}" of ${statement.source.value} is never used`,
        start: statement.source.start,
        end: statement.source.end,
      });
    }
  }

  return found;
}

/** The relative imports of `.mango` modules and CSS modules: what the module depends on. */
function localImports(program: ast.Program): string[] {
  const specifiers = new Set<string>();

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration') continue;

    const path = statement.source.value;

    if (/^\.{1,2}\//.test(path) && (path.endsWith('.mango') || isStyleModule(path))) {
      specifiers.add(path);
    }
  }

  return [...specifiers];
}
