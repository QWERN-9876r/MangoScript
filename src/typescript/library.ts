import type * as TS from 'typescript';
import type { Library } from '../checker/checker.ts';
import { instantiate, type Type } from '../checker/types.ts';
import type { TypeConverter } from './convert.ts';

// Globals of TypeScript's lib files (the standard library and the DOM) and of the `@types`
// packages, such as `process` from @types/node. Each name is converted when it is first used.

export class LibraryTypes implements Library {
  private readonly checker: TS.TypeChecker;
  private readonly converter: TypeConverter;
  private readonly values = new Map<string, TS.Symbol>();
  private readonly types = new Map<string, TS.Symbol>();
  private readonly converted = new Map<string, Type | undefined>();

  constructor(ts: typeof TS, program: TS.Program, converter: TypeConverter) {
    this.checker = program.getTypeChecker();
    this.converter = converter;
    // The scope of a script file is the global scope.
    const lib = program.getSourceFile(ts.getDefaultLibFilePath(program.getCompilerOptions()));
    if (!lib) return;
    for (const symbol of this.checker.getSymbolsInScope(lib, ts.SymbolFlags.Value)) {
      this.values.set(symbol.name, symbol);
    }
    for (const symbol of this.checker.getSymbolsInScope(lib, ts.SymbolFlags.Type)) {
      this.types.set(symbol.name, symbol);
    }
  }

  value(name: string): Type | undefined {
    return this.cached(`value ${name}`, () => {
      const symbol = this.values.get(name);
      return symbol && this.converter.valueOf(symbol);
    });
  }

  type(name: string): Type | undefined {
    return this.cached(`type ${name}`, () => {
      const symbol = this.types.get(name);
      return symbol && this.converter.typeOf(symbol);
    });
  }

  primitive(kind: 'string' | 'number' | 'bool'): Type | undefined {
    return this.type(kind === 'string' ? 'String' : kind === 'number' ? 'Number' : 'Boolean');
  }

  array(element: Type): Type | undefined {
    const symbol = this.types.get('Array');
    return symbol && instantiate(this.converter.arrayTemplate(symbol), [element]);
  }

  element(tag: string): Type | undefined {
    return this.cached(`element ${tag}`, () => this.entry('HTMLElementTagNameMap', tag));
  }

  event(name: string): Type | undefined {
    return this.cached(`event ${name}`, () => this.entry('HTMLElementEventMap', name));
  }

  /** `Map[key]` of an interface that maps names to types. */
  private entry(map: string, key: string): Type | undefined {
    const symbol = this.types.get(map);
    if (!symbol) return undefined;
    const property = this.checker.getPropertyOfType(
      this.checker.getDeclaredTypeOfSymbol(symbol),
      key,
    );
    return property && this.converter.convert(this.checker.getTypeOfSymbol(property));
  }

  private cached(key: string, compute: () => Type | undefined): Type | undefined {
    if (!this.converted.has(key)) this.converted.set(key, compute());
    return this.converted.get(key);
  }
}
