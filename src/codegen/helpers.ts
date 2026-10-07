// Small functions that a module gets only when its code needs them.

export type Helper =
  'runDeferred' | 'append' | 'attribute' | 'content' | 'branches' | 'list' | 'owner' | 'mount';

/** Helpers that use other helpers. */
export const HELPER_NEEDS: Readonly<Partial<Record<Helper, readonly Helper[]>>> = {
  owner: ['runDeferred'],
  mount: ['owner'],
  content: ['owner'],
  branches: ['owner'],
  list: ['owner'],
};

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
  /**
   * Owners of markup that `{if}`, `{switch}` and `{for}` may remove: the functions returned by the
   * `mount()` of its components, and the removal of the blocks inside it, run when it is removed.
   * The current owner is shared by the modules of a page, since the blocks of one module may hold
   * the components of another.
   */
  owner: [
    'const $$owner = Symbol.for("mangoscript.owner");',
    '',
    'function $$owned(create) {',
    '  const owner = { removed: false, cleanups: [] };',
    '  const parent = globalThis[$$owner];',
    '  globalThis[$$owner] = owner;',
    '  let result;',
    '  try {',
    '    result = create();',
    '  } finally {',
    '    globalThis[$$owner] = parent;',
    '  }',
    '  const remove = () => {',
    '    if (owner.removed) return;',
    '    owner.removed = true;',
    '    $$runDeferred(owner.cleanups);',
    '  };',
    '  return [result, remove];',
    '}',
    '',
    'function $$onRemove(cleanup) {',
    '  globalThis[$$owner]?.cleanups.push(cleanup);',
    '}',
  ],
  /**
   * `mount() { ... }` of a component: runs after the code that creates the component, when its
   * markup is in the document, unless it was removed before. The function it returns runs when
   * its owner is removed.
   */
  mount: [
    'function $$mount(mount) {',
    '  const owner = globalThis[$$owner];',
    '  queueMicrotask(() => {',
    '    if (owner?.removed) return;',
    '    const cleanup = mount();',
    '    if (typeof cleanup === "function") owner?.cleanups.push(cleanup);',
    '  });',
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
   * Nodes of markup that change, `{list}` or `{ok ? <b /> : null}`: they are kept before an end
   * marker. Nodes that stay are moved rather than created again. Returns the markers with the
   * first nodes, to be inserted, and the update.
   */
  content: [
    'function $$content(value) {',
    '  const end = document.createTextNode("");',
    '  const fragment = document.createDocumentFragment();',
    '  fragment.append(end);',
    '  let nodes = [];',
    '  let remove;',
    '  const update = () => {',
    '    const next = [];',
    '    const add = (item) => {',
    '      if (item == null || item === false) return;',
    '      if (Array.isArray(item)) {',
    '        for (const each of item) add(each);',
    '      } else if (item.nodeType === 11) {',
    '        next.push(...item.childNodes);',
    '      } else {',
    '        next.push(typeof item === "object" ? item : document.createTextNode(String(item)));',
    '      }',
    '    };',
    '    const [created, removeCreated] = $$owned(value);',
    '    add(created);',
    '    remove?.();',
    '    remove = removeCreated;',
    '    const kept = new Set(next);',
    '    for (const node of nodes) if (!kept.has(node)) node.remove();',
    '    end.before(...next);',
    '    nodes = next;',
    '  };',
    '  update();',
    '  $$onRemove(() => remove?.());',
    '  return [fragment, update];',
    '}',
  ],
  /**
   * `{if ...}` and `{switch ...}` in markup: shows the block that `choose` picks (-1 for none)
   * between two markers. The block is created again only when the choice changes; otherwise it is
   * updated.
   */
  branches: [
    'function $$branches(choose, blocks) {',
    '  const start = document.createTextNode("");',
    '  const end = document.createTextNode("");',
    '  const fragment = document.createDocumentFragment();',
    '  fragment.append(start, end);',
    '  let current = null;',
    '  let update;',
    '  let remove;',
    '  const render = () => {',
    '    const next = choose();',
    '    if (next === current) {',
    '      update?.();',
    '      return;',
    '    }',
    '    current = next;',
    '    remove?.();',
    '    while (start.nextSibling !== end) start.nextSibling.remove();',
    '    update = undefined;',
    '    remove = undefined;',
    '    if (next >= 0) {',
    '      const [[content, blockUpdate], removeBlock] = $$owned(blocks[next]);',
    '      end.before(content);',
    '      update = blockUpdate;',
    '      remove = removeBlock;',
    '    }',
    '  };',
    '  render();',
    '  $$onRemove(() => remove?.());',
    '  return [fragment, render];',
    '}',
  ],
  /**
   * `{for item in items { ... }}` in markup: a block for each item, between its own markers. On
   * updates the blocks are found again by the item itself: blocks of items that stay are updated
   * and moved into place, others are created or removed.
   */
  list: [
    'function $$list(items, create) {',
    '  const end = document.createTextNode("");',
    '  const fragment = document.createDocumentFragment();',
    '  fragment.append(end);',
    '  let blocks = [];',
    '  const nodesOf = (block) => {',
    '    const nodes = [];',
    '    for (let node = block.start; node !== block.end; node = node.nextSibling) nodes.push(node);',
    '    nodes.push(block.end);',
    '    return nodes;',
    '  };',
    '  const update = () => {',
    '    const old = new Map();',
    '    for (const block of blocks) {',
    '      const same = old.get(block.item);',
    '      if (same) same.push(block);',
    '      else old.set(block.item, [block]);',
    '    }',
    '    const next = [];',
    '    let index = 0;',
    '    for (const item of items()) {',
    '      let block = old.get(item)?.shift();',
    '      if (block) {',
    '        block.update?.(index);',
    '      } else {',
    '        const [[content, blockUpdate], remove] = $$owned(() => create(item, index));',
    '        block = { item, start: document.createTextNode(""), end: document.createTextNode("") };',
    '        block.update = blockUpdate;',
    '        block.remove = remove;',
    '        block.content = document.createDocumentFragment();',
    '        block.content.append(block.start, content, block.end);',
    '      }',
    '      next.push(block);',
    '      index++;',
    '    }',
    '    for (const same of old.values()) {',
    '      for (const block of same) {',
    '        block.remove();',
    '        for (const node of nodesOf(block)) node.remove();',
    '      }',
    '    }',
    '    let before = end;',
    '    for (let i = next.length - 1; i >= 0; i--) {',
    '      const block = next[i];',
    '      if (block.content) {',
    '        before.before(block.content);',
    '        block.content = null;',
    '      } else if (block.end.nextSibling !== before) {',
    '        before.before(...nodesOf(block));',
    '      }',
    '      before = block.start;',
    '    }',
    '    blocks = next;',
    '  };',
    '  update();',
    '  $$onRemove(() => {',
    '    for (const block of blocks) block.remove();',
    '  });',
    '  return [fragment, update];',
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
