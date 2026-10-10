import type * as ast from '../ast.ts';
import { containsBreak } from '../walk.ts';
import { declarationsOf, endsWithJump, type BindingKind } from './analysis.ts';
import { SimpleStatementEmitter } from './simple-statements.ts';
import { ARROW, BINARY, POSTFIX } from './syntax.ts';

/** if, for, switch and try. */

export abstract class ControlStatementEmitter extends SimpleStatementEmitter {
  protected override ifStatement(node: ast.IfStatement): string {
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

  protected loopBody(body: ast.BlockStatement): string {
    return this.withBreakTarget(null, () => this.blockStatement(body));
  }

  protected override forStatement(node: ast.ForStatement): void {
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
  protected simpleStatement(node: ast.SimpleStatement): string {
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
  protected override forInStatement(node: ast.ForInStatement): void {
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
  protected override switchStatement(
    node: ast.SwitchStatement,
    discriminant: ast.Expression,
  ): void {
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
  protected override taglessSwitch(node: ast.SwitchStatement): void {
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

  protected override tryStatement(node: ast.TryStatement): string {
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
}
