import type * as ast from '../ast.ts';
import { containsBreak } from '../walk.ts';
import { declarationsOf, endsWithJump, type BindingKind } from './analysis.ts';
import { ExpressionEmitter } from './expressions.ts';
import { ARROW, arrayPattern, BINARY, POSTFIX } from './syntax.ts';

/** Statements and declarations: variables, loops, switch, imports, classes. */
export abstract class StatementEmitter extends ExpressionEmitter {
  /** Counter for the labels of switches compiled to if/else. */
  private labels = 0;

  /** A `defer` inside an if/loop/switch; implemented by FunctionEmitter. */
  protected abstract deferStatement(node: ast.DeferStatement): void;

  /** `const link = <a>...</a>`: creates the element right in the variable; see ElementEmitter. */
  protected abstract elementDeclaration(declaration: string, node: ast.ElementExpression): void;

  protected statements(list: readonly ast.Statement[]): void {
    let previous: ast.Statement | undefined;
    for (const statement of list) {
      // Types and components exist only at compile time.
      if (
        statement.kind === 'InterfaceDeclaration' ||
        statement.kind === 'TypeAliasDeclaration' ||
        statement.kind === 'ComponentDeclaration'
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

  private blockStatement(node: ast.BlockStatement): string {
    return this.block(() => this.blockStatements(node.body));
  }

  private statement(node: ast.Statement): void {
    this.withHoisting(true, () => this.emitStatement(node));
  }

  private emitStatement(node: ast.Statement): void {
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
          this.elementDeclaration(`${exported}${node.keyword} ${this.name(name!.name)}`, value);
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
      case 'ComponentDeclaration':
        break;
      case 'BlockStatement':
        this.line(this.blockStatement(node));
        break;
      case 'ExpressionStatement':
        this.line(`${this.expressionStatement(node.expression)};`);
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
    }
  }

  /** `let a, b = 1, 2` → `let a = 1, b = 2`; `const q, err = f()` → `const [q, err] = f()`. */
  private variableDeclaration(node: ast.VariableDeclaration): string {
    const { keyword } = node;
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
  private zeroValue(type: ast.TypeNode, seen = new Set<string>()): string | null {
    switch (type.kind) {
      case 'NullableType':
        return 'null';
      case 'ArrayType':
        return '[]';
      case 'FuncType':
      case 'ObjectType':
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
  private assignment(node: ast.AssignmentStatement): string {
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
  private returnStatement(node: ast.ReturnStatement): string {
    if (node.values.length === 0) return 'return;';
    if (node.values.length === 1) return `return ${this.expression(node.values[0]!, 0)};`;
    return `return [${node.values.map((value) => this.expression(value, ARROW)).join(', ')}];`;
  }

  private ifStatement(node: ast.IfStatement): string {
    let text = `if (${this.expression(node.condition, 0)}) ${this.blockStatement(node.consequent)}`;
    if (node.alternate?.kind === 'IfStatement') {
      // The condition of `else if` is evaluated only when the first one is false.
      const alternate = node.alternate;
      text += ` else ${this.withHoisting(false, () => this.ifStatement(alternate))}`;
    } else if (node.alternate) {
      text += ` else ${this.blockStatement(node.alternate)}`;
    }
    return text;
  }

  private loopBody(body: ast.BlockStatement): string {
    return this.withBreakTarget(null, () => this.blockStatement(body));
  }

  private forStatement(node: ast.ForStatement): void {
    const bindings =
      node.init?.kind === 'VariableDeclaration'
        ? node.init.names.map((name): [string, BindingKind] => [name.name, 'let'])
        : [];
    this.withScope(bindings, () => {
      const init = node.init ? this.simpleStatement(node.init) : '';
      // The condition and the update run on every iteration.
      const [condition, update] = this.withHoisting(false, () => [
        node.condition ? this.expression(node.condition, 0) : '',
        node.update ? this.simpleStatement(node.update) : '',
      ]);
      if (node.init === null && node.update === null) {
        this.line(`while (${condition || 'true'}) ${this.loopBody(node.body)}`);
        return;
      }
      this.line(`for (${init}; ${condition}; ${update}) ${this.loopBody(node.body)}`);
    });
  }

  /** A statement inside a `for` header, without the `;`. */
  private simpleStatement(node: ast.SimpleStatement): string {
    switch (node.kind) {
      case 'VariableDeclaration':
        return this.variableDeclaration(node);
      case 'AssignmentStatement':
        return this.assignment(node);
      case 'IncDecStatement':
        return `${this.expression(node.target, POSTFIX)}${node.operator}`;
      case 'ExpressionStatement':
        return this.expression(node.expression, 0);
    }
  }

  /** `for x in xs` → `for (const x of xs)`; `for i, x in xs` iterates `xs.entries()`. */
  private forInStatement(node: ast.ForInStatement): void {
    const bindings: [string, BindingKind][] = [[node.value.name, 'loop']];
    if (node.key) bindings.push([node.key.name, 'loop']);
    this.withScope(bindings, () => {
      const value = this.name(node.value.name);
      let head: string;
      if (node.key === null) {
        head = `const ${value} of ${this.expression(node.iterable, ARROW)}`;
      } else {
        const key = node.key.name === '_' ? '' : this.name(node.key.name);
        const pair = node.value.name === '_' ? `[${key}]` : `[${key}, ${value}]`;
        head = `const ${pair} of ${this.expression(node.iterable, POSTFIX)}.entries()`;
      }
      this.line(`for (${head}) ${this.loopBody(node.body)}`);
    });
  }

  /** Each `case` ends with an implicit `break`; a case with declarations gets its own block. */
  private switchStatement(node: ast.SwitchStatement, discriminant: ast.Expression): void {
    const head = `switch (${this.expression(discriminant, 0)})`;
    const body = this.withBreakTarget(null, () =>
      this.block(() => {
        node.cases.forEach((switchCase, i) => {
          // Case values are evaluated only until one matches.
          const labels =
            switchCase.tests.length === 0
              ? ['default:']
              : this.withHoisting(false, () =>
                  switchCase.tests.map((test) => `case ${this.expression(test, 0)}:`),
                );
          for (const label of labels.slice(0, -1)) this.line(label);

          const isLast = i === node.cases.length - 1;
          const needsBreak = !isLast && !endsWithJump(switchCase.body);
          const declarations = declarationsOf(switchCase.body);
          const lines = this.capture(() => {
            this.withScope(declarations, () => this.statements(switchCase.body));
            if (needsBreak) this.line('break;');
          });

          if (declarations.length > 0) {
            this.line(`${labels.at(-1)} {\n${lines.join('\n')}\n${this.indent()}}`);
          } else {
            this.line(labels.at(-1)!);
            this.lines.push(...lines);
          }
        });
      }),
    );
    this.line(`${head} ${body}`);
  }

  /**
   * `switch { case cond: ... }` becomes an if/else chain. A `break` inside it must leave the
   * switch, not an enclosing loop, so then the chain gets a label to break to.
   */
  private taglessSwitch(node: ast.SwitchStatement): void {
    const cases = node.cases.filter((switchCase) => switchCase.tests.length > 0);
    const fallback = node.cases.find((switchCase) => switchCase.tests.length === 0);
    const label = node.cases.some((switchCase) => containsBreak(switchCase.body))
      ? `$$switch${++this.labels}`
      : null;

    const text = this.withBreakTarget(label, () => {
      const caseBlock = (body: ast.Statement[]) => this.block(() => this.blockStatements(body));
      const branches = cases.map((switchCase) => {
        // Later conditions are evaluated only if the earlier ones are false.
        const condition = this.withHoisting(false, () =>
          switchCase.tests.length === 1
            ? this.expression(switchCase.tests[0]!, 0)
            : switchCase.tests.map((test) => this.expression(test, BINARY['||'] + 1)).join(' || '),
        );
        return `if (${condition}) ${caseBlock(switchCase.body)}`;
      });
      if (fallback) branches.push(caseBlock(fallback.body));
      return branches.join(' else ');
    });

    if (text === '') return;
    this.line(label ? `${label}: ${text}` : text);
  }

  private tryStatement(node: ast.TryStatement): string {
    let text = `try ${this.blockStatement(node.block)}`;
    const { handler } = node;
    if (handler) {
      const param = handler.param;
      const bindings: [string, BindingKind][] = param ? [[param.name, 'catch']] : [];
      text += this.withScope(bindings, () => {
        const head = param ? ` catch (${this.name(param.name)})` : ' catch';
        return `${head} ${this.blockStatement(handler.body)}`;
      });
    }
    if (node.finalizer) text += ` finally ${this.blockStatement(node.finalizer)}`;
    return text;
  }

  // ─── Declarations ──────────────────────────────────────────────────────────────────────────────

  private importDeclaration(node: ast.ImportDeclaration): void {
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
    if (named.length > 0) clauses.push(`{ ${named.join(', ')} }`);

    const importsNames =
      node.defaultImport !== null || node.namespaceImport !== null || node.namedImports.length > 0;
    if (importsNames && clauses.length === 0) return;

    const source = this.importPath(node.source);
    this.line(
      clauses.length > 0 ? `import ${clauses.join(', ')} from ${source};` : `import ${source};`,
    );
  }

  private importPath(source: ast.StringLiteral): string {
    const path = source.value;
    if (this.options.rewriteImports && /^\.{1,2}\//.test(path) && path.endsWith('.mango')) {
      return JSON.stringify(`${path.slice(0, -'.mango'.length)}.js`);
    }
    return source.raw;
  }

  private classDeclaration(node: ast.ClassDeclaration): void {
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
  private classMember(member: ast.ClassMember): void {
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
