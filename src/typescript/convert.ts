import type { ModuleExports } from '../checker/checker.ts';
import { LazyMap, type Type } from '../checker/types.ts';
import { ObjectConverter } from './convert-objects.ts';
import type * as TS from 'typescript';

export type { SharedTypes } from './convert-base.ts';

/** Converts the types of a TypeScript program; one converter per program. */

export class TypeConverter extends ObjectConverter {
  /** The values and types a module exports, converted when they are imported. */
  moduleExports(module: TS.Symbol): ModuleExports {
    const { checker } = this;
    const { SymbolFlags } = this.ts;
    const exported = new Map<string, TS.Symbol>();

    for (const symbol of checker.getExportsOfModule(module)) exported.set(symbol.name, symbol);

    // `export = value` (CommonJS packages, `node:path`): the default import is the value itself,
    // and named imports are its properties.
    const assigned = module.exports?.get(this.ts.InternalSymbolName.ExportEquals);

    if (assigned) {
      if (!exported.has('default')) exported.set('default', assigned);

      const value =
        assigned.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(assigned) : assigned;

      if (value.flags & SymbolFlags.Value) {
        for (const property of checker.getPropertiesOfType(checker.getTypeOfSymbol(value))) {
          if (!exported.has(property.name)) exported.set(property.name, property);
        }
      }
    }

    const target = (name: string) => {
      const symbol = exported.get(name)!;

      return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    };

    return {
      values: new LazyMap(
        () => exported.keys(),
        (name) => {
          const symbol = target(name);

          return symbol.flags & SymbolFlags.Value ? this.valueType(symbol) : undefined;
        },
      ),
      types: new LazyMap(
        () => exported.keys(),
        (name) => {
          const symbol = target(name);

          return symbol.flags & SymbolFlags.Type ? this.typeOf(symbol) : undefined;
        },
      ),
    };
  }

  /** The type of a value: a class is the class itself. */
  valueType(symbol: TS.Symbol): Type {
    if (symbol.flags & this.ts.SymbolFlags.Class) return this.classInfo(symbol).value;

    return this.convert(this.checker.getTypeOfSymbol(symbol));
  }

  /** The type that a declaration names: an interface, a class instance, an alias. */
  typeOf(symbol: TS.Symbol): Type {
    const { SymbolFlags } = this.ts;

    if (symbol.flags & SymbolFlags.Class) return this.classInfo(symbol).instance;

    const type = this.convert(this.checker.getDeclaredTypeOfSymbol(symbol));

    // `type Pair<A, B> = { ... }` works like a generic interface: `Pair[number, string]`.
    if (symbol.flags & SymbolFlags.TypeAlias && type.kind === 'object' && !type.typeParams) {
      const declaration = symbol.declarations?.find(this.ts.isTypeAliasDeclaration);
      const params = declaration?.typeParameters ?? [];

      if (params.length > 0) {
        return {
          ...type,
          name: symbol.name,
          typeParams: params.map((param) => this.typeParam(this.checker.getTypeAtLocation(param))),
        };
      }
    }

    return type;
  }
}
