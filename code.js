/* ============================================================
    OffQuill — Code mode logic (pure, no DOM)
    Reuses LayerA.clean, LayerB.getSession/paraphrase, and
    helpers from layers.js. Script load order: layers.js → code.js
    ============================================================ */

const CodeB = (() => {

  // --- Locked-term extraction for code (strings, imports, decorators,
  //     API calls, numeric literals — byte-identical by construction) ---
  function extractLockedTerms(code) {
    const spans = new Set();
    // String literals (single, double, backtick/template)
    const strRe = /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
    let m;
    while ((m = strRe.exec(code))) spans.add(m[0]);
    // Import paths and module names (quoted + bare Python-style)
    const impRe = /(?:from\s+|import\s+|require\s*\()\s*['"]([^'"]+)['"]/g;
    while ((m = impRe.exec(code))) spans.add(m[1]);
    const bareImp = /(?:^|\n)\s*import\s+([a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*)/g;
    while ((m = bareImp.exec(code))) spans.add(m[1]);
    const fromImp = /(?:^|\n)\s*from\s+([a-zA-Z_][\w.]*)\s+import\s+([^\n]+)/g;
    while ((m = fromImp.exec(code))) { spans.add(m[1]); spans.add(m[2].trim()); }
    // Decorator/attribute names (@decorator, .method chaining targets)
    const decRe = /@\w+/g;
    while ((m = decRe.exec(code))) spans.add(m[0]);
    // Numeric literals
    const numRe = /\b\d+(?:\.\d+)?\b/g;
    while ((m = numRe.exec(code))) spans.add(m[0]);
    return [...spans];
  }

  // --- Code prompt builders ---
  function buildPrompt(code, strength, locked = []) {
    const lockedRule = locked.length
      ? `LOCKED TERMS (absolute): These exact strings must appear UNCHANGED in the output, same spelling and case: ${locked.map((s) => `"${s}"`).join(', ')}. Never drop, reword, or synonymize them.`
      : '';
    const facts = `RULE 1 (absolute): Preserve ALL functionality exactly. The output must compile/run correctly. Do not add, remove, or alter any logic, data, or behavior.`;
    const pov = `RULE 2 (absolute): Keep the same structure, language features, and architecture. Do not change the programming paradigm, add frameworks, or switch approaches.`;
    const voice = `VOICE RULE (absolute): Write code like a human developer wrote it for a team they know well. FORBIDDEN: obvious comments that restate the syntax ("initialize the variable", "loop through the items"), docstrings that just restate the function name, defensive over-engineering (try/except catching exceptions the code can't raise, triple null checks), leftover debug statements (console.log, stray print() calls used for debugging), generic names (data, result, temp, item), \`foo\`/\`bar\`/\`baz\`, \`MyClass\`/\`MyFunction\`, and \`Helper\`/\`Manager\`/\`Handler\` suffixes without specificity.`;

    const instructions = {
      light: `${facts}\n${pov}\n${voice}\n${lockedRule}\nThis is LIGHT style polish only. Rename identifiers to natural, specific names. Thin obvious comments. Compress verbose patterns. Do NOT restructure or change logic.\n\nCode:\n${code}`,

      medium: `${facts}\n${pov}\n${voice}\n${lockedRule}\nRewrite this code to sound like a developer who knows the codebase well. Rename identifiers to natural, specific names. Remove obvious comments. Compress verbose patterns. Restructure only where it simplifies. Keep all string literals, import paths, numeric constants, and API calls byte-identical.\n\nCode:\n${code}`,

      strong: `${facts}\n${pov}\n${voice}\n${lockedRule}\nCompletely restructure with new naming and fresh patterns — but the code must do EXACTLY the same thing. Same language, same structure, same imports. Rename everything. Remove all AI-isms: obvious comments, defensive over-engineering, generic names, verbose boilerplate. String literals, import paths, numeric constants, and API calls stay byte-identical.\n\nCode:\n${code}`,
    };

    return instructions[strength] || instructions.medium;
  }

  async function paraphrase(code, strength, onProgress, opts = {}) {
    const s = await LayerB.getSession(onProgress);
    const locked = opts.locked || extractLockedTerms(code);
    const prompt = buildPrompt(code, strength, locked);
    const result = await withTimeout(s.prompt(prompt), 120000, 'Code paraphrase');
    // Verify locked terms survived
    const missing = locked.filter((t) => !result.includes(t));
    if (missing.length) {
      // Fall back to code as-is if critical terms lost
      console.warn('Code paraphrase lost locked terms:', missing.slice(0, 3));
      return { text: code, missingSpans: missing, changed: false };
    }
    return { text: result, missingSpans: [], changed: true };
  }

  return { paraphrase, extractLockedTerms };
})();


// ============================================================
// CODE LAYER C — Deterministic AI-slop removal
// String/comment-aware: transforms never touch literal contents.
// ============================================================

const CodeC = (() => {

  // --- String/comment scanner: extract literals and comments into
  //     unique placeholders so transforms never fire inside them. ---
  const STR_SENTINEL = '\x00S';
  const CMT_SENTINEL = '\x00C';

  function scanAndExtract(code) {
    const extracted = [];
    let i = 0;
    while (i < code.length) {
      // Single-line comment
      if (code[i] === '#' && (i === 0 || code[i - 1] !== "'")) {
        let end = code.indexOf('\n', i);
        if (end === -1) end = code.length;
        extracted.push({ type: 'comment', text: code.slice(i, end) });
        code = code.slice(0, i) + `${CMT_SENTINEL}${extracted.length - 1}${CMT_SENTINEL}` + code.slice(end);
        continue;
      }
      // Multi-line comment
      if (code[i] === '/' && code[i + 1] === '*') {
        let end = code.indexOf('*/', i + 2);
        if (end === -1) end = code.length; else end += 2;
        extracted.push({ type: 'comment', text: code.slice(i, end) });
        code = code.slice(0, i) + `${CMT_SENTINEL}${extracted.length - 1}${CMT_SENTINEL}` + code.slice(end);
        continue;
      }
      // JS/TS/CSS single-line comment //
      if (code[i] === '/' && code[i + 1] === '/') {
        let end = code.indexOf('\n', i);
        if (end === -1) end = code.length;
        extracted.push({ type: 'comment', text: code.slice(i, end) });
        code = code.slice(0, i) + `${CMT_SENTINEL}${extracted.length - 1}${CMT_SENTINEL}` + code.slice(end);
        continue;
      }
      // Template literal (backtick) — handle escapes and interpolations
      if (code[i] === '`') {
        let j = i + 1;
        while (j < code.length) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === '`') { j++; break; }
          if (code[j] === '$' && code[j + 1] === '{') {
            // Skip interpolation — just find closing brace
            let depth = 1;
            j += 2;
            while (j < code.length && depth > 0) {
              if (code[j] === '{') depth++;
              else if (code[j] === '}') depth--;
              j++;
            }
          } else { j++; }
        }
        extracted.push({ type: 'string', text: code.slice(i, j) });
        code = code.slice(0, i) + `${STR_SENTINEL}${extracted.length - 1}${STR_SENTINEL}` + code.slice(j);
        continue;
      }
      // Regular string literals (single and double)
      if (code[i] === '"' || code[i] === "'") {
        const quote = code[i];
        let j = i + 1;
        while (j < code.length) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === quote) { j++; break; }
          j++;
        }
        extracted.push({ type: 'string', text: code.slice(i, j) });
        code = code.slice(0, i) + `${STR_SENTINEL}${extracted.length - 1}${STR_SENTINEL}` + code.slice(j);
        continue;
      }
      // Character literal in C/C++/Rust/Go
      if (code[i] === '\'' && i + 2 < code.length && code[i + 2] === '\'' && code[i + 1] !== '\\') {
        extracted.push({ type: 'string', text: code.slice(i, i + 3) });
        code = code.slice(0, i) + `${STR_SENTINEL}${extracted.length - 1}${STR_SENTINEL}` + code.slice(i + 3);
        continue;
      }
      i++;
    }
    return { code, extracted };
  }

  function restore(code, extracted) {
    let result = code;
    for (let k = extracted.length - 1; k >= 0; k--) {
      result = result.replace(`${CMT_SENTINEL}${k}${CMT_SENTINEL}`, extracted[k].text);
      result = result.replace(`${STR_SENTINEL}${k}${STR_SENTINEL}`, extracted[k].text);
    }
    return result;
  }

  // --- Delimiter balance check (runs on literal-free code, so brackets
  //     inside strings can't trip it; < > excluded — comparisons and
  //     generics would false-positive).
  function isBalanced(code) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const open = new Set(Object.keys(pairs));
    const stack = [];
    const scanned = scanAndExtract(code);
    // Only check code, not extracted literals
    for (const ch of scanned.code) {
      if (open.has(ch)) stack.push(ch);
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (!stack.length || pairs[stack.pop()] !== ch) return false;
      }
    }
    return stack.length === 0;
  }

  // --- Reserved-word collision check after renames ---
  const JS_RESERVED = new Set([
    'break','case','catch','continue','debugger','default','delete','do',
    'else','export','extends','finally','for','function','if','import',
    'in','instanceof','new','return','super','this','throw','try','typeof',
    'var','void','while','with','yield','class','const','enum','let','static',
    'implements','interface','package','private','protected','public',
    'abstract','boolean','byte','char','double','final','float','int',
    'long','native','short','synchronized','throws','transient','volatile',
    'true','false','null','undefined','NaN','Infinity','async','await',
    'of','from','as','typeof','instanceof','get','set','new','target',
    'this','super','constructor','extends','implements','interface',
    'declare','type','namespace','module','enum','abstract','readonly',
    'assert','global','globalThis','eval','arguments','caller',
  ]);
  const PY_RESERVED = new Set([
    'False','True','None','and','as','assert','async','await','break',
    'class','continue','def','del','elif','else','except','finally','for',
    'from','global','if','import','in','is','lambda','nonlocal','not',
    'or','pass','raise','return','try','while','with','yield','lambda',
    'self','cls','super','property','staticmethod','classmethod',
    'async','await','type','object','int','str','float','list','dict',
    'tuple','set','frozenset','bytes','bool','complex','range','slice',
    'enumerate','zip','map','filter','sorted','reversed','any','all',
    'open','print','input','len','range','super','property','staticmethod',
  ]);

  function hasReservedWordCollision(code, oldNames, newNames) {
    const lang = detectLanguage(code);
    const reserved = lang === 'python' ? PY_RESERVED : JS_RESERVED;
    for (const n of newNames) {
      if (reserved.has(n)) return true;
    }
    return false;
  }

  // --- Minified-input guard ---
  function isMinified(code) {
    const lines = code.split('\n').filter((l) => l.trim());
    if (lines.length < 3) return true;
    const avgLen = code.length / Math.max(1, lines.length);
    return avgLen > 200 && lines.length < 10;
  }

  // --- Transform tables per language ---
  // Each entry: { from: regex, to: replacement, desc }
  // All transforms operate on code-with-placeholders (literals extracted).

  // NOTE: debug-output deletion (console.log, print, println) is
  // deliberately NOT here — removing output changes observable behavior.
  // Nano's rewrite prompt covers debug leftovers instead.
  const SHARED_TRANSFORMS = [
    // == true / == false → bare (lowercase only, so Python True/False
    // never match — `!` is not valid Python).
    { from: /\bif\s*\(\s*(\w+)\s*==\s*true\s*\)/g, to: 'if ($1)', desc: '== true collapse' },
    { from: /\bif\s*\(\s*(\w+)\s*==\s*false\s*\)/g, to: 'if (!$1)', desc: '== false collapse' },
    // if x: return True else: return False → return x (Python, single-line)
    { from: /\bif\s+(\w+)\s*:\s*return\s+True\s*else\s*:\s*return\s+False/g, to: 'return $1', desc: 'bool return collapse' },
    // x = x + 1 → x += 1
    { from: /\b(\w+)\s*=\s*\1\s*\+\s*1\b/g, to: '$1 += 1', desc: '++ assignment' },
    { from: /\b(\w+)\s*=\s*\1\s*-\s*1\b/g, to: '$1 -= 1', desc: '-- assignment' },
    // if len(x) > 0: → if x: (Python)
    { from: /\bif\s+len\((\w+)\)\s*>\s*0\s*:/g, to: 'if $1:', desc: 'len > 0 collapse' },
    { from: /\bif\s+len\((\w+)\)\s*==\s*0\s*:/g, to: 'if not $1:', desc: 'len == 0 collapse' },
    // Double negation
    { from: /\bnot\s+not\s+(\w+)/g, to: '$1', desc: 'double negation' },
    // Empty list/dict constructors (Python)
    { from: /\blist\(\)/g, to: '[]', desc: 'list() → []' },
    { from: /\bdict\(\)/g, to: '{}', desc: 'dict() → {}' },
    // Blank line compression (3+ blank lines → 2)
    { from: /\n{3,}/g, to: '\n\n', desc: 'blank line compression' },
    // Trailing whitespace on lines
    { from: /[ \t]+$/gm, to: '', desc: 'trailing whitespace' },
    // Trailing semicolons (Python noise; ASI-safe in JS)
    { from: /;\s*$/gm, to: '', desc: 'trailing semicolon' },
  ];

  const PY_TRANSFORMS = [
    // result = [] + append loop (adjacent lines) → list comprehension
    { from: /\bresult\s*=\s*\[\]\s*\n\s*for\s+(\w+)\s+in\s+(\w+)\s*:\s*\n\s*result\.append\(\1\)/g, to: 'result = [$1 for $1 in $2]', desc: 'list comprehension' },
    // result = {} + assignment loop (adjacent lines) → dict comprehension
    { from: /\bresult\s*=\s*\{\}\s*\n\s*for\s+(\w+)\s+in\s+(\w+)\s*:\s*\n\s*result\[(\w+)\]\s*=\s*(\w+)/g, to: 'result = {$3: $4 for $1 in $2}', desc: 'dict comprehension' },
    // if c: return a else: return b (single-line) → ternary
    { from: /\bif\s+(\w+)\s*:\s*return\s+(\w+)\s*else\s*:\s*return\s+(\w+)/g, to: 'return $2 if $1 else $3', desc: 'inline ternary' },
    // isinstance(x, int) and isinstance(x, float) → isinstance(x, (int, float))
    { from: /\bisinstance\s*\(\s*(\w+)\s*,\s*int\s*\)\s*and\s*isinstance\s*\(\s*\1\s*,\s*float\s*\)/g, to: 'isinstance($1, (int, float))', desc: 'isinstance collapse' },
  ];

  const JS_TRANSFORMS = [
    // if (x) { return true } else { return false } → return x
    { from: /\bif\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+true\s*;?\s*\}\s*else\s*\{\s*return\s+false\s*;?\s*\}/g, to: 'return $1', desc: 'bool return collapse' },
    { from: /\bif\s*\(\s*!\s*(\w+)\s*\)\s*\{\s*return\s+false\s*;?\s*\}\s*else\s*\{\s*return\s+true\s*;?\s*\}/g, to: 'return $1', desc: 'neg bool return collapse' },
    // (x) => { return y + 1 } → x => y + 1
    { from: /\(\s*(\w+)\s*\)\s*=>\s*\{\s*return\s+(\w+)\s*\+\s*1\s*\}/g, to: '$1 => $2 + 1', desc: 'arrow function simplify' },
    // function (x) { return y + 1 } → (x) => y + 1 (body has no `this` by construction)
    { from: /\bfunction\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+(\w+)\s*\+\s*1\s*\}/g, to: '($1) => $2 + 1', desc: 'arrow conversion' },
    // Empty array constructor → literal
    { from: /\bnew\s+Array\(\)\s*/g, to: '[]', desc: 'new Array → []' },
    // Promise.resolve(Promise.resolve( → Promise.resolve(
    { from: /\bPromise\.resolve\s*\(\s*Promise\.resolve\s*\(/g, to: 'Promise.resolve(', desc: 'nested Promise.resolve' },
  ];

  const JAVA_TRANSFORMS = [
    // if (x) { return true } else { return false } → return x
    { from: /\bif\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+true\s*;?\s*\}\s*else\s*\{\s*return\s+false\s*;?\s*\}/g, to: 'return $1', desc: 'bool return collapse' },
    // new ArrayList<String>() → new ArrayList<>()
    { from: /List\s*<\s*String\s*>\s*(\w+)\s*=\s*new\s+ArrayList\s*<\s*String\s*>\s*\(\)/g, to: 'List<String> $1 = new ArrayList<>()', desc: 'generic type simplify' },
  ];

  const CPP_TRANSFORMS = [
    // std::endl → '\n' (drops the flush — accepted style normalization)
    { from: /\bstd::endl\b/g, to: "'\\n'", desc: 'endl → newline' },
    // if (x) { return true } else { return false } → return x
    { from: /\bif\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+true\s*;?\s*\}\s*else\s*\{\s*return\s+false\s*;?\s*\}/g, to: 'return $1', desc: 'bool return collapse' },
  ];

  const GO_TRANSFORMS = [
    // if err != nil {} (empty body) → removed (no-op)
    { from: /if\s+err\s*!=\s*nil\s*\{\s*\n\s*\}/g, to: '', desc: 'empty err check' },
    // go func() {}() (empty goroutine) → removed (no-op)
    { from: /\bgo\s+func\s*\(\s*\)\s*\{\s*\}\s*\(\)/g, to: '', desc: 'empty goroutine removal' },
  ];

  // Rust idioms (ownership, lifetimes, error types) are beyond safe
  // regex transforms — Nano handles Rust restructuring, CodeC applies
  // the shared universal set only.
  const RUST_TRANSFORMS = [];

  const LANGUAGE_TRANSFORMS = {
    python: [...SHARED_TRANSFORMS, ...PY_TRANSFORMS],
    javascript: [...SHARED_TRANSFORMS, ...JS_TRANSFORMS],
    typescript: [...SHARED_TRANSFORMS, ...JS_TRANSFORMS],
    java: [...SHARED_TRANSFORMS, ...JAVA_TRANSFORMS],
    cpp: [...SHARED_TRANSFORMS, ...CPP_TRANSFORMS],
    c: [...SHARED_TRANSFORMS, ...CPP_TRANSFORMS],
    go: [...SHARED_TRANSFORMS, ...GO_TRANSFORMS],
    rust: [...SHARED_TRANSFORMS, ...RUST_TRANSFORMS],
  };

  // Fallback for unknown languages: shared + JS-like transforms
  const DEFAULT_TRANSFORMS = [...SHARED_TRANSFORMS, ...JS_TRANSFORMS];

  function getTransforms(lang) {
    return LANGUAGE_TRANSFORMS[lang] || DEFAULT_TRANSFORMS;
  }

  // --- Apply transform tables to code-with-placeholders ---
  function applyTransforms(code, lang) {
    const transforms = getTransforms(lang);
    let result = code;
    let count = 0;
    for (const t of transforms) {
      const prev = result;
      result = result.replace(t.from, t.to);
      if (result !== prev) count++;
    }
    return { text: result, count };
  }

  // --- Full code cleanup pipeline ---
  function clean(code, lang) {
    if (isMinified(code)) {
      return { cleaned: code, minified: true, count: 0 };
    }
    const { code: extractedCode, extracted } = scanAndExtract(code);
    // Balance-check the literal-free code — brackets inside strings
    // must not trip the guard.
    if (!isBalanced(extractedCode)) {
      return { cleaned: code, balanced: false, count: 0 };
    }
    const { text, count } = applyTransforms(extractedCode, lang);
    const cleaned = restore(text, extracted);
    // Trim leading/trailing whitespace
    return { cleaned: cleaned.trim(), minified: false, count };
  }

  // --- Public API ---
  return {
    detectLanguage,
    clean,
    isBalanced,
    isMinified,
    scanAndExtract,
    restore,
    extractLockedTerms: CodeB.extractLockedTerms,
    applyTransforms,
    getTransforms,
    hasReservedWordCollision,
  };
})();


// ============================================================
// LANGUAGE DETECTION
// ============================================================

function detectLanguage(code) {
  if (!code || !code.trim()) return 'auto';
  // Shebang detection
  if (code.startsWith('#!/usr/bin/env python') || code.startsWith('#!/usr/bin/python')) return 'python';
  if (code.startsWith('#!/usr/bin/env node') || code.startsWith('#!/usr/local/bin/node')) return 'javascript';
  if (code.startsWith('#!/usr/bin/go') || code.startsWith('#!/usr/local/go/bin/go')) return 'go';
  // File extension hints (passed from app.js, but also sniff here)
  if (/\bdef\s+\w+\s*\(/.test(code) && /\bimport\s+\w+/.test(code)) return 'python';
  if (/\bfunction\s*\(|=>\s*\{|const\s+\w+\s*=/.test(code) && /\brequire\s*\(|import\s+.*\s+from\s+/.test(code)) return 'javascript';
  if (/\bpublic\s+static\s+void\s+main\s*\(/.test(code)) return 'java';
  if (/\bfunc\s+main\s*\(/.test(code)) return 'go';
  if (/\bfn\s+main\s*\(/.test(code) && /println!/.test(code)) return 'rust';
  if (/#include\s*</.test(code) && /int\s+main\s*\(/.test(code)) return 'cpp';
  if (/\btype\s+\w+\s*struct\b/.test(code)) return 'go';
  if (/\blet\s+\w+\s*:\s*\w+\s*=/.test(code)) return 'typescript';
  // Default to javascript if ambiguous
  if (/\b(var|let|const)\s+\w+\s*=/.test(code)) return 'javascript';
  return 'auto';
}

function getLanguageExtensions() {
  return {
    python: ['py', 'pyw'],
    javascript: ['js', 'jsx', 'mjs', 'cjs'],
    typescript: ['ts', 'tsx', 'mts', 'cts'],
    java: ['java'],
    cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hxx'],
    c: ['c', 'h'],
    go: ['go'],
    rust: ['rs'],
  };
}

function extensionToLang(ext) {
  const map = {
    py: 'python', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    java: 'java', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    c: 'c', h: 'c', go: 'go', rs: 'rust',
  };
  return map[ext] || 'auto';
}

function getSupportedExtensions() {
  return Object.values(getLanguageExtensions()).flat();
}
