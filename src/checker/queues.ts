import type * as ast from '../ast.ts';
import { ChannelChecker } from './channels.ts';
import { isUntyped } from './helpers.ts';
import { arrayOf, queueOf, typeToString, type Type } from './types.ts';

// Queues: `queue<number>()` makes an empty one, `queue<number>(items)` one with the values of an
// array or of another iterable. The members of `queue T` are in types/queue.ts.

export abstract class QueueChecker extends ChannelChecker {
  protected override checkQueue(node: ast.QueueExpression): Type {
    const element = this.resolveType(node.element);

    if (node.items) {
      // An array literal gets the type of the values, so that `[]` and `[1, null]` fit.
      const items = this.checkValue(node.items, arrayOf(element));

      if (items.kind === 'object' && items.iterates) {
        this.expectAssignable(items.iterates, element, node.items);
      } else if (items.kind === 'array' || isUntyped(items)) {
        this.expectAssignable(items, arrayOf(element), node.items);
      } else {
        this.error(
          `queue<T>(items) takes its first values as an array or another iterable, not ${typeToString(items)}, e.g. queue<number>([1, 2, 3])`,
          node.items,
        );
      }
    }

    return queueOf(element);
  }
}
