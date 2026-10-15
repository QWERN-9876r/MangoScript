import { CHAN_HELPERS, type ChanHelper } from './chan-helpers.ts';
import { GO_HELPERS, type GoHelper } from './go-helpers.ts';
import { SELECT_HELPERS, type SelectHelper } from './select-helpers.ts';
import { THREAD_HELPERS, type ThreadHelper } from './thread-helpers.ts';

// Small functions that a module gets only when its code needs them; those of `go` and of channels
// are in go-helpers.ts, chan-helpers.ts, select-helpers.ts and thread-helpers.ts.

export type Helper =
  | GoHelper
  | ChanHelper
  | SelectHelper
  | ThreadHelper
  | 'runDeferred'
  | 'values'
  | 'append'
  | 'attribute'
  | 'content'
  | 'branches'
  | 'dynamic'
  | 'list'
  | 'owner'
  | 'mount'
  | 'style'
  | 'element'
  | 'svgElement';

/** Predeclared functions of goroutines and channels, by the helpers that define them. */
export const PREDECLARED: Readonly<Record<string, Helper>> = {
  close: 'chan',
  transfer: 'threads',
  after: 'timers',
  tick: 'timers',
  cancel: 'cancel',
};

/** Helpers that use other helpers. */
export const HELPER_NEEDS: Readonly<Partial<Record<Helper, readonly Helper[]>>> = {
  go: ['threads'],
  goLocal: ['threads'],
  serve: ['threads'],
  chan: ['threads', 'select'],
  timers: ['chan'],
  cancel: ['threads'],
  select: ['chan'],
  owner: ['runDeferred'],
  mount: ['owner'],
  content: ['owner'],
  branches: ['owner'],
  dynamic: ['owner'],
  list: ['owner'],
};

export const HELPERS: Readonly<Record<Helper, readonly string[]>> = {
  ...GO_HELPERS,
  ...CHAN_HELPERS,
  ...SELECT_HELPERS,
  ...THREAD_HELPERS,
  /** `for v in x` over an untyped value: a Map gives its values, as a typed one does. */
  values: [
    'function $$values(iterable) {',
    '  return iterable instanceof Map ? iterable.values() : iterable;',
    '}',
  ],
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
   * `mount() { ... }` of a component: runs when its markup is in the document. That is checked
   * after the code that creates the component; markup that is not in the document yet is waited
   * for with a MutationObserver, which watches only while some markup waits. Markup that its
   * owner removes before that never mounts. The function `mount` returns runs when the owner is
   * removed.
   */
  mount: [
    'const $$waiting = new Set();',
    'let $$observer = null;',
    '',
    'function $$mount(node, mount) {',
    '  const entry = { node, mount, owner: globalThis[$$owner] };',
    '  entry.owner?.cleanups.push(() => $$waiting.delete(entry));',
    '  queueMicrotask(() => $$tryMount(entry));',
    '}',
    '',
    'function $$tryMount(entry) {',
    '  if (entry.owner?.removed) return;',
    '  const node = entry.node();',
    '  if (node != null && !node.isConnected) {',
    '    $$waiting.add(entry);',
    '    if (!$$observer) {',
    '      $$observer = new MutationObserver($$mountWaiting);',
    '      $$observer.observe(node.ownerDocument ?? document, { childList: true, subtree: true });',
    '    }',
    '    return;',
    '  }',
    '  const cleanup = entry.mount();',
    '  if (typeof cleanup === "function") entry.owner?.cleanups.push(cleanup);',
    '}',
    '',
    'function $$mountWaiting() {',
    '  for (const entry of $$waiting) {',
    '    if (!entry.node().isConnected) continue;',
    '    $$waiting.delete(entry);',
    '    $$tryMount(entry);',
    '  }',
    '  if ($$waiting.size === 0) {',
    '    $$observer.disconnect();',
    '    $$observer = null;',
    '  }',
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
   * `<Page />` whose component is a value that changes: when it does, the block that `create`
   * makes with it is created again between two markers; otherwise the block is updated.
   */
  dynamic: [
    'function $$dynamic(component, create) {',
    '  const start = document.createTextNode("");',
    '  const end = document.createTextNode("");',
    '  const fragment = document.createDocumentFragment();',
    '  fragment.append(start, end);',
    '  let current;',
    '  let update;',
    '  let remove;',
    '  const render = () => {',
    '    const next = component();',
    '    if (remove && next === current) {',
    '      update?.();',
    '      return;',
    '    }',
    '    current = next;',
    '    remove?.();',
    '    while (start.nextSibling !== end) start.nextSibling.remove();',
    '    const [[content, blockUpdate], removeBlock] = $$owned(() => create(next));',
    '    end.before(content);',
    '    update = blockUpdate;',
    '    remove = removeBlock;',
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
  /** Creates an element with its properties and the attributes that are set with setAttribute. */
  element: [
    'function $$element(tag, properties, attributes) {',
    '  const element = Object.assign(document.createElement(tag), properties);',
    '  for (const name in attributes) element.setAttribute(name, attributes[name]);',
    '  return element;',
    '}',
  ],
  /** Creates an SVG element with its attributes. */
  svgElement: [
    'function $$svgElement(tag, attributes) {',
    '  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);',
    '  for (const name in attributes) element.setAttribute(name, attributes[name]);',
    '  return element;',
    '}',
  ],
  /** Sets an attribute whose value may be null: then the attribute is removed. */
  attribute: [
    'function $$attribute(element, name, value) {',
    '  if (value == null) element.removeAttribute(name);',
    '  else element.setAttribute(name, value);',
    '}',
  ],
  /**
   * Adds the CSS of a component to the page once: modules that inline the same component add it
   * with the same id. `$$styles` keeps the CSS of the module for the shadow roots of its web
   * components, which the page's styles do not reach.
   */
  style: [
    'const $$styles = [];',
    '',
    'function $$style(id, css) {',
    '  $$styles.push(css);',
    '  if (document.getElementById(id)) return;',
    '  const style = document.createElement("style");',
    '  style.id = id;',
    '  style.textContent = css;',
    '  document.head.append(style);',
    '}',
  ],
};
