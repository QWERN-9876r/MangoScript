import type * as ast from './ast.ts';
import { declaredIn, declaredNames } from './names.ts';
import { forEachChild } from './walk.ts';

// `go for i, v in items { ... }`: the array is split into parts, one per processor, each part runs
// as a goroutine, and the loop waits for all of them. A goroutine is a function of the worker
// module that loops over its part. The body reaches the array only through its own element,
// `items[i]`, so the part is all that a goroutine needs: there `items` is the part, and `items[i]`
// becomes `items[$$i]`, the index in the part. The local names that the body uses are copied to
// the workers, as for a function literal of `go` (goroutines.ts).

/** Whether a node is `go for`. */
export function isGoFor(node: ast.Node): node is ast.ForInStatement {
  return node.kind === 'ForInStatement' && node.go === true;
}

/** The array that the body may write into: the iterable, if it is a name. */
export function arrayName(loop: ast.ForInStatement): string | null {
  return loop.iterable.kind === 'Identifier' ? loop.iterable.name : null;
}

/** The variables of the loop, as the parameters of a function, for the names its body uses. */
export function loopParams(loop: ast.ForInStatement): ast.Parameter[] {
  return [loop.key, loop.value].flatMap((name): ast.Parameter[] =>
    name
      ? [
          {
            kind: 'Parameter',
            name,
            type: null,
            defaultValue: null,
            start: name.start,
            end: name.end,
          },
        ]
      : [],
  );
}

/** How the body uses the array: its own elements, `items[i]`, and anything else, an error. */
export interface ArrayUses {
  elements: ast.IndexExpression[];
  others: ast.Identifier[];
}

/**
 * The uses of the array in the body. A name declared again inside hides the array or the key; in
 * a function literal of `go` the element is not the loop's, since that goroutine runs elsewhere.
 */
export function arrayUses(loop: ast.ForInStatement): ArrayUses {
  const uses: ArrayUses = { elements: [], others: [] };
  const array = arrayName(loop);
  const key = loop.key && loop.key.name !== '_' ? loop.key.name : null;

  if (array === null) return uses;

  const visit = (node: ast.Node, keyShown: boolean): void => {
    const declared = scopeNames(node);

    if (declared.has(array)) return;

    const shown = keyShown && (key === null || !declared.has(key));

    switch (node.kind) {
      case 'Identifier':
        if (node.name === array) uses.others.push(node);

        return;

      case 'IndexExpression':
        if (
          shown &&
          !node.optional &&
          node.object.kind === 'Identifier' &&
          node.object.name === array &&
          node.index.kind === 'Identifier' &&
          node.index.name === key
        ) {
          uses.elements.push(node);

          return;
        }

        break;

      case 'MemberExpression':
        visit(node.object, shown);

        return;

      case 'Property':
        visit(node.value, shown);

        return;

      case 'GoExpression':
        forEachChild(node, (child) => visit(child, false));

        return;

      default:
        break;
    }

    forEachChild(node, (child) => visit(child, shown));
  };

  visit(loop.body, true);

  return uses;
}

/** The names that a node declares for the code inside it. */
function scopeNames(node: ast.Node): Set<string> {
  switch (node.kind) {
    case 'FuncDeclaration':
    case 'FuncExpression':
    case 'ArrowFunction':
    case 'ClassDeclaration':
      return declaredNames(node);

    case 'BlockStatement':
      return new Set(declaredIn(node.body));

    case 'ForInStatement':
      return new Set([node.value.name, ...(node.key ? [node.key.name] : [])]);

    case 'ForStatement':
      return new Set(node.init?.kind === 'VariableDeclaration' ? declaredIn([node.init]) : []);

    case 'SelectCase':
      return new Set(node.names.map((name) => name.name));

    case 'CatchClause':
      return new Set(node.param ? [node.param.name] : []);

    default:
      return new Set();
  }
}

/** Whether the body writes into the array, so that the parts go back into it. */
export function writesArray(loop: ast.ForInStatement, uses = arrayUses(loop)): boolean {
  const elements = new Set<ast.Node>(uses.elements);
  let found = false;
  const visit = (node: ast.Node): void => {
    if (node.kind === 'AssignmentStatement') {
      found ||= node.targets.some((target) => elements.has(target));
    } else if (node.kind === 'IncDecStatement') {
      found ||= elements.has(node.target);
    }

    forEachChild(node, visit);
  };

  visit(loop.body);

  return found;
}

/** The loops in the functions of the worker module, by the `go for` they were made from. */
const parts = new WeakMap<ast.ForInStatement, ast.ForInStatement>();

/** The `go for` that a loop of a function of the worker module goes over a part of, or null. */
export function partOf(node: ast.ForInStatement): ast.ForInStatement | null {
  return parts.get(node) ?? null;
}

/**
 * The function of the worker module that runs a part of `go for`: it gets the part, the index of
 * its first element in the array, and the local names that the body uses.
 */
export function partFunction(
  loop: ast.ForInStatement,
  name: string,
  captured: readonly string[],
): ast.FuncDeclaration {
  const at = { start: loop.start, end: loop.start };
  const id = (name: string): ast.Identifier => ({ kind: 'Identifier', name, ...at });
  const array = arrayName(loop) ?? '$$items';
  const part: ast.ForInStatement = { ...loop, iterable: id(array) };
  const params = [array, '$$from', ...captured].map((each): ast.Parameter => ({
    kind: 'Parameter',
    name: id(each),
    type: null,
    defaultValue: null,
    ...at,
  }));

  parts.set(part, loop);

  return {
    kind: 'FuncDeclaration',
    exported: false,
    isPublic: false,
    // The body may wait, for a channel or for `go`.
    async: true,
    name: id(name),
    typeParams: [],
    params,
    results: [],
    body: { kind: 'BlockStatement', body: [part], start: loop.start, end: loop.end },
    start: loop.start,
    end: loop.end,
  };
}
