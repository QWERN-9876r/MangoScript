import type * as ast from '../ast.ts';
import { AssignmentChecker } from './assignments.ts';
import { isUntyped, isNumeric } from './helpers.ts';
import {
  func,
  hasZeroValue,
  isNullable,
  nonNull,
  nullable,
  typeToString,
  UNKNOWN,
  type Type,
} from './types.ts';

// Statements: declarations of variables, blocks, `mount()`. Assignments and `return` are in
// assignments.ts.

export abstract class StatementChecker extends AssignmentChecker {
  protected override checkStatement(node: ast.Statement): void {
    switch (node.kind) {
      case 'VariableDeclaration':
        this.checkVariableDeclaration(node);
        break;

      case 'BlockStatement':
        this.checkBlock(node.body);
        break;

      case 'ExpressionStatement':
        this.checkExpression(node.expression, null);
        break;

      case 'JsxElementStatement':
        this.checkExpression(node.element, null);
        break;

      case 'AssignmentStatement':
        this.checkAssignment(node);
        break;

      case 'IncDecStatement': {
        const type = this.checkTarget(node.target);

        if (!isNumeric(type)) {
          this.error(`"${node.operator}" needs a number, not ${typeToString(type)}`, node.target);
        }

        this.forget(node.target);
        break;
      }

      case 'ReturnStatement':
        this.checkReturn(node);
        break;

      case 'IfStatement':
        this.checkIf(node);
        break;

      case 'ForStatement':
        this.checkFor(node);
        break;

      case 'ForInStatement':
        this.checkForIn(node);
        break;

      case 'SwitchStatement':
        this.checkSwitch(node);
        break;

      case 'ThrowStatement':
        this.checkValue(node.argument);
        break;

      case 'TryStatement':
        this.checkTry(node);
        break;

      case 'DeferStatement':
        if (node.body.kind === 'BlockStatement') this.checkBlock(node.body.body);
        else this.checkExpression(node.body, null);
        break;

      case 'MountStatement':
        this.checkMount(node);
        break;

      case 'ImportDeclaration':
      case 'FuncDeclaration':
      case 'ComponentDeclaration':
      case 'DecoratorDeclaration':
      case 'ClassDeclaration':
      case 'InterfaceDeclaration':
      case 'TypeAliasDeclaration':
      case 'BreakStatement':
      case 'ContinueStatement':
        // Declarations are handled by declareStatements(); jumps were checked by the parser.
        break;
    }
  }

  /**
   * `mount() { ... }`: a function that runs once the markup is in the document, like a handler.
   * It may return the function that cleans up, or nothing.
   */
  protected checkMount(node: ast.MountStatement): void {
    const results = this.checkFunction([], func([], []), null, node.body, { closure: true });

    if (results.length === 0) return;

    const result = results.length === 1 ? nonNull(results[0]!) : null;
    const cleans =
      result !== null &&
      (isUntyped(result) ||
        result.kind === 'never' ||
        (result.kind === 'function' && result.required === 0));

    if (!cleans) {
      const returned =
        results.length === 1 ? typeToString(results[0]!) : `${results.length} values`;

      this.error(
        `mount() returns the function that cleans up, e.g. return () => clearInterval(timer), not ${returned}`,
        { start: node.start, end: node.start + 'mount'.length },
      );
    }
  }

  protected checkBlock(statements: readonly ast.Statement[]): void {
    this.withScope(() => this.checkStatementList(statements, false));
  }

  protected checkVariableDeclaration(node: ast.VariableDeclaration): void {
    const declared = node.type ? this.resolveType(node.type) : null;
    const { names, values } = node;
    // The variables exist from the start of their declaration, as in JS, so functions in the
    // initializer can use them (initializers.ts). A written type they have right away.
    const bindings = names.map((name) => {
      if (name.name === '_') return null;

      // Top-level variables were declared in advance by declareStatements().
      const existing = this.scope.values.get(name.name);
      const binding =
        existing && existing.type === null && existing.kind === node.keyword
          ? existing
          : this.declareValue(name, node.keyword, null);

      binding.type = declared;

      return binding;
    });

    this.checkInitializer(
      node,
      bindings.filter((binding) => binding !== null),
      () => {
        const types = this.initializerTypes(node, declared);

        bindings.forEach((binding, i) => {
          if (!binding) return;

          const type = types[i] ?? UNKNOWN;

          binding.type = type;

          const value = values.length === names.length ? values[i] : undefined;

          if (value && isNullable(type) && !isNullable(this.typeOfChecked(value))) {
            this.flow.set(binding, nonNull(type));
          }
        });
      },
    );
  }

  /** The types of the variables of a declaration: the written one, or those of their values. */
  private initializerTypes(node: ast.VariableDeclaration, declared: Type | null): Type[] {
    const { names, values } = node;
    let types: Type[];

    if (values.length === 0) {
      if (declared && !hasZeroValue(declared) && declared.kind !== 'unknown') {
        const type = typeToString(declared);

        this.error(
          `${type} has no zero value: give "${names[0]!.name}" a value or make it nullable with ${typeToString(nullable(declared))}`,
          node.type ?? node,
        );
      }

      types = names.map(() => declared ?? UNKNOWN);
    } else if (values.length === names.length) {
      types = values.map((value) => {
        const type = this.checkValue(value, declared);

        if (!declared) return this.inferredType(type, value);
        this.expectAssignable(type, declared, value);

        return declared;
      });
    } else {
      types = this.unpack(values[0]!, names.length, declared);
    }

    return types;
  }
}
