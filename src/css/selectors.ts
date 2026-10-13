// Selectors: split into compound selectors, given the class of a component, with the classes of
// a CSS module renamed, or read for what elements they ask for. `:global(...)` keeps what is
// inside it as it is.

/** A selector list split at the commas outside brackets. */
export function splitList(selector: string): string[] {
  return splitTopLevel(selector, (c) => c === ',').map((part) => part.trim());
}

/**
 * A complex selector as compound selectors and the combinators between them:
 * `ul > li.item a` → ["ul", " > ", "li.item", " ", "a"]. A relative selector starts with a
 * combinator: `> a` → ["", "> ", "a"].
 */
export function splitComplex(selector: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;

    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (
      depth === 0 &&
      (c === ' ' || c === '>' || c === '+' || c === '~') &&
      !escaped(selector, i)
    ) {
      let combinator = '';

      while (i < selector.length && /[\s>+~]/.test(selector[i]!)) combinator += selector[i++];
      i--;
      parts.push(current, combinator.trim() === '' ? ' ' : ` ${combinator.trim()} `);
      current = '';
    } else {
      current += c;
    }
  }

  parts.push(current);

  return parts;
}

/**
 * Gives every compound selector the class of a component, before its pseudo-elements, so that the
 * rule applies only to its elements. Compounds with `&` refer to the rule around them, and those
 * in `:global(...)` are left to the page.
 */
export function scopeSelector(selector: string, scope: string): string {
  return splitList(selector)
    .map((complex) =>
      splitComplex(complex)
        .map((part, i) => (i % 2 === 1 || part === '' ? part : scopeCompound(part, scope)))
        .join('')
        .trim(),
    )
    .join(', ');
}

function scopeCompound(compound: string, scope: string): string {
  if (compound.includes(':global(')) return unwrapGlobal(compound);
  if (compound.includes('&')) return compound;

  const pseudo = pseudoElementStart(compound);

  return `${compound.slice(0, pseudo)}.${scope}${compound.slice(pseudo)}`;
}

/** Where the pseudo-element of a compound starts: `a::before` → 1, or its length if none. */
function pseudoElementStart(compound: string): number {
  let depth = 0;

  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];

    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && c === ':' && LEGACY_PSEUDO_ELEMENT.test(compound.slice(i))) return i;
  }

  return compound.length;
}

/** `::before`, and the pseudo-elements that may be written with one colon. */
const LEGACY_PSEUDO_ELEMENT = /^(?:::|:(?:before|after|first-line|first-letter)(?![\w-]))/;

/** `:global(.a) .b` → `.a .b`. */
export function unwrapGlobal(selector: string): string {
  let result = selector;

  while (true) {
    const start = result.indexOf(':global(');

    if (start === -1) return result;

    const close = matchingParen(result, start + ':global'.length);

    result =
      result.slice(0, start) +
      result.slice(start + ':global('.length, close) +
      result.slice(close + 1);
  }
}

/**
 * The classes of a CSS module get its names: `.button:hover` → `.button_k3f9:hover`. Classes in
 * `:global(...)` keep their names. Calls `found` for every local class.
 */
export function renameClasses(
  selector: string,
  rename: (name: string) => string,
  found: (name: string) => void,
): string {
  let result = '';
  let i = 0;

  while (i < selector.length) {
    if (selector.startsWith(':global(', i)) {
      const close = matchingParen(selector, i + ':global'.length);

      result += selector.slice(i + ':global('.length, close);
      i = close + 1;
    } else if (selector[i] === '[' || selector[i] === '"' || selector[i] === "'") {
      // Attribute selectors and strings are not classes: `[class~="a"]`.
      const end =
        selector[i] === '[' ? selector.indexOf(']', i) : selector.indexOf(selector[i]!, i + 1);
      const stop = end === -1 ? selector.length : end + 1;

      result += selector.slice(i, stop);
      i = stop;
    } else if (
      selector[i] === '.' &&
      !escaped(selector, i) &&
      /[\w-]/.test(selector[i + 1] ?? '')
    ) {
      const name = /^[\w-]+/.exec(selector.slice(i + 1))![0];

      found(name);
      result += `.${rename(name)}`;
      i += name.length + 1;
    } else {
      result += selector[i];
      i++;
    }
  }

  return result;
}

/** What a compound selector asks of an element, for checking that some element can match it. */
export interface CompoundRequirements {
  tag: string | null;
  classes: string[];
  ids: string[];
}

/** The tag, classes and ids a compound requires; those inside `:not(...)` and others are not. */
export function requirements(compound: string): CompoundRequirements {
  const outside = compound.replace(/\([^)]*\)/g, '()').replace(/\[[^\]]*\]/g, '[]');
  const tag = /^[a-zA-Z][\w-]*|^\*/.exec(outside)?.[0] ?? null;

  return {
    tag: tag === '*' ? null : tag,
    classes: [...outside.matchAll(/\.([\w-]+)/g)].map((match) => match[1]!),
    ids: [...outside.matchAll(/#([\w-]+)/g)].map((match) => match[1]!),
  };
}

function splitTopLevel(text: string, at: (c: string) => boolean): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const c of text) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && at(c)) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }

  parts.push(current);

  return parts;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return i;
  }

  return text.length;
}

function escaped(text: string, i: number): boolean {
  return i > 0 && text[i - 1] === '\\';
}
