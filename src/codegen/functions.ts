import type * as ast from '../ast.ts';
import { declarationsOf, findDefers } from './analysis.ts';
import type { DeferMode } from './emitter.ts';
import { StatementEmitter } from './statements.ts';
import { ARROW, POSTFIX } from './syntax.ts';

/** Runs deferred calls in reverse order; every call runs even if an earlier one throws. */
export const RUN_DEFERRED = [
  'function $$runDeferred(deferred) {',
  '  let failure;',
  '  for (let i = deferred.length - 1; i >= 0; i--) {',
  '    try {',
  '      deferred[i]();',
  '    } catch (error) {',
  '      failure = { error };',
  '    }',
  '  }',
  '  if (failure) throw failure.error;',
  '}',
];

/** Function bodies and `defer`. */
export abstract class FunctionEmitter extends StatementEmitter {
  /** Parameters and body of a function, method or func literal. */
  protected override func(params: ast.Parameter[], body: ast.BlockStatement): [string, string] {
    const defers = findDefers(body);
    const mode: DeferMode =
      defers.length === 0
        ? 'none'
        : defers.every((defer) => body.body.includes(defer))
          ? 'try'
          : 'stack';

    return this.withFunction(mode, params, () => {
      const paramList = this.params(params);
      const text = this.block(() => {
        this.withScope(declarationsOf(body.body), () => {
          if (mode === 'try') {
            this.statementsWithDefers(body.body);
          } else if (mode === 'stack') {
            this.usesRunDeferred = true;
            this.line('const $$defer = [];');
            const statements = this.block(() => this.statements(body.body));
            const finalizer = this.block(() => this.line('$$runDeferred($$defer);'));
            this.line(`try ${statements} finally ${finalizer}`);
          } else {
            this.statements(body.body);
          }
        });
      });
      return [paramList, text];
    });
  }

  /** A `defer` in 'stack' mode; in 'try' mode they are handled by statementsWithDefers. */
  protected override deferStatement(node: ast.DeferStatement): void {
    const { body } = node;
    if (body.kind === 'BlockStatement') {
      const block = this.block(() => this.blockStatements(body.body));
      this.line(`$$defer.push(() => ${block});`);
      return;
    }
    // Temporaries for the arguments go into a block so that each loop iteration gets its own.
    const lines = this.capture(() => this.line(`$$defer.push(() => ${this.deferredCall(body)});`));
    if (lines.length === 1) this.line(lines[0]!.trimStart());
    else this.line(`{\n${lines.join('\n')}\n${this.indent()}}`);
  }

  /** Statements of a body whose `defer`s are all at its top level: one try/finally per `defer`. */
  private statementsWithDefers(list: readonly ast.Statement[]): void {
    const index = list.findIndex((statement) => statement.kind === 'DeferStatement');
    if (index === -1) {
      this.statements(list);
      return;
    }
    this.statements(list.slice(0, index));
    const runDeferred = this.prepareDeferred(list[index] as ast.DeferStatement);
    const rest = list.slice(index + 1);
    if (rest.length === 0) {
      // Nothing can happen between the `defer` and the end of the function.
      runDeferred();
      return;
    }
    const body = this.block(() => this.statementsWithDefers(rest));
    this.line(`try ${body} finally ${this.block(runDeferred)}`);
  }

  /**
   * Go evaluates the function and arguments of a deferred call at the `defer` statement. Values
   * that cannot change in between are used as they are; others are saved to temporaries here.
   * Returns a function that writes the deferred code.
   */
  private prepareDeferred(node: ast.DeferStatement): () => void {
    const { body } = node;
    if (body.kind === 'BlockStatement') return () => this.blockStatements(body.body);
    const call = this.deferredCall(body);
    return () => this.line(`${call};`);
  }

  private deferredCall(call: ast.CallExpression): string {
    const { callee } = call;
    let target: string;
    if (callee.kind === 'MemberExpression') {
      const object = this.memberObject(callee.object, (o) => this.stable(o, POSTFIX));
      target = `${object}${callee.optional ? '?.' : '.'}${callee.property.name}`;
    } else if (callee.kind === 'IndexExpression') {
      const object = this.memberObject(callee.object, (o) => this.stable(o, POSTFIX));
      target = `${object}${callee.optional ? '?.[' : '['}${this.stable(callee.index, 0)}]`;
    } else if (this.isBuiltinError(callee)) {
      target = 'Error';
    } else {
      target = this.stable(callee, POSTFIX);
    }
    const args = call.arguments.map((arg) =>
      arg.kind === 'SpreadElement'
        ? `...${this.stable(arg.argument, ARROW)}`
        : this.stable(arg, ARROW),
    );
    return `${target}${call.optional ? '?.' : ''}(${args.join(', ')})`;
  }

  /** The expression itself if its value cannot change before the deferred call runs. */
  private stable(node: ast.Expression, precedence: number): string {
    if (this.isStable(node)) return this.expression(node, precedence);
    const temp = `$$${this.fn.temps++}`;
    this.line(`const ${temp} = ${this.expression(node, ARROW)};`);
    return temp;
  }

  private isStable(node: ast.Expression): boolean {
    switch (node.kind) {
      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'ThisExpression':
      case 'SuperExpression':
        return true;
      case 'TemplateLiteral':
        return node.expressions.every((expression) => this.isStable(expression));
      case 'Identifier': {
        const kind = this.lookup(node.name);
        if (kind === 'let' || kind === 'param' || kind === 'catch') {
          return !this.assigned.has(node.name);
        }
        return true;
      }
      default:
        return false;
    }
  }
}
