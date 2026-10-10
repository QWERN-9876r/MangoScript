import type * as ast from '../ast.ts';
import { moduleNamesOf } from '../decorators.ts';
import { assignedNames } from '../names.ts';
import { forEachChild } from '../walk.ts';
import type { DecoratorInfo } from './context.ts';
import { DecoratorWrapperChecker } from './decorator-wrappers.ts';
import { lookupIn } from './helpers.ts';

// Exported decorators, `export dec visible() { ... }`. Other modules inline their code, which uses
// the names of this module through hidden exports, `export { log as $$visible$log }`; so the code
// must work from there.

export abstract class DecoratorExportChecker extends DecoratorWrapperChecker {
  protected checkExportedDecorator(info: DecoratorInfo): void {
    const { node } = info;
    const name = node.name.name;

    info.moduleNames = moduleNamesOf(node, this.program);
    info.expressionTypes = this.checkedTypes;

    // A module that applies it applies those it needs too, so it must be able to import them.
    for (const needed of info.needed) {
      const other = needed.node.name.name;

      if (needed.node.exported) continue;
      this.error(
        `@${name} is exported, so @${other} that it needs must be exported too: export dec ${other}(...)`,
        node.needs.find((need) => need.name === other) ?? node.name,
      );
    }

    // Other modules can read the variables of this one, but not assign them.
    const assigned = assignedNames(node.body);

    for (const used of info.moduleNames) {
      if (!assigned.has(used)) continue;
      this.error(
        `@${name} is exported, so it cannot change "${used}" of its module: other modules can only read it; change it in a function of the module`,
        node.name,
      );
    }

    this.checkExportedMarkup(name, node.body);
  }

  /** The tags in a decorator inlined elsewhere would be names of that module, not of this one. */
  private checkExportedMarkup(decorator: string, body: ast.BlockStatement): void {
    const visit = (node: ast.Node): void => {
      const tag = node.kind === 'ElementExpression' ? node.tag : null;

      if (tag && lookupIn(this.moduleScope, tag.name)?.component) {
        this.error(
          `@${decorator} is exported, so it cannot use the component ${tag.name}: components in decorators of other modules are not supported yet`,
          tag,
        );
      }

      forEachChild(node, visit);
    };

    visit(body);
  }
}
