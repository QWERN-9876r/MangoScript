import type * as ast from '../ast.ts';
import { containsElement, hasOptionalLink, startsWithObjectLiteral } from './analysis.ts';
import { Emitter } from './emitter.ts';
import { ARROW, BINARY, CONDITIONAL, POSTFIX, PRIMARY, UNARY } from './syntax.ts';

/** Expressions, with the parentheses that JS operator precedence requires. */
export abstract class ExpressionEmitter extends Emitter {
  /** Parameters and body of a function; implemented by FunctionEmitter. */
  protected abstract func(params: ast.Parameter[], body: ast.BlockStatement): [string, string];

  /** Code that creates an element, as an expression; implemented by ElementEmitter. */
  protected abstract element(node: ast.ElementExpression): string;

  /** Writes a statement; implemented by StatementEmitter. */
  protected abstract statement(node: ast.Statement): void;

  /** Whether an arrow function's expression body changes component state; see ElementEmitter. */
  protected abstract changesState(body: ast.Expression): boolean;

  /** The expression, in parentheses if it binds weaker than `minPrecedence`. */
  protected expression(node: ast.Expression, minPrecedence: number, forceParens = false): string {
    const [text, precedence] = this.expressionWithPrecedence(node);
    return precedence < minPrecedence || forceParens ? `(${text})` : text;
  }

  /** An expression used as a statement: JS would read a leading `{` as a block. */
  protected expressionStatement(node: ast.Expression): string {
    const text = this.expression(node, 0);
    return startsWithObjectLiteral(node) ? `(${text})` : text;
  }

  /** `1.toFixed()` is not valid JS, so number literals before `.` get parentheses. */
  protected memberObject(node: ast.Expression, render: (node: ast.Expression) => string): string {
    const text = render(node);
    return node.kind === 'NumberLiteral' ? `(${text})` : text;
  }

  private expressionWithPrecedence(node: ast.Expression): [string, number] {
    switch (node.kind) {
      case 'Identifier':
        // The predeclared `error` used as a value is JS's `Error`, which also works without `new`.
        return [this.isBuiltinError(node) ? 'Error' : this.name(node.name), PRIMARY];
      case 'NumberLiteral':
      case 'StringLiteral':
        return [node.raw, PRIMARY];
      case 'TemplateLiteral':
        return [this.template(node), PRIMARY];
      case 'BooleanLiteral':
        return [String(node.value), PRIMARY];
      case 'NullLiteral':
        return ['null', PRIMARY];
      case 'ThisExpression':
        return ['this', PRIMARY];
      case 'SuperExpression':
        return ['super', PRIMARY];
      case 'ArrayLiteral':
        return [`[${this.elements(node.elements)}]`, PRIMARY];
      case 'ObjectLiteral':
        return [this.objectLiteral(node), PRIMARY];
      case 'FuncExpression': {
        // Func literals become arrow functions, so `this` inside them is the enclosing `this`.
        const [params, body] = this.func(node.params, node.body);
        return [`(${params}) => ${body}`, ARROW];
      }
      case 'ArrowFunction':
        return [this.arrowFunction(node), ARROW];
      case 'UnaryExpression':
        return [this.unary(node), UNARY];
      case 'BinaryExpression':
        return [this.binary(node), BINARY[node.operator]];
      case 'ConditionalExpression': {
        const test = this.expression(node.test, CONDITIONAL + 1);
        // Only one branch runs, so neither may create elements in advance.
        const [consequent, alternate] = this.withHoisting(false, () => [
          this.expression(node.consequent, ARROW),
          this.expression(node.alternate, ARROW),
        ]);
        return [`${test} ? ${consequent} : ${alternate}`, CONDITIONAL];
      }
      case 'CallExpression':
        return [this.call(node), POSTFIX];
      case 'NewExpression':
        return [`new ${this.newCallee(node.callee)}(${this.elements(node.arguments)})`, POSTFIX];
      case 'MemberExpression': {
        const object = this.memberObject(node.object, (o) => this.expression(o, POSTFIX));
        return [`${object}${node.optional ? '?.' : '.'}${node.property.name}`, POSTFIX];
      }
      case 'IndexExpression': {
        const object = this.memberObject(node.object, (o) => this.expression(o, POSTFIX));
        const index = this.expression(node.index, 0);
        return [`${object}${node.optional ? '?.[' : '['}${index}]`, POSTFIX];
      }
      case 'ElementExpression':
        return [this.element(node), POSTFIX];
    }
  }

  private call(node: ast.CallExpression): string {
    // After `?.` the arguments may not be evaluated at all.
    const conditional = node.optional || hasOptionalLink(node.callee);
    const args = this.withHoisting(this.hoist && !conditional, () => this.elements(node.arguments));
    if (this.isBuiltinError(node.callee) && !node.optional) return `new Error(${args})`;
    return `${this.expression(node.callee, POSTFIX)}${node.optional ? '?.' : ''}(${args})`;
  }

  /** `new (f())()` and `new (a?.B)()` need parentheses around the class expression. */
  private newCallee(callee: ast.Expression): string {
    let node = callee;
    let needsParens = false;
    for (;;) {
      if (node.kind === 'CallExpression') {
        needsParens = true;
        break;
      }
      if (node.kind !== 'MemberExpression' && node.kind !== 'IndexExpression') break;
      if (node.optional) {
        needsParens = true;
        break;
      }
      node = node.object;
    }
    return this.expression(callee, POSTFIX, needsParens);
  }

  private elements(elements: readonly (ast.Expression | ast.SpreadElement)[]): string {
    return elements
      .map((element) =>
        element.kind === 'SpreadElement'
          ? `...${this.expression(element.argument, ARROW)}`
          : this.expression(element, ARROW),
      )
      .join(', ');
  }

  private template(node: ast.TemplateLiteral): string {
    let text = '`';
    node.quasis.forEach((quasi, i) => {
      text += quasi.raw;
      const expression = node.expressions[i];
      if (expression) text += `\${${this.expression(expression, 0)}}`;
    });
    return `${text}\``;
  }

  private objectLiteral(node: ast.ObjectLiteral): string {
    if (node.properties.length === 0) return '{}';
    const properties = node.properties.map((property) => {
      if (property.kind === 'SpreadElement') {
        return `...${this.expression(property.argument, ARROW)}`;
      }
      const key = property.key.kind === 'StringLiteral' ? property.key.raw : property.key.name;
      const value = this.expression(property.value, ARROW);
      // A renamed shorthand (`{ delete }` → `delete$`) must keep its key.
      return property.shorthand && value === key ? key : `${key}: ${value}`;
    });
    return `{ ${properties.join(', ')} }`;
  }

  private arrowFunction(node: ast.ArrowFunction): string {
    const { body } = node;
    if (body.kind === 'BlockStatement') {
      const [params, block] = this.func(node.params, body);
      return `(${params}) => ${block}`;
    }
    return this.withFunction('none', node.params, () => {
      const params = this.params(node.params);
      if (containsElement(body) || this.changesState(body)) {
        // Elements are created by statements, and so are updates after a change of state: the
        // body becomes a block.
        const statement: ast.ReturnStatement = {
          kind: 'ReturnStatement',
          values: [body],
          start: body.start,
          end: body.end,
        };
        const block = this.block(() => this.statement(statement));
        return `(${params}) => ${block}`;
      }
      // `() => ({ ... })`: a body starting with `{` would be read as a block.
      const text = this.expression(body, ARROW, startsWithObjectLiteral(body));
      return `(${params}) => ${text}`;
    });
  }

  private unary(node: ast.UnaryExpression): string {
    const argument = this.expression(node.argument, UNARY);
    if (node.operator === 'typeof') return `typeof ${argument}`;
    // `- -x` must not turn into `--x`.
    const space =
      (node.operator === '-' || node.operator === '+') && argument.startsWith(node.operator);
    return `${node.operator}${space ? ' ' : ''}${argument}`;
  }

  private binary(node: ast.BinaryExpression): string {
    const { operator } = node;
    const precedence = BINARY[operator];
    const rightAssociative = operator === '**';
    const nullishMix = (operand: ast.Expression) =>
      operand.kind === 'BinaryExpression' &&
      (operator === '??'
        ? operand.operator === '||' || operand.operator === '&&'
        : (operator === '||' || operator === '&&') && operand.operator === '??');

    // JS rejects `-a ** b` and mixing `??` with `||` / `&&` unless there are parentheses.
    const left = this.expression(
      node.left,
      rightAssociative ? precedence + 1 : precedence,
      (operator === '**' && node.left.kind === 'UnaryExpression') || nullishMix(node.left),
    );
    // The right side of `&&`, `||` and `??` may not be evaluated.
    const shortCircuits = operator === '&&' || operator === '||' || operator === '??';
    const right = this.withHoisting(this.hoist && !shortCircuits, () =>
      this.expression(
        node.right,
        rightAssociative ? precedence : precedence + 1,
        nullishMix(node.right),
      ),
    );

    let jsOperator: string = operator;
    if (operator === '==' || operator === '!=') {
      // `x == null` stays loose so that it also matches `undefined` coming from JS code.
      const withNull = node.left.kind === 'NullLiteral' || node.right.kind === 'NullLiteral';
      if (!withNull) jsOperator = `${operator}=`;
    }
    return `${left} ${jsOperator} ${right}`;
  }
}
