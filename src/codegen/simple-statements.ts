import type * as ast from '../ast.ts';
import { declarationsOf } from './analysis.ts';
import { ExpressionEmitter } from './expressions.ts';
import { ARROW, arrayPattern, POSTFIX } from './syntax.ts';

/** Statements: lists and blocks of them, variables, assignments, `return`; the others are in later layers. */

export abstract class SimpleStatementEmitter extends ExpressionEmitter {
  // Implemented by later layers: the checking of statements, expressions and markup calls each other.

  protected abstract forInStatement(node: ast.ForInStatement): void;

  protected abstract forStatement(node: ast.ForStatement): void;

  protected abstract ifStatement(node: ast.IfStatement): string;

  protected abstract switchStatement(node: ast.SwitchStatement, discriminant: ast.Expression): void;

  protected abstract taglessSwitch(node: ast.SwitchStatement): void;

  protected abstract tryStatement(node: ast.TryStatement): string;

  protected abstract classDeclaration(node: ast.ClassDeclaration): void;

  protected abstract importDeclaration(node: ast.ImportDeclaration): void;

  /** Counter for the labels of switches compiled to if/else. */
  protected labels = 0;

  /** A `defer` inside an if/loop/switch; implemented by FunctionEmitter. */
  protected abstract deferStatement(node: ast.DeferStatement): void;

  /** `mount() { ... }` of a component (see ComponentEmitter). */
  protected abstract mountStatement(node: ast.MountStatement): void;

  /** `const link = <a>...</a>`: creates the element right in the variable; see ElementEmitter. */
  protected abstract elementDeclaration(declaration: string, node: ast.ElementExpression): void;

  /** An element in the block of `{if ...}` / `{for ...}` in markup; see ElementEmitter. */
  protected abstract elementStatement(node: ast.JsxElementStatement): void;

  /** A recursive component, which becomes a function; see ComponentEmitter. */
  protected abstract componentFunction(node: ast.ComponentDeclaration): void;

  protected statements(list: readonly ast.Statement[]): void {
    let previous: ast.Statement | undefined;

    for (const statement of list) {
      // Types, decorators and inlined components exist only at compile time.
      if (
        statement.kind === 'InterfaceDeclaration' ||
        statement.kind === 'TypeAliasDeclaration' ||
        statement.kind === 'DecoratorDeclaration' ||
        (statement.kind === 'ComponentDeclaration' &&
          !this.functionComponents.has(this.applied(statement)))
      ) {
        continue;
      }

      if (previous && this.blankLineBetween(previous, statement)) this.blankLine();
      this.statement(statement);
      previous = statement;
    }
  }

  /** A block's statements in a new scope, without the braces; `then` writes more code in it. */
  protected blockStatements(statements: readonly ast.Statement[], then?: () => void): void {
    this.withScope(declarationsOf(statements), () => {
      this.statements(statements);
      then?.();
    });
  }

  protected blockStatement(node: ast.BlockStatement): string {
    return this.block(() => this.blockStatements(node.body));
  }

  protected override statement(node: ast.Statement): void {
    this.withHoisting(true, () => this.emitStatement(node));
  }

  protected emitStatement(node: ast.Statement): void {
    switch (node.kind) {
      case 'ImportDeclaration':
        this.importDeclaration(node);
        break;

      case 'FuncDeclaration': {
        const [params, body] = this.func(node.params, node.body);
        const exported = node.exported ? 'export ' : '';

        this.line(`${exported}function ${this.name(node.name.name)}(${params}) ${body}`);
        break;
      }

      case 'VariableDeclaration': {
        const [name] = node.names;
        const [value] = node.values;

        if (node.names.length === 1 && value?.kind === 'ElementExpression' && name?.name !== '_') {
          const exported = node.exported ? 'export ' : '';
          const keyword = node.keyword === 'state' ? 'let' : node.keyword;

          this.elementDeclaration(`${exported}${keyword} ${this.name(name!.name)}`, value);
          break;
        }

        if (node.names.every((name) => name.name === '_') && !node.exported) {
          // `const _ = f()` only evaluates the values.
          for (const value of node.values) this.line(`${this.expressionStatement(value)};`);
        } else {
          this.line(`${node.exported ? 'export ' : ''}${this.variableDeclaration(node)};`);
        }

        break;
      }

      case 'ClassDeclaration':
        this.classDeclaration(node);
        break;

      case 'InterfaceDeclaration':
      case 'TypeAliasDeclaration':
      case 'DecoratorDeclaration':
        break;

      case 'ComponentDeclaration':
        this.componentFunction(this.applied(node));
        break;

      case 'BlockStatement':
        this.line(this.blockStatement(node));
        break;

      case 'ExpressionStatement':
        this.line(`${this.expressionStatement(node.expression)};`);
        break;

      case 'JsxElementStatement':
        this.elementStatement(node);
        break;

      case 'AssignmentStatement':
        this.line(`${this.assignment(node)};`);
        break;

      case 'IncDecStatement':
        this.line(`${this.expression(node.target, POSTFIX)}${node.operator};`);
        break;

      case 'ReturnStatement':
        this.line(this.returnStatement(node));
        break;

      case 'IfStatement':
        this.line(this.ifStatement(node));
        break;

      case 'ForStatement':
        this.forStatement(node);
        break;

      case 'ForInStatement':
        this.forInStatement(node);
        break;

      case 'SwitchStatement':
        if (node.discriminant === null) this.taglessSwitch(node);
        else this.switchStatement(node, node.discriminant);
        break;

      case 'BreakStatement': {
        const label = this.fn.breakTargets.at(-1);

        this.line(label ? `break ${label};` : 'break;');
        break;
      }

      case 'ContinueStatement':
        this.line('continue;');
        break;

      case 'ThrowStatement':
        this.line(`throw ${this.expression(node.argument, 0)};`);
        break;

      case 'TryStatement':
        this.line(this.tryStatement(node));
        break;

      case 'DeferStatement':
        this.deferStatement(node);
        break;

      case 'MountStatement':
        this.mountStatement(node);
        break;
    }
  }

  /** `let a, b = 1, 2` → `let a = 1, b = 2`; `const q, err = f()` → `const [q, err] = f()`. */
  protected variableDeclaration(node: ast.VariableDeclaration): string {
    // A state variable is an ordinary variable; updates are added where it changes.
    const keyword = node.keyword === 'state' ? 'let' : node.keyword;

    if (node.values.length === 0) {
      const zero = node.type ? this.zeroValue(node.type) : null;
      const names = node.names.map((name) => this.name(name.name));

      return `${keyword} ${names.map((name) => (zero === null ? name : `${name} = ${zero}`)).join(', ')}`;
    }

    const values = node.values.map((value) => this.expression(value, ARROW));
    const skips = node.names.some((name) => name.name === '_');

    if (values.length === node.names.length && !skips) {
      const pairs = node.names.map((name, i) => `${this.name(name.name)} = ${values[i]}`);

      return `${keyword} ${pairs.join(', ')}`;
    }

    const pattern = node.names.map((name) => (name.name === '_' ? '' : this.name(name.name)));
    const value = values.length === 1 ? values[0]! : `[${values.join(', ')}]`;

    return `${keyword} ${arrayPattern(pattern)} = ${value}`;
  }

  /** Go-style zero value of a type, or `null` for types without one. */
  protected zeroValue(type: ast.TypeNode, seen = new Set<string>()): string | null {
    switch (type.kind) {
      case 'NullableType':
        return 'null';

      case 'ArrayType':
        return '[]';

      case 'FuncType':
      case 'ObjectType':
      case 'UnionType':
      case 'LiteralType':
        return null;

      case 'TypeReference': {
        const name = type.name.name;
        const alias = this.typeAliases.get(name);

        if (alias && !seen.has(name)) return this.zeroValue(alias, seen.add(name));
        switch (name) {
          case 'number':
            return '0';

          case 'string':
            return '""';

          case 'bool':
            return 'false';

          case 'any':
          case 'error':
            return 'null';

          default:
            return null;
        }
      }
    }
  }

  /** `a = b`, `a, b = b, a` → `[a, b] = [b, a]`, `q, err = f()` → `[q, err] = f()`. */
  protected assignment(node: ast.AssignmentStatement): string {
    const isBlank = (target: ast.Expression) => target.kind === 'Identifier' && target.name === '_';

    if (node.targets.every(isBlank)) {
      // `_ = f()` only evaluates the values.
      if (node.values.length === 1) return this.expressionStatement(node.values[0]!);

      return `[${node.values.map((value) => this.expression(value, ARROW)).join(', ')}]`;
    }

    const values = node.values.map((value) => this.expression(value, ARROW));

    if (node.targets.length === 1) {
      return `${this.expression(node.targets[0]!, POSTFIX)} ${node.operator} ${values[0]}`;
    }

    const pattern = node.targets.map((target) =>
      isBlank(target) ? '' : this.expression(target, POSTFIX),
    );
    const value = values.length === 1 ? values[0]! : `[${values.join(', ')}]`;

    return `${arrayPattern(pattern)} = ${value}`;
  }

  /** Several results are returned as an array: `return a, b` → `return [a, b]`. */
  protected returnStatement(node: ast.ReturnStatement): string {
    if (node.values.length === 0) return 'return;';
    if (node.values.length === 1) return `return ${this.expression(node.values[0]!, 0)};`;

    return `return [${node.values.map((value) => this.expression(value, ARROW)).join(', ')}];`;
  }
}
