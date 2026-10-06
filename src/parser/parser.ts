import type * as ast from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { tokenize } from '../lexer/lexer.ts';
import { isKeyword, type StringToken, type Token, type TokenKind } from '../lexer/token.ts';

export interface ParseResult {
  program: ast.Program;
  /** Lexer and parser errors, sorted by position. */
  diagnostics: Diagnostic[];
}

export function parse(text: string): ParseResult {
  const { tokens, diagnostics } = tokenize(text);
  const parser = new Parser(tokens);
  const program = parser.parseProgram();
  return {
    program,
    diagnostics: [...diagnostics, ...parser.diagnostics].sort((a, b) => a.start - b.start),
  };
}

/** Binary operators and their precedence (higher binds tighter), as in JS. */
const BINARY_PRECEDENCE: Readonly<Record<ast.BinaryOperator, number>> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '|': 4,
  '^': 5,
  '&': 6,
  '==': 7,
  '!=': 7,
  '<': 8,
  '>': 8,
  '<=': 8,
  '>=': 8,
  instanceof: 8,
  '<<': 9,
  '>>': 9,
  '>>>': 9,
  '+': 10,
  '-': 10,
  '*': 11,
  '/': 11,
  '%': 11,
  '**': 12,
};

const UNARY_OPERATORS: ReadonlySet<string> = new Set<ast.UnaryOperator>([
  '!',
  '-',
  '+',
  '~',
  'typeof',
]);

const ASSIGNMENT_OPERATORS: ReadonlySet<string> = new Set<ast.AssignmentOperator>([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
  '>>>=',
  '&&=',
  '||=',
  '??=',
]);

function isBinaryOperator(kind: TokenKind): kind is ast.BinaryOperator {
  return Object.hasOwn(BINARY_PRECEDENCE, kind);
}

function isUnaryOperator(kind: TokenKind): kind is ast.UnaryOperator {
  return UNARY_OPERATORS.has(kind);
}

function isAssignmentOperator(kind: TokenKind): kind is ast.AssignmentOperator {
  return ASSIGNMENT_OPERATORS.has(kind);
}

const RESERVED: ReadonlySet<string> = new Set(['map', 'async', 'await']);

const MODIFIERS: ReadonlySet<string> = new Set(['public', 'protected', 'private', 'static']);

/** Words from JS that MangoScript spells differently. */
const FOREIGN_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ['function', 'declare functions with "func"'],
  ['var', 'declare variables with "let" or "const"'],
  ['while', 'write loops as "for condition { ... }"'],
]);

/** Keywords that start a statement; used to find where to resume after a syntax error. */
const STATEMENT_KEYWORDS: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'import',
  'export',
  'func',
  'let',
  'const',
  'class',
  'interface',
  'type',
  'return',
  'if',
  'for',
  'switch',
  'break',
  'continue',
  'throw',
  'try',
  'defer',
]);

/** Closing brackets and the opening brackets they match. */
const BRACKETS: Readonly<Partial<Record<TokenKind, TokenKind>>> = {
  ')': '(',
  ']': '[',
  '}': '{',
  TemplateTail: 'TemplateHead',
};

interface Context {
  /** At the top level of the module, where imports and exports are allowed. */
  topLevel: boolean;
  inFunction: boolean;
  inLoop: boolean;
  /** Inside a loop or switch, where `break` is allowed. */
  inBreakable: boolean;
  inDefer: boolean;
  /** In an if/for/switch header, where `{` starts the block rather than an object literal. */
  noObjectLiteral: boolean;
}

const FUNCTION_BODY: Partial<Context> = {
  topLevel: false,
  inFunction: true,
  inLoop: false,
  inBreakable: false,
  inDefer: false,
  noObjectLiteral: false,
};

/** Thrown to abandon the current statement after its syntax error has been reported. */
class ParseError extends Error {}

function describe(token: Token): string {
  switch (token.kind) {
    case 'EOF':
      return 'end of file';
    case ';':
      return token.text === '' ? 'newline' : '";"';
    case 'String':
      return 'string';
    case 'Number':
      return `number ${token.text}`;
    case 'Template':
    case 'TemplateHead':
      return 'template literal';
    default:
      return `"${token.text}"`;
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The text of a template part without its delimiters: "`" or "}" before it, "`" or "${" after it. */
function templateElement(token: StringToken): ast.TemplateElement {
  const text = token.text;
  const end = text.endsWith('${') ? -2 : text.length > 1 && text.endsWith('`') ? -1 : text.length;
  return {
    kind: 'TemplateElement',
    value: token.value,
    raw: text.slice(1, end),
    start: token.start,
    end: token.end,
  };
}

class Parser {
  readonly diagnostics: Diagnostic[] = [];
  private readonly tokens: Token[];
  private pos = 0;
  private context: Context = {
    topLevel: true,
    inFunction: false,
    inLoop: false,
    inBreakable: false,
    inDefer: false,
    noObjectLiteral: false,
  };
  /** Expressions written in parentheses, which the tree itself does not record. */
  private readonly parenthesized = new WeakSet<ast.Expression>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseProgram(): ast.Program {
    const body = this.parseStatements(() => false);
    return { kind: 'Program', body, start: 0, end: this.peek().end };
  }

  // ─── Tokens ────────────────────────────────────────────────────────────────────────────────────

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** Whether the current token is the word `word`, e.g. the contextual keyword `from`. */
  private checkWord(word: string): boolean {
    const token = this.peek();
    return token.kind === 'Identifier' && token.text === word;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'EOF') this.pos++;
    return token;
  }

  private accept(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.next();
    return true;
  }

  private acceptWord(word: string): boolean {
    if (!this.checkWord(word)) return false;
    this.next();
    return true;
  }

  private expect(kind: TokenKind, what = `"${kind}"`): Token {
    if (this.check(kind)) return this.next();
    return this.fail(`expected ${what}, found ${describe(this.peek())}`);
  }

  private expectWord(word: string): void {
    if (!this.acceptWord(word)) this.fail(`expected "${word}", found ${describe(this.peek())}`);
  }

  private isImplicitSemicolon(): boolean {
    const token = this.peek();
    return token.kind === ';' && token.text === '';
  }

  /** Start and end of a node that began at `start` and ends with the last consumed token. */
  private span(start: number): ast.NodeBase {
    return { start, end: this.tokens[this.pos - 1]?.end ?? start };
  }

  // ─── Errors ────────────────────────────────────────────────────────────────────────────────────

  /** Reports an error unless one was already reported at the same position. */
  private error(message: string, start: number, end: number): void {
    if (this.diagnostics.some((d) => d.start === start)) return;
    this.diagnostics.push({ message, start, end });
  }

  /** Reports an error at the current token and abandons the current statement. */
  private fail(message: string): never {
    const token = this.peek();
    return this.failAt(message, token.start, token.end);
  }

  private failAt(message: string, start: number, end: number): never {
    this.error(message, start, end);
    throw new ParseError(message);
  }

  /** Runs `parse` with some context flags changed. */
  private withContext<T>(changes: Partial<Context>, parse: () => T): T {
    const saved = this.context;
    this.context = { ...saved, ...changes };
    try {
      return parse();
    } finally {
      this.context = saved;
    }
  }

  /** Inside brackets `{` starts an object literal again, even within an if/for/switch header. */
  private nested<T>(parse: () => T): T {
    return this.withContext({ noObjectLiteral: false }, parse);
  }

  /**
   * Parses items separated by newlines or `;` until `isEnd`. A syntax error abandons only the item
   * it occurred in: the parser skips to the item's end and continues with the next one.
   */
  private parseSeparated(isEnd: () => boolean, parseItem: () => void): void {
    while (!isEnd() && !this.check('EOF')) {
      if (this.accept(';')) continue;
      const start = this.pos;
      try {
        parseItem();
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        this.synchronize(start);
        if (this.pos === start) this.next();
      }
    }
  }

  /**
   * Skips the broken statement that began at token index `start`: up to the first `;` outside
   * brackets, or up to a `}` that closes the enclosing block.
   */
  private synchronize(start: number): void {
    this.pos = start;
    // The `;` inside a `for` header do not end the statement.
    const explicitSemicolonEnds = this.peek().kind !== 'for';
    const open: TokenKind[] = [];
    for (;;) {
      const token = this.next();
      const kind = token.kind;
      if (kind === 'EOF') return;
      if (kind === ';') {
        if (open.length === 0 && (token.text === '' || explicitSemicolonEnds)) return;
        // A newline before a statement keyword: probably an unclosed bracket on the line above.
        if (token.text === '' && STATEMENT_KEYWORDS.has(this.peek().kind)) return;
      } else if (kind === '(' || kind === '[' || kind === '{' || kind === 'TemplateHead') {
        open.push(kind);
      } else if (kind === 'TemplateMiddle') {
        // Closes one substitution and opens the next one.
      } else {
        const opening = BRACKETS[kind];
        if (opening !== undefined) {
          const index = open.lastIndexOf(opening);
          if (index !== -1) open.length = index;
          else if (kind === '}') {
            // A `}` without a matching `{` closes the enclosing block: leave it to the block.
            this.pos--;
            return;
          }
        }
      }
      if (this.check('}') && !open.includes('{')) return;
    }
  }

  // ─── Statements ────────────────────────────────────────────────────────────────────────────────

  private parseStatements(isEnd: () => boolean): ast.Statement[] {
    const body: ast.Statement[] = [];
    this.parseSeparated(isEnd, () => {
      body.push(this.parseStatement());
    });
    return body;
  }

  private parseStatement(): ast.Statement {
    const token = this.peek();
    const declaration = this.parseDeclaration(token.start, false);
    if (declaration) return declaration;

    switch (token.kind) {
      case 'import':
        return this.parseImport();
      case 'export':
        return this.parseExport();
      case '{':
        return this.parseBlock();
      case 'return':
        return this.parseReturn();
      case 'if':
        return this.parseIf();
      case 'for':
        return this.parseFor();
      case 'switch':
        return this.parseSwitch();
      case 'break':
      case 'continue':
        return this.parseBreakOrContinue();
      case 'throw':
        return this.parseThrow();
      case 'try':
        return this.parseTry();
      case 'defer':
        return this.parseDefer();
      default:
        break;
    }

    const hint = token.kind === 'Identifier' ? FOREIGN_KEYWORDS.get(token.text) : undefined;
    if (hint !== undefined && this.peek(1).kind === 'Identifier') {
      this.fail(`"${token.text}" is not a MangoScript keyword: ${hint}`);
    }

    const statement = this.parseSimpleStatement();
    if (statement.kind === 'ExpressionStatement') {
      const { expression } = statement;
      if (expression.kind !== 'CallExpression' && expression.kind !== 'NewExpression') {
        this.error(
          'this expression does nothing: only function calls can be used as statements',
          expression.start,
          expression.end,
        );
      }
    }
    this.endStatement();
    return statement;
  }

  /** Parses a declaration if the current token starts one, otherwise returns `undefined`. */
  private parseDeclaration(start: number, exported: boolean): ast.Statement | undefined {
    switch (this.peek().kind) {
      case 'func':
        // `func(...)` without a name is a function literal, e.g. one that is called right away.
        if (this.peek(1).kind !== 'Identifier') return undefined;
        return this.parseFuncDeclaration(start, exported);
      case 'let':
      case 'const': {
        const declaration = this.parseVariableDeclaration(start, exported);
        this.endStatement();
        return declaration;
      }
      case 'class':
        return this.parseClass(start, exported);
      case 'interface':
        return this.parseInterface(start, exported);
      case 'type': {
        const declaration = this.parseTypeAlias(start, exported);
        this.endStatement();
        return declaration;
      }
      default:
        return undefined;
    }
  }

  /** A statement ends with a newline or `;`, or right before the `}` that closes its block. */
  private endStatement(): void {
    if (this.accept(';') || this.check('}') || this.check('EOF')) return;
    const token = this.peek();
    if (token.kind === '++' || token.kind === '--') {
      this.fail(`"${token.kind}" is a statement and cannot be used inside an expression`);
    }
    this.fail(`expected newline or ";" after statement, found ${describe(token)}`);
  }

  /** `x := 1` is a common habit from Go. */
  private rejectColonEquals(): void {
    const colon = this.peek();
    const equals = this.peek(1);
    if (colon.kind === ':' && equals.kind === '=' && equals.start === colon.end) {
      this.fail('":=" is not supported: declare variables with "let" or "const"');
    }
  }

  /** Statements allowed in `for` headers: declarations, assignments, `i++` and expressions. */
  private parseSimpleStatement(): ast.SimpleStatement {
    const start = this.peek().start;
    if (this.check('let') || this.check('const'))
      return this.parseVariableDeclaration(start, false);

    const first = this.parseExpression();
    this.rejectColonEquals();

    if (this.check(',') || isAssignmentOperator(this.peek().kind)) {
      const targets = [first];
      while (this.accept(',')) targets.push(this.parseExpression());
      this.rejectColonEquals();
      const operator = this.peek().kind;
      if (!isAssignmentOperator(operator)) {
        return this.fail(`expected "=", found ${describe(this.peek())}`);
      }
      this.next();
      if (operator !== '=' && targets.length > 1) {
        this.error(`"${operator}" works with a single variable`, start, this.span(start).end);
      }
      for (const target of targets) this.checkAssignable(target);
      const values = this.parseExpressionList();
      this.checkArity(targets.length, values, start);
      return { kind: 'AssignmentStatement', operator, targets, values, ...this.span(start) };
    }

    if (this.check('++') || this.check('--')) {
      const operator = this.next().kind === '++' ? '++' : '--';
      this.checkAssignable(first);
      return { kind: 'IncDecStatement', operator, target: first, ...this.span(start) };
    }

    return { kind: 'ExpressionStatement', expression: first, ...this.span(start) };
  }

  private checkAssignable(target: ast.Expression): void {
    const assignable =
      target.kind === 'Identifier' ||
      ((target.kind === 'MemberExpression' || target.kind === 'IndexExpression') &&
        !target.optional);
    if (!assignable) this.error('cannot assign to this expression', target.start, target.end);
  }

  /** `a, b = 1, 2, 3`: the counts must match, unless a single call returns all the values. */
  private checkArity(targets: number, values: ast.Expression[], start: number): void {
    if (values.length === 0 || values.length === targets) return;
    if (values.length === 1 && values[0]!.kind === 'CallExpression') return;
    this.error(
      `assignment mismatch: ${plural(targets, 'variable')} but ${plural(values.length, 'value')}`,
      start,
      this.span(start).end,
    );
  }

  private parseExpressionList(): ast.Expression[] {
    const expressions = [this.parseExpression()];
    while (this.accept(',')) expressions.push(this.parseExpression());
    return expressions;
  }

  private parseVariableDeclaration(start: number, exported: boolean): ast.VariableDeclaration {
    const keyword = this.next().kind === 'const' ? 'const' : 'let';
    const names = [this.parseIdentifier('variable name')];
    while (this.accept(',')) names.push(this.parseIdentifier('variable name'));
    const type = this.canStartType() ? this.parseType() : null;
    const values = this.accept('=') ? this.parseExpressionList() : [];
    const { end } = this.span(start);

    if (values.length === 0 && type === null) {
      this.error(`"${names[0]!.name}" needs a type or a value`, start, end);
    } else if (values.length === 0 && keyword === 'const') {
      this.error('constants need a value', start, end);
    }
    this.checkArity(names.length, values, start);
    return { kind: 'VariableDeclaration', exported, keyword, names, type, values, start, end };
  }

  private parseBlock(): ast.BlockStatement {
    const start = this.expect('{').start;
    const body = this.withContext({ topLevel: false, noObjectLiteral: false }, () =>
      this.parseStatements(() => this.check('}')),
    );
    this.expect('}');
    return { kind: 'BlockStatement', body, ...this.span(start) };
  }

  private parseFunctionBody(): ast.BlockStatement {
    return this.withContext(FUNCTION_BODY, () => this.parseBlock());
  }

  /** An if/for/switch header, where `{` starts the block rather than an object literal. */
  private parseHeaderExpression(): ast.Expression {
    return this.withContext({ noObjectLiteral: true }, () => this.parseExpression());
  }

  private parseReturn(): ast.ReturnStatement {
    const start = this.next().start;
    if (!this.context.inFunction) {
      this.error('"return" outside of a function', start, this.span(start).end);
    } else if (this.context.inDefer) {
      this.error('"return" is not allowed inside "defer"', start, this.span(start).end);
    }
    const values =
      this.check(';') || this.check('}') || this.check('EOF') ? [] : this.parseExpressionList();
    const statement: ast.ReturnStatement = { kind: 'ReturnStatement', values, ...this.span(start) };
    this.endStatement();
    return statement;
  }

  /** `}` + newline + `else`: the newline ends the `if`, so explain the error instead of failing. */
  private checkSameLine(keyword: 'else' | 'catch' | 'finally'): void {
    if (this.isImplicitSemicolon() && this.peek(1).kind === keyword) {
      const token = this.peek(1);
      this.error(
        `"${keyword}" must be on the same line as the closing "}"`,
        token.start,
        token.end,
      );
      this.next();
    }
  }

  private parseIf(): ast.IfStatement {
    const start = this.next().start;
    const condition = this.parseHeaderExpression();
    const consequent = this.parseBlock();
    let alternate: ast.BlockStatement | ast.IfStatement | null = null;
    this.checkSameLine('else');
    if (this.accept('else')) {
      alternate = this.check('if') ? this.parseIf() : this.parseBlock();
    }
    return { kind: 'IfStatement', condition, consequent, alternate, ...this.span(start) };
  }

  private parseFor(): ast.ForStatement | ast.ForInStatement {
    const start = this.next().start;
    if (this.isForInHeader()) return this.parseForIn(start);
    const [init, condition, update] = this.withContext({ noObjectLiteral: true }, () =>
      this.parseForHeader(),
    );
    const body = this.parseLoopBody();
    return { kind: 'ForStatement', init, condition, update, body, ...this.span(start) };
  }

  /** `for x in` or `for i, x in`. */
  private isForInHeader(): boolean {
    if (!this.check('Identifier')) return false;
    if (this.peek(1).kind === 'in') return true;
    return (
      this.peek(1).kind === ',' && this.peek(2).kind === 'Identifier' && this.peek(3).kind === 'in'
    );
  }

  /** `{` (infinite loop), `cond {`, or `init; cond; update {`. */
  private parseForHeader(): [
    ast.SimpleStatement | null,
    ast.Expression | null,
    ast.SimpleStatement | null,
  ] {
    if (this.check('{')) return [null, null, null];
    const init = this.check(';') ? null : this.parseSimpleStatement();
    if (init?.kind === 'ExpressionStatement' && this.check('{')) {
      return [null, init.expression, null];
    }
    this.expect(';', '";" or "{"');
    const condition = this.check(';') ? null : this.parseExpression();
    this.expect(';');
    const update = this.check('{') ? null : this.parseSimpleStatement();
    return [init, condition, update];
  }

  private parseForIn(start: number): ast.ForInStatement {
    let key: ast.Identifier | null = null;
    let value = this.parseIdentifier('loop variable');
    if (this.accept(',')) {
      key = value;
      value = this.parseIdentifier('loop variable');
    }
    this.expect('in');
    const iterable = this.parseHeaderExpression();
    const body = this.parseLoopBody();
    return { kind: 'ForInStatement', key, value, iterable, body, ...this.span(start) };
  }

  private parseLoopBody(): ast.BlockStatement {
    return this.withContext({ inLoop: true, inBreakable: true }, () => this.parseBlock());
  }

  private parseSwitch(): ast.SwitchStatement {
    const start = this.next().start;
    const discriminant = this.check('{') ? null : this.parseHeaderExpression();
    this.expect('{');
    const cases: ast.SwitchCase[] = [];
    let hasDefault = false;
    while (!this.check('}') && !this.check('EOF')) {
      if (this.accept(';')) continue;
      const caseStart = this.peek().start;
      let tests: ast.Expression[] = [];
      if (this.accept('default')) {
        if (hasDefault) {
          this.error('multiple "default" cases in switch', caseStart, this.span(caseStart).end);
        }
        hasDefault = true;
      } else {
        this.expect('case', '"case", "default" or "}"');
        tests = this.parseExpressionList();
      }
      this.expect(':');
      const body = this.withContext({ topLevel: false, inBreakable: true }, () =>
        this.parseStatements(() => this.check('case') || this.check('default') || this.check('}')),
      );
      cases.push({ kind: 'SwitchCase', tests, body, ...this.span(caseStart) });
    }
    this.expect('}');
    return { kind: 'SwitchStatement', discriminant, cases, ...this.span(start) };
  }

  private parseBreakOrContinue(): ast.BreakStatement | ast.ContinueStatement {
    const token = this.next();
    let statement: ast.BreakStatement | ast.ContinueStatement;
    if (token.kind === 'break') {
      if (!this.context.inBreakable) {
        this.error('"break" outside of a loop or switch', token.start, token.end);
      }
      statement = { kind: 'BreakStatement', start: token.start, end: token.end };
    } else {
      if (!this.context.inLoop) this.error('"continue" outside of a loop', token.start, token.end);
      statement = { kind: 'ContinueStatement', start: token.start, end: token.end };
    }
    this.endStatement();
    return statement;
  }

  private parseThrow(): ast.ThrowStatement {
    const start = this.next().start;
    const argument = this.parseExpression();
    const statement: ast.ThrowStatement = { kind: 'ThrowStatement', argument, ...this.span(start) };
    this.endStatement();
    return statement;
  }

  private parseTry(): ast.TryStatement {
    const start = this.next().start;
    const block = this.parseBlock();
    let handler: ast.CatchClause | null = null;
    let finalizer: ast.BlockStatement | null = null;

    this.checkSameLine('catch');
    if (this.check('catch')) {
      const catchStart = this.next().start;
      if (this.check('(')) this.fail('write "catch e {" without parentheses');
      const param = this.check('Identifier') ? this.parseIdentifier() : null;
      const body = this.parseBlock();
      handler = { kind: 'CatchClause', param, body, ...this.span(catchStart) };
    }

    this.checkSameLine('finally');
    if (this.accept('finally')) finalizer = this.parseBlock();

    if (handler === null && finalizer === null) {
      this.error('"try" needs a "catch" or "finally" block', start, block.start);
    }
    return { kind: 'TryStatement', block, handler, finalizer, ...this.span(start) };
  }

  private parseDefer(): ast.DeferStatement {
    const start = this.next().start;
    if (!this.context.inFunction) {
      this.error('"defer" outside of a function', start, this.span(start).end);
    }
    if (this.check('{')) {
      const body = this.withContext({ inDefer: true, inLoop: false, inBreakable: false }, () =>
        this.parseBlock(),
      );
      return { kind: 'DeferStatement', body, ...this.span(start) };
    }
    const call = this.parseExpression();
    if (call.kind !== 'CallExpression') {
      this.failAt('"defer" needs a function call or a block', call.start, call.end);
    }
    const statement: ast.DeferStatement = {
      kind: 'DeferStatement',
      body: call,
      ...this.span(start),
    };
    this.endStatement();
    return statement;
  }

  // ─── Modules ───────────────────────────────────────────────────────────────────────────────────

  private parseImport(): ast.ImportDeclaration {
    const start = this.next().start;
    if (!this.context.topLevel) {
      this.error(
        'imports are only allowed at the top level of a module',
        start,
        this.span(start).end,
      );
    }
    let defaultImport: ast.Identifier | null = null;
    let namespaceImport: ast.Identifier | null = null;
    let namedImports: ast.ImportSpecifier[] = [];

    if (!this.check('String')) {
      const hasDefault = this.check('Identifier');
      if (hasDefault) defaultImport = this.parseIdentifier('import name');
      if (!hasDefault || this.accept(',')) {
        if (this.accept('*')) {
          this.expectWord('as');
          namespaceImport = this.parseIdentifier('namespace name');
        } else {
          this.expect('{', '"{", "*" or a name');
          namedImports = this.parseList('}', () => this.parseImportSpecifier());
        }
      }
      this.expectWord('from');
    }

    const source = this.parseStringLiteral('module path');
    const declaration: ast.ImportDeclaration = {
      kind: 'ImportDeclaration',
      defaultImport,
      namespaceImport,
      namedImports,
      source,
      ...this.span(start),
    };
    this.endStatement();
    return declaration;
  }

  private parseImportSpecifier(): ast.ImportSpecifier {
    const token = this.peek();
    const imported = this.parsePropertyName('import name');
    let local = imported;
    if (this.acceptWord('as')) {
      local = this.parseIdentifier('import name');
    } else if (token.kind !== 'Identifier') {
      this.error(`"${token.text}" is a keyword: rename it with "as"`, token.start, token.end);
    }
    return { kind: 'ImportSpecifier', imported, local, ...this.span(token.start) };
  }

  private parseExport(): ast.Statement {
    const start = this.next().start;
    if (!this.context.topLevel) {
      this.error(
        '"export" is only allowed at the top level of a module',
        start,
        this.span(start).end,
      );
    }
    return (
      this.parseDeclaration(start, true) ??
      this.fail(`expected a declaration after "export", found ${describe(this.peek())}`)
    );
  }

  // ─── Declarations ──────────────────────────────────────────────────────────────────────────────

  private parseFuncDeclaration(start: number, exported: boolean): ast.FuncDeclaration {
    this.expect('func');
    const name = this.parseIdentifier('function name');
    const params = this.parseParams(false);
    const results = this.parseResults();
    const body = this.parseFunctionBody();
    return { kind: 'FuncDeclaration', exported, name, params, results, body, ...this.span(start) };
  }

  /**
   * `(a, b number, c string)`. Names without a type take the type of the next typed name, as in
   * Go; only arrow functions may leave types out entirely.
   */
  private parseParams(typesOptional: boolean): ast.Parameter[] {
    this.expect('(');
    const params: ast.Parameter[] = [];
    let untyped = 0;
    while (!this.check(')')) {
      const name = this.parseIdentifier('parameter name');
      const type = this.canStartType() ? this.parseType() : null;
      params.push({ kind: 'Parameter', name, type, ...this.span(name.start) });
      if (type === null) {
        untyped++;
      } else {
        for (const param of params.slice(params.length - 1 - untyped)) param.type = type;
        untyped = 0;
      }
      if (!this.accept(',')) break;
    }
    this.expect(')');
    if (untyped > 0 && !typesOptional) {
      const param = params[params.length - untyped]!;
      this.error(`missing type for parameter "${param.name.name}"`, param.start, param.end);
    }
    return params;
  }

  /** Result types after a parameter list: nothing, `T`, or `(T1, T2)`. */
  private parseResults(): ast.TypeNode[] {
    if (this.accept('(')) return this.parseList(')', () => this.parseType());
    // `{` after the parameters starts the body, so an object result type needs parentheses.
    if (this.canStartType() && !this.check('{')) return [this.parseType()];
    return [];
  }

  private parseClass(start: number, exported: boolean): ast.ClassDeclaration {
    this.expect('class');
    const name = this.parseIdentifier('class name');

    let superClass: ast.Expression | null = null;
    if (this.accept('extends')) {
      superClass = this.withContext({ noObjectLiteral: true }, () =>
        this.parsePostfix(this.parsePrimary()),
      );
    }

    const interfaces: ast.TypeReference[] = [];
    if (this.acceptWord('implements')) {
      do {
        const interfaceName = this.parseIdentifier('interface name');
        interfaces.push({
          kind: 'TypeReference',
          name: interfaceName,
          ...this.span(interfaceName.start),
        });
      } while (this.accept(','));
    }

    this.expect('{');
    const members: ast.ClassMember[] = [];
    this.withContext({ topLevel: false }, () => {
      this.parseSeparated(
        () => this.check('}'),
        () => {
          members.push(...this.parseClassMember());
        },
      );
    });
    this.expect('}');
    return {
      kind: 'ClassDeclaration',
      exported,
      name,
      superClass,
      implements: interfaces,
      members,
      ...this.span(start),
    };
  }

  private parseClassMember(): ast.ClassMember[] {
    const start = this.peek().start;
    let visibility: ast.Visibility | null = null;
    let isStatic = false;

    // Modifiers are contextual: `static` is a modifier only when a member name follows it.
    while (this.peek().kind === 'Identifier' && MODIFIERS.has(this.peek().text)) {
      const following = this.peek(1);
      if (following.kind !== 'Identifier' && !isKeyword(following.kind)) break;
      const modifier = this.next();
      if (modifier.text === 'static') {
        if (isStatic) this.error('duplicate "static" modifier', modifier.start, modifier.end);
        isStatic = true;
      } else {
        if (visibility) this.error('duplicate visibility modifier', modifier.start, modifier.end);
        visibility = modifier.text as ast.Visibility;
      }
    }

    if (this.checkWord('constructor') && this.peek(1).kind === '(') {
      this.next();
      if (isStatic) this.error('constructors cannot be static', start, this.span(start).end);
      const params = this.parseParams(false);
      const resultsStart = this.peek().start;
      if (this.parseResults().length > 0) {
        this.error('constructors cannot have result types', resultsStart, this.span(start).end);
      }
      const body = this.parseFunctionBody();
      return [
        {
          kind: 'ConstructorDeclaration',
          visibility: visibility ?? 'public',
          params,
          body,
          ...this.span(start),
        },
      ];
    }

    const name = this.parsePropertyName('member name');
    if (this.check('(')) {
      const params = this.parseParams(false);
      const results = this.parseResults();
      const body = this.parseFunctionBody();
      return [
        {
          kind: 'MethodDeclaration',
          visibility: visibility ?? 'public',
          isStatic,
          name,
          params,
          results,
          body,
          ...this.span(start),
        },
      ];
    }

    // Fields: `name string`, `count = 0`, `x, y number`.
    const names = [name];
    while (this.accept(',')) names.push(this.parsePropertyName('field name'));
    const type = this.canStartType() ? this.parseType() : null;
    const value = this.accept('=') ? this.parseExpression() : null;
    const span = this.span(start);
    if (type === null && value === null) {
      this.error(`field "${name.name}" needs a type or a value`, span.start, span.end);
    } else if (names.length > 1 && value !== null) {
      this.error('a value can only be given to a single field', span.start, span.end);
    }
    this.endStatement();
    return names.map((fieldName): ast.FieldDeclaration => ({
      kind: 'FieldDeclaration',
      visibility: visibility ?? 'public',
      isStatic,
      name: fieldName,
      type,
      value,
      ...span,
    }));
  }

  private parseInterface(start: number, exported: boolean): ast.InterfaceDeclaration {
    this.expect('interface');
    const name = this.parseIdentifier('interface name');
    const members = this.parseTypeMembers();
    return { kind: 'InterfaceDeclaration', exported, name, members, ...this.span(start) };
  }

  private parseTypeAlias(start: number, exported: boolean): ast.TypeAliasDeclaration {
    this.expect('type');
    const name = this.parseIdentifier('type name');
    const type = this.parseType();
    return { kind: 'TypeAliasDeclaration', exported, name, type, ...this.span(start) };
  }

  // ─── Types ─────────────────────────────────────────────────────────────────────────────────────

  private canStartType(): boolean {
    const kind = this.peek().kind;
    return kind === 'Identifier' || kind === '[' || kind === '?' || kind === 'func' || kind === '{';
  }

  private parseType(): ast.TypeNode {
    const start = this.peek().start;
    switch (this.peek().kind) {
      case '?': {
        this.next();
        const type = this.parseType();
        return { kind: 'NullableType', type, ...this.span(start) };
      }
      case '[': {
        this.next();
        this.expect(']', '"]" (array types are written as []T)');
        const element = this.parseType();
        return { kind: 'ArrayType', element, ...this.span(start) };
      }
      case 'func': {
        this.next();
        this.expect('(');
        const params = this.parseList(')', () => this.parseType());
        const results = this.parseResults();
        return { kind: 'FuncType', params, results, ...this.span(start) };
      }
      case '{': {
        const members = this.parseTypeMembers();
        return { kind: 'ObjectType', members, ...this.span(start) };
      }
      default: {
        const name = this.parseIdentifier('type');
        return { kind: 'TypeReference', name, ...this.span(start) };
      }
    }
  }

  /** `{ name string; x, y number; area() number }`, separated by newlines, `;` or `,`. */
  private parseTypeMembers(): ast.TypeMember[] {
    this.expect('{');
    const members: ast.TypeMember[] = [];
    this.parseSeparated(
      () => this.check('}'),
      () => {
        members.push(...this.parseTypeMember());
        if (!this.accept(',') && !this.accept(';') && !this.check('}')) {
          this.fail(`expected newline, ";" or "}" after member, found ${describe(this.peek())}`);
        }
      },
    );
    this.expect('}');
    return members;
  }

  private parseTypeMember(): ast.TypeMember[] {
    const start = this.peek().start;
    const name = this.parsePropertyName('member name');
    if (this.check('(')) {
      const params = this.parseParams(false);
      const results = this.parseResults();
      return [{ kind: 'MethodSignature', name, params, results, ...this.span(start) }];
    }
    // `x, y number` declares several properties of the same type.
    const names = [name];
    while (this.accept(',')) names.push(this.parsePropertyName('member name'));
    const type = this.parseType();
    return names.map((memberName): ast.PropertySignature => ({
      kind: 'PropertySignature',
      name: memberName,
      type,
      start: memberName.start,
      end: type.end,
    }));
  }

  // ─── Expressions ───────────────────────────────────────────────────────────────────────────────

  private parseExpression(): ast.Expression {
    const test = this.parseBinary(1);
    if (!this.accept('?')) return test;
    const consequent = this.parseExpression();
    this.expect(':');
    const alternate = this.parseExpression();
    return {
      kind: 'ConditionalExpression',
      test,
      consequent,
      alternate,
      start: test.start,
      end: alternate.end,
    };
  }

  /** Precedence climbing: parses operators that bind at least as tight as `minPrecedence`. */
  private parseBinary(minPrecedence: number): ast.Expression {
    let left = this.parseUnary();
    for (;;) {
      const operator = this.peek().kind;
      if (!isBinaryOperator(operator)) return left;
      const precedence = BINARY_PRECEDENCE[operator];
      if (precedence < minPrecedence) return left;
      this.next();
      // `**` is right-associative, all other binary operators are left-associative.
      const right = this.parseBinary(operator === '**' ? precedence : precedence + 1);
      left = this.makeBinary(operator, left, right);
    }
  }

  /** Rejects combinations that JS forbids without parentheses, since the output must be valid JS. */
  private makeBinary(
    operator: ast.BinaryOperator,
    left: ast.Expression,
    right: ast.Expression,
  ): ast.BinaryExpression {
    if (operator === '??') {
      for (const operand of [left, right]) {
        if (
          operand.kind === 'BinaryExpression' &&
          (operand.operator === '||' || operand.operator === '&&') &&
          !this.parenthesized.has(operand)
        ) {
          this.error(
            '"??" cannot be mixed with "||" or "&&" without parentheses',
            operand.start,
            operand.end,
          );
        }
      }
    }
    if (operator === '**' && left.kind === 'UnaryExpression' && !this.parenthesized.has(left)) {
      this.error(
        'wrap the unary expression in parentheses: "(-a) ** b" or "-(a ** b)"',
        left.start,
        left.end,
      );
    }
    return { kind: 'BinaryExpression', operator, left, right, start: left.start, end: right.end };
  }

  private parseUnary(): ast.Expression {
    const token = this.peek();
    if (isUnaryOperator(token.kind)) {
      const operator = token.kind;
      this.next();
      const argument = this.parseUnary();
      return { kind: 'UnaryExpression', operator, argument, start: token.start, end: argument.end };
    }
    if (token.kind === '++' || token.kind === '--') {
      this.fail(`"${token.kind}" must follow the variable: "i${token.kind}"`);
    }
    return this.parsePostfix(this.parsePrimary());
  }

  /** Member access, indexing and calls: `a.b`, `a?.b`, `a[i]`, `a?.[i]`, `f(x)`, `f?.(x)`. */
  private parsePostfix(expression: ast.Expression): ast.Expression {
    for (;;) {
      const start = expression.start;
      if (this.accept('.')) {
        const property = this.parsePropertyName();
        expression = {
          kind: 'MemberExpression',
          object: expression,
          property,
          optional: false,
          ...this.span(start),
        };
      } else if (this.accept('?.')) {
        if (this.check('(')) {
          const args = this.parseArguments();
          expression = {
            kind: 'CallExpression',
            callee: expression,
            arguments: args,
            optional: true,
            ...this.span(start),
          };
        } else if (this.accept('[')) {
          const index = this.nested(() => this.parseExpression());
          this.expect(']');
          expression = {
            kind: 'IndexExpression',
            object: expression,
            index,
            optional: true,
            ...this.span(start),
          };
        } else {
          const property = this.parsePropertyName();
          expression = {
            kind: 'MemberExpression',
            object: expression,
            property,
            optional: true,
            ...this.span(start),
          };
        }
      } else if (this.check('(')) {
        const args = this.parseArguments();
        expression = {
          kind: 'CallExpression',
          callee: expression,
          arguments: args,
          optional: false,
          ...this.span(start),
        };
      } else if (this.accept('[')) {
        const index = this.nested(() => this.parseExpression());
        this.expect(']');
        expression = {
          kind: 'IndexExpression',
          object: expression,
          index,
          optional: false,
          ...this.span(start),
        };
      } else {
        return expression;
      }
    }
  }

  private parsePrimary(): ast.Expression {
    const token = this.peek();
    const { start, end } = token;
    switch (token.kind) {
      case 'Identifier':
        if (this.peek(1).kind === '=>') return this.parseArrowFunction();
        this.next();
        return { kind: 'Identifier', name: token.text, start, end };
      case 'Number':
        this.next();
        return { kind: 'NumberLiteral', value: token.value, raw: token.text, start, end };
      case 'String':
        return this.parseStringLiteral();
      case 'Template':
      case 'TemplateHead':
        return this.parseTemplate(token);
      case 'true':
      case 'false':
        this.next();
        return { kind: 'BooleanLiteral', value: token.kind === 'true', start, end };
      case 'null':
        this.next();
        return { kind: 'NullLiteral', start, end };
      case 'this':
        this.next();
        return { kind: 'ThisExpression', start, end };
      case 'super':
        this.next();
        if (!this.check('(') && !this.check('.'))
          this.fail('"super" must be followed by "(" or "."');
        return { kind: 'SuperExpression', start, end };
      case '(':
        return this.isArrowFunctionAhead() ? this.parseArrowFunction() : this.parseParenthesized();
      case '[':
        return this.parseArrayLiteral();
      case '{':
        if (this.context.noObjectLiteral) {
          this.fail('expected expression, found "{" (wrap object literals in parentheses here)');
        }
        return this.parseObjectLiteral();
      case 'func':
        return this.parseFuncExpression();
      case 'new':
        return this.parseNew();
      default:
        if (RESERVED.has(token.kind)) this.fail(`"${token.text}" is reserved for future use`);
        return this.fail(`expected expression, found ${describe(token)}`);
    }
  }

  /** Whether the `(` at the current position opens arrow function parameters: `(...) =>`. */
  private isArrowFunctionAhead(): boolean {
    let depth = 0;
    for (let i = this.pos; i < this.tokens.length; i++) {
      const kind = this.tokens[i]!.kind;
      if (kind === '(' || kind === '[' || kind === '{') {
        depth++;
      } else if (kind === ')' || kind === ']' || kind === '}') {
        depth--;
        if (depth === 0) return this.tokens[i + 1]?.kind === '=>';
      } else if (kind === 'EOF') {
        return false;
      }
    }
    return false;
  }

  private parseArrowFunction(): ast.ArrowFunction {
    const start = this.peek().start;
    let params: ast.Parameter[];
    if (this.check('Identifier')) {
      const name = this.parseIdentifier();
      params = [{ kind: 'Parameter', name, type: null, start: name.start, end: name.end }];
    } else {
      params = this.parseParams(true);
    }
    this.expect('=>');
    const body = this.withContext(FUNCTION_BODY, () =>
      this.check('{') ? this.parseBlock() : this.parseExpression(),
    );
    return { kind: 'ArrowFunction', params, body, ...this.span(start) };
  }

  private parseParenthesized(): ast.Expression {
    this.expect('(');
    const expression = this.nested(() => this.parseExpression());
    this.expect(')');
    this.parenthesized.add(expression);
    return expression;
  }

  private parseFuncExpression(): ast.FuncExpression {
    const start = this.expect('func').start;
    const params = this.parseParams(false);
    const results = this.parseResults();
    const body = this.parseFunctionBody();
    return { kind: 'FuncExpression', params, results, body, ...this.span(start) };
  }

  private parseNew(): ast.NewExpression {
    const start = this.expect('new').start;
    // The class is a name or a member chain (`new ns.User()`); the parentheses are the arguments.
    let callee = this.parsePrimary();
    while (this.accept('.')) {
      const property = this.parsePropertyName();
      callee = {
        kind: 'MemberExpression',
        object: callee,
        property,
        optional: false,
        ...this.span(callee.start),
      };
    }
    const args = this.check('(') ? this.parseArguments() : [];
    return { kind: 'NewExpression', callee, arguments: args, ...this.span(start) };
  }

  private parseArguments(): (ast.Expression | ast.SpreadElement)[] {
    this.expect('(');
    return this.nested(() => this.parseList(')', () => this.parseElement()));
  }

  /** An expression or `...spread` in array literals and call arguments. */
  private parseElement(): ast.Expression | ast.SpreadElement {
    if (!this.check('...')) return this.parseExpression();
    const start = this.next().start;
    const argument = this.parseExpression();
    return { kind: 'SpreadElement', argument, ...this.span(start) };
  }

  private parseArrayLiteral(): ast.ArrayLiteral {
    const start = this.expect('[').start;
    const elements = this.nested(() => this.parseList(']', () => this.parseElement()));
    return { kind: 'ArrayLiteral', elements, ...this.span(start) };
  }

  private parseObjectLiteral(): ast.ObjectLiteral {
    const start = this.expect('{').start;
    const properties = this.nested(() => this.parseList('}', () => this.parseProperty()));
    return { kind: 'ObjectLiteral', properties, ...this.span(start) };
  }

  private parseProperty(): ast.Property | ast.SpreadElement {
    const token = this.peek();
    if (token.kind === '...') return this.parseElement() as ast.SpreadElement;
    const key = token.kind === 'String' ? this.parseStringLiteral() : this.parsePropertyName();
    if (this.accept(':')) {
      const value = this.parseExpression();
      return { kind: 'Property', key, value, shorthand: false, ...this.span(token.start) };
    }
    // Shorthand `{ name }` means `{ name: name }`, so the key must be a plain name.
    if (key.kind !== 'Identifier' || token.kind !== 'Identifier') {
      this.fail(`expected ":" after property name, found ${describe(this.peek())}`);
    }
    return { kind: 'Property', key, value: { ...key }, shorthand: true, ...this.span(token.start) };
  }

  private parseTemplate(first: StringToken): ast.TemplateLiteral {
    this.next();
    const quasis = [templateElement(first)];
    const expressions: ast.Expression[] = [];
    if (first.kind === 'TemplateHead') {
      for (;;) {
        expressions.push(this.nested(() => this.parseExpression()));
        const part = this.peek();
        if (part.kind !== 'TemplateMiddle' && part.kind !== 'TemplateTail') {
          this.fail(`expected "}" to close the template substitution, found ${describe(part)}`);
        }
        this.next();
        quasis.push(templateElement(part));
        if (part.kind === 'TemplateTail') break;
      }
    }
    return { kind: 'TemplateLiteral', quasis, expressions, ...this.span(first.start) };
  }

  /** Parses `item, item, ...` up to `close`, which is consumed. A trailing comma is allowed. */
  private parseList<T>(close: TokenKind, parseItem: () => T): T[] {
    const items: T[] = [];
    while (!this.check(close)) {
      items.push(parseItem());
      if (!this.accept(',')) break;
    }
    this.expect(close);
    return items;
  }

  private parseIdentifier(what = 'name'): ast.Identifier {
    const token = this.peek();
    if (token.kind !== 'Identifier') this.fail(`expected ${what}, found ${describe(token)}`);
    this.next();
    return { kind: 'Identifier', name: token.text, start: token.start, end: token.end };
  }

  /** Names after `.`, object keys and member names, where keywords are allowed too. */
  private parsePropertyName(what = 'property name'): ast.Identifier {
    const token = this.peek();
    if (token.kind !== 'Identifier' && !isKeyword(token.kind)) {
      this.fail(`expected ${what}, found ${describe(token)}`);
    }
    this.next();
    return { kind: 'Identifier', name: token.text, start: token.start, end: token.end };
  }

  private parseStringLiteral(what = 'string'): ast.StringLiteral {
    const token = this.peek();
    if (token.kind !== 'String') this.fail(`expected ${what}, found ${describe(token)}`);
    this.next();
    return {
      kind: 'StringLiteral',
      value: token.value,
      raw: token.text,
      start: token.start,
      end: token.end,
    };
  }
}
