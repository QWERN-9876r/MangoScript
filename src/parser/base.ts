import type * as ast from '../ast.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { StringToken, Token, TokenKind } from '../lexer/token.ts';
import { STATEMENT_KEYWORDS, BRACKETS, type Context, ParseError, describe } from './syntax.ts';

// The parser is a chain of layers, one per area: base → statements → control flow → declarations →
// classes → types → expressions → literals → markup → Parser (parser.ts). Statements, expressions
// and markup contain each other, so methods of later layers that earlier ones call are declared
// here as abstract.
//
// This layer reads tokens, reports errors and recovers from them.

export abstract class ParserBase {
  // Implemented by later layers: the checking of statements, expressions and markup calls each other.

  protected abstract parseBreakOrContinue(): ast.BreakStatement | ast.ContinueStatement;

  protected abstract parseDefer(): ast.DeferStatement;

  protected abstract parseFor(): ast.ForStatement | ast.ForInStatement;

  protected abstract parseIf(): ast.IfStatement;

  protected abstract parseSwitch(): ast.SwitchStatement;

  protected abstract parseThrow(): ast.ThrowStatement;

  protected abstract parseTry(): ast.TryStatement;

  protected abstract parseComponent(
    start: number,
    exported: boolean,
    htmlTag?: ast.HtmlTag | null,
  ): ast.ComponentDeclaration;

  protected abstract parseHtmlTag(): ast.HtmlTag;

  protected abstract parseExport(): ast.Statement;

  protected abstract parseFuncDeclaration(start: number, exported: boolean): ast.FuncDeclaration;

  protected abstract parseImport(): ast.ImportDeclaration;

  protected abstract parseClass(start: number, exported: boolean): ast.ClassDeclaration;

  protected abstract parseInterface(start: number, exported: boolean): ast.InterfaceDeclaration;

  protected abstract parseTypeAlias(start: number, exported: boolean): ast.TypeAliasDeclaration;

  protected abstract canStartType(): boolean;

  protected abstract parseType(): ast.TypeNode;

  protected abstract parseTypeArgs(): ast.TypeNode[];

  protected abstract parseTypeMembers(): ast.TypeMember[];

  protected abstract parseExpression(): ast.Expression;

  protected abstract parsePostfix(expression: ast.Expression): ast.Expression;

  protected abstract parsePrimary(): ast.Expression;

  protected abstract isArrowFunctionAhead(): boolean;

  protected abstract parseArguments(): (ast.Expression | ast.SpreadElement)[];

  protected abstract parseArrayLiteral(): ast.ArrayLiteral;

  protected abstract parseArrowFunction(): ast.ArrowFunction;

  protected abstract parseFuncExpression(): ast.FuncExpression;

  protected abstract parseIdentifier(what?: string): ast.Identifier;

  protected abstract parseList<T>(close: TokenKind, parseItem: () => T): T[];

  protected abstract parseNew(): ast.NewExpression;

  protected abstract parseObjectLiteral(): ast.ObjectLiteral;

  protected abstract parseParenthesized(): ast.Expression;

  protected abstract parsePropertyName(what?: string): ast.Identifier;

  protected abstract parseTemplate(first: StringToken): ast.TemplateLiteral;

  protected abstract parseJsxElement(): ast.ElementExpression;

  protected abstract parseStringLiteral(what?: string): ast.StringLiteral;

  readonly diagnostics: Diagnostic[] = [];

  protected readonly tokens: Token[];

  protected pos = 0;

  protected context: Context = {
    topLevel: true,
    inFunction: false,
    inLoop: false,
    inBreakable: false,
    inDefer: false,
    noObjectLiteral: false,
    inComponent: false,
    inMarkup: false,
  };

  /** Expressions written in parentheses, which the tree itself does not record. */
  protected readonly parenthesized = new WeakSet<ast.Expression>();

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  protected peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  protected check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** Whether the current token is the word `word`, e.g. the contextual keyword `from`. */
  protected checkWord(word: string): boolean {
    const token = this.peek();
    return token.kind === 'Identifier' && token.text === word;
  }

  protected next(): Token {
    const token = this.peek();
    if (token.kind !== 'EOF') this.pos++;
    return token;
  }

  protected accept(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.next();
    return true;
  }

  protected acceptWord(word: string): boolean {
    if (!this.checkWord(word)) return false;
    this.next();
    return true;
  }

  protected expect(kind: TokenKind, what = `"${kind}"`): Token {
    if (this.check(kind)) return this.next();
    return this.fail(`expected ${what}, found ${describe(this.peek())}`);
  }

  protected expectWord(word: string): void {
    if (!this.acceptWord(word)) this.fail(`expected "${word}", found ${describe(this.peek())}`);
  }

  protected isImplicitSemicolon(): boolean {
    const token = this.peek();
    return token.kind === ';' && token.text === '';
  }

  /** Start and end of a node that began at `start` and ends with the last consumed token. */
  protected span(start: number): ast.NodeBase {
    return { start, end: this.tokens[this.pos - 1]?.end ?? start };
  }

  /** Reports an error unless one was already reported at the same position. */
  protected error(message: string, start: number, end: number): void {
    if (this.diagnostics.some((d) => d.start === start)) return;
    this.diagnostics.push({ message, start, end });
  }

  /** Reports an error at the current token and abandons the current statement. */
  protected fail(message: string): never {
    const token = this.peek();
    return this.failAt(message, token.start, token.end);
  }

  protected failAt(message: string, start: number, end: number): never {
    this.error(message, start, end);
    throw new ParseError(message);
  }

  /** Runs `parse` with some context flags changed. */
  protected withContext<T>(changes: Partial<Context>, parse: () => T): T {
    const saved = this.context;
    this.context = { ...saved, ...changes };
    try {
      return parse();
    } finally {
      this.context = saved;
    }
  }

  /** Inside brackets `{` starts an object literal again, even within an if/for/switch header. */
  protected nested<T>(parse: () => T): T {
    return this.withContext({ noObjectLiteral: false }, parse);
  }

  /**
   * Parses items separated by newlines or `;` until `isEnd`. A syntax error abandons only the item
   * it occurred in: the parser skips to the item's end and continues with the next one.
   */
  protected parseSeparated(isEnd: () => boolean, parseItem: () => void): void {
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
  protected synchronize(start: number): void {
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
}
