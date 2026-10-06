import type * as ast from '../ast.ts';
import { forEachChild } from '../walk.ts';

export interface JsOptions {
  /** The MangoScript source, used to keep the blank lines between statements. */
  source: string;
  /** Replace `.mango` with `.js` in relative import paths, for output written next to the sources. */
  rewriteImports: boolean;
}

/** Generates a readable ES module from a program that has parsed without errors. */
export function generateJs(program: ast.Program, options: JsOptions): string {
  return new JsGenerator(program, options).generate();
}

// JS operator precedence: an operand whose precedence is lower than required gets parentheses.
const ARROW = 1;
const CONDITIONAL = 2;
const UNARY = 14;
const POSTFIX = 17;
const PRIMARY = 18;

const BINARY: Readonly<Record<ast.BinaryOperator, number>> = {
  '??': 3,
  '||': 3,
  '&&': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '==': 8,
  '!=': 8,
  '<': 9,
  '>': 9,
  '<=': 9,
  '>=': 9,
  instanceof: 9,
  '<<': 10,
  '>>': 10,
  '>>>': 10,
  '+': 11,
  '-': 11,
  '*': 12,
  '/': 12,
  '%': 12,
  '**': 13,
};

/** Names that MangoScript allows but strict-mode JS reserves; they get a `$` suffix. */
const JS_RESERVED: ReadonlySet<string> = new Set([
  'debugger',
  'delete',
  'do',
  'enum',
  'function',
  'implements',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** Names that strict-mode JS can read but not declare. */
const JS_UNDECLARABLE: ReadonlySet<string> = new Set(['eval', 'arguments']);

/** Runs deferred calls in reverse order; every call runs even if an earlier one throws. */
const RUN_DEFERRED = [
  'function $$runDeferred(deferred) {',
  '  let failure;',
  '  for (let i = deferred.length - 1; i >= 0; i--) {',
  '    try {',
  '      deferred[i]();',
  '    } catch (error) {',
  '      failure = { error };',
  '    }',
  '  }',
  '  if (failure) throw failure.error;',
  '}',
];

type BindingKind = 'let' | 'const' | 'param' | 'function' | 'class' | 'import' | 'loop' | 'catch';

/** How a function implements its `defer` statements. */
type DeferMode =
  | 'none'
  // Every `defer` is at the top level of the body: nested try/finally blocks.
  | 'try'
  // Some `defer` is inside an if/loop/switch: a stack of closures run by $$runDeferred.
  | 'stack';

interface FunctionContext {
  deferMode: DeferMode;
  /** Counter for `$$0`, `$$1`, ... temporaries. */
  temps: number;
  /** Innermost last: `null` for loops and switches, a label for a switch compiled to if/else. */
  breakTargets: (string | null)[];
}

class JsGenerator {
  private readonly program: ast.Program;
  private readonly options: JsOptions;
  private lines: string[] = [];
  private level = 0;

  private readonly scopes: Map<string, BindingKind>[] = [];
  private fn: FunctionContext = { deferMode: 'none', temps: 0, breakTargets: [] };
  private labels = 0;
  private usesRunDeferred = false;

  /** Top-level `type` aliases, to find the zero value of `let id ID`. */
  private readonly typeAliases = new Map<string, ast.TypeNode>();
  /** Names that are assigned somewhere in the module; others keep their value. */
  private readonly assigned = new Set<string>();
  /** Names used as values; imports used only as types are dropped. */
  private readonly valueNames = new Set<string>();

  constructor(program: ast.Program, options: JsOptions) {
    this.program = program;
    this.options = options;
    for (const statement of program.body) {
      if (statement.kind === 'TypeAliasDeclaration') {
        this.typeAliases.set(statement.name.name, statement.type);
      }
    }
    collectAssigned(program, this.assigned);
    collectValueNames(program, this.valueNames);
  }

  generate(): string {
    this.withScope(declarationsOf(this.program.body), () => this.statements(this.program.body));
    let lines = this.lines;
    if (this.usesRunDeferred) {
      let imports = 0;
      while (lines[imports]?.startsWith('import ')) imports++;
      const rest = lines.slice(imports);
      while (rest[0] === '') rest.shift();
      lines = [
        ...lines.slice(0, imports),
        ...(imports > 0 ? [''] : []),
        ...RUN_DEFERRED,
        ...(rest.length > 0 ? [''] : []),
        ...rest,
      ];
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  // ─── Output ────────────────────────────────────────────────────────────────────────────────────

  private indent(): string {
    return '  '.repeat(this.level);
  }

  /** Writes a line at the current indentation. Later lines of `text` are already indented. */
  private line(text: string): void {
    this.lines.push(this.indent() + text);
  }

  private blankLine(): void {
    if (this.lines.length > 0 && this.lines.at(-1) !== '') this.lines.push('');
  }

  /** Returns the lines written by `emit`, one level deeper than the current one. */
  private capture(emit: () => void): string[] {
    const saved = this.lines;
    this.lines = [];
    this.level++;
    try {
      emit();
      return this.lines;
    } finally {
      this.level--;
      this.lines = saved;
    }
  }

  /** Renders the lines written by `emit` as a `{ ... }` block, for use inside a line. */
  private block(emit: () => void): string {
    const inner = this.capture(emit);
    return inner.length === 0 ? '{}' : `{\n${inner.join('\n')}\n${this.indent()}}`;
  }

  private blankLineBetween(previous: ast.NodeBase, next: ast.NodeBase): boolean {
    return /\n[^\S\n]*\n/.test(this.options.source.slice(previous.end, next.start));
  }

  // ─── Scopes ────────────────────────────────────────────────────────────────────────────────────

  private withScope<T>(bindings: Iterable<[string, BindingKind]>, emit: () => T): T {
    this.scopes.push(new Map(bindings));
    try {
      return emit();
    } finally {
      this.scopes.pop();
    }
  }

  private lookup(name: string): BindingKind | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const kind = this.scopes[i]!.get(name);
      if (kind !== undefined) return kind;
    }
    return undefined;
  }

  /** The JS name for a MangoScript name. */
  private name(name: string): string {
    const rename =
      JS_RESERVED.has(name) || (JS_UNDECLARABLE.has(name) && this.lookup(name) !== undefined);
    return rename ? `${name}$` : name;
  }

  /** Whether `error` refers to the predeclared function rather than to a declared name. */
  private isBuiltinError(node: ast.Expression): boolean {
    return (
      node.kind === 'Identifier' && node.name === 'error' && this.lookup('error') === undefined
    );
  }

  private withFunction<T>(mode: DeferMode, params: ast.Parameter[], emit: () => T): T {
    const saved = this.fn;
    this.fn = { deferMode: mode, temps: 0, breakTargets: [] };
    try {
      return this.withScope(
        params.map((param): [string, BindingKind] => [param.name.name, 'param']),
        emit,
      );
    } finally {
      this.fn = saved;
    }
  }

  private withBreakTarget<T>(label: string | null, emit: () => T): T {
    this.fn.breakTargets.push(label);
    try {
      return emit();
    } finally {
      this.fn.breakTargets.pop();
    }
  }

  // ─── Statements ────────────────────────────────────────────────────────────────────────────────

  private statements(list: readonly ast.Statement[]): void {
    let previous: ast.Statement | undefined;
    for (const statement of list) {
      if (statement.kind === 'InterfaceDeclaration' || statement.kind === 'TypeAliasDeclaration') {
        continue;
      }
      if (previous && this.blankLineBetween(previous, statement)) this.blankLine();
      this.statement(statement);
      previous = statement;
    }
  }

  /** A block's statements in a new scope, without the braces. */
  private blockStatements(statements: readonly ast.Statement[]): void {
    this.withScope(declarationsOf(statements), () => this.statements(statements));
  }

  private blockStatement(node: ast.BlockStatement): string {
    return this.block(() => this.blockStatements(node.body));
  }

  private statement(node: ast.Statement): void {
    switch (node.kind) {
      case 'ImportDeclaration':
        this.importDeclaration(node);
        break;
      case 'FuncDeclaration': {
        const [params, body] = this.func(node.params, node.body);
        const exported = node.exported ? 'export ' : '';
        this.line(`${exported}function ${this.name(node.name.name)}(${params}) ${body}`);
        break;
      }
      case 'VariableDeclaration':
        if (node.names.every((name) => name.name === '_') && !node.exported) {
          // `const _ = f()` only evaluates the values.
          for (const value of node.values) this.line(`${this.expressionStatement(value)};`);
        } else {
          this.line(`${node.exported ? 'export ' : ''}${this.variableDeclaration(node)};`);
        }
        break;
      case 'ClassDeclaration':
        this.classDeclaration(node);
        break;
      case 'InterfaceDeclaration':
      case 'TypeAliasDeclaration':
        break;
      case 'BlockStatement':
        this.line(this.blockStatement(node));
        break;
      case 'ExpressionStatement':
        this.line(`${this.expressionStatement(node.expression)};`);
        break;
      case 'AssignmentStatement':
        this.line(`${this.assignment(node)};`);
        break;
      case 'IncDecStatement':
        this.line(`${this.expression(node.target, POSTFIX)}${node.operator};`);
        break;
      case 'ReturnStatement':
        this.line(this.returnStatement(node));
        break;
      case 'IfStatement':
        this.line(this.ifStatement(node));
        break;
      case 'ForStatement':
        this.forStatement(node);
        break;
      case 'ForInStatement':
        this.forInStatement(node);
        break;
      case 'SwitchStatement':
        if (node.discriminant === null) this.taglessSwitch(node);
        else this.switchStatement(node, node.discriminant);
        break;
      case 'BreakStatement': {
        const label = this.fn.breakTargets.at(-1);
        this.line(label ? `break ${label};` : 'break;');
        break;
      }
      case 'ContinueStatement':
        this.line('continue;');
        break;
      case 'ThrowStatement':
        this.line(`throw ${this.expression(node.argument, 0)};`);
        break;
      case 'TryStatement':
        this.line(this.tryStatement(node));
        break;
      case 'DeferStatement':
        this.deferStatement(node);
        break;
    }
  }

  /** An expression used as a statement: JS would read a leading `{` as a block. */
  private expressionStatement(node: ast.Expression): string {
    const text = this.expression(node, 0);
    return startsWithObjectLiteral(node) ? `(${text})` : text;
  }

  /** `let a, b = 1, 2` → `let a = 1, b = 2`; `const q, err = f()` → `const [q, err] = f()`. */
  private variableDeclaration(node: ast.VariableDeclaration): string {
    const { keyword } = node;
    if (node.values.length === 0) {
      const zero = node.type ? this.zeroValue(node.type) : null;
      const names = node.names.map((name) => this.name(name.name));
      return `${keyword} ${names.map((name) => (zero === null ? name : `${name} = ${zero}`)).join(', ')}`;
    }
    const values = node.values.map((value) => this.expression(value, ARROW));
    const skips = node.names.some((name) => name.name === '_');
    if (values.length === node.names.length && !skips) {
      const pairs = node.names.map((name, i) => `${this.name(name.name)} = ${values[i]}`);
      return `${keyword} ${pairs.join(', ')}`;
    }
    const pattern = node.names.map((name) => (name.name === '_' ? '' : this.name(name.name)));
    const value = values.length === 1 ? values[0]! : `[${values.join(', ')}]`;
    return `${keyword} ${arrayPattern(pattern)} = ${value}`;
  }

  /** Go-style zero value of a type, or `null` for types without one. */
  private zeroValue(type: ast.TypeNode, seen = new Set<string>()): string | null {
    switch (type.kind) {
      case 'NullableType':
        return 'null';
      case 'ArrayType':
        return '[]';
      case 'FuncType':
      case 'ObjectType':
        return null;
      case 'TypeReference': {
        const name = type.name.name;
        const alias = this.typeAliases.get(name);
        if (alias && !seen.has(name)) return this.zeroValue(alias, seen.add(name));
        switch (name) {
          case 'number':
            return '0';
          case 'string':
            return '""';
          case 'bool':
            return 'false';
          case 'any':
          case 'error':
            return 'null';
          default:
            return null;
        }
      }
    }
  }

  /** `a = b`, `a, b = b, a` → `[a, b] = [b, a]`, `q, err = f()` → `[q, err] = f()`. */
  private assignment(node: ast.AssignmentStatement): string {
    const isBlank = (target: ast.Expression) => target.kind === 'Identifier' && target.name === '_';
    if (node.targets.every(isBlank)) {
      // `_ = f()` only evaluates the values.
      if (node.values.length === 1) return this.expressionStatement(node.values[0]!);
      return `[${node.values.map((value) => this.expression(value, ARROW)).join(', ')}]`;
    }
    const values = node.values.map((value) => this.expression(value, ARROW));
    if (node.targets.length === 1) {
      return `${this.expression(node.targets[0]!, POSTFIX)} ${node.operator} ${values[0]}`;
    }
    const pattern = node.targets.map((target) =>
      isBlank(target) ? '' : this.expression(target, POSTFIX),
    );
    const value = values.length === 1 ? values[0]! : `[${values.join(', ')}]`;
    return `${arrayPattern(pattern)} = ${value}`;
  }

  /** Several results are returned as an array: `return a, b` → `return [a, b]`. */
  private returnStatement(node: ast.ReturnStatement): string {
    if (node.values.length === 0) return 'return;';
    if (node.values.length === 1) return `return ${this.expression(node.values[0]!, 0)};`;
    return `return [${node.values.map((value) => this.expression(value, ARROW)).join(', ')}];`;
  }

  private ifStatement(node: ast.IfStatement): string {
    let text = `if (${this.expression(node.condition, 0)}) ${this.blockStatement(node.consequent)}`;
    if (node.alternate?.kind === 'IfStatement') {
      text += ` else ${this.ifStatement(node.alternate)}`;
    } else if (node.alternate) {
      text += ` else ${this.blockStatement(node.alternate)}`;
    }
    return text;
  }

  private loopBody(body: ast.BlockStatement): string {
    return this.withBreakTarget(null, () => this.blockStatement(body));
  }

  private forStatement(node: ast.ForStatement): void {
    const bindings =
      node.init?.kind === 'VariableDeclaration'
        ? node.init.names.map((name): [string, BindingKind] => [name.name, 'let'])
        : [];
    this.withScope(bindings, () => {
      const condition = node.condition ? this.expression(node.condition, 0) : '';
      if (node.init === null && node.update === null) {
        this.line(`while (${condition || 'true'}) ${this.loopBody(node.body)}`);
        return;
      }
      const init = node.init ? this.simpleStatement(node.init) : '';
      const update = node.update ? this.simpleStatement(node.update) : '';
      this.line(`for (${init}; ${condition}; ${update}) ${this.loopBody(node.body)}`);
    });
  }

  /** A statement inside a `for` header, without the `;`. */
  private simpleStatement(node: ast.SimpleStatement): string {
    switch (node.kind) {
      case 'VariableDeclaration':
        return this.variableDeclaration(node);
      case 'AssignmentStatement':
        return this.assignment(node);
      case 'IncDecStatement':
        return `${this.expression(node.target, POSTFIX)}${node.operator}`;
      case 'ExpressionStatement':
        return this.expression(node.expression, 0);
    }
  }

  /** `for x in xs` → `for (const x of xs)`; `for i, x in xs` iterates `xs.entries()`. */
  private forInStatement(node: ast.ForInStatement): void {
    const bindings: [string, BindingKind][] = [[node.value.name, 'loop']];
    if (node.key) bindings.push([node.key.name, 'loop']);
    this.withScope(bindings, () => {
      const value = this.name(node.value.name);
      let head: string;
      if (node.key === null) {
        head = `const ${value} of ${this.expression(node.iterable, ARROW)}`;
      } else {
        const key = node.key.name === '_' ? '' : this.name(node.key.name);
        const pair = node.value.name === '_' ? `[${key}]` : `[${key}, ${value}]`;
        head = `const ${pair} of ${this.expression(node.iterable, POSTFIX)}.entries()`;
      }
      this.line(`for (${head}) ${this.loopBody(node.body)}`);
    });
  }

  /** Each `case` ends with an implicit `break`; a case with declarations gets its own block. */
  private switchStatement(node: ast.SwitchStatement, discriminant: ast.Expression): void {
    const head = `switch (${this.expression(discriminant, 0)})`;
    const body = this.withBreakTarget(null, () =>
      this.block(() => {
        node.cases.forEach((switchCase, i) => {
          const labels =
            switchCase.tests.length === 0
              ? ['default:']
              : switchCase.tests.map((test) => `case ${this.expression(test, 0)}:`);
          for (const label of labels.slice(0, -1)) this.line(label);

          const isLast = i === node.cases.length - 1;
          const needsBreak = !isLast && !endsWithJump(switchCase.body);
          const declarations = declarationsOf(switchCase.body);
          const lines = this.capture(() => {
            this.withScope(declarations, () => this.statements(switchCase.body));
            if (needsBreak) this.line('break;');
          });

          if (declarations.length > 0) {
            this.line(`${labels.at(-1)} {\n${lines.join('\n')}\n${this.indent()}}`);
          } else {
            this.line(labels.at(-1)!);
            this.lines.push(...lines);
          }
        });
      }),
    );
    this.line(`${head} ${body}`);
  }

  /**
   * `switch { case cond: ... }` becomes an if/else chain. A `break` inside it must leave the
   * switch, not an enclosing loop, so then the chain gets a label to break to.
   */
  private taglessSwitch(node: ast.SwitchStatement): void {
    const cases = node.cases.filter((switchCase) => switchCase.tests.length > 0);
    const fallback = node.cases.find((switchCase) => switchCase.tests.length === 0);
    const label = node.cases.some((switchCase) => breaksOut(switchCase.body))
      ? `$$switch${++this.labels}`
      : null;

    const text = this.withBreakTarget(label, () => {
      const caseBlock = (body: ast.Statement[]) => this.block(() => this.blockStatements(body));
      const branches = cases.map((switchCase) => {
        const condition =
          switchCase.tests.length === 1
            ? this.expression(switchCase.tests[0]!, 0)
            : switchCase.tests.map((test) => this.expression(test, BINARY['||'] + 1)).join(' || ');
        return `if (${condition}) ${caseBlock(switchCase.body)}`;
      });
      if (fallback) branches.push(caseBlock(fallback.body));
      return branches.join(' else ');
    });

    if (text === '') return;
    this.line(label ? `${label}: ${text}` : text);
  }

  private tryStatement(node: ast.TryStatement): string {
    let text = `try ${this.blockStatement(node.block)}`;
    const { handler } = node;
    if (handler) {
      const param = handler.param;
      const bindings: [string, BindingKind][] = param ? [[param.name, 'catch']] : [];
      text += this.withScope(bindings, () => {
        const head = param ? ` catch (${this.name(param.name)})` : ' catch';
        return `${head} ${this.blockStatement(handler.body)}`;
      });
    }
    if (node.finalizer) text += ` finally ${this.blockStatement(node.finalizer)}`;
    return text;
  }

  // ─── Functions and defer ───────────────────────────────────────────────────────────────────────

  /** Parameters and body of a function, method or func literal. */
  private func(params: ast.Parameter[], body: ast.BlockStatement): [string, string] {
    const defers = findDefers(body);
    const mode: DeferMode =
      defers.length === 0
        ? 'none'
        : defers.every((defer) => body.body.includes(defer))
          ? 'try'
          : 'stack';

    return this.withFunction(mode, params, () => {
      const paramList = this.params(params);
      const text = this.block(() => {
        this.withScope(declarationsOf(body.body), () => {
          if (mode === 'try') {
            this.statementsWithDefers(body.body);
          } else if (mode === 'stack') {
            this.usesRunDeferred = true;
            this.line('const $$defer = [];');
            const statements = this.block(() => this.statements(body.body));
            const finalizer = this.block(() => this.line('$$runDeferred($$defer);'));
            this.line(`try ${statements} finally ${finalizer}`);
          } else {
            this.statements(body.body);
          }
        });
      });
      return [paramList, text];
    });
  }

  private params(params: ast.Parameter[]): string {
    // Several `_` parameters would be duplicate names in JS.
    const blanks = params.filter((param) => param.name.name === '_').length;
    return params
      .map((param, i) =>
        param.name.name === '_' && blanks > 1 ? `_${i}` : this.name(param.name.name),
      )
      .join(', ');
  }

  /** Statements of a body whose `defer`s are all at its top level: one try/finally per `defer`. */
  private statementsWithDefers(list: readonly ast.Statement[]): void {
    const index = list.findIndex((statement) => statement.kind === 'DeferStatement');
    if (index === -1) {
      this.statements(list);
      return;
    }
    this.statements(list.slice(0, index));
    const runDeferred = this.prepareDeferred(list[index] as ast.DeferStatement);
    const rest = list.slice(index + 1);
    if (rest.length === 0) {
      // Nothing can happen between the `defer` and the end of the function.
      runDeferred();
      return;
    }
    const body = this.block(() => this.statementsWithDefers(rest));
    this.line(`try ${body} finally ${this.block(runDeferred)}`);
  }

  /**
   * Go evaluates the function and arguments of a deferred call at the `defer` statement. Values
   * that cannot change in between are used as they are; others are saved to temporaries here.
   * Returns a function that writes the deferred code.
   */
  private prepareDeferred(node: ast.DeferStatement): () => void {
    const { body } = node;
    if (body.kind === 'BlockStatement') return () => this.blockStatements(body.body);
    const call = this.deferredCall(body);
    return () => this.line(`${call};`);
  }

  private deferredCall(call: ast.CallExpression): string {
    const { callee } = call;
    let target: string;
    if (callee.kind === 'MemberExpression') {
      const object = this.memberObject(callee.object, (o) => this.stable(o, POSTFIX));
      target = `${object}${callee.optional ? '?.' : '.'}${callee.property.name}`;
    } else if (callee.kind === 'IndexExpression') {
      const object = this.memberObject(callee.object, (o) => this.stable(o, POSTFIX));
      target = `${object}${callee.optional ? '?.[' : '['}${this.stable(callee.index, 0)}]`;
    } else if (this.isBuiltinError(callee)) {
      target = 'Error';
    } else {
      target = this.stable(callee, POSTFIX);
    }
    const args = call.arguments.map((arg) =>
      arg.kind === 'SpreadElement'
        ? `...${this.stable(arg.argument, ARROW)}`
        : this.stable(arg, ARROW),
    );
    return `${target}${call.optional ? '?.' : ''}(${args.join(', ')})`;
  }

  /** The expression itself if its value cannot change before the deferred call runs. */
  private stable(node: ast.Expression, precedence: number): string {
    if (this.isStable(node)) return this.expression(node, precedence);
    const temp = `$$${this.fn.temps++}`;
    this.line(`const ${temp} = ${this.expression(node, ARROW)};`);
    return temp;
  }

  private isStable(node: ast.Expression): boolean {
    switch (node.kind) {
      case 'NumberLiteral':
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'ThisExpression':
      case 'SuperExpression':
        return true;
      case 'TemplateLiteral':
        return node.expressions.every((expression) => this.isStable(expression));
      case 'Identifier': {
        const kind = this.lookup(node.name);
        if (kind === 'let' || kind === 'param' || kind === 'catch') {
          return !this.assigned.has(node.name);
        }
        return true;
      }
      default:
        return false;
    }
  }

  private deferStatement(node: ast.DeferStatement): void {
    // In 'try' mode `defer`s are handled by statementsWithDefers and never get here.
    const { body } = node;
    if (body.kind === 'BlockStatement') {
      const block = this.block(() => this.blockStatements(body.body));
      this.line(`$$defer.push(() => ${block});`);
      return;
    }
    // Temporaries for the arguments go into a block so that each loop iteration gets its own.
    const lines = this.capture(() => this.line(`$$defer.push(() => ${this.deferredCall(body)});`));
    if (lines.length === 1) this.line(lines[0]!.trimStart());
    else this.line(`{\n${lines.join('\n')}\n${this.indent()}}`);
  }

  // ─── Declarations ──────────────────────────────────────────────────────────────────────────────

  private importDeclaration(node: ast.ImportDeclaration): void {
    // Imports used only as types (e.g. interfaces) do not exist at runtime.
    const used = (name: ast.Identifier) => this.valueNames.has(name.name);
    const clauses: string[] = [];
    if (node.defaultImport && used(node.defaultImport)) {
      clauses.push(this.name(node.defaultImport.name));
    }
    if (node.namespaceImport && used(node.namespaceImport)) {
      clauses.push(`* as ${this.name(node.namespaceImport.name)}`);
    }
    const named = node.namedImports
      .filter((specifier) => used(specifier.local))
      .map((specifier) => {
        const local = this.name(specifier.local.name);
        return specifier.imported.name === local ? local : `${specifier.imported.name} as ${local}`;
      });
    if (named.length > 0) clauses.push(`{ ${named.join(', ')} }`);

    const importsNames =
      node.defaultImport !== null || node.namespaceImport !== null || node.namedImports.length > 0;
    if (importsNames && clauses.length === 0) return;

    const source = this.importPath(node.source);
    this.line(
      clauses.length > 0 ? `import ${clauses.join(', ')} from ${source};` : `import ${source};`,
    );
  }

  private importPath(source: ast.StringLiteral): string {
    const path = source.value;
    if (this.options.rewriteImports && /^\.{1,2}\//.test(path) && path.endsWith('.mango')) {
      return JSON.stringify(`${path.slice(0, -'.mango'.length)}.js`);
    }
    return source.raw;
  }

  private classDeclaration(node: ast.ClassDeclaration): void {
    const exported = node.exported ? 'export ' : '';
    const superClass = node.superClass
      ? ` extends ${this.expression(node.superClass, POSTFIX)}`
      : '';
    const body = this.block(() => {
      let previous: ast.ClassMember | undefined;
      for (const member of node.members) {
        const bothFields =
          previous?.kind === 'FieldDeclaration' && member.kind === 'FieldDeclaration';
        if (previous && (!bothFields || this.blankLineBetween(previous, member))) this.blankLine();
        this.classMember(member);
        previous = member;
      }
    });
    this.line(`${exported}class ${this.name(node.name.name)}${superClass} ${body}`);
  }

  /** Visibility modifiers are checked by the compiler and do not exist in the output. */
  private classMember(member: ast.ClassMember): void {
    switch (member.kind) {
      case 'FieldDeclaration': {
        const value = member.value
          ? this.expression(member.value, ARROW)
          : member.type
            ? this.zeroValue(member.type)
            : null;
        const prefix = member.isStatic ? 'static ' : '';
        this.line(`${prefix}${member.name.name}${value === null ? '' : ` = ${value}`};`);
        break;
      }
      case 'ConstructorDeclaration': {
        const [params, body] = this.func(member.params, member.body);
        this.line(`constructor(${params}) ${body}`);
        break;
      }
      case 'MethodDeclaration': {
        const [params, body] = this.func(member.params, member.body);
        this.line(`${member.isStatic ? 'static ' : ''}${member.name.name}(${params}) ${body}`);
        break;
      }
    }
  }

  // ─── Expressions ───────────────────────────────────────────────────────────────────────────────

  /** The expression, in parentheses if it binds weaker than `minPrecedence`. */
  private expression(node: ast.Expression, minPrecedence: number, forceParens = false): string {
    const [text, precedence] = this.expressionWithPrecedence(node);
    return precedence < minPrecedence || forceParens ? `(${text})` : text;
  }

  private expressionWithPrecedence(node: ast.Expression): [string, number] {
    switch (node.kind) {
      case 'Identifier':
        // The predeclared `error` used as a value is JS's `Error`, which also works without `new`.
        return [this.isBuiltinError(node) ? 'Error' : this.name(node.name), PRIMARY];
      case 'NumberLiteral':
      case 'StringLiteral':
        return [node.raw, PRIMARY];
      case 'TemplateLiteral':
        return [this.template(node), PRIMARY];
      case 'BooleanLiteral':
        return [String(node.value), PRIMARY];
      case 'NullLiteral':
        return ['null', PRIMARY];
      case 'ThisExpression':
        return ['this', PRIMARY];
      case 'SuperExpression':
        return ['super', PRIMARY];
      case 'ArrayLiteral':
        return [`[${this.elements(node.elements)}]`, PRIMARY];
      case 'ObjectLiteral':
        return [this.objectLiteral(node), PRIMARY];
      case 'FuncExpression': {
        // Func literals become arrow functions, so `this` inside them is the enclosing `this`.
        const [params, body] = this.func(node.params, node.body);
        return [`(${params}) => ${body}`, ARROW];
      }
      case 'ArrowFunction':
        return [this.arrowFunction(node), ARROW];
      case 'UnaryExpression':
        return [this.unary(node), UNARY];
      case 'BinaryExpression':
        return [this.binary(node), BINARY[node.operator]];
      case 'ConditionalExpression': {
        const test = this.expression(node.test, CONDITIONAL + 1);
        const consequent = this.expression(node.consequent, ARROW);
        const alternate = this.expression(node.alternate, ARROW);
        return [`${test} ? ${consequent} : ${alternate}`, CONDITIONAL];
      }
      case 'CallExpression':
        return [this.call(node), POSTFIX];
      case 'NewExpression':
        return [`new ${this.newCallee(node.callee)}(${this.elements(node.arguments)})`, POSTFIX];
      case 'MemberExpression': {
        const object = this.memberObject(node.object, (o) => this.expression(o, POSTFIX));
        return [`${object}${node.optional ? '?.' : '.'}${node.property.name}`, POSTFIX];
      }
      case 'IndexExpression': {
        const object = this.memberObject(node.object, (o) => this.expression(o, POSTFIX));
        const index = this.expression(node.index, 0);
        return [`${object}${node.optional ? '?.[' : '['}${index}]`, POSTFIX];
      }
    }
  }

  /** `1.toFixed()` is not valid JS, so number literals before `.` get parentheses. */
  private memberObject(node: ast.Expression, render: (node: ast.Expression) => string): string {
    const text = render(node);
    return node.kind === 'NumberLiteral' ? `(${text})` : text;
  }

  private call(node: ast.CallExpression): string {
    const args = this.elements(node.arguments);
    if (this.isBuiltinError(node.callee) && !node.optional) return `new Error(${args})`;
    return `${this.expression(node.callee, POSTFIX)}${node.optional ? '?.' : ''}(${args})`;
  }

  /** `new (f())()` and `new (a?.B)()` need parentheses around the class expression. */
  private newCallee(callee: ast.Expression): string {
    let node = callee;
    let needsParens = false;
    for (;;) {
      if (node.kind === 'CallExpression') {
        needsParens = true;
        break;
      }
      if (node.kind !== 'MemberExpression' && node.kind !== 'IndexExpression') break;
      if (node.optional) {
        needsParens = true;
        break;
      }
      node = node.object;
    }
    return this.expression(callee, POSTFIX, needsParens);
  }

  private elements(elements: readonly (ast.Expression | ast.SpreadElement)[]): string {
    return elements
      .map((element) =>
        element.kind === 'SpreadElement'
          ? `...${this.expression(element.argument, ARROW)}`
          : this.expression(element, ARROW),
      )
      .join(', ');
  }

  private template(node: ast.TemplateLiteral): string {
    let text = '`';
    node.quasis.forEach((quasi, i) => {
      text += quasi.raw;
      const expression = node.expressions[i];
      if (expression) text += `\${${this.expression(expression, 0)}}`;
    });
    return `${text}\``;
  }

  private objectLiteral(node: ast.ObjectLiteral): string {
    if (node.properties.length === 0) return '{}';
    const properties = node.properties.map((property) => {
      if (property.kind === 'SpreadElement') {
        return `...${this.expression(property.argument, ARROW)}`;
      }
      const key = property.key.kind === 'StringLiteral' ? property.key.raw : property.key.name;
      const value = this.expression(property.value, ARROW);
      // A renamed shorthand (`{ delete }` → `delete$`) must keep its key.
      return property.shorthand && value === key ? key : `${key}: ${value}`;
    });
    return `{ ${properties.join(', ')} }`;
  }

  private arrowFunction(node: ast.ArrowFunction): string {
    const { body } = node;
    if (body.kind === 'BlockStatement') {
      const [params, block] = this.func(node.params, body);
      return `(${params}) => ${block}`;
    }
    return this.withFunction('none', node.params, () => {
      const params = this.params(node.params);
      // `() => ({ ... })`: a body starting with `{` would be read as a block.
      const text = this.expression(body, ARROW, startsWithObjectLiteral(body));
      return `(${params}) => ${text}`;
    });
  }

  private unary(node: ast.UnaryExpression): string {
    const argument = this.expression(node.argument, UNARY);
    if (node.operator === 'typeof') return `typeof ${argument}`;
    // `- -x` must not turn into `--x`.
    const space =
      (node.operator === '-' || node.operator === '+') && argument.startsWith(node.operator);
    return `${node.operator}${space ? ' ' : ''}${argument}`;
  }

  private binary(node: ast.BinaryExpression): string {
    const { operator } = node;
    const precedence = BINARY[operator];
    const rightAssociative = operator === '**';
    const nullishMix = (operand: ast.Expression) =>
      operand.kind === 'BinaryExpression' &&
      (operator === '??'
        ? operand.operator === '||' || operand.operator === '&&'
        : (operator === '||' || operator === '&&') && operand.operator === '??');

    // JS rejects `-a ** b` and mixing `??` with `||` / `&&` unless there are parentheses.
    const left = this.expression(
      node.left,
      rightAssociative ? precedence + 1 : precedence,
      (operator === '**' && node.left.kind === 'UnaryExpression') || nullishMix(node.left),
    );
    const right = this.expression(
      node.right,
      rightAssociative ? precedence : precedence + 1,
      nullishMix(node.right),
    );

    let jsOperator: string = operator;
    if (operator === '==' || operator === '!=') {
      // `x == null` stays loose so that it also matches `undefined` coming from JS code.
      const withNull = node.left.kind === 'NullLiteral' || node.right.kind === 'NullLiteral';
      if (!withNull) jsOperator = `${operator}=`;
    }
    return `${left} ${jsOperator} ${right}`;
  }
}

// ─── Analysis helpers ────────────────────────────────────────────────────────────────────────────

/** Names declared directly in a list of statements. */
function declarationsOf(statements: readonly ast.Statement[]): [string, BindingKind][] {
  const bindings: [string, BindingKind][] = [];
  for (const statement of statements) {
    switch (statement.kind) {
      case 'VariableDeclaration':
        for (const name of statement.names) bindings.push([name.name, statement.keyword]);
        break;
      case 'FuncDeclaration':
        bindings.push([statement.name.name, 'function']);
        break;
      case 'ClassDeclaration':
        bindings.push([statement.name.name, 'class']);
        break;
      case 'ImportDeclaration':
        if (statement.defaultImport) bindings.push([statement.defaultImport.name, 'import']);
        if (statement.namespaceImport) bindings.push([statement.namespaceImport.name, 'import']);
        for (const specifier of statement.namedImports) {
          bindings.push([specifier.local.name, 'import']);
        }
        break;
      default:
        break;
    }
  }
  return bindings;
}

/** `defer` statements of a function body, excluding those of nested functions. */
function findDefers(body: ast.BlockStatement): ast.DeferStatement[] {
  const defers: ast.DeferStatement[] = [];
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'DeferStatement':
        defers.push(node);
        return;
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'ClassDeclaration':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  forEachChild(body, visit);
  return defers;
}

/** Whether a `break` in these statements leaves the enclosing switch (not a nested loop). */
function breaksOut(statements: readonly ast.Statement[]): boolean {
  let found = false;
  const visit = (node: ast.Node): void => {
    switch (node.kind) {
      case 'BreakStatement':
        found = true;
        return;
      case 'ForStatement':
      case 'ForInStatement':
      case 'SwitchStatement':
      case 'FuncDeclaration':
      case 'FuncExpression':
      case 'ArrowFunction':
      case 'ClassDeclaration':
        return;
      default:
        forEachChild(node, visit);
    }
  };
  statements.forEach(visit);
  return found;
}

/** `[a, , c]`; skipped (empty) elements at the end are dropped: `[q, ]` → `[q]`. */
function arrayPattern(elements: readonly string[]): string {
  let end = elements.length;
  while (end > 0 && elements[end - 1] === '') end--;
  return `[${elements.slice(0, end).join(', ')}]`;
}

function endsWithJump(statements: readonly ast.Statement[]): boolean {
  const kind = statements.at(-1)?.kind;
  return (
    kind === 'ReturnStatement' ||
    kind === 'ThrowStatement' ||
    kind === 'BreakStatement' ||
    kind === 'ContinueStatement'
  );
}

function startsWithObjectLiteral(node: ast.Expression): boolean {
  switch (node.kind) {
    case 'ObjectLiteral':
      return true;
    case 'CallExpression':
      return startsWithObjectLiteral(node.callee);
    case 'MemberExpression':
    case 'IndexExpression':
      return startsWithObjectLiteral(node.object);
    case 'BinaryExpression':
      return startsWithObjectLiteral(node.left);
    case 'ConditionalExpression':
      return startsWithObjectLiteral(node.test);
    default:
      return false;
  }
}

/** Names assigned anywhere: `x = ...`, `x += ...`, `x++`. */
function collectAssigned(node: ast.Node, names: Set<string>): void {
  if (node.kind === 'AssignmentStatement') {
    for (const target of node.targets) if (target.kind === 'Identifier') names.add(target.name);
  } else if (node.kind === 'IncDecStatement' && node.target.kind === 'Identifier') {
    names.add(node.target.name);
  }
  forEachChild(node, (child) => collectAssigned(child, names));
}

/** Names used as values, as opposed to declared names, property names and types. */
function collectValueNames(node: ast.Node, names: Set<string>): void {
  const visit = (child: ast.Node | null) => {
    if (child) collectValueNames(child, names);
  };
  switch (node.kind) {
    case 'Identifier':
      names.add(node.name);
      return;
    case 'MemberExpression':
      visit(node.object);
      return;
    case 'Property':
      visit(node.value);
      return;
    case 'VariableDeclaration':
      node.values.forEach(visit);
      return;
    case 'FuncDeclaration':
    case 'MethodDeclaration':
    case 'ConstructorDeclaration':
    case 'FuncExpression':
    case 'ArrowFunction':
      visit(node.body);
      return;
    case 'ClassDeclaration':
      visit(node.superClass);
      node.members.forEach(visit);
      return;
    case 'FieldDeclaration':
      visit(node.value);
      return;
    case 'ForInStatement':
      visit(node.iterable);
      visit(node.body);
      return;
    case 'CatchClause':
      visit(node.body);
      return;
    case 'ImportDeclaration':
    case 'InterfaceDeclaration':
    case 'TypeAliasDeclaration':
    case 'Parameter':
    case 'TypeReference':
    case 'ArrayType':
    case 'NullableType':
    case 'FuncType':
    case 'ObjectType':
      return;
    default:
      forEachChild(node, visit);
  }
}
