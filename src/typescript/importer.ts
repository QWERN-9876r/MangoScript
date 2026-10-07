import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as TS from 'typescript';
import type { ImportResult, Library } from '../checker/checker.ts';
import { TypeConverter, type SharedTypes } from './convert.ts';
import { LibraryTypes } from './library.ts';

// Types of imports that are not `.mango` modules: npm packages, `node:` modules and `.ts` files.
// The TypeScript compiler finds and reads their declarations; it is loaded only when such an
// import is checked, and an import without declarations stays untyped (`any`).

const TYPESCRIPT_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts', '.ts', '.mts', '.cts', '.tsx'];

export class DeclarationImporter {
  private ts: typeof TS | null | undefined;
  /** Files with declarations that imports resolved to; the program is rebuilt when one is added. */
  private readonly roots = new Set<string>();
  /** `node_modules/@types` folders above the importing files: `@types/node` gives `node:fs`. */
  private readonly typeRoots = new Set<string>();
  /** The packages in them; TypeScript 6 does not include them by itself. */
  private readonly typePackages = new Set<string>();
  private program: TS.Program | undefined;
  private stale = true;
  private converter: TypeConverter | undefined;
  /** Types of lib files and packages, shared by the converters of every program. */
  private readonly shared: SharedTypes = new Map();
  private libraryTypes: LibraryTypes | undefined;
  private readonly results = new Map<string, ImportResult>();

  /** The exports of the module `specifier` imported from the file `fromFile`. */
  import(fromFile: string, specifier: string): ImportResult {
    const key = `${dirname(fromFile)}\0${specifier}`;
    if (this.results.has(key)) return this.results.get(key);
    const ts = this.loadTypeScript();
    const result = ts ? this.resolve(ts, fromFile, specifier) : undefined;
    this.results.set(key, result);
    return result;
  }

  /**
   * The standard library and the DOM for a file: TypeScript's lib files and the `@types` packages
   * above it. The globals come from the program as it is when they are used.
   */
  library(fromFile: string): Library | undefined {
    const ts = this.loadTypeScript();
    if (!ts) return undefined;
    this.addTypeRoots(fromFile);
    const current = () => this.current(ts).library;
    return {
      value: (name) => current().value(name),
      type: (name) => current().type(name),
      primitive: (kind) => current().primitive(kind),
      array: (element) => current().array(element),
      element: (tag) => current().element(tag),
      event: (name) => current().event(name),
    };
  }

  private loadTypeScript(): typeof TS | null {
    if (this.ts === undefined) {
      try {
        this.ts = createRequire(import.meta.url)('typescript') as typeof TS;
      } catch {
        this.ts = null;
      }
    }
    return this.ts;
  }

  private resolve(ts: typeof TS, fromFile: string, specifier: string): ImportResult {
    this.addTypeRoots(fromFile);
    const { resolvedModule } = ts.resolveModuleName(specifier, fromFile, this.options(ts), ts.sys);
    if (resolvedModule) {
      const file = resolvedModule.resolvedFileName;
      // A JS file without declarations next to it.
      if (!TYPESCRIPT_EXTENSIONS.some((extension) => file.endsWith(extension))) return undefined;
      if (!this.roots.has(file)) {
        this.roots.add(file);
        this.stale = true;
      }
      const { program, converter } = this.current(ts);
      const source = program.getSourceFile(file);
      const module = source && program.getTypeChecker().getSymbolAtLocation(source);
      return module ? { exports: converter.moduleExports(module) } : undefined;
    }
    // `node:fs`, `fs`: modules declared with `declare module "..."`, as in @types/node.
    const { program, converter } = this.current(ts);
    const name = JSON.stringify(specifier);
    const ambient = program
      .getTypeChecker()
      .getAmbientModules()
      .find((module) => module.name === name);
    return ambient ? { exports: converter.moduleExports(ambient) } : undefined;
  }

  private addTypeRoots(fromFile: string): void {
    for (let directory = dirname(fromFile); ; directory = dirname(directory)) {
      const types = join(directory, 'node_modules', '@types');
      if (!this.typeRoots.has(types) && existsSync(types)) {
        this.typeRoots.add(types);
        for (const name of readdirSync(types)) {
          if (!name.startsWith('.')) this.typePackages.add(name);
        }
        this.stale = true;
      }
      if (dirname(directory) === directory) break;
    }
  }

  private options(ts: typeof TS): TS.CompilerOptions {
    return {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      esModuleInterop: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      typeRoots: [...this.typeRoots],
      types: [...this.typePackages],
    };
  }

  /**
   * The program with every root so far. A new program reuses the files of the old one; types
   * already imported keep coming from the old one.
   */
  private current(ts: typeof TS): {
    program: TS.Program;
    converter: TypeConverter;
    library: LibraryTypes;
  } {
    if (this.stale || !this.program || !this.converter || !this.libraryTypes) {
      const options = this.options(ts);
      this.program = ts.createProgram({
        // Without a root file, a program reads neither the lib nor the `types` packages.
        rootNames: [ts.getDefaultLibFilePath(options), ...this.roots],
        options,
        ...(this.program ? { oldProgram: this.program } : {}),
      });
      this.converter = new TypeConverter(ts, this.program, this.shared);
      this.libraryTypes = new LibraryTypes(ts, this.program, this.converter);
      this.stale = false;
    }
    return { program: this.program, converter: this.converter, library: this.libraryTypes };
  }
}

let shared: DeclarationImporter | undefined;

/** Imports with declarations, shared by every compilation in this process. */
export function importDeclarations(fromFile: string, specifier: string): ImportResult {
  shared ??= new DeclarationImporter();
  return shared.import(fromFile, specifier);
}

/** The standard library and the DOM for a file, shared like the imports. */
export function libraryFor(fromFile: string): Library | undefined {
  shared ??= new DeclarationImporter();
  return shared.library(fromFile);
}
