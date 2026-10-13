import { describe, expect, it } from 'vitest';
import { check } from '../src/checker/checker.ts';
import { compile } from '../src/index.ts';
import { parse } from '../src/parser/parser.ts';
import { mountWithDom } from './fake-dom.ts';

// SVG in markup: `<svg>`, the elements inside it and tags that only SVG has are created in the SVG
// namespace, and their attributes are set with setAttribute.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);

  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);

  return check(program).diagnostics.map((d) => d.message);
}

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

const NS = '"http://www.w3.org/2000/svg"';

describe('types', () => {
  it('types SVG elements and lets them be appended', () => {
    expect(
      errors(
        'const icon SVGSVGElement = <svg viewBox="0 0 16 16"><path d="M0 0h16" /></svg>\ndocument.body.append(icon)',
      ),
    ).toEqual([]);
    expect(errors('const dot SVGElement = <circle r="2" />')).toEqual([]);
  });

  it('takes any text, number or bool for SVG attributes', () => {
    expect(errors('const s = <svg width={16} height="16" focusable={false} />')).toEqual([]);
  });
});

describe('generated code', () => {
  it('creates SVG elements in the SVG namespace and sets attributes', () => {
    const code = js(
      'const size = 16\ndocument.body.append(<svg class="icon" width={size}><path d="M2 2" /></svg>)',
    );

    expect(code).toContain(`const $$svg1 = document.createElementNS(${NS}, "svg");`);
    expect(code).toContain('$$svg1.setAttribute("class", "icon");');
    expect(code).toContain('$$svg1.setAttribute("width", size);');
    expect(code).toContain(`document.createElementNS(${NS}, "path");`);
  });

  it('knows tags that only SVG has, also in a component outside <svg>', () => {
    expect(
      js('comp Dot() {\n    return <circle r="2" />\n}\nconst s = <svg><Dot /></svg>'),
    ).toContain(`document.createElementNS(${NS}, "circle");`);
  });

  it('makes <a> SVG inside <svg> and HTML again inside <foreignObject>', () => {
    const code = js(
      'const s = <svg><a href="#x" /><foreignObject><a href="#y" /></foreignObject></svg>',
    );

    expect(code).toContain(`document.createElementNS(${NS}, "a");`);
    expect(code).toContain('setAttribute("href", "#x");');
    expect(code).toContain('const $$a3 = document.createElement("a");\n$$a3.href = "#y";');
  });

  it('creates the element of a ref in SVG', () => {
    const code = js(
      'comp A() {\n    ref line\n    return <svg><g><line ref={line} x2="4" /></g></svg>\n}\ndocument.body.append(<A />)',
    );

    expect(code).toContain(`const line = document.createElementNS(${NS}, "line");`);
    expect(code).toContain('line.setAttribute("x2", "4");');
  });
});

describe('running', () => {
  it('builds the SVG tree', () => {
    const { body } = mountWithDom(
      'document.body.append(<svg viewBox="0 0 8 8"><title>Dot</title><circle r="2" /></svg>)',
    );
    const svg = body.find('svg');

    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.find('circle').namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(String(body)).toBe(
      '<body><svg viewBox=0 0 8 8><title>Dot</title><circle r=2></circle></svg></body>',
    );
  });
});
