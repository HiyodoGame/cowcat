// Regex-lexer syntax highlighting: line scanner with ordered sticky-regex rule
// tables and a small cross-line state (block comments / multiline strings).
// Output is an opaque ANSI block; callers cache it and never re-parse.

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const r = (src, token, enter) => ({ re: new RegExp(src, 'y'), token, enter });
const kw = (words, token) => r(`\\b(?:${words})\\b`, token);

const JS_KEYWORDS = [
  'const|let|var|function|return|if|else|for|while|do|switch|case|default',
  'break|continue|new|delete|typeof|void|instanceof|in|of|class|extends|super',
  'this|null|undefined|true|false|yield|async|await|try|catch|finally|throw',
  'import|from|as|export|static|get|set',
].join('|');

const JS_BUILT_INS = [
  'console|Math|JSON|Object|Array|String|Number|Boolean|Symbol|BigInt|Promise',
  'Map|Set|WeakMap|WeakSet|Date|RegExp|Error|TypeError|ReferenceError|RangeError',
  'SyntaxError|EvalError|URIError|AggregateError|Proxy|Reflect|Intl|globalThis',
  'NaN|Infinity|isNaN|parseInt|parseFloat|setTimeout|setInterval|clearTimeout',
  'clearInterval|queueMicrotask|fetch|require|module|process|Buffer|__dirname',
  '__filename|window|document|localStorage|navigator',
].join('|');

const NUMBER_SRC = '\\b(?:0[xX][\\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b';

function jsRules(extra = []) {
  return [
    r(/\/\*/, 'comment', () => ({ inBlockComment: '*/' })),
    r(/\/\/[^\n]*/, 'comment'),
    r(/`/, 'string', () => ({ inString: '`' })),
    r(/"(?:\\.|[^"\\\n])*"/, 'string'),
    r(/'(?:\\.|[^'\\\n])*'/, 'string'),
    r(NUMBER_SRC, 'number'),
    kw(JS_KEYWORDS, 'keyword'),
    ...extra,
    kw(JS_BUILT_INS, 'built_in'),
    r(/[A-Za-z_$][\w$]*(?=\s*\()/, 'function'),
    r(/[A-Za-z_$][\w$]*/, 'name'),
    r(/[+\-*/%=<>!&|^~?:]+/, 'op'),
    r(/[{}[\]();,.]+/, 'punct'),
  ];
}

const TS_TYPES = [
  r(/(?<=\b(?:interface|type|class|extends|implements|new)\s)[A-Za-z_$][\w$]*/, 'type'),
  r(/(?<=[:)]\s?)[A-Za-z_$][\w$]*/, 'type'),
];

const PY_KEYWORDS = [
  'and|or|not|if|elif|else|for|while|in|is|def|class|return|yield|from|import|as',
  'with|try|except|finally|raise|assert|pass|break|continue|global|nonlocal|lambda',
  'del|async|await|match|case|None|True|False',
].join('|');

const PY_BUILT_INS = [
  'print|len|range|str|int|float|bool|list|dict|set|tuple|frozenset|type|isinstance',
  'issubclass|open|enumerate|zip|map|filter|sum|min|max|abs|round|repr|sorted',
  'reversed|super|getattr|setattr|hasattr|delattr|vars|dir|id|hash|iter|next|slice',
  'object|Exception|BaseException|ValueError|TypeError|KeyError|IndexError',
  'AttributeError|RuntimeError|NameError|ZeroDivisionError|StopIteration|self|cls',
].join('|');

const PYTHON_RULES = [
  r(/^@\w[\w.]*/, 'meta'),
  r(/#.*$/, 'comment'),
  r(/[rbfu]{0,2}'''/, 'string', () => ({ inString: "'''" })),
  r(/[rbfu]{0,2}"""/, 'string', () => ({ inString: '"""' })),
  r(/[rbfu]{0,2}"(?:\\.|[^"\\\n])*"/, 'string'),
  r(/[rbfu]{0,2}'(?:\\.|[^'\\\n])*'/, 'string'),
  r(NUMBER_SRC, 'number'),
  kw(PY_KEYWORDS, 'keyword'),
  r(/(?<=\bdef\s)[A-Za-z_]\w*/, 'function'),
  r(/(?<=\bclass\s)[A-Za-z_]\w*/, 'class'),
  kw(PY_BUILT_INS, 'built_in'),
  r(/[A-Za-z_]\w*(?=\()/, 'function'),
  r(/[A-Za-z_]\w*/, 'name'),
  r(/[+\-*/%=<>!&|^~]+/, 'op'),
  r(/[{}[\]();:,.]+/, 'punct'),
];

const SH_KEYWORDS = [
  'if|then|else|elif|fi|for|in|do|done|while|until|case|esac|select|function',
  'return|break|continue|time|coproc',
].join('|');

const SH_BUILT_INS = [
  'echo|printf|cd|pwd|pushd|popd|export|local|readonly|declare|typeset|unset',
  'source|alias|unalias|set|shift|exit|eval|exec|trap|read|wait|jobs|bg|fg|kill',
  'ulimit|umask|getopts|command|builtin|enable|let|test',
].join('|');

const SH_RULES = [
  r(/^#![^\n]*/, 'comment'),
  r(/#[^\n]*/, 'comment'),
  r(/"(?:\\.|[^"\\\n])*"/, 'string'),
  r(/'[^'\n]*'/, 'string'),
  r(/`[^`\n]*`/, 'string'),
  r(/\$(?:\w+|\{[^}\n]*\})/, 'attr'),
  r(/\b\d+\b/, 'number'),
  kw(SH_KEYWORDS, 'keyword'),
  kw('true|false', 'literal'),
  kw(SH_BUILT_INS, 'built_in'),
  r(/[A-Za-z_][\w.-]*(?=\s*\()/, 'function'),
  r(/[A-Za-z_]\w*(?==(?![=]))/, 'name'),
  r(/--?[A-Za-z][\w-]*/, 'meta'),
  r(/[><|&;]+/, 'op'),
  r(/[{}()\[\]]+/, 'punct'),
];

const JSON_RULES = [
  r(/"(?:\\.|[^"\\])*"(?=\s*:)/, 'attr'),
  r(/"(?:\\.|[^"\\])*"/, 'string'),
  r(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'),
  kw('true|false|null', 'literal'),
  r(/[{}[\]:,]+/, 'punct'),
];

const MD_RULES = [
  r(/^---$/, 'meta'),
  r(/^#{1,6}(?=\s)/, 'keyword'),
  r(/^\s*(?:[-*+]|\d+[.)])(?=\s)/, 'punct'),
  r(/^>/, 'meta'),
  r(/`[^`\n]+`/, 'literal'),
  r(/\[[^\]\n]*\]\([^)\n]*\)/, 'attr'),
];

export const LANGUAGES = ['js', 'ts', 'python', 'sh', 'json', 'md'];

const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', node: 'js',
  ts: 'ts', typescript: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  python: 'python', py: 'python', python3: 'python',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md',
};

const RULES = {
  js: jsRules(),
  ts: jsRules(TS_TYPES),
  python: PYTHON_RULES,
  sh: SH_RULES,
  json: JSON_RULES,
  md: MD_RULES,
};

function cyanFor(theme) {
  const probe = theme && theme.text ? theme.text : '';
  if (probe.includes('38;2;')) return '\x1b[38;2;95;175;215m';
  if (probe.includes('38;5;')) return '\x1b[38;5;74m';
  return '\x1b[36m';
}

function stylesFor(theme) {
  const cyan = cyanFor(theme);
  return {
    keyword: theme.permission,
    literal: theme.permission,
    class: theme.permission,
    name: theme.permission,
    built_in: cyan,
    type: cyan,
    attr: cyan,
    string: theme.error,
    regexp: theme.error,
    number: theme.success,
    doctag: theme.success,
    comment: DIM + theme.success,
    function: theme.warning,
    meta: theme.inactive,
    tag: theme.inactive,
    op: theme.text,
    punct: theme.text,
  };
}

export function tokenizeLine(rules, line, state) {
  const tokens = [];
  const plain = (text) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.token === null) last.text += text;
    else tokens.push({ text, token: null });
  };
  const emit = (text, token) => tokens.push({ text, token });

  let pos = 0;
  while (pos < line.length) {
    if (state.inBlockComment) {
      const close = state.inBlockComment;
      const end = line.indexOf(close, pos);
      if (end === -1) {
        emit(line.slice(pos), 'comment');
        pos = line.length;
      } else {
        emit(line.slice(pos, end + close.length), 'comment');
        pos = end + close.length;
        delete state.inBlockComment;
      }
      continue;
    }
    if (state.inString) {
      const close = state.inString;
      let i = pos;
      let closed = false;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line.startsWith(close, i)) { i += close.length; closed = true; break; }
        i += 1;
      }
      emit(line.slice(pos, i), 'string');
      pos = i;
      if (closed) delete state.inString;
      continue;
    }
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(line);
      if (!m || m.index !== pos) continue;
      if (m[0].length === 0) continue;
      if (rule.token) emit(m[0], rule.token);
      else plain(m[0]);
      if (rule.enter) Object.assign(state, rule.enter(m));
      pos += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      plain(line[pos]);
      pos += 1;
    }
  }
  return tokens;
}

export function highlightCode(code, lang, theme) {
  const name = ALIASES[String(lang || '').toLowerCase()];
  if (!name) return code;
  const rules = RULES[name];
  const styles = stylesFor(theme);
  const state = {};
  const lines = String(code).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  for (const line of lines) {
    let text = '';
    for (const tok of tokenizeLine(rules, line, state)) {
      const sgr = tok.token ? styles[tok.token] : '';
      text += sgr ? `${sgr}${tok.text}${RESET}` : tok.text;
    }
    out.push(text);
  }
  return out.join('\n') + '\n';
}
