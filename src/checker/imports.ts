import type * as ast from '../ast.ts';
import { CheckerBase } from './base.ts';
import type { DecoratorInfo } from './context.ts';
import { ANY, LazyMap, memberNames, UNKNOWN, type Member, type Type } from './types.ts';

// Imports: the names of other modules, typed by their exports (`importModule` for `.rk` modules,
// `importDeclarations` for the rest), or untyped when nothing is known about them.

export abstract class ImportChecker extends CheckerBase {
  protected declareImport(node: ast.ImportDeclaration): void {
    const specifier = node.source.value;
    const isRook = specifier.endsWith('.rk');
    const result = isRook
      ? this.options.importModule?.(specifier)
      : this.options.importDeclarations?.(specifier);

    if (result && 'error' in result) this.error(result.error, node.source);

    const exports = result && 'exports' in result ? result.exports : null;

    if (node.defaultImport && exports && !isRook) {
      // `import fs from "node:fs"`: the default export of a module with types.
      const value = exports.values.get('default');
      const type = exports.types.get('default');

      if (value === undefined && type === undefined) {
        this.error(`"${specifier}" has no default export`, node.defaultImport);
      }

      this.declareValue(node.defaultImport, 'import', value ?? UNKNOWN);
      if (type !== undefined) this.declareType(node.defaultImport, type);
    } else if (node.defaultImport) {
      if (exports) {
        this.error('Rook modules have no default export: use import { ... }', node.defaultImport);
      }

      this.declareValue(node.defaultImport, 'import', exports ? UNKNOWN : ANY);
      this.scope.types.set(node.defaultImport.name, ANY);
    }

    if (node.namespaceImport) {
      const values = exports?.values;
      const members = new LazyMap<Member>(
        () => (values ? memberNames(values) : []),
        (name) => {
          const type = values?.get(name);

          return type && { type, method: false, visibility: 'public', owner: null };
        },
      );
      const type: Type = exports ? { kind: 'object', name: specifier, members, call: null } : ANY;

      this.declareValue(node.namespaceImport, 'import', type);
    }

    for (const specifierNode of node.namedImports) {
      const name = specifierNode.imported.name;

      if (!exports) {
        this.declareValue(specifierNode.local, 'import', ANY);
        this.scope.types.set(specifierNode.local.name, ANY);
        continue;
      }

      const value = exports.values.get(name);
      const type = exports.types.get(name);
      const decorator = exports.decorators?.get(name);
      const component = exports.components?.get(name);
      const found = [value, type, decorator, component].some((each) => each !== undefined);

      if (!found) {
        this.error(`"${name}" is not exported by "${specifier}"`, specifierNode.imported);
      }

      if (value !== undefined) this.declareValue(specifierNode.local, 'import', value);
      if (type !== undefined) this.declareType(specifierNode.local, type);
      if (decorator !== undefined) this.importDecorator(specifierNode, decorator);
      if (component !== undefined) {
        this.declareValue(specifierNode.local, 'component', UNKNOWN).component = component;
      }
    }
  }

  /** `import { visible } from "./visible.rk"`: decorators have a namespace of their own. */
  private importDecorator(node: ast.ImportSpecifier, info: DecoratorInfo): void {
    const { imported, local } = node;

    // After the error the decorator keeps its name, so its uses are not reported again.
    if (local.name !== imported.name) {
      this.error(`renaming decorators is not supported yet: import { ${imported.name} }`, local);
    }

    if (this.decorators.has(imported.name)) {
      this.error(`the decorator @${imported.name} is already declared`, local);
    } else {
      this.decorators.set(imported.name, info);
      this.importedDecorators.add(info);
    }
  }
}
