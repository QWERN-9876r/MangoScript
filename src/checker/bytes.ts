import type * as ast from '../ast.ts';
import { ChannelChecker } from './channels.ts';
import { isUntyped } from './helpers.ts';
import { isBytes, nonNull, NUMBER, STRING, typeToString, UNKNOWN, type Type } from './types.ts';

// `[]byte`, a Uint8Array: an array literal where one is expected, `let data []byte = [1, 2]`, and
// the conversions of Go between text and its UTF-8 bytes, `[]byte("mango")` and `string(data)`.

export abstract class BytesChecker extends ChannelChecker {
  protected override checkArrayLiteral(node: ast.ArrayLiteral, expected: Type | null): Type {
    const bytes = expected && nonNull(expected);

    if (!bytes || !isBytes(bytes)) return super.checkArrayLiteral(node, expected);

    for (const item of node.elements) {
      if (item.kind === 'SpreadElement') {
        const spread = this.checkValue(item.argument, bytes);

        if (!isBytes(spread) && !this.isNumbers(spread)) {
          this.error(`cannot spread ${typeToString(spread)} into []byte`, item.argument);
        }
      } else {
        this.expectAssignable(this.checkValue(item, NUMBER), NUMBER, item);
      }
    }

    return bytes;
  }

  private isNumbers(type: Type): boolean {
    return isUntyped(type) || (type.kind === 'array' && type.element.kind === 'number');
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
