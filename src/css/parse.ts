// CSS as a tree of rules, at-rules and declarations: enough to rewrite selectors and to put values
// from code into declarations. The text of selectors, at-rule preludes and values is kept as it is
// written, without comments. A value from code is SLOT in the text given to the parser.

/** Stands for a value from code in the text of a style block. */
export const SLOT = '';

export interface CssRule {
  kind: 'rule';
  selector: string;
  /** Offsets in the parsed text. */
  start: number;
  end: number;
  body: CssNode[];
}

export interface CssAtRule {
  kind: 'at-rule';
  /** `media` for `@media (min-width: 600px) { ... }`. */
  name: string;
  prelude: string;
  start: number;
  end: number;
  /** Null for a statement such as `@import url(a.css);`. */
  body: CssNode[] | null;
}

export interface CssDeclaration {
  kind: 'declaration';
  property: string;
  /** Text and the numbers of the values from code, in order: `0 {gap}px` → ["0 ", 0, "px"]. */
  value: (string | number)[];
  start: number;
  end: number;
}

export type CssNode = CssRule | CssAtRule | CssDeclaration;

export interface CssProblem {
  message: string;
  start: number;
  end: number;
}

export interface CssSheet {
  nodes: CssNode[];
  problems: CssProblem[];
}

/** Parses CSS; values from code are SLOT characters, numbered in order. */
export function parseCss(text: string): CssSheet {
  const problems: CssProblem[] = [];
  let pos = 0;
  let slots = 0;

  const skipSpace = (): void => {
    while (pos < text.length) {
      if (/\s/.test(text[pos]!)) {
        pos++;
      } else if (text.startsWith('/*', pos)) {
        const end = text.indexOf('*/', pos + 2);

        pos = end === -1 ? text.length : end + 2;
      } else {
        break;
      }
    }
  };

  /** Reads up to `{`, `;` or `}` outside strings and brackets; comments are left out. */
  const readItem = (): string => {
    let item = '';
    let depth = 0;

    while (pos < text.length) {
      const c = text[pos]!;

      if (text.startsWith('/*', pos)) {
        const end = text.indexOf('*/', pos + 2);

        pos = end === -1 ? text.length : end + 2;
        item += ' ';
        continue;
      }

      if (c === '"' || c === "'") {
        const start = pos;

        pos++;
        while (pos < text.length && text[pos] !== c && text[pos] !== '\n') {
          pos += text[pos] === '\\' ? 2 : 1;
        }

        pos++;
        item += text.slice(start, pos);
        continue;
      }

      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (depth <= 0 && (c === '{' || c === ';' || c === '}')) break;
      item += c;
      pos++;
    }

    return item;
  };

  const block = (inRule: boolean): CssNode[] => {
    const nodes: CssNode[] = [];

    while (true) {
      skipSpace();
      if (pos >= text.length || text[pos] === '}') return nodes;

      const start = pos;
      const item = readItem().trim();
      const end = pos;
      const next = text[pos];

      if (next === '{') {
        pos++;

        const body = block(true);

        if (text[pos] === '}') pos++;
        nodes.push(
          item.startsWith('@')
            ? { kind: 'at-rule', ...atRule(item), start, end, body }
            : { kind: 'rule', selector: item, start, end, body },
        );
        continue;
      }

      if (next === ';') pos++;
      if (item === '') continue;

      if (item.startsWith('@')) {
        nodes.push({ kind: 'at-rule', ...atRule(item), start, end, body: null });
        continue;
      }

      const colon = item.indexOf(':');

      if (colon <= 0) {
        problems.push({
          message: `expected a declaration such as "color: red", found "${item}"`,
          start,
          end,
        });
      } else if (!inRule) {
        problems.push({
          message: `a declaration needs a rule around it, e.g. .card { ${item} }`,
          start,
          end,
        });
      }

      if (colon > 0) {
        nodes.push({
          kind: 'declaration',
          property: item.slice(0, colon).trim(),
          value: valueParts(item.slice(colon + 1).trim()),
          start,
          end,
        });
      }
    }
  };

  const valueParts = (value: string): (string | number)[] => {
    const parts: (string | number)[] = [];

    value.split(SLOT).forEach((piece, i) => {
      if (i > 0) parts.push(slots++);
      if (piece !== '') parts.push(piece);
    });

    return parts;
  };

  const nodes = block(false);

  while (pos < text.length) {
    // A `}` without its `{`: report it and go on after it.
    problems.push({ message: 'unexpected "}" in CSS', start: pos, end: pos + 1 });
    pos++;
    nodes.push(...block(false));
  }

  return { nodes, problems };
}

function atRule(item: string): { name: string; prelude: string } {
  const name = /^@([\w-]*)/.exec(item)![1]!;

  return { name, prelude: item.slice(name.length + 1).trim() };
}

/** At-rules whose blocks hold rules with selectors of the page, such as `@media`. */
export function holdsRules(rule: CssAtRule): boolean {
  return ['media', 'supports', 'container', 'layer', 'scope', 'document'].includes(rule.name);
}
