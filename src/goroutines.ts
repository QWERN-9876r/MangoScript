import type * as ast from './ast.ts';
import { arrayName, isGoFor, loopParams, partFunction } from './go-for.ts';
import { declaredNames, freeNames } from './names.ts';
import { forEachChild } from './walk.ts';

// Goroutines: `go work(x)` calls a function in a worker. The worker loads a module of its own
// with the functions that `go` calls and the declarations of the module that their code reaches,
// but not the rest of the module: its top-level code would run again there, and a worker has no
// `document`. The imports that this code uses are imported there too. A function literal,
// `go func(x) { ... }(y)`, becomes a function of the worker module, `$$goroutine0`, and the local
// names it uses are passed to it first, as copies. So is the body of `go for`, which becomes a
// function that loops over a part of the array (go-for.ts).

/** What runs as a goroutine: the call of `go`, or the body of `go for`. */
export type Goroutine = ast.GoExpression | ast.ForInStatement;

/** What a goroutine reaches from the function it calls. */
export interface Reach {
  /** Top-level declarations of the module, in source order. */
  statements: ast.Statement[];
  /** Imported names, by their import declarations. */
  imports: Map<ast.ImportDeclaration, Set<string>>;
  /** `let` variables of the module: a worker does not share them. */
  lets: string[];
  /** Components, decorators or markup, which need a document: the first one found. */
  markup: string | null;
}

/** Every `go` expression and `go for` loop of the program, nested ones too. */
export function goroutines(program: ast.Program): Goroutine[] {
  const found: Goroutine[] = [];
  const visit = (node: ast.Node) => {
    if (node.kind === 'GoExpression' || isGoFor(node)) found.push(node);
    forEachChild(node, visit);
  };

  visit(program);

  return found;
}

/**
 * The names of the functions of the literals of `go` and of the `go for` loops in the worker
 * module, numbered in the module as written. The worker module has the same nodes, and keeps them.
 */
const literalNames = new WeakMap<Goroutine, string>();

/** The programs whose literals have names. */
const named = new WeakSet<ast.Program>();

/** The local names that a literal of `go` or a `go for` uses, as the checker finds them. */
const captures = new WeakMap<Goroutine, string[]>();

/** A function literal of `go`, or a `go for`: code that becomes a function of the worker module. */
function isLiteral(node: Goroutine): boolean {
  return node.kind === 'ForInStatement' || node.call.callee.kind === 'FuncExpression';
}

/**
 * The function that a goroutine calls in the worker module: a name, or the name given to a
 * function literal or a `go for`; anything else is reported by the checker.
 */
export function goTarget(program: ast.Program, node: Goroutine): string | null {
  if (node.kind === 'GoExpression' && node.call.callee.kind === 'Identifier') {
    return node.call.callee.name;
  }

  if (!isLiteral(node)) return null;

  if (!named.has(program) && !literalNames.has(node)) {
    named.add(program);
    goroutines(program)
      .filter(isLiteral)
      .forEach((each, i) => literalNames.set(each, `$$goroutine${i}`));
  }

  return literalNames.get(node) ?? null;
}

export function recordCaptures(node: Goroutine, names: string[]): void {
  captures.set(node, names);
}

/**
 * The local names that the literal of a `go` or a `go for` gets first: those the checker found.
 * Code that was not checked passes the names that the code uses and the declaration around it
 * declares, but not the array of `go for`, which goes in parts.
 */
export function goCaptures(program: ast.Program, node: Goroutine): string[] {
  const recorded = captures.get(node);

  if (recorded) return recorded;

  const literal =
    node.kind === 'ForInStatement'
      ? { params: loopParams(node), body: node.body }
      : (node.call.callee as ast.FuncExpression);
  const array = node.kind === 'ForInStatement' ? arrayName(node) : null;
  const outer = program.body.find((each) => each.start <= node.start && node.end <= each.end);
  const module = new Set(program.body.flatMap(declaredBy));
  const local = outer
    ? declaredNames({ kind: 'BlockStatement', body: [outer], start: outer.start, end: outer.end })
    : new Set<string>();

  return [...freeNames(literal)].filter(
    (name) => local.has(name) && !module.has(name) && name !== array,
  );
}

/** Parameters for the local names that a literal of `go` gets first. */
export function goParams(literal: ast.FuncExpression, names: string[]): ast.Parameter[] {
  const at = { start: literal.start, end: literal.start };

  return names.map((name) => ({
    kind: 'Parameter',
    name: { kind: 'Identifier', name, ...at },
    type: null,
    defaultValue: null,
    ...at,
  }));
}

/**
 * The functions of the literals of `go`, with the local names they use as their first parameters,
 * and of the `go for` loops.
 */
function literalFunctions(program: ast.Program): ast.FuncDeclaration[] {
  return goroutines(program).flatMap((node): ast.FuncDeclaration[] => {
    if (node.kind === 'ForInStatement') {
      return [partFunction(node, goTarget(program, node)!, goCaptures(program, node))];
    }

    const literal = node.call.callee;

    if (literal.kind !== 'FuncExpression') return [];

    const at = { start: literal.start, end: literal.start };
    const params = goParams(literal, goCaptures(program, node));

    return [
      {
        kind: 'FuncDeclaration',
        exported: false,
        isPublic: false,
        ...(literal.async ? { async: true } : {}),
        name: { kind: 'Identifier', name: goTarget(program, node)!, ...at },
        typeParams: [],
        params: [...params, ...literal.params],
        results: literal.results,
        body: literal.body,
        start: literal.start,
        end: literal.end,
      },
    ];
  });
}

/** What the code of the functions `names` reaches in the module, through the names it uses. */
export function reach(program: ast.Program, names: Iterable<string>): Reach {
  const declarations = new Map<string, ast.Statement>();
  const importsByName = new Map<string, ast.ImportDeclaration>();

  for (const statement of program.body) {
    for (const name of declaredBy(statement)) declarations.set(name, statement);
  }

  const result: Reach = { statements: [], imports: new Map(), lets: [], markup: null };
  const reached = new Set<ast.Statement>();
  const queue = [...names];
  const seen = new Set(queue);

  for (const statement of program.body) {
    if (statement.kind !== 'ImportDeclaration') continue;
    for (const name of importedNames(statement)) importsByName.set(name, statement);
  }

  for (let i = 0; i < queue.length; i++) {
    const name = queue[i]!;
    const imported = importsByName.get(name);

    if (imported) {
      const used = result.imports.get(imported) ?? new Set();

      used.add(name);
      result.imports.set(imported, used);
      continue;
    }

    const statement = declarations.get(name);

    if (!statement) continue;
    if (statement.kind === 'VariableDeclaration' && statement.keyword !== 'const') {
      result.lets.push(name);
      continue;
    }

    if (statement.kind === 'ComponentDeclaration' || statement.kind === 'DecoratorDeclaration') {
      result.markup ??= `the ${statement.kind === 'ComponentDeclaration' ? 'component' : 'decorator'} "${name}"`;
      continue;
    }

    if (reached.has(statement)) continue;
    reached.add(statement);
    if (hasMarkup(statement)) result.markup ??= `the markup in "${name}"`;
    for (const used of usedNames(statement)) {
      if (!seen.has(used)) {
        seen.add(used);
        queue.push(used);
      }
    }
  }

  result.statements = program.body.filter((statement) => reached.has(statement));

  return result;
}

/**
 * The program of the worker module: the imports and the declarations that the functions `targets`
 * reach, unexported, since the worker module is only loaded by the worker.
 */
export function workerProgram(program: ast.Program, targets: readonly string[]): ast.Program {
  const lifted = { ...program, body: [...program.body, ...literalFunctions(program)] };
  const { statements, imports } = reach(lifted, targets);
  const body: ast.Statement[] = [];

  for (const [statement, names] of imports) {
    body.push({
      ...statement,
      defaultImport: statement.defaultImport && keep(statement.defaultImport, names),
      namespaceImport: statement.namespaceImport && keep(statement.namespaceImport, names),
      namedImports: statement.namedImports.filter((specifier) => names.has(specifier.local.name)),
    });
  }

  for (const statement of statements) {
    body.push('exported' in statement ? { ...statement, exported: false } : statement);
  }

  return { ...program, body };
}

function keep(name: ast.Identifier, names: ReadonlySet<string>): ast.Identifier | null {
  return names.has(name.name) ? name : null;
}

function declaredBy(statement: ast.Statement): string[] {
  switch (statement.kind) {
    case 'VariableDeclaration':
      return statement.names.map((name) => name.name);

    case 'FuncDeclaration':
    case 'ClassDeclaration':
    case 'ComponentDeclaration':
    case 'DecoratorDeclaration':
      return [statement.name.name];

    default:
      return [];
  }
}

function importedNames(statement: ast.ImportDeclaration): string[] {
  return [
    ...(statement.defaultImport ? [statement.defaultImport.name] : []),
    ...(statement.namespaceImport ? [statement.namespaceImport.name] : []),
    ...statement.namedImports.map((specifier) => specifier.local.name),
  ];
}

/** The names that the code of a top-level declaration uses; not those of members or keys. */
function usedNames(statement: ast.Statement): Set<string> {
  const block = (body: ast.Statement[]): ast.BlockStatement => ({
    kind: 'BlockStatement',
    body,
    start: statement.start,
    end: statement.end,
  });

  switch (statement.kind) {
    case 'FuncDeclaration':
      return freeNames(statement);

    case 'VariableDeclaration':
      return freeNames({ params: [], body: block([statement]) });

    case 'ClassDeclaration': {
      const names = new Set<string>();
      const add = (found: Set<string>) => found.forEach((name) => names.add(name));

      if (statement.superClass) {
        add(freeNames({ params: [], body: block([expression(statement.superClass)]) }));
      }

      for (const member of statement.members) {
        if (member.kind === 'FieldDeclaration') {
          if (member.value) add(freeNames({ params: [], body: block([expression(member.value)]) }));
        } else {
          add(freeNames(member));
        }
      }

      return names;
    }

    default:
      return new Set();
  }
}

function expression(node: ast.Expression): ast.ExpressionStatement {
  return { kind: 'ExpressionStatement', expression: node, start: node.start, end: node.end };
}

function hasMarkup(node: ast.Node): boolean {
  if (node.kind === 'ElementExpression') return true;

  let found = false;

  forEachChild(node, (child) => {
    found ||= hasMarkup(child);
  });

  return found;
}
