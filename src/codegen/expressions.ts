import type * as ast from '../ast.ts';
import { decoratedName } from '../decorators.ts';
import { goCaptures, goParams, goTarget } from '../goroutines.ts';
import { isIterator, usesThis } from '../iterators.ts';
import { containsElement, startsWithObjectLiteral } from './analysis.ts';
import { Emitter } from './emitter.ts';
import { PREDECLARED } from './helpers.ts';
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

  /** Go-style zero value of a type, or `null`; implemented by SimpleStatementEmitter. */
  protected abstract zeroValue(type: ast.TypeNode): string | null;

  /** `f(x)`, `new C(x)`, `[a, b]` and `[]byte(s)`; implemented by CallEmitter. */
  protected abstract call(node: ast.CallExpression): string;

  protected abstract newExpression(node: ast.NewExpression): string;

  protected abstract arrayLiteral(node: ast.ArrayLiteral): string;

  protected abstract conversion(node: ast.ConversionExpression): string;

  /** `<-ch` that gives `[value, ok]`, in `v, ok = <-ch`. */
  protected readonly commaOk = new WeakSet<ast.Expression>();

  /** `items[i]` in a part of `go for`, which is `items[$$i]` there (parallel.ts). */
  protected readonly partElements = new Set<ast.Expression>();

  /** In the worker module, `go` runs in the same worker (go-helpers.ts). */
  protected get inWorker(): boolean {
    return this.options.goroutines !== undefined && 'targets' in this.options.goroutines;
  }

  /** `v, ok = <-ch`: two variables from a single receive. */
  protected markCommaOk(count: number, values: readonly ast.Expression[]): void {
    const [value] = values;

    if (count === 2 && values.length === 1 && value?.kind === 'UnaryExpression') {
      if (value.operator === '<-') this.commaOk.add(value);
    }
  }

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

  /** Whether `error` refers to the predeclared function rather than to a declared name. */
  protected isBuiltinError(node: ast.Expression): boolean {
    return (
      node.kind === 'Identifier' && node.name === 'error' && this.lookup('error') === undefined
    );
  }

  /**
   * The component a capitalized name refers to here: not a variable that hides it, as the
   * property `Header` of an inlined component does.
   */
  protected componentNamed(name: string): ast.ComponentDeclaration | undefined {
    const binding = this.lookup(name);

    return binding === undefined || binding === 'import' ? this.components.get(name) : undefined;
  }

  private expressionWithPrecedence(node: ast.Expression): [string, number] {
    switch (node.kind) {
      case 'Identifier': {
        const component = this.componentNamed(node.name);

        // A component as a value is its function.
        if (component) {
          return [this.functionNames.get(component) ?? `$$${component.name.name}`, PRIMARY];
        }

        // `close(ch)` and the like are predeclared; JS has a `close` of its own, the window's.
        const helper = Object.hasOwn(PREDECLARED, node.name) ? PREDECLARED[node.name] : undefined;

        if (helper && this.lookup(node.name) === undefined) {
          this.helpers.add(helper);

          return [`$$${node.name}`, PRIMARY];
        }

        // The predeclared `error` used as a value is JS's `Error`, which also works without `new`.
        return [this.isBuiltinError(node) ? 'Error' : this.name(node.name), PRIMARY];
      }

      case 'NumberLiteral':
      case 'BigIntLiteral':
      case 'StringLiteral':
        return [node.raw, PRIMARY];

      case 'TemplateLiteral':
        return [this.template(node), PRIMARY];

      case 'BooleanLiteral':
        return [String(node.value), PRIMARY];

      case 'NullLiteral':
        return ['null', PRIMARY];

      // The member is a variable of the component's code: see decorate().
      case 'DecoratorMember':
        return [decoratedName(node.decorator.name, node.member.name), PRIMARY];

      case 'DecoratorGet':
        return [decoratedName(node.target.decorator.name, node.target.member.name), PRIMARY];

      case 'ThisExpression':
        return ['this', PRIMARY];

      // `as` is only for the checker.
      case 'AsExpression':
        return this.expressionWithPrecedence(node.expression);

      case 'SuperExpression':
        return ['super', PRIMARY];

      case 'ArrayLiteral': {
        const text = this.arrayLiteral(node);

        return [text, text.startsWith('[') ? PRIMARY : POSTFIX];
      }

      case 'ObjectLiteral':
        return [this.objectLiteral(node), PRIMARY];

      case 'FuncExpression': {
        // Func literals become arrow functions, so `this` inside them is the enclosing `this`. An
        // iterator is a generator function, which is never an arrow: it gets that `this` bound.
        const [params, body] = this.func(node.params, node.body);

        if (isIterator(node.params)) {
          return usesThis(node.body)
            ? [`function* () ${body}.bind(this)`, POSTFIX]
            : [`function* () ${body}`, PRIMARY];
        }

        return [`${node.async ? 'async ' : ''}(${params}) => ${body}`, ARROW];
      }

      case 'ArrowFunction':
        return [this.arrowFunction(node), ARROW];

      // `chan<number>(10)`: the channel keeps the zero value that a closed one gives.
      case 'ChanExpression': {
        const size = node.size ? this.expression(node.size, ARROW) : '0';

        this.helpers.add('chan');

        return [`$$chan(${size}, ${this.zeroValue(node.element) ?? 'null'})`, POSTFIX];
      }

      // The worker module has the function under the same name, a literal under the name given to
      // it, after the local names it uses; the arguments are copied there. In the worker module a
      // literal runs in the same worker, with copies of those names as its first parameters.
      case 'GoExpression': {
        const { callee } = node.call;
        const literal = callee.kind === 'FuncExpression' ? callee : null;
        const captured = literal ? goCaptures(this.program, node) : [];
        const args = [
          ...captured.map((name) => this.name(name)),
          this.elements(node.call.arguments),
        ];
        // Without type checking, a callee that is neither fails when the call runs.
        const fn =
          literal && this.inWorker
            ? this.expression(
                { ...literal, params: [...goParams(literal, captured), ...literal.params] },
                ARROW,
              )
            : JSON.stringify(goTarget(this.program, node));

        this.helpers.add(this.inWorker ? 'goLocal' : 'go');

        return [`$$go(${fn}, [${args.filter((arg) => arg !== '').join(', ')}])`, POSTFIX];
      }

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
        return [this.newExpression(node), POSTFIX];

      case 'ConversionExpression':
        return [this.conversion(node), POSTFIX];

      case 'MemberExpression': {
        const object = this.memberObject(node.object, (o) => this.expression(o, POSTFIX));

        return [`${object}${node.optional ? '?.' : '.'}${node.property.name}`, POSTFIX];
      }

      case 'IndexExpression': {
        const object = this.memberObject(node.object, (o) => this.expression(o, POSTFIX));
        const index = this.partElements.has(node) ? '$$i' : this.expression(node.index, 0);

        return [`${object}${node.optional ? '?.[' : '['}${index}]`, POSTFIX];
      }

      case 'ElementExpression':
        return [this.element(node), POSTFIX];
    }
  }

  protected elements(elements: readonly (ast.Expression | ast.SpreadElement)[]): string {
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
    const async = node.async ? 'async ' : '';

    if (body.kind === 'BlockStatement') {
      const [params, block] = this.func(node.params, body);

      return `${async}(${params}) => ${block}`;
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

        return `${async}(${params}) => ${block}`;
      }

      // `() => ({ ... })`: a body starting with `{` would be read as a block.
      const text = this.expression(body, ARROW, startsWithObjectLiteral(body));

      return `${async}(${params}) => ${text}`;
    });
  }

  private unary(node: ast.UnaryExpression): string {
    if (node.operator === '<-') {
      this.helpers.add('chan');

      const channel = this.expression(node.argument, ARROW);

      return `await $$receive(${channel}${this.commaOk.has(node) ? ', true' : ''})`;
    }

    const argument = this.expression(node.argument, UNARY);

    if (node.operator === 'typeof' || node.operator === 'await') {
      return `${node.operator} ${argument}`;
    }

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
