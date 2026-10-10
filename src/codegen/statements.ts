import type * as ast from '../ast.ts';
import { decoratedName, moduleNamesOf } from '../decorators.ts';
import { ControlStatementEmitter } from './control-statements.ts';
import { ARROW, POSTFIX } from './syntax.ts';

/**
 * Imports and classes; with the layers below, all statements and declarations. A decorator of
 * another module is not a value, but its code uses names of its module: the import brings them
 * under hidden names, `import { $$visible$log } from "./visible.js"`, which that module exports.
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

    for (const specifier of node.namedImports) {
      const component = this.options.components?.get(specifier.local.name);

      if (component) {
        const fn = `$$${component.name.name}`;
        const local = this.functionNames.get(component)!;

        named.push(fn === local ? fn : `${fn} as ${local}`);
      }

      const decorator = this.options.decorators?.get(specifier.local.name);

      if (!decorator || !this.appliedDecorators.has(specifier.local.name)) continue;
      for (const name of decorator.moduleNames) {
        named.push(decoratedName(decorator.node.name.name, name));
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

  /** `export { log as $$visible$log }`: the names that an exported decorator uses. */
  protected hiddenExports(): void {
    for (const statement of this.program.body) {
      if (statement.kind !== 'DecoratorDeclaration' || !statement.exported) continue;

      const names = moduleNamesOf(statement, this.program).map(
        (name) => `${this.name(name)} as ${decoratedName(statement.name.name, name)}`,
      );

      if (names.length === 0) continue;
      this.blankLine();
      this.line(`export { ${names.join(', ')} };`);
    }
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
