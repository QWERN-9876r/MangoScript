import { describe, expect, it } from 'vitest';
import { arrayMember, boolMember, numberMember, stringMember } from '../src/checker/builtins.ts';
import {
  ARRAY_MEMBERS,
  BOOL_MEMBERS,
  NUMBER_MEMBERS,
  STRING_MEMBERS,
} from '../src/checker/completion-names.ts';
import { NUMBER } from '../src/checker/types.ts';
import { completeModule, type CompletionList } from '../src/completion.ts';
import { complete } from '../src/index.ts';

// Completion for editors. `‸` marks the cursor. Without a library (as in the browser) only the
// built-in types are known; the last tests use TypeScript's lib files, as `complete` in Node does.

function completeAt(text: string): CompletionList {
  return completeModule(text.replace('‸', ''), text.indexOf('‸'));
}

function names(text: string): string[] {
  return completeAt(text).items.map((item) => item.name);
}

/** The items that are not keywords, as `name kind detail`. */
function described(text: string): string[] {
  return completeAt(text)
    .items.filter((item) => item.kind !== 'keyword')
    .map((item) => [item.name, item.kind, item.detail].filter(Boolean).join(' '));
}

describe('names in scope', () => {
  it('lists locals, parameters and declarations of the module with their types', () => {
    const items = described(`let xs = [1, 2]
func sum(count number) number {
    let total = 0
    return to‸
}`);

    expect(items.slice(0, 4)).toEqual([
      'count variable number',
      'total variable number',
      'xs variable []number',
      'sum function func(number) number',
    ]);
    expect(items).toContain('console variable console');
  });

  it('adds keywords, and does not list names declared after the cursor', () => {
    const items = names(`func main() {
    ‸
    let later = 1
}`);

    expect(items).toContain('return');
    expect(items).toContain('if');
    expect(items).not.toContain('later');
    expect(items).not.toContain('map');
  });

  it('gives the narrowed type of a variable', () => {
    expect(
      described(`func f(name ?string) {
    if name == null { return }
    console.log(na‸)
}`)[0],
    ).toBe('name variable string');
  });

  it('replaces the part of the name before the cursor', () => {
    const { start, end } = completeAt('let total = 1\nlet x = to‸tal');

    expect([start, end]).toEqual([22, 24]);
  });
});

describe('members', () => {
  it('lists the members of a class, private ones only inside it', () => {
    const source = `class User {
    name string
    private age number

    constructor() { this.name = ""; this.age = 0 }

    greet() string { return this.‸ }
}
let user = new User()
user.‸`;
    const [inside, outside] = source.split('this.‸');

    expect(described(`${inside}this.‸${outside!.replace('‸', '')}`)).toEqual([
      'name property string',
      'age property number',
      'greet method func() string',
    ]);
    expect(described(source.replace('this.‸', 'this.'))).toEqual([
      'name property string',
      'greet method func() string',
    ]);
  });

  it('lists inherited members and the static ones of a class', () => {
    const items = names(`class Base { id number }
class Item extends Base {
    title string
    static count = 0
}
func f(item Item) {
    console.log(item.‸)
    console.log(Item.count)
}`);

    expect(items).toEqual(['title', 'id']);
    expect(names('class Item { static count = 0 }\nconsole.log(Item.‸)')).toEqual(['count']);
  });

  it('lists the members of strings, arrays and objects', () => {
    expect(names('let s = "abc"\nconsole.log(s.‸)')).toEqual(STRING_MEMBERS);
    expect(described('let xs = [1]\nxs.‸').slice(0, 2)).toEqual([
      'length property number',
      'push method func(...number) number',
    ]);
    expect(names('let p = { x: 1, y: 2 }\nconsole.log(p.‸)')).toEqual(['x', 'y']);
  });

  it('lists the members that every type of a union has', () => {
    expect(
      names(`interface A { id number; a string }
interface B { id number; b string }
func f(value A | B) { console.log(value.‸) }`),
    ).toEqual(['id']);
  });

  it('works after "?." and while the line is not finished', () => {
    expect(names('func f(s ?string) { console.log(s?.len‸) }')).toContain('length');
    expect(names('let s = "abc"\nconsole.log(s.‸\nlet n = 1')).toContain('trim');
  });
});

describe('types, markup and the places with nothing to complete', () => {
  it('lists types where a type is written', () => {
    const items = completeAt('type Point { x number }\nlet p Po‸').items;

    expect(items.map((item) => item.name)).toEqual(expect.arrayContaining(['Point', 'number']));
    expect(items).toContainEqual({ name: 'func', kind: 'keyword' });
  });

  it('lists components and tags, also in an element that is not finished', () => {
    const app = (markup: string) =>
      `comp Card(title string, count number) {\n    return <p>{title}</p>\n}\ncomp App() {\n    return <div>${markup}</div>\n}`;

    expect(described(app('<Ca‸ />'))[0]).toBe('Card component comp(title string, count number)');
    expect(names(app('<sp‸'))).toContain('span');
    expect(names(app('\n<sp‸\n'))).toContain('span');
  });

  it('lists the properties of a component and the attributes of an element not given yet', () => {
    const card = 'comp Card(title string, count number) {\n    return <p>{title}</p>\n}\n';

    expect(described(`${card}let a = <Card count={1} t‸ />`)).toEqual([
      'ref attribute',
      'title property string',
    ]);

    const items = names('let a = <input type="text" v‸ />');

    expect(items).toEqual(expect.arrayContaining(['value', 'class', 'onInput', 'onKeyDown']));
    expect(items).not.toContain('type');
  });

  it('gives nothing in strings, comments, numbers and names being declared', () => {
    expect(names('let s = "ab‸c"')).toEqual([]);
    expect(names('let n = 1 // a com‸ment')).toEqual([]);
    expect(names('/* a\n com‸ment */')).toEqual([]);
    expect(names('let n = 12‸')).toEqual([]);
    expect(names('let na‸')).toEqual([]);
    expect(names('func f(na‸) {}')).toEqual([]);
  });

  // Code being typed: the brackets of the declaration around the cursor are not closed yet.
  it('lists types in a declaration that is not finished', () => {
    const rest = '\n\nconst fruits = [1, 2]\nconsole.log(fruits.length)';

    for (const text of [
      'comp Card(title str‸',
      'comp Card(title string, count nu‸',
      'func f(a string) st‸',
      'comp Card() {\n    state count nu‸',
      'interface User {\n    name st‸',
    ]) {
      expect(names(text + rest)).toEqual(expect.arrayContaining(['string', 'number']));
    }
  });

  it('lists the words that start a statement only where they can', () => {
    const component = names('comp Card() {\n    st‸\n    return <p />\n}');

    expect(component).toEqual(
      expect.arrayContaining(['state', 'derived', 'ref', 'style', 'effect', 'mount', 'select']),
    );
    expect(names('comp Card() {\n    st‸')).toContain('state');
    expect(names('dec logged() {\n    st‸\n}')).toContain('state');
    expect(names('se‸')).toEqual(expect.arrayContaining(['select', 'dec']));
    expect(names('func f() {\n    st‸\n}')).not.toContain('state');
    expect(
      names('comp Card() {\n    if true {\n        st‸\n    }\n    return <p />\n}'),
    ).not.toContain('state');
    expect(names('comp Card() {\n    let n = st‸\n    return <p />\n}')).not.toContain('state');
  });

  it('gives keywords where the code cannot be understood', () => {
    expect(names('if (((( ‸')).toContain('return');
  });
});

describe('with the library', () => {
  it('lists the globals, the members and the tags of the DOM', () => {
    const at = (text: string) =>
      complete(text.replace('‸', ''), text.indexOf('‸'), {
        filename: new URL('main.mango', import.meta.url).pathname,
      }).items.map((item) => item.name);

    expect(at('let x = doc‸')).toContain('document');
    expect(at('document.‸')).toEqual(expect.arrayContaining(['body', 'getElementById']));
    expect(at('let s = "a"\ns.‸')).toEqual(expect.arrayContaining(['trim', 'localeCompare', 'at']));
    expect(at('let a = <dia‸ />')).toContain('dialog');
    expect(at('let a = <button cl‸ />')).toEqual(expect.arrayContaining(['class', 'disabled']));
  });
});

describe('built-in member names', () => {
  it('exist in builtins.ts', () => {
    const missing = [
      ...STRING_MEMBERS.filter((name) => !stringMember(name)),
      ...NUMBER_MEMBERS.filter((name) => !numberMember(name)),
      ...BOOL_MEMBERS.filter((name) => !boolMember(name)),
      ...ARRAY_MEMBERS.filter((name) => !arrayMember(NUMBER, name)),
    ];

    expect(missing).toEqual([]);
  });
});
