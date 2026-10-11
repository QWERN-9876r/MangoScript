import { moduleNamesOf } from '../decorators.ts';
import { assignedNames } from '../names.ts';
import type { DecoratorInfo } from './context.ts';
import { DecoratorWrapperChecker } from './decorator-wrappers.ts';

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

    // Its code goes into components elsewhere with the components of this module that it uses.
    info.inline = this.modulePackages().decorators.get(name) ?? null;
    if (info.inline === null) {
      this.error(
        `@${name} is exported, so its code and the components it uses cannot use components or decorators that this module imports yet`,
        node.name,
      );
    }

    // The type of what its wrapper gives: the tags of its markup are names of this module.
    if (info.wrapper) info.wrapper.result = this.wrapperResult(info.wrapper, new Set());
  }
}
