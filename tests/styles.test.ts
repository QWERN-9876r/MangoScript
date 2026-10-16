import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { parseCss } from '../src/css/parse.ts';
import { scopeSelector } from '../src/css/selectors.ts';
import { formatDiagnostic } from '../src/diagnostics.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { SourceFile } from '../src/source.ts';

// `style { ... }` in components and decorators: CSS for their own markup, whose elements get the
// class of the style, with values from code in `{...}` that become CSS variables.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

function warnings(source: string): string[] {
  return compile(source).warnings.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

/** A component with `style { css }` and `markup`, used once. */
const card = (css: string, markup = '<section class="card"><p>text</p></section>', body = '') =>
  `comp Card(accent string = "red") {\n${body}    style {\n${css}\n    }\n    return ${markup}\n}\ndocument.body.append(<Card />)\n`;

describe('syntax', () => {
  it('keeps style an ordinary name elsewhere', () => {
    expect(
      errors('const style = { color: "red" }\nfunc f(style string) string {\n    return style\n}'),
    ).toEqual([]);
    expect(
      errors('comp A() {\n    let style = 1\n    style = 2\n    return <p>{style}</p>\n}'),
    ).toEqual([]);
  });

  it.each([
    ['style {\n    p { color: red }\n}', 'style can only be declared inside a component'],
    [
      'comp A() {\n    if true {\n        style {\n            p { color: red }\n        }\n    }\n    return <p />\n}',
      'style is declared at the top level of a component, not inside blocks or functions',
    ],
    [
      'comp A() {\n    style {\n        p { color: red }',
      'unterminated style block: close it with "}"',
    ],
    [
      card('        color: red;'),
      'a declaration needs a rule around it, e.g. .card { color: red }',
    ],
    [card('        .card { red }'), 'expected a declaration such as "color: red", found "red"'],
  ])('reports %j', (source, message) => {
    expect(errors(source)).toContain(message);
  });

  it('reads {...} as a value only in a declaration', () => {
    const code = js(
      card(
        '        .card { color: {accent}; content: "{"; }\n        .card:hover { color: blue }\n        a:not(.x) { margin: 0 {2}px }',
        '<section class="card"><a>x</a></section>',
      ),
    );

    expect(code).toContain('content: "{";');
    expect(code).toContain('.card.rook-card-');
    expect(code).toContain('a:not(.x).rook-card-');
    expect(code).toMatch(/margin: var\(--rook-card-\w+-1\);/);
  });
});

describe('types and warnings', () => {
  it('takes strings and numbers as values, and sees the whole body', () => {
    expect(
      errors(card('        .card { width: {width}px; color: {accent} }', undefined, '')),
    ).toEqual(['"width" is not defined']);
    expect(
      errors(
        card('        .card { width: {width}px; color: {accent} }').replace(
          '    return',
          '    state width = 3\n    return',
        ),
      ),
    ).toEqual([]);
    expect(errors(card('        .card { color: {true} }'))).toEqual([
      'a value in CSS is a string or a number, not bool',
    ]);
  });

  it('warns about selectors that match no element of the markup', () => {
    expect(
      warnings(card('        .card p { margin: 0 }\n        .missing, h1 { color: red }')),
    ).toEqual([
      'selector ".missing" matches no element of Card',
      'selector "h1" matches no element of Card',
    ]);
    // Any class may come from class={...}, and :global(...) is the page's.
    expect(
      warnings(
        card(
          '        .any { margin: 0 }\n        :global(body) .card { margin: 0 }',
          '<p class={accent}>x</p>',
        ),
      ),
    ).toEqual([]);
  });

  it('formats warnings as warnings', () => {
    const source = card('        h1 { color: red }');
    const [warning] = compile(source).warnings;

    expect(formatDiagnostic(new SourceFile('a.rk', source), warning!, 'warning')).toMatch(
      /^a\.rk:3:9: warning: selector "h1" matches no element of Card/,
    );
  });

  it('needs an element at the top of the markup for values from code', () => {
    expect(errors(card('        p { color: {accent} }', '<><p>x</p></>'))).toEqual([
      'values from code in the style of Card are set on the element it returns, so it cannot return DocumentFragment',
    ]);
  });

  it('checks the style of a decorator against its own markup', () => {
    expect(
      warnings(`dec framed() {
    style {
        .frame { padding: 4px }
        .card { margin: 0 }
    }
    return (content Element) => <div class="frame">{content}</div>
}
@framed
comp Card() {
    return <p class="card" />
}
document.body.append(<Card />)`),
    ).toEqual(['selector ".card" matches no element of @framed']);
  });
});

describe('CSS', () => {
  it.each([
    ['.card', '.card.s'],
    ['.a .b, .c > .d', '.a.s .b.s, .c.s > .d.s'],
    ['li:hover::before', 'li:hover.s::before'],
    ['p:first-line', 'p.s:first-line'],
    ['a:not(.x)', 'a:not(.x).s'],
    [':global(body) .card', 'body .card.s'],
    ['&:hover', '&:hover'],
    ['> .item', '> .item.s'],
    ['input[type="text"] + label', 'input[type="text"].s + label.s'],
  ])('scopes %j', (selector, scoped) => {
    expect(scopeSelector(selector, 's')).toBe(scoped);
  });

  it('parses rules, at-rules and declarations with values from code', () => {
    const { nodes, problems } = parseCss(
      '@import url(a.css);\n.a { color: ; .b { margin: 0 px } }\n@media (x) { .c { top: 0 } }',
    );

    expect(problems).toEqual([]);
    expect(nodes.map((node) => node.kind)).toEqual(['at-rule', 'rule', 'at-rule']);
    expect(nodes[1]).toMatchObject({
      selector: '.a',
      body: [
        { kind: 'declaration', property: 'color', value: [0] },
        { kind: 'rule', selector: '.b', body: [{ value: ['0 ', 1, 'px'] }] },
      ],
    });
  });
});

describe('generated code', () => {
  it('adds the CSS once at the start of the module and the class to every element', () => {
    const code = js(card('        .card { padding: 8px }\n        p { margin: 0 }'));
    const [, scope] = /\$\$style\("(rook-card-\w+)"/.exec(code)!;

    expect(code).toContain(
      `$$style("${scope}", \`.card.${scope} {\n  padding: 8px;\n}\np.${scope} {`,
    );
    expect(code).toContain(`$$card1.className = "card ${scope}";`);
    expect(code).toContain(`$$p2.className = "${scope}";`);
  });

  it('keeps the class of the style in a class that changes', () => {
    const code = js(
      card(
        '        .on { color: red }',
        '<section class={on ? "on" : ""} onClick={on = !on} />',
        '    state on = false\n',
      ),
    );

    expect(code).toMatch(/className = `\$\{on \? "on" : ""\} rook-card-\w+`;/);
  });

  it('sets the class of SVG elements and of the element of a ref', () => {
    const code = js(
      card(
        '        svg { width: 16px }\n        .box { padding: 0 }',
        '<div class="box" ref={box}><svg /></div>',
        '    ref box\n',
      ),
    );

    expect(code).toMatch(
      /const box = document\.createElement\("div"\);\n {2}box\.className = "box rook-card-\w+";/,
    );
    expect(code).toMatch(/\$\$svg\d+\.setAttribute\("class", "rook-card-\w+"\);/);
  });

  it('sets values from code as CSS variables and updates them', () => {
    const code = js(
      card(
        '        .card { width: {width}px; color: {accent} }',
        '<section class="card" onClick={width++} />',
        '    state width = 1\n',
      ),
    );

    expect(code).toMatch(/\$\$card1\.style\.setProperty\("--rook-card-\w+-0", `\$\{width\}px`\);/);
    expect(code).toMatch(/\$\$card1\.style\.setProperty\("--rook-card-\w+-1", accent\);/);
    // Only the value that reads the state is updated.
    expect(code.match(/setProperty\("--rook-card-\w+-1"/g)).toHaveLength(1);
    expect(code.match(/setProperty\("--rook-card-\w+-0"/g)).toHaveLength(2);
  });

  it('has no styles when no component has them', () => {
    expect(js('comp A() {\n    return <p />\n}\ndocument.body.append(<A />)')).not.toContain(
      '$$style',
    );
  });
});
