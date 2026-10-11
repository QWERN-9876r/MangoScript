import type * as ast from '../ast.ts';
import { decoratedName, moduleNamesOf } from '../decorators.ts';
import { inlinePackages, type InlinePackage } from '../inline-packages.ts';
import { packageExports } from './imported.ts';
import { ControlStatementEmitter } from './control-statements.ts';
import { ARROW, POSTFIX } from './syntax.ts';

/**
 * Imports and classes; with the layers below, all statements and declarations. A decorator of
 * another module is not a value, but its code uses names of its module: the import brings them
 * under hidden names, `import { $$visible$log } from "./visible.js"`, which that module exports.
 * So does an inlined component of another module; a called one brings its function, `$$Card`.
 */

export abstract class StatementEmitter extends ControlStatementEmitter {
  protected override importDeclaration(node: ast.ImportDeclaration): void {
    // Imports used only as types (e.g. interfaces) do not exist at runtime.
    const used = (name: ast.Identifier) => this.valueNames.has(name.name);
    const clauses: string[] = [];

    if (node.defaultImport && used(node.defaultImport)) {
      clauses.push(this.name(node.defaultImport.name));
    }

    if (node.namespaceImport && used(node.namespaceImport)) {
      clauses.push(`* as ${this.name(node.namespaceImport.name)}`);
    }

    const named = node.namedImports
      .filter((specifier) => used(specifier.local))
      .map((specifier) => {
        const local = this.name(specifier.local.name);

        return specifier.imported.name === local ? local : `${specifier.imported.name} as ${local}`;
      });

    const hidden = (exported: string, local: string) =>
      named.push(exported === local ? exported : `${exported} as ${local}`);

    for (const specifier of node.namedImports) {
      const component = this.options.components?.get(specifier.local.name);
      const inlined = this.inlinedImports.get(specifier.local.name);

      if (inlined) {
        for (const [exported, local] of inlined.imports) hidden(exported, local);
      } else if (component) {
        hidden(`$$${component.node.name.name}`, this.functionNames.get(component.node)!);
      }

      const decorator = this.options.decorators?.get(specifier.local.name);

      if (!decorator || !this.appliedDecorators.has(specifier.local.name)) continue;
      for (const name of decorator.moduleNames) {
        named.push(decoratedName(decorator.node.name.name, name));
      }

      for (const [exported, local] of this.decoratorImports.get(specifier.local.name)?.imports ??
        []) {
        hidden(exported, local);
      }
    }

    if (named.length > 0) clauses.push(`{ ${named.join(', ')} }`);

    const importsNames =
      node.defaultImport !== null || node.namespaceImport !== null || node.namedImports.length > 0;

    if (importsNames && clauses.length === 0) return;

    const source = this.importPath(node.source);

    this.line(
      clauses.length > 0 ? `import ${clauses.join(', ')} from ${source};` : `import ${source};`,
    );
  }

  /**
   * `export { log as $$visible$log }`: the names of the module that the code of exported
   * decorators uses, and that of exported components when other modules inline them.
   */
  protected hiddenExports(): void {
    const exports = new Map<string, string>();

    for (const statement of this.program.body) {
      if (statement.kind !== 'DecoratorDeclaration' || !statement.exported) continue;
      for (const name of moduleNamesOf(statement, this.program)) {
        exports.set(decoratedName(statement.name.name, name), this.name(name));
      }
    }

    const packages = inlinePackages(this.program);
    const decorators = [...packages.decorators].filter(
      (entry): entry is [string, InlinePackage] => entry[1] !== null,
    );

    for (const found of [packages.components, new Map(decorators)]) {
      for (const [exported, local] of packageExports(found, (name) => this.name(name))) {
        exports.set(exported, local);
      }
    }

    if (exports.size === 0) return;

    const names = [...exports].map(([exported, local]) =>
      exported === local ? exported : `${local} as ${exported}`,
    );

    this.blankLine();
    this.line(`export { ${names.join(', ')} };`);
  }

  protected importPath(source: ast.StringLiteral): string {
    const path = source.value;

    if (this.options.rewriteImports && /^\.{1,2}\//.test(path) && path.endsWith('.mango')) {
      return JSON.stringify(`${path.slice(0, -'.mango'.length)}.js`);
    }

    return source.raw;
  }

  protected override classDeclaration(node: ast.ClassDeclaration): void {
    const exported = node.exported ? 'export ' : '';
    const superClass = node.superClass
      ? ` extends ${this.expression(node.superClass, POSTFIX)}`
      : '';
    const body = this.block(() => {
      let previous: ast.ClassMember | undefined;

      for (const member of node.members) {
        const bothFields =
          previous?.kind === 'FieldDeclaration' && member.kind === 'FieldDeclaration';

        if (previous && (!bothFields || this.blankLineBetween(previous, member))) this.blankLine();
        this.classMember(member);
        previous = member;
      }
    });

    this.line(`${exported}class ${this.name(node.name.name)}${superClass} ${body}`);
  }

  /** Visibility modifiers are checked by the compiler and do not exist in the output. */
  protected classMember(member: ast.ClassMember): void {
    switch (member.kind) {
      case 'FieldDeclaration': {
        // Field values are part of the class body, where no statements can go.
        const fieldValue = member.value;
        const value = fieldValue
          ? this.withHoisting(false, () => this.expression(fieldValue, ARROW))
          : member.type
            ? this.zeroValue(member.type)
            : null;
        const prefix = member.isStatic ? 'static ' : '';

        this.line(`${prefix}${member.name.name}${value === null ? '' : ` = ${value}`};`);
        break;
      }

      case 'ConstructorDeclaration': {
        const [params, body] = this.func(member.params, member.body);

        this.line(`constructor(${params}) ${body}`);
        break;
      }

      case 'MethodDeclaration': {
        const [params, body] = this.func(member.params, member.body);

        this.line(`${member.isStatic ? 'static ' : ''}${member.name.name}(${params}) ${body}`);
        break;
      }
    }
  }
}
