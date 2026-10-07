import type * as ast from './ast.ts';
import type { CheckResult } from './checker/checker.ts';
import { CONTENT } from './checker/dom.ts';
import {
  ERROR_CLASS,
  memberNames,
  type FunctionType,
  type Member,
  type ObjectType,
  type Type,
  type TypeParam,
} from './checker/types.ts';
import { JS_RESERVED } from './codegen/syntax.ts';

// A TypeScript declaration file (`.d.ts`) for a compiled module, so that TypeScript code can use
// it with types. Parameter names come from the code, types from the type checker:
//
//   number, string, bool   → number, string, boolean
//   ?T, error              → T | null, Error | null
//   []T                    → T[]
//   (A, B) results         → [A, B], the array that the JS function returns
//
// Interfaces, type aliases and classes are declared even when they are not exported, since the
// exported declarations may use them. Components exist only at compile time and are left out.

export function printDeclarations(program: ast.Program, checked: CheckResult): string {
  const printer = new DeclarationPrinter(checked);
  return printer.print(program);
}

class DeclarationPrinter {
  private readonly checked: CheckResult;
  private readonly lines: string[] = [];

  constructor(checked: CheckResult) {
    this.checked = checked;
  }

  print(program: ast.Program): string {
    let exports = false;
    for (const statement of program.body) {
      if ('exported' in statement && statement.exported) exports = true;
      switch (statement.kind) {
        case 'ImportDeclaration':
          this.importDeclaration(statement);
          break;
        case 'FuncDeclaration':
          if (statement.exported) this.functionDeclaration(statement);
          break;
        case 'VariableDeclaration':
          if (statement.exported) this.variableDeclaration(statement);
          break;
        case 'ClassDeclaration':
          this.classDeclaration(statement);
          break;
        case 'InterfaceDeclaration':
          this.interfaceDeclaration(statement);
          break;
        case 'TypeAliasDeclaration':
          this.typeAlias(statement);
          break;
        default:
          break;
      }
    }
    // A declaration file without imports or exports would declare global names.
    if (!exports) this.lines.push('export {};');
    return this.lines.join('\n') + '\n';
  }

  /** Imports are repeated, so that the names they bring can be used in types. */
  private importDeclaration(node: ast.ImportDeclaration): void {
    const parts: string[] = [];
    if (node.defaultImport) parts.push(node.defaultImport.name);
    if (node.namespaceImport) parts.push(`* as ${node.namespaceImport.name}`);
    if (node.namedImports.length > 0) {
      const names = node.namedImports.map((specifier) =>
        specifier.imported.name === specifier.local.name
          ? specifier.local.name
          : `${specifier.imported.name} as ${specifier.local.name}`,
      );
      parts.push(`{ ${names.join(', ')} }`);
    }
    if (parts.length === 0) return;
    const source = node.source.value.replace(/\.mango$/, '.js');
    this.lines.push(`import ${parts.join(', ')} from ${JSON.stringify(source)};`);
  }

  private functionDeclaration(node: ast.FuncDeclaration): void {
    const type = this.checked.declarations.values.get(node.name.name);
    if (type?.kind !== 'function') return;
    const name = jsName(node.name.name);
    this.lines.push(
      `export declare function ${name}${this.typeParams(type.typeParams)}${this.signature(node.params, type)};`,
    );
  }

  private variableDeclaration(node: ast.VariableDeclaration): void {
    const keyword = node.keyword === 'let' ? 'let' : 'const';
    for (const name of node.names) {
      if (name.name === '_') continue;
      const type = this.checked.declarations.values.get(name.name);
      this.lines.push(
        `export declare ${keyword} ${jsName(name.name)}: ${type ? tsType(type) : 'any'};`,
      );
    }
  }

  private interfaceDeclaration(node: ast.InterfaceDeclaration): void {
    const type = this.checked.declarations.types.get(node.name.name);
    if (type?.kind !== 'object') return;
    const exported = node.exported ? 'export ' : '';
    this.lines.push(
      `${exported}interface ${node.name.name}${this.typeParams(type.typeParams ?? [])} {`,
      ...this.objectMembers(node.members, type).map((line) => `    ${line}`),
      '}',
    );
  }

  private typeAlias(node: ast.TypeAliasDeclaration): void {
    const type = this.checked.declarations.types.get(node.name.name);
    if (!type) return;
    const exported = node.exported ? 'export ' : '';
    const params = this.typeParams(type.kind === 'object' ? (type.typeParams ?? []) : []);
    // `type Pair[A, B any] { ... }` names an object type; other aliases are another name.
    if (node.type.kind === 'ObjectType' && type.kind === 'object') {
      const members = this.objectMembers(node.type.members, type);
      this.lines.push(
        `${exported}type ${node.name.name}${params} = {`,
        ...members.map((line) => `    ${line}`),
        '};',
      );
      return;
    }
    this.lines.push(`${exported}type ${node.name.name}${params} = ${tsType(type, true)};`);
  }

  /** Members of an interface or an object type, with the parameter names of its methods. */
  private objectMembers(members: readonly ast.TypeMember[], type: ObjectType): string[] {
    return members.map((member) => {
      const name = member.name.name;
      const memberType = type.members.get(name)?.type;
      if (member.kind === 'MethodSignature' && memberType?.kind === 'function') {
        return `${name}${this.signature(member.params, memberType)};`;
      }
      return memberType ? property(name, memberType) : `${name}: any;`;
    });
  }

  private classDeclaration(node: ast.ClassDeclaration): void {
    const instance = this.checked.declarations.types.get(node.name.name);
    if (instance?.kind !== 'class') return;
    const { info } = instance;
    const exported = node.exported ? 'export ' : '';
    const base = node.superClass && expressionName(node.superClass);
    const heritage = base ? ` extends ${base}` : '';
    const lines: string[] = [];
    for (const member of node.members) {
      switch (member.kind) {
        case 'FieldDeclaration': {
          const found = (member.isStatic ? info.statics : info.members).get(member.name.name);
          const modifiers = this.modifiers(member.visibility, member.isStatic);
          // As in the declaration files TypeScript writes, private members have no type.
          if (member.visibility === 'private') lines.push(`${modifiers}${member.name.name};`);
          else if (found) lines.push(`${modifiers}${member.name.name}: ${tsType(found.type)};`);
          break;
        }
        case 'ConstructorDeclaration': {
          const modifiers = this.modifiers(member.visibility, false);
          if (info.ctor) {
            lines.push(`${modifiers}constructor${parameters(member.params, info.ctor)};`);
          }
          break;
        }
        case 'MethodDeclaration': {
          const found = (member.isStatic ? info.statics : info.members).get(member.name.name);
          const modifiers = this.modifiers(member.visibility, member.isStatic);
          if (member.visibility === 'private') lines.push(`${modifiers}${member.name.name}();`);
          else if (found?.type.kind === 'function') {
            lines.push(
              `${modifiers}${member.name.name}${this.signature(member.params, found.type)};`,
            );
          }
          break;
        }
      }
    }
    this.lines.push(
      `${exported}declare class ${jsName(node.name.name)}${this.typeParams(info.typeParams)}${heritage} {`,
      ...lines.map((line) => `    ${line}`),
      '}',
    );
  }

  private modifiers(visibility: ast.Visibility, isStatic: boolean): string {
    return `${visibility === 'public' ? '' : `${visibility} `}${isStatic ? 'static ' : ''}`;
  }

  /** `<T, U extends Shape>` */
  private typeParams(params: readonly TypeParam[]): string {
    if (params.length === 0) return '';
    const list = params.map((param) =>
      param.constraint ? `${param.name} extends ${tsType(param.constraint)}` : param.name,
    );
    return `<${list.join(', ')}>`;
  }

  /** `(a: number, b?: string): R` with the names of the parameters in the code. */
  private signature(params: readonly ast.Parameter[], type: FunctionType): string {
    return `${parameters(params, type)}: ${resultType(type.results)}`;
  }
}

function parameters(params: readonly ast.Parameter[], type: FunctionType): string {
  const list = type.params.map((param, i) => {
    const name = params[i] ? jsName(params[i].name.name) : `arg${i + 1}`;
    return `${name}${i < type.required ? '' : '?'}: ${tsType(param)}`;
  });
  return `(${list.join(', ')})`;
}

/** A nullable property may be left out of an object: `name?: string | null`. */
function property(name: string, type: Type): string {
  const optional = type.kind === 'nullable' || type.kind === 'null' ? '?' : '';
  return `${name}${optional}: ${tsType(type)};`;
}

function resultType(results: readonly Type[]): string {
  if (results.length === 0) return 'void';
  if (results.length === 1) return tsType(results[0]!);
  return `[${results.map((result) => tsType(result)).join(', ')}]`;
}

/**
 * A type in TypeScript syntax. A union keeps the name of its alias, except in the alias itself
 * (`expand`).
 */
export function tsType(type: Type, expand = false): string {
  switch (type.kind) {
    case 'number':
    case 'string':
    case 'any':
    case 'void':
    case 'null':
    case 'never':
    case 'unknown':
      return type.kind;
    case 'bool':
      return 'boolean';
    case 'literal':
      return typeof type.value === 'string' ? JSON.stringify(type.value) : String(type.value);
    case 'nullable':
      return `${grouped(type.type)} | null`;
    case 'union':
      if (type.name !== undefined && !expand) return type.name;
      return type.types.map(grouped).join(' | ');
    case 'array':
      return `${element(type.element)}[]`;
    case 'tuple':
      return `[${type.types.map((each) => tsType(each)).join(', ')}]`;
    case 'function':
      return functionType(type);
    case 'object':
      return objectType(type);
    case 'class': {
      if (type.info === ERROR_CLASS) return 'Error';
      const args = type.args ? `<${type.args.map((arg) => tsType(arg)).join(', ')}>` : '';
      return `${type.info.name}${args}`;
    }
    case 'classValue':
      return `typeof ${type.info.name}`;
    case 'param':
      return type.name;
  }
}

function functionType(type: FunctionType): string {
  return `(${anonymousParameters(type)}) => ${resultType(type.results)}`;
}

/** A method of an object type: `name(arg1: number): string`. */
function methodType(name: string, type: FunctionType): string {
  return `${name}(${anonymousParameters(type)}): ${resultType(type.results)};`;
}

/** Parameters of a function type, which has no names for them. */
function anonymousParameters(type: FunctionType): string {
  const params = type.params.map(
    (param, i) => `arg${i + 1}${i < type.required ? '' : '?'}: ${tsType(param)}`,
  );
  if (type.rest) params.push(`...rest: ${element(type.rest)}[]`);
  return params.join(', ');
}

function objectType(type: ObjectType): string {
  // The children of a component are a fragment at runtime.
  if (type === CONTENT) return 'Node';
  if (type.name !== null) {
    const args = type.instanceOf?.args ?? type.typeParams;
    return args ? `${type.name}<${args.map((arg) => tsType(arg)).join(', ')}>` : type.name;
  }
  const members = [...memberNames(type.members)].map((name) => {
    const member: Member | undefined = type.members.get(name);
    if (!member) return '';
    if (member.method && member.type.kind === 'function') return methodType(name, member.type);
    return property(name, member.type);
  });
  if (type.call) members.push(methodType('', type.call));
  return members.length === 0 ? '{}' : `{ ${members.filter(Boolean).join(' ')} }`;
}

/** Parentheses around unions and functions inside `| null`: `(string | number) | null`. */
function grouped(type: Type): string {
  const text = tsType(type);
  return type.kind === 'function' || (type.kind === 'union' && type.name === undefined)
    ? `(${text})`
    : text;
}

/** An element type before `[]`: `(string | null)[]`. */
function element(type: Type): string {
  const text = tsType(type);
  return type.kind === 'function' ||
    type.kind === 'nullable' ||
    (type.kind === 'union' && type.name === undefined)
    ? `(${text})`
    : text;
}

/** `Base` or `events.EventEmitter` in `extends`; other expressions cannot be written in types. */
function expressionName(node: ast.Expression): string | null {
  if (node.kind === 'Identifier') return node.name;
  if (node.kind === 'MemberExpression') {
    const object = expressionName(node.object);
    return object && `${object}.${node.property.name}`;
  }
  return null;
}

/** Names that are reserved in JS get `$`, as in the generated code. */
function jsName(name: string): string {
  return JS_RESERVED.has(name) ? `${name}$` : name;
}
