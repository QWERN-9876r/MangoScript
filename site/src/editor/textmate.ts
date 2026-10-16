import * as monaco from 'monaco-editor/editor/editor.api';
import * as oniguruma from 'vscode-oniguruma';
import onigUrl from 'vscode-oniguruma/release/onig.wasm?url';
import * as textmate from 'vscode-textmate';
import mainGrammar from '../../../editors/vscode/syntaxes/mangoscript.tmLanguage.json?raw';
import cssGrammar from '../../../editors/vscode/syntaxes/mangoscript-css.tmLanguage.json?raw';
import markupGrammar from '../../../editors/vscode/syntaxes/mangoscript-markup.tmLanguage.json?raw';

// Highlighting in the editor of the playground: the grammar of the VS Code extension, run by the
// engine of VS Code (vscode-textmate with the Oniguruma regular expressions in WebAssembly). Its
// scopes become the classes of site/src/highlight.mango, so the playground has the colors of the
// examples (theme.ts).

/** The grammar of a scope; the main one includes those of markup and styles, as in VS Code. */
const GRAMMARS: Record<string, string> = {
  'source.mango': mainGrammar,
  'source.mango.markup': markupGrammar,
  'source.mango.css': cssGrammar,
};

/** Classes of tokens by the start of their scope; the first match from the innermost scope wins. */
const CLASSES: [string, string][] = [
  ['comment', 'com'],
  ['punctuation.definition.comment', 'com'],
  ['keyword.operator.new', 'kw'],
  ['keyword.operator.expression', 'kw'],
  ['keyword.operator', ''],
  ['keyword', 'kw'],
  ['storage', 'kw'],
  ['variable.language', 'kw'],
  ['constant.numeric', 'num'],
  ['constant.language', 'lit'],
  ['constant.other.color', 'num'],
  ['constant.character', 'str'],
  ['string', 'str'],
  ['entity.name.function', 'fn'],
  ['support.function', 'fn'],
  ['entity.name.tag', 'tag'],
  ['entity.name.type', 'type'],
  ['entity.other.inherited-class', 'type'],
  ['support.type.property-name', 'attr'],
  ['support.type', 'type'],
  ['support.class', 'type'],
  ['entity.other.attribute-name', 'attr'],
];

/** Code inside a string or markup: a scope of these stops the search for a class outside it. */
const EMBEDDED = ['meta.embedded', 'meta.template.expression', 'meta.jsx.children'];

function classOf(scopes: string[]): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    const match = CLASSES.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`));

    if (match) return match[1];
    if (EMBEDDED.some((prefix) => scope.startsWith(prefix))) return '';
  }

  return '';
}

/** The state of the grammar at the end of a line, as Monaco keeps it between lines. */
class State implements monaco.languages.IState {
  readonly stack: textmate.StateStack;

  constructor(stack: textmate.StateStack) {
    this.stack = stack;
  }

  clone(): State {
    return new State(this.stack.clone());
  }

  equals(other: monaco.languages.IState): boolean {
    return other instanceof State && other.stack.equals(this.stack);
  }
}

async function loadGrammar(): Promise<textmate.IGrammar> {
  // Bytes, not the response: compiling a response needs the server to send application/wasm.
  await oniguruma.loadWASM(await (await fetch(onigUrl)).arrayBuffer());

  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (text) => new oniguruma.OnigString(text),
    }),
    loadGrammar: (scopeName) => {
      const grammar = GRAMMARS[scopeName];

      return Promise.resolve(
        grammar === undefined ? null : textmate.parseRawGrammar(grammar, `${scopeName}.json`),
      );
    },
  });
  const grammar = await registry.loadGrammar('source.mango');

  if (!grammar) throw new Error('the grammar of MangoScript did not load');

  return grammar;
}

/** Highlights `language` with the grammar of the VS Code extension. */
export async function registerHighlighting(language: string): Promise<void> {
  const grammar = await loadGrammar();

  monaco.languages.setTokensProvider(language, {
    getInitialState: () => new State(textmate.INITIAL),
    tokenize(line, state) {
      const result = grammar.tokenizeLine(line, (state as State).stack);

      return {
        tokens: result.tokens.map((token) => ({
          startIndex: token.startIndex,
          scopes: classOf(token.scopes),
        })),
        endState: new State(result.ruleStack),
      };
    },
  });
}
