import { describe, expect, it } from 'vitest';
import { compile } from '../src/index.ts';
import { mountWithDom } from './fake-dom.ts';

// The inlining threshold: a component is inlined where it is used, unless its copies add more than
// 100 lines compared to a function and its calls (INLINE_LIMIT in codegen/js.ts).

/** A component with `rows` rows of markup that read both of its properties. */
const big = (rows: number) => `comp Big(label string, count number) {
    return <section>
${Array.from({ length: rows }, (_, i) => `        <p>{label} ${i} <b>{count}</b></p>`).join('\n')}
    </section>
}
`;

const app = (uses: string) => `comp App() {
    state count = 0
    return <div>
        <button onClick={count++}>+</button>
${uses}
    </div>
}

document.body.append(<App />)
`;

const uses = (count: number) =>
  Array.from({ length: count }, (_, i) => `        <Big label="${i}" count={count} />`).join('\n');

function js(source: string): string {
  const { code, diagnostics } = compile(source);

  expect(diagnostics).toEqual([]);

  return code;
}

describe('inlining threshold', () => {
  it('makes a function of a component whose copies add too many lines', () => {
    const code = js(big(20) + app(uses(3)));

    expect(code).toContain('function $$Big(label, count) {');
    expect(code.match(/= \$\$Big\(/g)).toHaveLength(3);
    expect(code).not.toContain('// <Big>');
  });

  it('inlines a component used once, however large', () => {
    const code = js(big(60) + app(uses(1)));

    expect(code).not.toContain('function $$Big');
    expect(code).toContain('// <Big>');
  });

  it('counts the lines of all the copies, however small each one is', () => {
    // A copy of this one takes about 30 lines, with the function that sets its properties: four
    // copies add less than 100 lines to a function and its calls, six add more.
    const four = js(big(2) + app(uses(4)));
    const six = js(big(2) + app(uses(6)));

    expect(four).not.toContain('function $$Big');
    expect(four.match(/\/\/ <Big>/g)).toHaveLength(4);
    expect(six).toContain('function $$Big(label, count) {');
  });

  it('keeps the behavior: the properties still update', () => {
    const { body } = mountWithDom(big(20) + app(uses(3)));

    body.find('button').click();
    expect(String(body.find('section', 2).find('p', 19))).toBe('<p>2 19 <b>1</b></p>');
  });
});
