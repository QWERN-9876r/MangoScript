import type * as ast from '../ast.ts';
import { CallChecker } from './calls.ts';
import type { CheckOptions, CheckResult } from './context.ts';

export type { CheckOptions, CheckResult, ImportResult, Library, ModuleExports } from './context.ts';

// The type checker of a module; its layers are listed in base.ts.

class Checker extends CallChecker {
  run(): CheckResult {
    this.checkStatementList(this.program.body, true);
    this.checkEndlessRecursion();
    this.checkHtmlTags();
    this.diagnostics.sort((a, b) => a.start - b.start);

    return {
      diagnostics: this.diagnostics,
      ...this.collectDeclarations(),
      types: this.checkedTypes,
    };
  }
}

export function check(program: ast.Program, options: CheckOptions = {}): CheckResult {
  return new Checker(program, options).run();
}
