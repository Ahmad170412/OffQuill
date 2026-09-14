/* OffQuill headless test harness (node tests/headless.mjs)
 *
 * Loads the REAL layers.js + code.js into a vm context with mocked
 * Chrome AI globals (LanguageModel, Translator) and runs assertion
 * checks over every pipeline stage. No Chrome, no flags, no model.
 *
 *   node tests/headless.mjs        # run all checks, exit 1 on failure
 *
 * The mocks are deterministic: canned prompt replies let us verify the
 * orchestration logic (best-candidate pick, locked-term verification,
 * gap guards, placeholder-free stitching) without a real model.
 */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- Canned mock behaviour (tests control these) ----
const mock = {
  promptReplies: [],   // shift()ed per prompt() call
  promptsSeen: [],
  translateImpl: null, // (pair, text) => string
};

// ---- Mock Chrome AI globals ----
function installMocks(ctx) {
  ctx.LanguageModel = {
    availability: async () => 'available',
    create: async ({ monitor } = {}) => {
      if (monitor) {
        try {
          monitor({ addEventListener: () => {} });
        } catch { /* ignore */ }
      }
      return {
        prompt: async (p) => {
          mock.promptsSeen.push(p);
          if (!mock.promptReplies.length) throw new Error('mock: no prompt reply queued');
          const r = mock.promptReplies.shift();
          if (r instanceof Error) throw r;
          return r;
        },
        destroy: () => {},
      };
    },
  };
  ctx.Translator = {
    availability: async () => 'available',
    create: async ({ sourceLanguage, targetLanguage, monitor } = {}) => {
      if (monitor) {
        try {
          monitor({ addEventListener: () => {} });
        } catch { /* ignore */ }
      }
      const pair = `${sourceLanguage}-${targetLanguage}`;
      return {
        translate: async (t) => (mock.translateImpl ? mock.translateImpl(pair, t) : t),
        destroy: () => {},
      };
    },
  };
}

// ---- Load real sources ----
const ctx = {};
for (const k of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'Date', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'RegExp', 'Map', 'Set', 'WeakMap', 'Promise', 'Error', 'console']) {
  ctx[k] = globalThis[k];
}
vm.createContext(ctx);
installMocks(ctx);
vm.runInContext(load('layers.js'), ctx);
vm.runInContext(
  `globalThis.__T = { LayerA, LayerB, LayerD, findProtectedSpans, ` +
  `countMissingSpans, lexicalDivergence, countWords, applyPhraseSwaps, ` +
  `fixMtCapitalization, fixMtTense, parenthesizeAppositives, varyRhythm, ` +
  `withTimeout };`,
  ctx
);
const T = ctx.__T;

// ---- Tiny assert framework ----
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}
function section(name) { console.log(`\n## ${name}`); }
const ZWJ = String.fromCodePoint(0x200D);

// ================= 1. Layer A =================
section('Layer A — unicode scrub');
{
  const zwsp = String.fromCodePoint(0x200B);
  ok(T.LayerA.clean('a' + zwsp + 'b').cleaned === 'ab', 'ZWSP stripped');

  const fam = String.fromCodePoint(0x1F468) + ZWJ + String.fromCodePoint(0x1F469) + ZWJ + String.fromCodePoint(0x1F467);
  const famOut = T.LayerA.clean(fam).cleaned;
  ok(famOut === fam, 'ZWJ family preserved', `got len ${famOut.length}, want ${fam.length}`);

  ok(T.LayerA.clean('a' + String.fromCodePoint(0xE0041) + 'b').cleaned === 'ab', 'tag char stripped');
  ok(T.LayerA.clean('a' + String.fromCodePoint(0xE000) + 'b').cleaned === 'ab', 'PUA stripped');
  ok(T.LayerA.clean('a' + String.fromCodePoint(0xE0100) + 'b').cleaned === 'ab', 'VS-supplement stripped');
  ok(T.LayerA.clean('a' + String.fromCodePoint(0xA0) + 'b').cleaned === 'a b', 'NBSP normalized');
  // U+202E override stripped, RLM preserved
  ok(T.LayerA.clean('a‮b').cleaned === 'ab', 'bidi override stripped');
  ok(T.LayerA.clean('a‏b').cleaned === 'a‏b', 'RLM preserved');
  // CJK variation selector kept; astral CJK + supplementary VS kept
  ok(T.LayerA.clean('漢️').cleaned === '漢️', 'CJK VS kept');
  const astralCjk = String.fromCodePoint(0x20000) + String.fromCodePoint(0xE0100);
  ok(T.LayerA.clean(astralCjk).cleaned === astralCjk, 'astral CJK + supp VS kept');
}

// ================= 2. Locked terms =================
section('Locked terms (incl. new bigram rule)');
{
  const txt = 'Organizations must leverage robust solutions. Teams using robust solutions ship faster. Data pipelines carry the data pipelines daily.';
  const spans = T.findProtectedSpans(txt);
  ok(spans.includes('robust solutions'), 'repeated bigram locked', JSON.stringify(spans));
  ok(spans.includes('Data pipelines'), 'second bigram locked (first-occurrence surface form)');
  // hyphenated pair must NOT lock a phantom joined form
  const hyp = 'Data-driven teams ship. Data-driven orgs scale. Done.';
  const hypSpans = T.findProtectedSpans(hyp);
  ok(!hypSpans.includes('data driven'), 'hyphenated phantom not locked', JSON.stringify(hypSpans));
  ok(T.findProtectedSpans('short').length >= 0, 'no crash on tiny input');
}
{
  // emoji locking: sequences lock, bare digits don't, budget capped
  const FAM = String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
  const s1 = T.findProtectedSpans(`morale improved too ${FAM}. Great work ✅ team`);
  ok(s1.includes(FAM), 'ZWJ family locked', JSON.stringify(s1));
  ok(s1.includes('✅'), 'single emoji locked');
  // digits lock via the NUMERIC rule (correct) — but the EMOJI pattern
  // itself must never match a bare digit (keycaps need U+20E3). Mirror
  // the source pattern and probe it directly.
  const EMOJI_CORE_T = '[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{2190}-\\u{25FF}\\u203C\\u2049\\u2122\\u2139\\u00A9\\u00AE\\u3030\\u303D\\u3297\\u3299][\\u{1F3FB}-\\u{1F3FF}]?\\uFE0F?';
  const emojiProbe = new RegExp(
    '[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F}|[#*0-9]\\uFE0F?\\u20E3|(?:' + EMOJI_CORE_T + ')(?:\\u200D(?:' + EMOJI_CORE_T + '))*', 'gu');
  ok('2019 the 2 cats'.match(emojiProbe) === null, 'emoji pattern ignores bare digits');
  const s3 = T.findProtectedSpans('keycap 1️⃣ test here');
  ok(s3.includes('1️⃣'), 'keycap locked');
  const s4 = T.findProtectedSpans('flags 🇬🇧 and 🇯🇵 here today');
  ok(s4.includes('🇬🇧') && s4.includes('🇯🇵'), 'RI flags locked');
  const s5 = T.findProtectedSpans('thumbs 👍🏽 up now');
  ok(s5.includes('👍🏽'), 'skin-tone sequence locked as one span');
  const many = ['😀','😁','😂','🤣','😊','😍','🤔','🙄','😴','🤯','🥳','😎','🤠','😇','🥺'].join(' ');
  const emoRe = /^(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{25FF}\u203C\u2049\u2122\u2139\u00A9\u00AE\u3030\u303D\u3297\u3299]|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})+$/u;
  const s6 = T.findProtectedSpans(many);
  ok(s6.filter((s) => emoRe.test(s)).length <= 10, 'emoji budget capped at 10', `got ${s6.filter((s) => emoRe.test(s)).length}`);
}

// ================= 3. Layer B orchestration =================
section('Layer B — best-candidate pick (mocked Nano)');
{
  T.LayerB.destroy();
  mock.promptsSeen = [];
  const src = 'NASA launched the probe. The results were unprecedented in scope.';
  const locked = T.findProtectedSpans(src);
  // candidate 1 drops a locked term, candidate 2 keeps everything
  mock.promptReplies = [
    'NASA launched the probe. Results were big.',           // drops "unprecedented"? (not locked) — craft sharper:
  ];
  // Sharper: lock NASA explicitly
  const locked2 = ['NASA'];
  mock.promptReplies = [
    'The probe was launched. Results were big.',            // drops NASA
    'NASA launched the probe with big results.',            // keeps NASA
  ];
  const res = await T.LayerB.paraphrase(src, 'medium', null, { candidates: 2, locked: locked2 });
  ok(res.text.includes('NASA'), 'picks candidate that keeps locked term', JSON.stringify(res.text));
  ok(res.missingSpans.length === 0, 'no missing spans on best pick');
  ok(res.candidates.length === 2, 'both candidates attempted');
  T.LayerB.destroy();
}
{
  // repair() keeps locked terms
  T.LayerB.destroy();
  mock.promptReplies = ['NASA probe launched fine.'];
  const r = await T.LayerB.repair('NASA probe launched fine.', ['NASA']);
  ok(r.missingSpans.length === 0, 'repair keeps locked terms');
  T.LayerB.destroy();
}
{
  // emoji in locked terms steers the best-candidate pick (mocked Nano)
  T.LayerB.destroy();
  const FAM = String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
  mock.promptReplies = [
    'Morale improved a lot this quarter.',          // drops emoji
    `Morale improved a lot this quarter ${FAM}`,    // keeps emoji
  ];
  const res = await T.LayerB.paraphrase(`Morale improved ${FAM} lots.`, 'medium', null, { candidates: 2, locked: [FAM] });
  ok(res.text.includes(FAM), 'picks candidate that keeps emoji', JSON.stringify(res.text));
  T.LayerB.destroy();
}

// ================= 4. Layer D orchestration =================
section('Layer D — round-trip stitching + guards (mocked MT)');
{
  T.LayerD.destroy();
  // identity MT: locked spans must survive byte-identical
  mock.translateImpl = (pair, t) => t;
  const locked = ['NASA', 'January 5, 2024'];
  const src = 'NASA launched on January 5, 2024 with great fanfare worldwide.';
  const rt = await T.LayerD.roundTrip(src, null, { locked });
  ok(rt.text === src, 'identity MT round-trips byte-identical', JSON.stringify(rt.text));
  for (const s of locked) ok(rt.text.includes(s), `locked survives: ${s}`);
  T.LayerD.destroy();
}
{
  // scrambling MT (10x expansion) trips the length guard -> gap kept
  T.LayerD.destroy();
  mock.translateImpl = (pair, t) => (t + ' ').repeat(10).trim();
  const src = 'Alpha beta gamma delta. Epsilon zeta eta theta here.';
  const rt = await T.LayerD.roundTrip(src, null, { locked: [] });
  ok(rt.kept > 0, 'scrambled gaps kept pre-translation', `kept=${rt.kept}`);
  T.LayerD.destroy();
}
{
  // POV guard: MT injecting first-person trips voice guard
  T.LayerD.destroy();
  mock.translateImpl = (pair, t) => (pair === 'ja-en' ? 'I think ' + t : t);
  const src = 'The probe launched at dawn. Engineers watched the telemetry.';
  const rt = await T.LayerD.roundTrip(src, null, { locked: [] });
  ok(rt.kept > 0, 'POV-injecting gaps kept', `kept=${rt.kept}`);
  T.LayerD.destroy();
}
{
  // locked emoji survives a hostile MT that rewrites every gap
  T.LayerD.destroy();
  const FAM = String.fromCodePoint(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
  mock.translateImpl = (pair, t) => 'REWRITTEN MT OUTPUT HERE';
  const src = `Hello team ${FAM} great work today everyone involved`;
  const rt = await T.LayerD.roundTrip(src, null, { locked: [FAM] });
  ok(rt.text.includes(FAM), 'emoji stitched back verbatim', JSON.stringify(rt.text));
  T.LayerD.destroy();
  mock.translateImpl = null;
}

// ================= 5. Layer C + post passes =================
section('Layer C + rhythm + parens + MT fixes');
{
  const p = T.applyPhraseSwaps('In order to delve into robust solutions, furthermore, it is important to note that we leverage AI.');
  ok(p.count >= 5, 'swaps fire', `count=${p.count}`);
  ok(!/in order to|delve into|furthermore|leverage/i.test(p.text), 'AI-isms gone', p.text);
  ok(T.applyPhraseSwaps('Hello world.').count === 0, 'clean text untouched');
}
{
  // rhythm: uniform paragraph merges; trailing fragment preserved
  const uni = 'This is a medium sentence here today. Another medium length sentence follows now. A third medium sentence comes right after. A fourth one ends the set nicely.';
  const r1 = T.varyRhythm(uni, uni);
  ok(r1.merges > 0, 'uniform rhythm merges', JSON.stringify(r1.text));
  const withTail = uni + ' trailing fragment with no period';
  const r2 = T.varyRhythm(withTail, withTail);
  ok(r2.text.includes('trailing fragment with no period'), 'trailing fragment preserved', JSON.stringify(r2.text));
  const varied = 'Short. This is a much longer sentence with many more words in it than the short one before it. Tiny.';
  ok(T.varyRhythm(varied, varied).text === varied, 'already-varied untouched');
}
{
  const pa = T.parenthesizeAppositives('AlexNet, a neural network, proved the point.');
  ok(pa.count === 1 && pa.text.includes('(a neural network)'), 'appositive parenthesized');
  ok(T.fixMtTense('GPT-3 will be released in 2020') === 'GPT-3 was released in 2020', 'past-year tense fixed');
  ok(T.fixMtTense('It will be released in 2099').includes('will be'), 'future year untouched');
}

// ================= 6. app.js static checks =================
section('app.js static checks');
{
  // Strip comments + string literals, then no bare identifier may remain
  // (the getElementById('...') lookup and comments are fine).
  const stripped = load('app.js')
    .replace(/\/\/.*$/gm, '')
    .replace(/getElementById\('translateToggleWrap'\)/g, '')
    .replace(/(['"`])[^'"`\n]*\1/g, '');
  ok(!/\btranslateToggleWrap\b/.test(stripped), 'no bare translateToggleWrap global');
  ok(!/\b(CodeB|CodeC|detectLanguage|extensionToLang|runCodePipeline|applyMode|codeLang)\b/.test(stripped),
    'no code-mode references in app.js');
  ok(!/\b(dropZone|fileInput|readFile|MAX_FILE_BYTES|FileReader)\b/.test(stripped),
    'no file-drop references in app.js');
}
{
  // privacy posture: zero third-party requests, CSP denies page network
  const html = load('index.html');
  ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), 'no webfont requests');
  ok(/http-equiv="Content-Security-Policy"/.test(html), 'CSP meta present');
  ok(/connect-src 'none'/.test(html), "CSP denies page-initiated network");
  ok(/script-src 'self'/.test(html) && !/unsafe-inline/.test(html), 'no inline-script allowance');
}
{
  // locked terms with literal quotes are escaped as one unit in prompts
  T.LayerB.destroy();
  mock.promptsSeen = [];
  mock.promptReplies = ['NASA launched fine.'];
  await T.LayerB.paraphrase('NASA launched fine.', 'light', null, { candidates: 1, locked: ['"secret"'] });
  ok(mock.promptsSeen[0].includes('\\"secret\\"'), 'quoted span escaped in prompt', mock.promptsSeen[0].slice(0, 200));
  T.LayerB.destroy();
}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:', failures.join(' | ')); process.exit(1); }
