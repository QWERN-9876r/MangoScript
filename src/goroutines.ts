import type * as ast from './ast.ts';
import { freeNames } from './names.ts';
import { forEachChild } from './walk.ts';

// Goroutines: `go work(x)` calls a function in a worker. The worker loads a module of its own
// with the functions that `go` calls and the declarations of the module that their code reaches,
// but not the rest of the module: its top-level code would run again there, and a worker has no
// `document`. The imports that this code uses are imported there too.

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

/** Every `go` expression of the program, nested ones too. */
export function goExpressions(program: ast.Program): ast.GoExpression[] {
  const found: ast.GoExpression[] = [];
  const visit = (node: ast.Node) => {
    if (node.kind === 'GoExpression') found.push(node);
    forEachChild(node, visit);
  };

  visit(program);

  return found;
}

/** The function that a `go` calls: a name; anything else is reported by the checker. */
export function goTarget(node: ast.GoExpression): string | null {
  return node.call.callee.kind === 'Identifier' ? node.call.callee.name : null;
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
  const { statements, imports } = reach(program, targets);
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
