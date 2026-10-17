/**
 * Minimal Lua data-table parser.
 *
 * The WARFRAME Wiki keeps its machine-readable datasets in Lua modules
 * (Module:Mods/data, Module:DamageTypes/data, Module:Warframes/data). They are
 * pure data -- no functions, no loops -- so a tiny recursive parser is enough
 * and avoids running any Lua.
 *
 * Supported: `return { ... }`, `local x = { ... }`, bare/["quoted"]/[1]=(numeric) keys,
 * nested tables, strings with escapes, numbers, true/false/nil, `--` and `--[[ ]]` comments,
 * and named fields declared in any order.
 * Not supported (and not needed): expressions, concatenation, function calls.
 */

export type LuaValue = string | number | boolean | null | LuaTable;
export interface LuaTable {
  [key: string]: LuaValue;
  /** Numeric (array) part, when the table is used as a list. */
  [key: number]: LuaValue;
}

class Parser {
  private i = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): LuaValue {
    this.skipTrivia();
    const result = this.value();
    this.skipTrivia();
    if (this.i < this.src.length) this.fail('trailing content after top-level value');
    return result;
  }

  /** Parses a single value and reports how many characters it consumed. */
  parsePrefix(): { value: LuaValue; consumed: number } {
    this.skipTrivia();
    const value = this.value();
    return { value, consumed: this.i };
  }

  /** Parses a wiki module body: `local a = {...}; local b = {...}; return a`. */
  parseModule(): LuaValue {
    const bindings = new Map<string, LuaValue>();
    let truncated = false;
    while (!truncated) {
      this.skipTrivia();
      if (this.i >= this.src.length) break;
      const keyword = /^(local|return)\b/.exec(this.src.slice(this.i));
      if (!keyword) {
        // Real Lua code (loops, helper functions) after the data tables: stop here and
        // resolve the trailing `return <name>` below. We never execute wiki code.
        truncated = true;
        break;
      }
      this.i += keyword[1].length;
      this.skipTrivia();
      if (keyword[1] === 'return') {
        const id = /^[A-Za-z_]\w*/.exec(this.src.slice(this.i));
        if (id && bindings.has(id[0])) {
          this.i += id[0].length;
          return bindings.get(id[0])!;
        }
        return this.value();
      }
      const name = /^[A-Za-z_]\w*/.exec(this.src.slice(this.i));
      if (!name) this.fail('expected a local name');
      this.i += name[0].length;
      this.skipTrivia();
      if (this.src[this.i] !== '=') this.fail(`expected '=' after local '${name[0]}'`);
      this.i++;
      bindings.set(name[0], this.value());
    }
    const returned = /\breturn\s+([A-Za-z_]\w*)\s*$/m.exec(this.src.slice(this.i));
    if (returned && bindings.has(returned[1])) return bindings.get(returned[1])!;
    if (bindings.size === 1) return [...bindings.values()][0];
    this.fail(`module ends in unsupported code and returns more than one table (${[...bindings.keys()].join(', ')})`);
  }

  private fail(msg: string): never {
    const line = this.src.slice(0, this.i).split('\n').length;
    throw new Error(`Lua parse error at line ${line}: ${msg}`);
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.i++;
      } else if (c === '-' && this.src[this.i + 1] === '-') {
        const long = this.src.startsWith('--[[', this.i) || this.src.startsWith('--[==[', this.i);
        if (long) {
          const close = this.src.startsWith('--[==[', this.i) ? ']==]' : ']]';
          const end = this.src.indexOf(close, this.i);
          this.i = end === -1 ? this.src.length : end + close.length;
        } else {
          const end = this.src.indexOf('\n', this.i);
          this.i = end === -1 ? this.src.length : end + 1;
        }
      } else {
        return;
      }
    }
  }

  /** Skips optional `local name =` / bare `name =` prelude and returns the value. */
  private value(): LuaValue {
    this.skipTrivia();
    const c = this.src[this.i];
    if (c === '{') return this.table();
    if (c === '"' || c === "'") return this.string(c);
    if (c === '[') return this.string(']'); // long bracket string
    const num = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(this.src.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const word = /^[A-Za-z_][\w.]*/.exec(this.src.slice(this.i));
    if (word) {
      this.i += word[0].length;
      if (word[0] === 'true') return true;
      if (word[0] === 'false') return false;
      if (word[0] === 'nil') return null;
      if (word[0] === 'local' || word[0] === 'return') {
        this.skipTrivia();
        // `local Name = ...` / `return ...`
        if (word[0] === 'local') {
          const id = /^[A-Za-z_][\w]*/.exec(this.src.slice(this.i));
          if (id) this.i += id[0].length;
          this.skipTrivia();
          if (this.src[this.i] === '=') this.i++;
        }
        return this.value();
      }
      this.fail(`unexpected identifier '${word[0]}'`);
    }
    this.fail(`unexpected character '${c}'`);
  }

  private string(_quote: string): string {
    if (this.src[this.i] === '[') {
      const long = /^\[(=*)\[/.exec(this.src.slice(this.i));
      if (!long) this.fail('malformed long string');
      const close = `]${long[1]}]`;
      const start = this.i + long[0].length;
      const end = this.src.indexOf(close, start);
      if (end === -1) this.fail('unterminated long string');
      this.i = end + close.length;
      return this.src.slice(start, end);
    }
    const quote = this.src[this.i];
    this.i++;
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i++];
      if (c === quote) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const esc = this.src[this.i++];
      switch (esc) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case '\n': out += '\n'; break;
        default: out += esc; break;
      }
    }
    this.fail('unterminated string');
  }

  private table(): LuaTable {
    this.i++; // {
    const out: LuaTable = {};
    let nextIndex = 1;
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.i];
      if (c === '}') {
        this.i++;
        return out;
      }
      if (c === undefined) this.fail('unterminated table');

      // key = value | ["key"] = value | [1] = value | positional value
      let key: string | number | undefined;
      const save = this.i;
      if (c === '[') {
        this.i++;
        this.skipTrivia();
        const k = this.value();
        this.skipTrivia();
        if (this.src[this.i] !== ']') this.fail('expected ] after table key');
        this.i++;
        this.skipTrivia();
        if (this.src[this.i] !== '=') this.fail('expected = after table key');
        this.i++;
        key = typeof k === 'number' ? k : String(k);
      } else if (/^[A-Za-z_]/.test(c) && /^\s*[A-Za-z_][\w]*\s*=/.test(this.src.slice(save, save + 80))) {
        const id = /^[A-Za-z_][\w]*/.exec(this.src.slice(save))!;
        this.i += id[0].length;
        this.skipTrivia();
        this.i++; // =
        key = id[0];
      }
      this.skipTrivia();
      const val = this.value();
      if (key === undefined) {
        out[nextIndex++] = val;
      } else if (typeof key === 'number') {
        out[key] = val;
      } else {
        out[key] = val;
      }
      this.skipTrivia();
      if (this.src[this.i] === ',' || this.src[this.i] === ';') this.i++;
      else if (this.src[this.i] !== '}') this.fail(`expected , or } but found '${this.src[this.i]}'`);
    }
  }
}

export function parseLua(src: string): LuaValue {
  return new Parser(src).parse();
}

/**
 * Parses a full wiki module: `local a = {...}; local b = {...}; return a`.
 * Returns the value returned by the module (identifiers are resolved from locals).
 * Lua code after the data tables is ignored as long as it sits in a comment.
 */
export function parseLuaModule(src: string): LuaValue {
  return new Parser(src).parseModule();
}

/** Returns the numeric (array) part of a Lua table, in order. */
export function luaList<T = LuaValue>(table: LuaTable | LuaValue): T[] {
  if (!table || typeof table !== 'object') return [];
  const keys = Object.keys(table).filter((k) => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  return keys.map((k) => (table as LuaTable)[k] as T);
}
