import type * as ast from '../ast.ts';
import { typedArrayOf, type Type } from '../checker/types.ts';
import { isYieldCall } from '../iterators.ts';
import { TYPED_ARRAYS, TYPED_ELEMENTS } from '../typed-arrays.ts';
import { hasOptionalLink } from './analysis.ts';
import { ExpressionEmitter } from './expressions.ts';
import { ARROW, BINARY, POSTFIX } from './syntax.ts';

// Calls, `new`, array literals and conversions. A `[]byte` is a Uint8Array: a literal where the
// checker found one expected becomes `new Uint8Array([...])`, and the conversions of Go between
// text and its UTF-8 bytes use TextEncoder and TextDecoder, `[]byte(s)` and `string(data)`. In an
// iterator, a generator, `yield(v)` yields: its value is `true`, since a generator that the loop
// over it leaves is closed at that `yield` and goes no further, so `false` is never seen.

export abstract class CallEmitter extends ExpressionEmitter {
  protected override call(node: ast.CallExpression): string {
    // After `?.` the arguments may not be evaluated at all.
    const conditional = node.optional || hasOptionalLink(node.callee);
    const args = this.withHoisting(this.hoist && !conditional, () => this.elements(node.arguments));

    if (this.isBuiltinError(node.callee) && !node.optional) return `new Error(${args})`;
    if (this.isStringConversion(node.callee)) return `new TextDecoder().decode(${args})`;

    const yielded = this.yielded(node);

    if (yielded !== null) return `(${yielded}, true)`;

    return `${this.expression(node.callee, POSTFIX)}${node.optional ? '?.' : ''}(${args})`;
  }

  /** `yield v` for `yield(v)` in an iterator, `yield [k, v]` for `yield(k, v)`; else `null`. */
  private yielded(node: ast.Expression): string | null {
    if (!this.fn.iterator || !isYieldCall(node) || this.lookup('yield') !== 'param') return null;

    const values = node.arguments.map((argument) =>
      this.expression(argument.kind === 'SpreadElement' ? argument.argument : argument, ARROW),
    );

    return values.length === 1 ? `yield ${values[0]}` : `yield [${values.join(', ')}]`;
  }

  protected override expressionStatement(node: ast.Expression): string {
    return this.yielded(node) ?? super.expressionStatement(node);
  }

  /** `if !yield(v) { return }`, the way an iterator of Go stops: in a generator, `yield v`. */
  protected yieldStatement(node: ast.IfStatement): string | null {
    const [only] = node.consequent.body;
    const { condition } = node;

    if (
      node.alternate ||
      node.consequent.body.length !== 1 ||
      only?.kind !== 'ReturnStatement' ||
      only.values.length > 0 ||
      condition.kind !== 'UnaryExpression' ||
      condition.operator !== '!'
    ) {
      return null;
    }

    return this.yielded(condition.argument);
  }

  /** `string(data)`, unless `string` is the name of a value here. */
  private isStringConversion(callee: ast.Expression): boolean {
    return callee.kind === 'Identifier' && callee.name === 'string' && !this.lookup('string');
  }

  protected override newExpression(node: ast.NewExpression): string {
    return `new ${this.newCallee(node.callee)}(${this.elements(node.arguments)})`;
  }

  /** `new (f())()` and `new (a?.B)()` need parentheses around the class expression. */
  private newCallee(callee: ast.Expression): string {
    let node = callee;
    let needsParens = false;

    while (true) {
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

  protected override arrayLiteral(node: ast.ArrayLiteral): string {
    const array = `[${this.elements(node.elements)}]`;
    const type = this.options.types?.get(node);
    const typed = type && typedArrayOf(type);

    return typed ? `new ${typed}(${array})` : array;
  }

  /**
   * `make([]float64, n)` → `new Float64Array(n)`; with `shared`, on a SharedArrayBuffer of its
   * size in bytes, `new Float64Array($$shared(8 * n))`. Without types the name is the one written.
   */
  protected override make(node: ast.MakeExpression): string {
    const type = this.options.types?.get(node);
    const written =
      node.type.kind === 'ArrayType' && node.type.element.kind === 'TypeReference'
        ? TYPED_ELEMENTS.get(node.type.element.name.name)
        : node.type.kind === 'TypeReference'
          ? node.type.name.name
          : undefined;
    const typed = (type && typedArrayOf(type)) ?? written ?? 'Array';

    if (!node.shared) return `new ${typed}(${this.expression(node.length, ARROW)})`;

    const size = TYPED_ARRAYS.get(typed) ?? 1;
    const bytes =
      size === 1
        ? this.expression(node.length, ARROW)
        : `${size} * ${this.expression(node.length, BINARY['*'] + 1)}`;

    this.helpers.add('shared');

    return `new ${typed}($$shared(${bytes}))`;
  }

  protected override conversion(node: ast.ConversionExpression): string {
    return `new TextEncoder().encode(${this.expression(node.argument, 0)})`;
  }

  /** `chan<number>(10)`: the channel keeps the zero value that a closed one gives. */
  protected override chan(node: ast.ChanExpression): string {
    const size = node.size ? this.expression(node.size, ARROW) : '0';

    this.helpers.add('chan');

    return `$$chan(${size}, ${this.zeroValue(node.element) ?? 'null'})`;
  }

  /** `queue<number>(items)`: the queue copies the values, as `[...items]` would. */
  protected override queue(node: ast.QueueExpression): string {
    this.helpers.add('queue');

    return `new $$Queue(${node.items ? this.expression(node.items, ARROW) : ''})`;
  }

  /**
   * `chan(stream, size)`: the channel keeps the zero value of its values, as `chan<T>(size)` does,
   * from the type of the stream that the checker found; without it, null.
   */
  protected override streamChan(node: ast.StreamChanExpression): string {
    const stream = this.expression(node.stream, ARROW);
    const size = node.size ? this.expression(node.size, ARROW) : '0';
    const type = this.options.types?.get(node);
    const channel = type?.kind === 'tuple' ? type.types[0] : undefined;
    const element = channel?.kind === 'object' ? channel.instanceOf?.args[0] : undefined;

    this.helpers.add('streams');

    return `$$fromStream(${stream}, ${size}, ${element ? zeroOf(element) : 'null'})`;
  }
}

/** The zero value of a type, as zeroValue gives for a type as written. */
function zeroOf(type: Type): string {
  const typed = typedArrayOf(type);

  if (typed !== null) return `new ${typed}()`;

  switch (type.kind) {
    case 'number':
      return '0';

    case 'bigint':
      return '0n';

    case 'string':
      return '""';

    case 'bool':
      return 'false';

    case 'array':
      return '[]';

    default:
      return 'null';
  }
}
