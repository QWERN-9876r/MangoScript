import type * as ast from '../ast.ts';
import { ChannelChecker } from './channels.ts';
import { isUntyped } from './helpers.ts';
import { holdsBigInts } from '../typed-arrays.ts';
import {
  BIGINT,
  isBytes,
  nonNull,
  NUMBER,
  STRING,
  typedArrayOf,
  typeToString,
  UNKNOWN,
  type Type,
} from './types.ts';

// `[]byte`, a Uint8Array, and the other typed arrays, `[]float64`: an array literal where one is
// expected, `let data []byte = [1, 2]`; and the conversions of Go between text and its UTF-8
// bytes, `[]byte("rook")` and `string(data)`.

export abstract class BytesChecker extends ChannelChecker {
  protected override checkArrayLiteral(node: ast.ArrayLiteral, expected: Type | null): Type {
    const typed = expected && nonNull(expected);
    const name = typed && typedArrayOf(typed);

    if (!typed || name === null) return super.checkArrayLiteral(node, expected);

    const element = holdsBigInts(name) ? BIGINT : NUMBER;

    for (const item of node.elements) {
      if (item.kind === 'SpreadElement') {
        const spread = this.checkValue(item.argument, typed);

        if (typedArrayOf(spread) !== name && !this.isElements(spread, element)) {
          this.error(
            `cannot spread ${typeToString(spread)} into ${typeToString(typed)}`,
            item.argument,
          );
        }
      } else {
        this.expectAssignable(this.checkValue(item, element), element, item);
      }
    }

    return typed;
  }

  private isElements(type: Type, element: Type): boolean {
    return isUntyped(type) || (type.kind === 'array' && type.element.kind === element.kind);
  }

  /** `make([]float64, n)`: a typed array of `n` zeros. */
  protected override checkMake(node: ast.MakeExpression): Type {
    const type = this.resolveType(node.type);

    this.expectAssignable(this.checkValue(node.length, NUMBER), NUMBER, node.length);
    if (typedArrayOf(type) === null) {
      this.error(
        `make makes a typed array, e.g. make([]float64, n), not ${typeToString(type)}; a list starts empty and grows, e.g. let names []string = []`,
        node.type,
      );
    }

    return type;
  }

  protected override checkConversion(node: ast.ConversionExpression): Type {
    const type = this.resolveType(node.type);
    const argument = this.checkValue(node.argument, STRING);

    if (!isBytes(type)) {
      this.error(
        `cannot convert to ${typeToString(type)}: only []byte("text") and string(bytes) convert between types; for other values call a function, e.g. Number(s)`,
        node.type,
      );

      return UNKNOWN;
    }

    if (!isUntyped(argument) && argument.kind !== 'string' && argument.kind !== 'literal') {
      this.error(
        `[]byte(...) gives the UTF-8 bytes of a string, not of ${typeToString(argument)}; bytes are written as a list, e.g. let data []byte = [1, 2]`,
        node.argument,
      );
    }

    return type;
  }

  // `string(data)`: `string` is a type, so a call of it is the conversion, unless the program has
  // a value of that name.
  protected override checkChain(
    node: ast.MemberExpression | ast.IndexExpression | ast.CallExpression,
    expected: Type | null = null,
  ): [Type, boolean] {
    if (
      node.kind !== 'CallExpression' ||
      node.callee.kind !== 'Identifier' ||
      node.callee.name !== 'string' ||
      this.lookupValue('string') !== undefined
    ) {
      return super.checkChain(node, expected);
    }

    const [argument, ...rest] = node.arguments;

    if (!argument || argument.kind === 'SpreadElement' || rest.length > 0) {
      this.error('string(...) takes one []byte, e.g. string(data)', node);

      return [STRING, false];
    }

    const type = this.checkValue(argument, this.bytes());

    if (!isBytes(type) && !isUntyped(type)) {
      this.error(
        `string(...) turns []byte into text, not ${typeToString(type)}; for other values use String(x) or a template string, e.g. \`\${x}\``,
        argument,
      );
    }

    return [STRING, false];
  }
}
