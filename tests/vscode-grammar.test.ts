import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';
import { beforeAll, describe, expect, it } from 'vitest';

// The VS Code extension in editors/vscode: its grammar is run by the same engine that VS Code uses.

const root = new URL('..', import.meta.url).pathname;
// The grammar of markup is a separate file that the main one includes, as in VS Code.
const grammarPaths: Record<string, string> = {
  'source.mango': join(root, 'editors/vscode/syntaxes/mangoscript.tmLanguage.json'),
  'source.mango.markup': join(root, 'editors/vscode/syntaxes/mangoscript-markup.tmLanguage.json'),
};

let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(
    createRequire(import.meta.url).resolve('vscode-oniguruma/release/onig.wasm'),
  );
  await oniguruma.loadWASM(wasm.buffer);
  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (text) => new oniguruma.OnigString(text),
    }),
    loadGrammar: (scopeName) => {
      const path = grammarPaths[scopeName];
      return Promise.resolve(
        path ? textmate.parseRawGrammar(readFileSync(path, 'utf8'), path) : null,
      );
    },
  });
  const loaded = await registry.loadGrammar('source.mango');
  if (!loaded) throw new Error('the grammar did not load');
  grammar = loaded;
});

interface Token {
  text: string;
  scopes: string[];
}

/** Tokens of each line, and the rule stack after the last line. */
function tokenize(source: string): { tokens: Token[]; stack: textmate.StateStack } {
  const tokens: Token[] = [];
  let stack = textmate.INITIAL;
  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, stack);
    for (const token of result.tokens) {
      tokens.push({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes });
    }
    stack = result.ruleStack;
  }
  return { tokens, stack };
}

/** The innermost scope of each token with this text, in order. */
function scopesOf(source: string, text: string): string[] {
  return tokenize(source)
    .tokens.filter((token) => token.text === text)
    .map((token) => token.scopes.at(-1)!.replace(/\.mango$/, ''));
}

function scopeOf(source: string, text: string): string {
  const [scope] = scopesOf(source, text);
  if (scope === undefined) throw new Error(`no token "${text}" in ${source}`);
  return scope;
}

describe('VS Code grammar', () => {
  it('colours declarations, keywords and types', () => {
    const source = 'func divide(a, b number) (number, error) {\n    return 0, error("x")\n}';
    expect(scopeOf(source, 'func')).toBe('storage.type.function');
    expect(scopeOf(source, 'divide')).toBe('entity.name.function');
    expect(scopesOf(source, 'number')).toEqual([
      'support.type.primitive',
      'support.type.primitive',
    ]);
    expect(scopesOf(source, 'error')).toEqual(['support.type.primitive', 'support.function']);
    expect(scopeOf(source, 'return')).toBe('keyword.control.flow');
    expect(scopeOf(source, '0')).toBe('constant.numeric.decimal');
  });

  it('colours components, classes and type declarations', () => {
    expect(scopeOf('comp Counter(initialValue number) {', 'Counter')).toBe(
      'entity.name.type.component',
    );
    const header = 'class Admin extends User implements Shape {';
    expect(scopesOf(header, 'class')).toEqual(['storage.type.class']);
    expect(scopeOf(header, 'Admin')).toBe('entity.name.type.class');
    expect(scopeOf(header, 'User')).toBe('entity.other.inherited-class');
    expect(scopeOf(header, 'implements')).toBe('storage.modifier');
    expect(scopeOf('interface Todo {', 'Todo')).toBe('entity.name.type');
    expect(scopeOf('let items []Todo', 'Todo')).toBe('entity.name.type');
    expect(scopeOf('let user ?User = null', '?')).toBe('keyword.operator.type.nullable');
    expect(scopeOf('const x = ok ? a : b', '?')).toBe('keyword.operator.ternary');
    expect(scopeOf('const MAX_TITLE = 80', 'MAX_TITLE')).toBe('variable.other.constant');
  });

  it('colours generic declarations and grouped types', () => {
    const header = 'class Stack[T] extends Base implements Source[T] {';
    expect(scopeOf(header, 'Stack')).toBe('entity.name.type.class');
    expect(scopesOf(header, 'T')).toEqual(['entity.name.type', 'entity.name.type']);
    expect(scopeOf(header, 'Base')).toBe('entity.other.inherited-class');
    expect(scopeOf(header, 'implements')).toBe('storage.modifier');
    const func = 'func first[T any](xs []T) ?T {';
    expect(scopeOf(func, 'first')).toBe('entity.name.function');
    expect(scopeOf(func, 'any')).toBe('support.type.primitive');
    expect(scopeOf('let x ?(A | B) = null', '?')).toBe('keyword.operator.type.nullable');
    expect(scopeOf('let xs [](A | B)', '[]')).toBe('punctuation.definition.type.array');
  });

  it('tells object keys from the ternary operator', () => {
    const source = 'const f = { id: "all", label: ok ? a : b }';
    expect(scopesOf(source, 'id')).toEqual(['meta.object-literal.key']);
    expect(scopesOf(source, ':')).toEqual([
      'punctuation.separator.key-value',
      'punctuation.separator.key-value',
      'keyword.operator.ternary',
    ]);
    expect(scopeOf('switch x {\ncase 1:\ndefault:\n}', 'default')).toBe(
      'keyword.control.conditional',
    );
  });

  it('colours @html-tag', () => {
    const source = '@html-tag("app-card") comp Card() {';
    expect(scopeOf(source, '@')).toBe('punctuation.decorator');
    expect(scopeOf(source, 'html-tag')).toBe('entity.name.function.decorator');
    expect(scopeOf(source, '"')).toBe('punctuation.definition.string.begin');
  });

  it('treats mount() as a keyword only at the start of a statement', () => {
    expect(scopeOf('    mount() {', 'mount')).toBe('storage.type.mount');
    expect(scopeOf('    widget.mount(element)', 'mount')).not.toBe('storage.type.mount');
  });

  it('treats state as a keyword only at the start of a declaration', () => {
    expect(scopeOf('    state count = 0', 'state')).toBe('storage.type.state');
    expect(scopeOf('let state = load()', 'state')).toBe('variable.other.readwrite');
    expect(scopeOf('state = 2', 'state')).toBe('variable.other.readwrite');
  });

  it('does not colour keywords used as property names', () => {
    expect(scopeOf('console.log(event.type)', 'type')).toBe('variable.other.property');
    expect(scopeOf('const xs = [...this.items]', 'this')).toBe('variable.language.this');
    expect(scopeOf('todos.push(todo)', 'push')).toBe('entity.name.function');
  });

  it('colours strings and template literals with expressions', () => {
    const source = 'const s = `Осталось: ${left} · ${f({ a: 1 })}`';
    expect(scopeOf(source, 'left')).toBe('variable.other.readwrite');
    expect(scopeOf(source, 'Осталось: ')).toBe('string.template');
    expect(scopeOf(source, 'f')).toBe('entity.name.function');
    expect(scopeOf('const s = "a\\nb"', '\\n')).toBe('constant.character.escape');
    expect(scopeOf('// комментарий', ' комментарий')).toBe('comment.line.double-slash');
  });

  it('colours markup: tags, components, attributes and expressions', () => {
    const source = 'return <button class="big" onClick={count++}>Нажато {count} раз</button>';
    expect(scopesOf(source, 'button')).toEqual(['entity.name.tag', 'entity.name.tag']);
    expect(scopeOf(source, 'class')).toBe('entity.other.attribute-name');
    expect(scopeOf(source, 'onClick')).toBe('entity.other.attribute-name');
    expect(scopeOf(source, 'big')).toBe('string.quoted.double');
    expect(scopesOf(source, 'count')).toEqual([
      'variable.other.readwrite',
      'variable.other.readwrite',
    ]);
    expect(scopeOf(source, 'Нажато ')).toBe('meta.jsx.children');

    const item = '<TodoItem todo={todo} onToggle={todos.toggle(todo.id)} />';
    expect(scopeOf(item, 'TodoItem')).toBe('support.class.component');
    expect(scopeOf('<input bind:value={title} />', 'bind')).toBe(
      'entity.other.attribute-name.namespace',
    );
    expect(scopeOf('<p>a &amp; b</p>', '&amp;')).toBe('constant.character.entity');
  });

  it('tells comparisons from markup', () => {
    expect(scopeOf('if a < b {', '<')).toBe('keyword.operator.comparison');
    expect(scopeOf('for let i = 0; i<n; i++ {', '<')).toBe('keyword.operator.comparison');
    expect(scopeOf('if count <= limit {', '<=')).toBe('keyword.operator.comparison');
    expect(scopeOf('const ok = f() <g', '<')).toBe('keyword.operator.comparison');
    expect(scopeOf('if count <limit {', '<')).toBe('keyword.operator.comparison');
    expect(scopeOf('return <div />', 'div')).toBe('entity.name.tag');
    expect(scopeOf('case 1:\n    throw <b />', 'b')).toBe('entity.name.tag');
  });

  it('colours control flow and elements nested in markup', () => {
    const source = `const list = <div>{for i, product in products {
    if product != null {
        <Product {...product} />
    } else {
        <>Пусто</>
    }
}}</div>`;
    expect(scopeOf(source, 'for')).toBe('keyword.control.loop');
    expect(scopeOf(source, 'if')).toBe('keyword.control.conditional');
    expect(scopeOf(source, 'Product')).toBe('support.class.component');
    expect(scopeOf(source, '...')).toBe('keyword.operator.spread');
    expect(scopeOf(source, 'Пусто')).toBe('meta.jsx.children');
    expect(scopesOf(source, 'div')).toEqual(['entity.name.tag', 'entity.name.tag']);
    expect(tokenize(source).stack.depth).toBe(textmate.INITIAL.depth);
  });

  it('closes every construct in the MangoScript files of the repository', () => {
    const files = [
      ...readdirSync(join(root, 'examples')).map((name) => join(root, 'examples', name)),
      ...readdirSync(join(root, 'site/src')).map((name) => join(root, 'site/src', name)),
      join(root, 'site/server.mango'),
    ].filter((path) => path.endsWith('.mango'));
    expect(files.length).toBeGreaterThan(3);
    for (const path of files) {
      const { stack } = tokenize(readFileSync(path, 'utf8'));
      expect([path, stack.depth]).toEqual([path, textmate.INITIAL.depth]);
    }
  });
});
