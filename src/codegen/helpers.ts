// Small functions that a module gets only when its code needs them.

export type Helper = 'runDeferred' | 'append' | 'swap' | 'attribute';

export const HELPERS: Readonly<Record<Helper, readonly string[]>> = {
  /** Runs deferred calls in reverse order; every call runs even if an earlier one throws. */
  runDeferred: [
    'function $$runDeferred(deferred) {',
    '  let failure;',
    '  for (let i = deferred.length - 1; i >= 0; i--) {',
    '    try {',
    '      deferred[i]();',
    '    } catch (error) {',
    '      failure = { error };',
    '    }',
    '  }',
    '  if (failure) throw failure.error;',
    '}',
  ],
  /** Appends element content whose type is not known: null adds nothing, arrays add each item. */
  append: [
    'function $$append(parent, value) {',
    '  if (value == null || value === false) return;',
    '  if (Array.isArray(value)) {',
    '    for (const item of value) $$append(parent, item);',
    '  } else {',
    '    parent.append(value);',
    '  }',
    '}',
  ],
  /**
   * Replaces the nodes of a changing part of markup, which are kept before `anchor`. Nodes that
   * stay are moved rather than created again. Returns the new nodes.
   */
  swap: [
    'function $$swap(old, anchor, value) {',
    '  const nodes = [];',
    '  const add = (item) => {',
    '    if (item == null || item === false) return;',
    '    if (Array.isArray(item)) {',
    '      for (const each of item) add(each);',
    '    } else if (item.nodeType === 11) {',
    '      nodes.push(...item.childNodes);',
    '    } else {',
    '      nodes.push(typeof item === "object" ? item : document.createTextNode(String(item)));',
    '    }',
    '  };',
    '  add(value);',
    '  const kept = new Set(nodes);',
    '  for (const node of old) if (!kept.has(node)) node.remove();',
    '  anchor.before(...nodes);',
    '  return nodes;',
    '}',
  ],
  /** Sets an attribute whose value may be null: then the attribute is removed. */
  attribute: [
    'function $$attribute(element, name, value) {',
    '  if (value == null) element.removeAttribute(name);',
    '  else element.setAttribute(name, value);',
    '}',
  ],
};
