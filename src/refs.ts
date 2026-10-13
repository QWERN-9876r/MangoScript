import type * as ast from './ast.ts';
import { forEachChild } from './walk.ts';

// References to elements: `ref input` in the body of a component or a decorator and
// `<input ref={input} />` in its markup. The element is created where the ref is declared, with
// its constant attributes, and the markup fills it in, so that markup must be created exactly
// once. `<Card ref={card} />` points to the element at the top of what `Card` returns, created
// the same way. The checker and the generator share these questions about the syntax tree.

/** Why markup may be created more than once, so that a ref cannot point into it. */
export type Repeated = 'for' | 'if' | 'switch' | 'expression' | 'function' | 'block';

export interface RefBinding {
  attribute: ast.JsxAttribute;
  element: ast.ElementExpression;
  /** Null when the markup is created exactly once. */
  repeated: Repeated | null;
}

/** `ref={input}` of an element or a component use. */
export function refAttribute(node: ast.ElementExpression): ast.JsxAttribute | undefined {
  return node.attributes.find(
    (attribute): attribute is ast.JsxAttribute =>
      attribute.kind === 'JsxAttribute' && attribute.name.name === 'ref',
  );
}

/** The ref an element is bound to: `input` in `<input ref={input} />`. */
export function refName(node: ast.ElementExpression): string | null {
  const value = refAttribute(node)?.value;

  return value?.kind === 'Identifier' ? value.name : null;
}

/**
 * The attributes that are set where the ref is declared: strings and attributes without a value,
 * before the first spread, which may override them. Values in braces, handlers and `bind:` are
 * set by the markup.
 */
export function constantAttributes(node: ast.ElementExpression): ast.JsxAttribute[] {
  const found: ast.JsxAttribute[] = [];

  for (const attribute of node.attributes) {
    if (attribute.kind === 'JsxSpreadAttribute') break;

    const { name, value } = attribute;

    if (name.name === 'ref' || name.name.startsWith('bind:') || /^on[A-Z]/.test(name.name)) {
      continue;
    }

    if (value === null || value.kind === 'StringLiteral') found.push(attribute);
  }

  return found;
}

/**
 * The `ref={...}` attributes in the markup of a body, and whether that markup is created exactly
 * once: what a `return` gives (also through the wrapper a decorator returns), `const x = <markup>`
 * at the top level, and the elements and children of components inside them.
 */
export function refBindings(body: ast.BlockStatement): RefBinding[] {
  const found: RefBinding[] = [];

  const markup = (node: ast.ElementExpression, repeated: Repeated | null): void => {
    for (const attribute of node.attributes) {
      if (attribute.kind === 'JsxAttribute' && attribute.name.name === 'ref') {
        found.push({ attribute, element: node, repeated });
      } else {
        visit(attribute, repeated ?? 'expression');
      }
    }

    for (const child of node.children) {
      // The children of a component are created by the markup that uses it, once.
      if (child.kind === 'ElementExpression') markup(child, repeated);
      else if (child.kind !== 'JsxStatementContainer') visit(child, repeated ?? 'expression');
      else visit(child.statement, flowOf(child.statement));
    }
  };

  const visit = (node: ast.Node, repeated: Repeated): void => {
    switch (node.kind) {
      case 'ElementExpression':
        markup(node, repeated);

        return;

      case 'ReturnStatement':
        // An early return of the body runs once, wherever it is.
        if (repeated === 'block') returned(node);
        else forEachChild(node, (child) => visit(child, repeated));

        return;

      case 'IfStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement': {
        // Control flow in markup; that of the body is a block, which runs once or in a loop.
        const inner = repeated === 'block' || repeated === 'function' ? repeated : flowOf(node);

        forEachChild(node, (child) => visit(child, inner));

        return;
      }

      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'EventHandler':
      case 'MountStatement':
      case 'EffectStatement':
      case 'ClassDeclaration':
        forEachChild(node, (child) => visit(child, 'function'));

        return;

      default:
        forEachChild(node, (child) => visit(child, repeated));
    }
  };

  const returned = (node: ast.ReturnStatement): void => {
    for (const value of node.values) {
      if (value.kind === 'ElementExpression') markup(value, null);
      else if (value.kind === 'ArrowFunction' || value.kind === 'FuncExpression') wrapper(value);
      else visit(value, 'expression');
    }
  };

  // The wrapper of a decorator runs once, where the component returns.
  const wrapper = (fn: ast.ArrowFunction | ast.FuncExpression): void => {
    for (const param of fn.params) visit(param, 'function');
    if (fn.body.kind === 'BlockStatement') statements(fn.body.body);
    else if (fn.body.kind === 'ElementExpression') markup(fn.body, null);
    else visit(fn.body, 'expression');
  };

  const statements = (list: readonly ast.Statement[]): void => {
    for (const statement of list) {
      const [value] = statement.kind === 'VariableDeclaration' ? statement.values : [];

      if (statement.kind === 'ReturnStatement') {
        returned(statement);
      } else if (value?.kind === 'ElementExpression' && statement.kind === 'VariableDeclaration') {
        if (statement.names.length === 1) markup(value, null);
        else visit(statement, 'block');
      } else {
        visit(statement, 'block');
      }
    }
  };

  statements(body.body);

  return found;
}

function flowOf(
  node: ast.IfStatement | ast.ForStatement | ast.ForInStatement | ast.SwitchStatement,
) {
  return node.kind === 'IfStatement' ? 'if' : node.kind === 'SwitchStatement' ? 'switch' : 'for';
}

/**
 * For each ref of a checked body, the element its markup binds it to. The wrapper of a decorator
 * is copied to every `return` of a component, so there may be several, all alike.
 */
export function refTargets(body: ast.BlockStatement): Map<string, ast.ElementExpression> {
  const targets = new Map<string, ast.ElementExpression>();
  const visit = (node: ast.Node): void => {
    const name = node.kind === 'ElementExpression' ? refName(node) : null;

    if (name !== null && !targets.has(name)) targets.set(name, node as ast.ElementExpression);
    forEachChild(node, visit);
  };

  visit(body);

  return targets;
}

/** Why the element a component creates is not known in advance; e.g. `has several returns`. */
export type Root = ast.ElementExpression | string;

/**
 * What a component returns, if it is known in advance: an element or the use of a component in
 * its own markup. Through `const content = <markup>`, which is how the wrapper of a decorator gets
 * it. Otherwise why it is not known, as a phrase after "it".
 */
export function ownRoot(component: ast.ComponentDeclaration): Root {
  const returns: ast.ReturnStatement[] = [];
  const visit = (node: ast.Node): void => {
    if (node.kind === 'ReturnStatement') returns.push(node);
    if (
      node.kind !== 'FuncDeclaration' &&
      node.kind !== 'FuncExpression' &&
      node.kind !== 'ArrowFunction' &&
      node.kind !== 'ClassDeclaration' &&
      node.kind !== 'MountStatement' &&
      node.kind !== 'EffectStatement'
    ) {
      forEachChild(node, visit);
    }
  };

  forEachChild(component.body, visit);

  if (returns.length > 1) return 'has several returns, so its element is not known in advance';

  const constants = new Map<string, ast.Expression>();

  for (const statement of component.body.body) {
    const [name] = statement.kind === 'VariableDeclaration' ? statement.names : [];

    if (statement.kind === 'VariableDeclaration' && statement.keyword === 'const' && name) {
      if (statement.names.length === 1 && statement.values.length === 1) {
        constants.set(name.name, statement.values[0]!);
      }
    }
  }

  let [value] = returns[0]?.values ?? [];
  const seen = new Set<string>();

  while (value?.kind === 'Identifier' && constants.has(value.name) && !seen.has(value.name)) {
    seen.add(value.name);
    value = constants.get(value.name);
  }

  if (value?.kind !== 'ElementExpression') {
    return 'does not return markup of its own, so its element is not known in advance';
  }

  return value.tag === null ? 'returns a fragment, which is empty once inserted' : value;
}

export function isComponentUse(node: ast.ElementExpression): boolean {
  return node.tag !== null && /^[A-Z]/.test(node.tag.name);
}

/**
 * The element at the top of what a component creates, through the components it returns.
 * `rootOf` gives that of another component by its tag.
 */
export function componentRoot(
  component: ast.ComponentDeclaration,
  rootOf: (tag: string) => Root | undefined,
): Root {
  const own = ownRoot(component);

  if (typeof own === 'string' || !isComponentUse(own)) return own;

  const tag = own.tag!.name;
  const inner = rootOf(tag) ?? 'is not known in advance';

  return typeof inner === 'string' ? `returns <${tag}>, which ${inner}` : inner;
}
