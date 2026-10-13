import { describe, expect, it } from 'vitest';
import { ELEMENT_HELPER_LIMIT } from '../src/codegen/js.ts';
import { compile } from '../src/index.ts';
import { mountWithDom } from './fake-dom.ts';

// A module that creates more than ELEMENT_HELPER_LIMIT elements creates them with $$element, which
// takes the attributes they have from the start.

/** Markup that is never created, but makes the module create enough elements for the helper. */
const FILLER = `\nconst filler = () => <div>${'<i />'.repeat(ELEMENT_HELPER_LIMIT)}</div>`;

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

describe('the element helper', () => {
  it('is used only when the module creates more elements than the limit', () => {
    const source = 'document.body.append(<div id="app"><p>Hi</p></div>)';
    const few = js(source);
    const many = js(source + FILLER);

    expect(few).toContain('const $$div1 = document.createElement("div");\n$$div1.id = "app";');
    expect(few).not.toContain('$$element');
    expect(many).toContain('const $$div1 = $$element("div", { id: "app" });');
    expect(many).toContain('const $$p2 = $$element("p");');
    expect(many.match(/function \$\$element\(/g)).toHaveLength(1);
  });

  it('takes properties and attributes; the rest are statements after it', () => {
    const code = js(
      `const label = "Close"
const note ?string = null
const extra = { title: "x" }
document.body.append(<button
    type="button"
    aria-label={label}
    disabled
    data-id="7"
    aria-describedby={note}
    style="color: red"
    onClick={console.log(1)}
    {...extra}
    id="after"
>x</button>)` + FILLER,
    );

    expect(code).toContain(
      'const $$button1 = $$element("button", { type: "button", disabled: true }, { "aria-label": label, "data-id": "7" });',
    );
    expect(code).toContain('if (note != null) $$button1.setAttribute("aria-describedby", note);');
    expect(code).toContain('$$button1.style.cssText = "color: red";');
    expect(code).toContain('$$button1.addEventListener("click"');
    // A spread may override what comes before it, and what comes after it overrides the spread.
    expect(code).toContain('Object.assign($$button1, extra);\n$$button1.id = "after";');
  });

  it('creates SVG elements with their attributes', () => {
    const code = js(
      'document.body.append(<svg viewBox="0 0 8 8"><path d="M0 0" /></svg>)' + FILLER,
    );

    expect(code).toContain('const $$svg1 = $$svgElement("svg", { viewBox: "0 0 8 8" });');
    expect(code).toContain('const $$path2 = $$svgElement("path", { d: "M0 0" });');
    expect(code).toContain('document.createElementNS("http://www.w3.org/2000/svg", tag)');
  });

  it('creates the element of a ref with its constant attributes', () => {
    const code = js(
      `comp Search(hint string) {
    ref input
    input.focus()
    return <label>Find <input ref={input} type="search" class="field" placeholder={hint} /></label>
}
document.body.append(<Search hint="Fruit" />)` + FILLER,
    );

    expect(code).toContain(
      'const input = $$element("input", { type: "search", className: "field" });\n  input.focus();',
    );
    expect(code).toContain('input.placeholder = hint;');
  });

  it('builds the same DOM and updates it the same way', () => {
    const source = `comp Panel(title string, ...attrs) {
    state open = false
    state count = 0
    style {
        .panel { padding: 4px; }
    }
    return <section class="panel" aria-label={title} {...attrs}>
        <h2 class={open ? "open" : "closed"} title={title} data-count={count}>{title}</h2>
        <button disabled={open} onClick={open = !open; count++}>Toggle</button>
        <svg viewBox="0 0 8 8"><path d={open ? "M0 0" : "M8 8"} /></svg>
        <p>{count}</p>
    </section>
}
document.body.append(<div id="app"><Panel title="A" class="wide" hidden /></div>)`;
    const plain = mountWithDom(source);
    const helped = mountWithDom(source + FILLER);

    expect(js(source + FILLER)).toContain('$$element("section"');
    expect(String(helped.body)).toBe(String(plain.body));
    expect(String(plain.body)).toContain('wide');

    plain.body.find('button').click();
    helped.body.find('button').click();
    expect(String(helped.body)).toBe(String(plain.body));
    expect(String(plain.body)).toContain('data-count=1');
  });
});
