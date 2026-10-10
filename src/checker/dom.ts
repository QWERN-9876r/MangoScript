import {
  ANY,
  BOOL,
  func,
  method,
  NUMBER,
  nullable,
  property,
  STRING,
  type Member,
  type ObjectType,
  type Type,
} from './types.ts';

// Types of the DOM for markup: what `<input>` creates and which attributes are properties. Only
// the commonly used members are typed; the rest of the DOM is reached through `any`.

const p = property;
const m = (...args: Parameters<typeof func>) => method(func(...args));

function object(name: string, members: Record<string, Member>): ObjectType {
  return { kind: 'object', name, members: new Map(Object.entries(members)), call: null };
}

const NODE_MEMBERS: Record<string, Member> = {
  nodeType: p(NUMBER),
  nodeName: p(STRING),
  textContent: p(nullable(STRING)),
  parentNode: p(ANY),
  parentElement: p(ANY),
  childNodes: p(ANY),
  firstChild: p(ANY),
  lastChild: p(ANY),
  nextSibling: p(ANY),
  previousSibling: p(ANY),
  isConnected: p(BOOL),
  appendChild: m([ANY], [ANY]),
  removeChild: m([ANY], [ANY]),
  insertBefore: m([ANY, ANY], [ANY]),
  replaceChild: m([ANY, ANY], [ANY]),
  cloneNode: m([BOOL], [ANY], { required: 0 }),
  contains: m([ANY], [BOOL]),
  hasChildNodes: m([], [BOOL]),
  addEventListener: m([STRING, ANY, ANY], [], { required: 2 }),
  removeEventListener: m([STRING, ANY, ANY], [], { required: 2 }),
  dispatchEvent: m([ANY], [BOOL]),
};

/** Members of nodes that have children: elements and fragments. */
const PARENT_MEMBERS: Record<string, Member> = {
  append: m([], [], { rest: ANY }),
  prepend: m([], [], { rest: ANY }),
  replaceChildren: m([], [], { rest: ANY }),
  querySelector: m([STRING], [ANY]),
  querySelectorAll: m([STRING], [ANY]),
  children: p(ANY),
  firstElementChild: p(ANY),
  lastElementChild: p(ANY),
  childElementCount: p(NUMBER),
};

const ELEMENT_MEMBERS: Record<string, Member> = {
  ...NODE_MEMBERS,
  ...PARENT_MEMBERS,
  // Unlike other nodes, an element always has text content.
  textContent: p(STRING),
  before: m([], [], { rest: ANY }),
  after: m([], [], { rest: ANY }),
  replaceWith: m([], [], { rest: ANY }),
  remove: m([], []),
  id: p(STRING),
  className: p(STRING),
  classList: p(ANY),
  style: p(ANY),
  dataset: p(ANY),
  hidden: p(BOOL),
  title: p(STRING),
  lang: p(STRING),
  dir: p(STRING),
  tabIndex: p(NUMBER),
  draggable: p(BOOL),
  contentEditable: p(STRING),
  innerHTML: p(STRING),
  outerHTML: p(STRING),
  innerText: p(STRING),
  tagName: p(STRING),
  offsetWidth: p(NUMBER),
  offsetHeight: p(NUMBER),
  offsetTop: p(NUMBER),
  offsetLeft: p(NUMBER),
  clientWidth: p(NUMBER),
  clientHeight: p(NUMBER),
  scrollWidth: p(NUMBER),
  scrollHeight: p(NUMBER),
  scrollTop: p(NUMBER),
  scrollLeft: p(NUMBER),
  focus: m([ANY], [], { required: 0 }),
  blur: m([], []),
  click: m([], []),
  closest: m([STRING], [ANY]),
  matches: m([STRING], [BOOL]),
  getAttribute: m([STRING], [nullable(STRING)]),
  setAttribute: m([STRING, ANY], []),
  removeAttribute: m([STRING], []),
  hasAttribute: m([STRING], [BOOL]),
  toggleAttribute: m([STRING, BOOL], [BOOL], { required: 1 }),
  getBoundingClientRect: m([], [ANY]),
  scrollIntoView: m([ANY], [], { required: 0 }),
  animate: m([ANY, ANY], [ANY], { required: 1 }),
};

const MEDIA_MEMBERS: Record<string, Member> = {
  src: p(STRING),
  controls: p(BOOL),
  autoplay: p(BOOL),
  loop: p(BOOL),
  muted: p(BOOL),
  currentTime: p(NUMBER),
  volume: p(NUMBER),
  duration: p(NUMBER),
  paused: p(BOOL),
  play: m([], [ANY]),
  pause: m([], []),
};

export const NODE = object('Node', NODE_MEMBERS);
export const HTML_ELEMENT = object('HTMLElement', ELEMENT_MEMBERS);
export const DOCUMENT_FRAGMENT = object('DocumentFragment', {
  ...NODE_MEMBERS,
  ...PARENT_MEMBERS,
});

/** Tags whose elements have members of their own, with the name of their type. */
const SPECIFIC_ELEMENTS: Record<string, [string, Record<string, Member>]> = {
  a: [
    'HTMLAnchorElement',
    { href: p(STRING), target: p(STRING), rel: p(STRING), download: p(STRING) },
  ],
  button: [
    'HTMLButtonElement',
    { disabled: p(BOOL), type: p(STRING), name: p(STRING), value: p(STRING), form: p(ANY) },
  ],
  input: [
    'HTMLInputElement',
    {
      value: p(STRING),
      valueAsNumber: p(NUMBER),
      checked: p(BOOL),
      disabled: p(BOOL),
      type: p(STRING),
      name: p(STRING),
      placeholder: p(STRING),
      required: p(BOOL),
      readOnly: p(BOOL),
      autofocus: p(BOOL),
      autocomplete: p(STRING),
      min: p(STRING),
      max: p(STRING),
      step: p(STRING),
      maxLength: p(NUMBER),
      minLength: p(NUMBER),
      pattern: p(STRING),
      multiple: p(BOOL),
      accept: p(STRING),
      files: p(ANY),
      form: p(ANY),
      select: m([], []),
      setCustomValidity: m([STRING], []),
      checkValidity: m([], [BOOL]),
    },
  ],
  textarea: [
    'HTMLTextAreaElement',
    {
      value: p(STRING),
      placeholder: p(STRING),
      disabled: p(BOOL),
      readOnly: p(BOOL),
      required: p(BOOL),
      rows: p(NUMBER),
      cols: p(NUMBER),
      maxLength: p(NUMBER),
      name: p(STRING),
      select: m([], []),
    },
  ],
  select: [
    'HTMLSelectElement',
    {
      value: p(STRING),
      disabled: p(BOOL),
      multiple: p(BOOL),
      required: p(BOOL),
      name: p(STRING),
      selectedIndex: p(NUMBER),
      options: p(ANY),
    },
  ],
  option: [
    'HTMLOptionElement',
    {
      value: p(STRING),
      selected: p(BOOL),
      disabled: p(BOOL),
      label: p(STRING),
      text: p(STRING),
    },
  ],
  form: [
    'HTMLFormElement',
    {
      action: p(STRING),
      method: p(STRING),
      noValidate: p(BOOL),
      elements: p(ANY),
      reset: m([], []),
      submit: m([], []),
      requestSubmit: m([ANY], [], { required: 0 }),
      checkValidity: m([], [BOOL]),
    },
  ],
  label: ['HTMLLabelElement', { htmlFor: p(STRING) }],
  img: [
    'HTMLImageElement',
    {
      src: p(STRING),
      alt: p(STRING),
      srcset: p(STRING),
      loading: p(STRING),
      width: p(NUMBER),
      height: p(NUMBER),
      naturalWidth: p(NUMBER),
      naturalHeight: p(NUMBER),
      complete: p(BOOL),
    },
  ],
  li: ['HTMLLIElement', { value: p(NUMBER) }],
  ol: ['HTMLOListElement', { start: p(NUMBER), reversed: p(BOOL) }],
  canvas: [
    'HTMLCanvasElement',
    {
      width: p(NUMBER),
      height: p(NUMBER),
      getContext: m([STRING, ANY], [ANY], { required: 1 }),
      toDataURL: m([STRING], [STRING], { required: 0 }),
    },
  ],
  video: ['HTMLVideoElement', { ...MEDIA_MEMBERS, width: p(NUMBER), height: p(NUMBER) }],
  audio: ['HTMLAudioElement', MEDIA_MEMBERS],
  iframe: ['HTMLIFrameElement', { src: p(STRING), allow: p(STRING) }],
  progress: ['HTMLProgressElement', { value: p(NUMBER), max: p(NUMBER) }],
  dialog: [
    'HTMLDialogElement',
    {
      open: p(BOOL),
      show: m([], []),
      showModal: m([], []),
      close: m([STRING], [], { required: 0 }),
    },
  ],
  details: ['HTMLDetailsElement', { open: p(BOOL) }],
  td: ['HTMLTableCellElement', { colSpan: p(NUMBER), rowSpan: p(NUMBER) }],
  th: ['HTMLTableCellElement', { colSpan: p(NUMBER), rowSpan: p(NUMBER) }],
};

const elementTypes = new Map<string, ObjectType>();

for (const [tag, [name, members]] of Object.entries(SPECIFIC_ELEMENTS)) {
  const existing = [...elementTypes.values()].find((type) => type.name === name);

  elementTypes.set(tag, existing ?? object(name, { ...ELEMENT_MEMBERS, ...members }));
}

/** The type of the element `<tag>` creates. */
export function elementType(tag: string): ObjectType {
  return elementTypes.get(tag) ?? HTML_ELEMENT;
}

/**
 * The type of a component's `children`: the markup between its tags. At runtime it is a
 * DocumentFragment, but only placing it as `{children}` is allowed.
 */
export const CONTENT = object('Content', {});

/** DOM types that programs can name, e.g. `func render() HTMLLIElement`. */
export const DOM_TYPES: ReadonlyMap<string, Type> = new Map<string, Type>([
  ['Node', NODE],
  ['Content', CONTENT],
  ['HTMLElement', HTML_ELEMENT],
  ['Element', HTML_ELEMENT],
  ['DocumentFragment', DOCUMENT_FRAGMENT],
  ...[...elementTypes.values()].map((type): [string, Type] => [type.name ?? '', type]),
]);

/** HTML attribute names whose DOM property is spelled differently. */
const PROPERTY_NAMES: Readonly<Record<string, string>> = {
  class: 'className',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  readonly: 'readOnly',
  maxlength: 'maxLength',
  minlength: 'minLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  contenteditable: 'contentEditable',
  novalidate: 'noValidate',
};

/** Properties that cannot be assigned: attributes with these names go through setAttribute. */
const READ_ONLY = new Set([
  ...Object.keys(NODE_MEMBERS),
  ...Object.keys(PARENT_MEMBERS),
  'classList',
  'dataset',
  'tagName',
  'offsetWidth',
  'offsetHeight',
  'offsetTop',
  'offsetLeft',
  'clientWidth',
  'clientHeight',
  'scrollWidth',
  'scrollHeight',
  'form',
  'elements',
  'options',
  'naturalWidth',
  'naturalHeight',
  'complete',
  'duration',
  'paused',
]);

READ_ONLY.delete('textContent');

/** The DOM property that an attribute sets, e.g. `class` → `className`; `null` for setAttribute. */
export function domProperty(tag: string, attribute: string): { name: string; type: Type } | null {
  const name = Object.hasOwn(PROPERTY_NAMES, attribute) ? PROPERTY_NAMES[attribute]! : attribute;

  if (READ_ONLY.has(name)) return null;

  const member = elementType(tag).members.get(name);

  return member && !member.method ? { name, type: member.type } : null;
}

const EVENT_MEMBERS: Record<string, Member> = {
  type: p(STRING),
  target: p(ANY),
  currentTarget: p(ANY),
  preventDefault: m([], []),
  stopPropagation: m([], []),
  stopImmediatePropagation: m([], []),
  defaultPrevented: p(BOOL),
  bubbles: p(BOOL),
  timeStamp: p(NUMBER),
  // Keyboard events
  key: p(STRING),
  code: p(STRING),
  repeat: p(BOOL),
  altKey: p(BOOL),
  ctrlKey: p(BOOL),
  shiftKey: p(BOOL),
  metaKey: p(BOOL),
  // Mouse, pointer and wheel events
  clientX: p(NUMBER),
  clientY: p(NUMBER),
  pageX: p(NUMBER),
  pageY: p(NUMBER),
  offsetX: p(NUMBER),
  offsetY: p(NUMBER),
  movementX: p(NUMBER),
  movementY: p(NUMBER),
  button: p(NUMBER),
  buttons: p(NUMBER),
  deltaX: p(NUMBER),
  deltaY: p(NUMBER),
  pointerId: p(NUMBER),
  relatedTarget: p(ANY),
  // Input events
  data: p(nullable(STRING)),
  inputType: p(STRING),
  isComposing: p(BOOL),
  // Other events
  dataTransfer: p(ANY),
  touches: p(ANY),
  changedTouches: p(ANY),
  detail: p(ANY),
  submitter: p(ANY),
};

export const EVENT = object('Event', EVENT_MEMBERS);

/** The `event` of a handler on an element: `currentTarget` is that element. */
export function eventType(element: Type): ObjectType {
  return object('Event', { ...EVENT_MEMBERS, currentTarget: p(element) });
}
