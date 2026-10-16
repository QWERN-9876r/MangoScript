// Names for completion in editors that the types cannot list: the members of strings, numbers and
// arrays in builtins.ts are found by name, and without a library there is no list of HTML tags.
// tests/completion.test.ts checks that each member listed here exists.

export const STRING_MEMBERS = [
  'length',
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'indexOf',
  'lastIndexOf',
  'includes',
  'startsWith',
  'endsWith',
  'slice',
  'substring',
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'normalize',
  'toString',
  'split',
  'replace',
  'replaceAll',
  'repeat',
  'padStart',
  'padEnd',
  'concat',
  'localeCompare',
  'match',
];

export const NUMBER_MEMBERS = ['toFixed', 'toPrecision', 'toString', 'toLocaleString'];

export const BOOL_MEMBERS = ['toString'];

export const BIGINT_MEMBERS = ['toString', 'toLocaleString', 'valueOf'];

export const ARRAY_MEMBERS = [
  'length',
  'push',
  'unshift',
  'pop',
  'shift',
  'at',
  'indexOf',
  'lastIndexOf',
  'includes',
  'join',
  'slice',
  'splice',
  'concat',
  'reverse',
  'fill',
  'sort',
  'map',
  'flatMap',
  'filter',
  'find',
  'findLast',
  'findIndex',
  'findLastIndex',
  'some',
  'every',
  'forEach',
  'reduce',
  'entries',
  'keys',
  'values',
  'toString',
];

/** HTML tags, for completion without TypeScript's `HTMLElementTagNameMap`. */
export const HTML_TAGS = [
  ...['a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'blockquote', 'br', 'button'],
  ...['canvas', 'caption', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details'],
  ...['dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer'],
  ...['form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'iframe', 'img'],
  ...['input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'menu', 'meter', 'nav'],
  ...['object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q'],
  ...['s', 'samp', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong'],
  ...['sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot'],
  ...['th', 'thead', 'time', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'],
];

/** Event attributes as programs write them: `on` and the event in camel case. */
export const EVENT_ATTRIBUTES = [
  ...['onClick', 'onDblClick', 'onContextMenu', 'onAuxClick'],
  ...['onInput', 'onChange', 'onSubmit', 'onReset', 'onInvalid', 'onSelect'],
  ...['onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onFocusIn', 'onFocusOut'],
  ...['onMouseDown', 'onMouseUp', 'onMouseMove', 'onMouseEnter', 'onMouseLeave', 'onMouseOver'],
  ...['onMouseOut', 'onWheel', 'onScroll', 'onScrollEnd'],
  ...['onPointerDown', 'onPointerUp', 'onPointerMove', 'onPointerEnter', 'onPointerLeave'],
  ...['onPointerCancel', 'onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel'],
  ...['onDragStart', 'onDrag', 'onDragEnd', 'onDragEnter', 'onDragOver', 'onDragLeave', 'onDrop'],
  ...['onCopy', 'onCut', 'onPaste', 'onLoad', 'onError', 'onToggle', 'onClose', 'onCancel'],
  ...['onAnimationStart', 'onAnimationEnd', 'onTransitionEnd'],
  ...['onPlay', 'onPause', 'onEnded', 'onTimeUpdate', 'onVolumeChange'],
];

/** DOM properties that attributes spell differently. */
export const ATTRIBUTE_NAMES: ReadonlyMap<string, string> = new Map([
  ['className', 'class'],
  ['htmlFor', 'for'],
]);
