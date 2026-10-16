import './features.ts';
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { complete, compile, type Completion } from '../../../src/browser.ts';
import { registerHighlighting } from './textmate.ts';
import { followPageTheme } from './theme.ts';

// The editor of the playground: the one of VS Code (Monaco), with the grammar of the VS Code
// extension, the errors of the compiler under the code and the completion of the language server.
// It is loaded with load.ts when the playground comes into view; until then, and on touch screens,
// playground.rk shows its own text area.

const LANGUAGE = 'rook';
/** The editor grows with its code up to this height, then scrolls. */
const MAX_HEIGHT = 440;
/** Errors are checked once the typing stops for this long. */
const DELAY = 250;

export interface EditorOptions {
  value: string;
  /** The accessible name of the text area. */
  label: string;
  onChange: (value: string) => void;
}

export interface Editor {
  /** Replaces the code, e.g. with an example opened in the playground. */
  setValue: (value: string) => void;
  dispose: () => void;
}

const KINDS: Record<Completion['kind'], monaco.languages.CompletionItemKind> = {
  variable: monaco.languages.CompletionItemKind.Variable,
  constant: monaco.languages.CompletionItemKind.Constant,
  function: monaco.languages.CompletionItemKind.Function,
  class: monaco.languages.CompletionItemKind.Class,
  component: monaco.languages.CompletionItemKind.Class,
  type: monaco.languages.CompletionItemKind.Interface,
  property: monaco.languages.CompletionItemKind.Property,
  method: monaco.languages.CompletionItemKind.Method,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  tag: monaco.languages.CompletionItemKind.Property,
  attribute: monaco.languages.CompletionItemKind.Value,
};

let ready: Promise<void> | null = null;

/** Registers the language once, for every editor of the page. */
function setUp(): Promise<void> {
  ready ??= (async () => {
    self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
    monaco.languages.register({ id: LANGUAGE, extensions: ['.rk'] });
    // What editors/vscode/language-configuration.json gives VS Code, but for its regular
    // expressions.
    monaco.languages.setLanguageConfiguration(LANGUAGE, {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string', 'comment'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
        { open: '`', close: '`', notIn: ['string', 'comment'] },
      ],
      surroundingPairs: ['{}', '[]', '()', '""', "''", '``', '<>'].map(([open, close]) => ({
        open: open!,
        close: close!,
      })),
    });
    monaco.languages.registerCompletionItemProvider(LANGUAGE, {
      triggerCharacters: ['.', '<'],
      provideCompletionItems(model, position) {
        const list = complete(model.getValue(), model.getOffsetAt(position), { markup: true });
        const start = model.getPositionAt(list.start);
        const end = model.getPositionAt(list.end);
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

        // The compiler lists the nearest names first; the order stays among equal matches.
        return {
          suggestions: list.items.map((item, index) => ({
            label: item.name,
            kind: KINDS[item.kind],
            ...(item.detail === undefined ? {} : { detail: item.detail }),
            sortText: String(index).padStart(5, '0'),
            insertText: item.name,
            range,
          })),
        };
      },
    });
    followPageTheme();
    await registerHighlighting(LANGUAGE);
  })();

  return ready;
}

/** The errors and warnings of the compiler, under the code they are about. */
function check(model: monaco.editor.ITextModel): void {
  const result = compile(model.getValue(), null, { markup: true });
  const marker =
    (severity: monaco.MarkerSeverity) =>
    (diagnostic: (typeof result.diagnostics)[number]): monaco.editor.IMarkerData => ({
      message: diagnostic.message,
      severity,
      startLineNumber: diagnostic.line,
      startColumn: diagnostic.column,
      endLineNumber: diagnostic.endLine,
      // An empty range would show nothing.
      endColumn:
        diagnostic.endLine === diagnostic.line && diagnostic.endColumn <= diagnostic.column
          ? diagnostic.column + 1
          : diagnostic.endColumn,
    });

  monaco.editor.setModelMarkers(model, LANGUAGE, [
    ...result.diagnostics.map(marker(monaco.MarkerSeverity.Error)),
    ...result.warnings.map(marker(monaco.MarkerSeverity.Warning)),
  ]);
}

/** Creates the editor in `host`, which it fills. */
export async function createEditor(host: HTMLElement, options: EditorOptions): Promise<Editor> {
  await setUp();

  const style = getComputedStyle(host);
  const editor = monaco.editor.create(host, {
    value: options.value,
    language: LANGUAGE,
    ariaLabel: options.label,
    automaticLayout: true,
    fontFamily: style.getPropertyValue('--rui-mono'),
    fontSize: 13.5,
    lineHeight: 1.6,
    tabSize: 4,
    insertSpaces: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // The page scrolls on when the editor is at its end.
    scrollbar: { alwaysConsumeMouseWheel: false, useShadows: false },
    padding: { top: 14, bottom: 14 },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderLineHighlight: 'line',
    // The colors of brackets are those of the examples on the page.
    bracketPairColorization: { enabled: false },
    fixedOverflowWidgets: true,
  });
  const model = editor.getModel()!;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const resize = () => {
    host.style.height = `${Math.min(editor.getContentHeight(), MAX_HEIGHT)}px`;
  };

  editor.onDidContentSizeChange(resize);
  resize();
  check(model);
  editor.onDidChangeModelContent(() => {
    options.onChange(editor.getValue());
    clearTimeout(timer);
    timer = setTimeout(() => check(model), DELAY);
  });

  return {
    setValue(value) {
      if (value !== editor.getValue()) editor.setValue(value);
    },
    dispose() {
      clearTimeout(timer);
      editor.dispose();
    },
  };
}
