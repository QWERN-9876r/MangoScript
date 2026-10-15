import type * as ast from '../ast.ts';
import { chanOf, elementOf, isChan } from './channel.ts';
import { GoroutineChecker } from './goroutines.ts';
import { isUntyped } from './helpers.ts';
import { NUMBER, typeToString, type Type } from './types.ts';

// Channels: `chan[number](10)` makes one, `ch <- v` sends a value, `<-ch` receives one (in
// operators.ts) and `for v in ch` receives them until it is closed (in control-flow.ts).

export abstract class ChannelChecker extends GoroutineChecker {
  protected override checkChan(node: ast.ChanExpression): Type {
    const element = this.resolveType(node.element);

    if (node.size) this.expectAssignable(this.checkValue(node.size, NUMBER), NUMBER, node.size);

    return chanOf(element);
  }

  protected override checkSend(node: ast.SendStatement): void {
    const channel = this.checkValue(node.channel);

    if (!isChan(channel)) {
      if (!isUntyped(channel)) {
        this.error(`"<-" sends to a channel, not to ${typeToString(channel)}`, node.channel);
      }

      this.checkValue(node.value);

      return;
    }

    const element = elementOf(channel);

    this.expectAssignable(this.checkValue(node.value, element), element, node.value);
  }
}
