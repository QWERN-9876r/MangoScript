/**
 * Syntax tree produced by the parser. Every node has a `kind` that discriminates the unions below
 * and the `start`/`end` offsets of its source text.
 *
 * For example, `const q, err = divide(10, 2)` becomes:
 *
 *     VariableDeclaration {
 *       keyword: 'const', names: [Identifier q, Identifier err], type: null,
 *       values: [CallExpression { callee: Identifier divide, arguments: [NumberLiteral 10, NumberLiteral 2] }],
 *     }
 *
 * Grouped names such as `a, b number` in parameters, fields and interface members are expanded into
 * separate nodes that share the same type node.
 */

export * from './ast/declarations.ts';
export * from './ast/statements.ts';
export * from './ast/expressions.ts';
export * from './ast/markup.ts';
