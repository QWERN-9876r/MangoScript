import { describe, expect, it } from 'vitest';
import type * as ast from '../src/ast.ts';
import { check } from '../src/checker/checker.ts';
import { parse } from '../src/parser/parser.ts';

// Component state: `state count = 0`, markup that follows it, and `bind:`. Syntax and types here;
// code generation in state-codegen.test.ts, behavior in state-runtime.test.ts.

function errors(source: string): string[] {
  const { program, diagnostics } = parse(source);
  if (diagnostics.length > 0) return diagnostics.map((d) => d.message);
  return check(program).diagnostics.map((d) => d.message);
}

const counter = `comp Counter(initialValue number) {
    state count = initialValue
    return <button onClick={count++}>Нажато {count} раз</button>
}
`;

describe('syntax', () => {
  it('parses state declarations at the top level of a component', () => {
    const { program, diagnostics } = parse(`${counter}`);
    expect(diagnostics).toEqual([]);
    const component = program.body[0] as ast.ComponentDeclaration;
    const declaration = component.body.body[0] as ast.VariableDeclaration;
    expect(declaration.keyword).toBe('state');
    expect(declaration.names.map((name) => name.name)).toEqual(['count']);
  });

  it('keeps state an ordinary name elsewhere', () => {
    expect(errors(`let state = 1\nstate = 2\nstate += 1`)).toEqual([]);
    expect(
      errors(`comp A() {\n    let state = "x"\n    state = "y"\n    return <p>{state}</p>\n}`),
    ).toEqual([]);
  });

  it.each([
    ['state count = 0', 'state can only be declared inside a component'],
    [
      `comp A(ok bool) {\n    if ok {\n        state x = 1\n    }\n    return <p />\n}`,
      'state is declared at the top level of a component, not inside blocks or functions',
    ],
    [
      `comp A() {\n    func f() {\n        state x = 1\n    }\n    return <p />\n}`,
      'state is declared at the top level of a component, not inside blocks or functions',
    ],
    [`comp A() {\n    state x\n    return <p />\n}`, '"x" needs a type or a value'],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});

describe('type checking', () => {
  it('accepts state, its zero values and bindings', () => {
    expect(
      errors(`interface User {
    name string
    age number
}
comp Form(user User) {
    state count number
    state names []string
    state subscribed = false
    state choice = "a"
    return <form onSubmit={count++; names.push("x")}>
        <input bind:value={user.name} />
        <input type="number" bind:value={user.age} />
        <input type="range" bind:value={count} />
        <input type="checkbox" bind:checked={subscribed} />
        <textarea bind:value={choice} />
        <select bind:value={choice}><option>a</option></select>
        {count} {names}
    </form>
}`),
    ).toEqual([]);
  });

  it.each([
    [
      `comp A(n number) {\n    return <button onClick={n++}>{n}</button>\n}`,
      `cannot assign to "n": component properties are read-only; to change the parent's state, pass a function`,
    ],
    [
      `comp A() {\n    state n = 0\n    return <button onClick={n = "x"}>{n}</button>\n}`,
      'cannot use string as number',
    ],
    [
      `comp A() {\n    const name = ""\n    return <input bind:value={name} />\n}`,
      'cannot assign to "name": it is a constant',
    ],
    [
      `comp A(name string) {\n    return <input bind:value={name} />\n}`,
      `cannot assign to "name": component properties are read-only; to change the parent's state, pass a function`,
    ],
    [
      `comp A() {\n    state ok = false\n    return <input type="checkbox" bind:checked={ok} bind:value={ok} />\n}`,
      'bind:value needs a string or a number, not bool',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input type="checkbox" bind:checked={name} />\n}`,
      'bind:checked needs a bool, not string',
    ],
    [
      `comp A() {\n    state n = 0\n    return <select bind:value={n} />\n}`,
      'bind:value needs a string, not number',
    ],
    [
      `comp A() {\n    state n = 0\n    return <input bind:value={n} />\n}`,
      'a number can be bound to <input type="number"> or <input type="range">',
    ],
    [
      `comp A() {\n    state name = ""\n    return <p bind:value={name} />\n}`,
      'bind:value works with <input>, <textarea> and <select>',
    ],
    [
      `comp A() {\n    state ok = false\n    return <select bind:checked={ok} />\n}`,
      'bind:checked works with <input>',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input bind:text={name} />\n}`,
      'unknown binding "bind:text": use bind:value or bind:checked',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input bind:value="name" />\n}`,
      '"bind:value" needs a variable in braces, e.g. bind:value={title}',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input bind:value={name + "!"} />\n}`,
      '"bind:value" needs a variable or a field to write to',
    ],
    [
      `comp A() {\n    state name = ""\n    return <input value={name} bind:value={name} />\n}`,
      '"value" and "bind:value" set the same property: keep one of them',
    ],
  ])('rejects %j', (source, message) => {
    expect(errors(source)).toEqual([message]);
  });
});
