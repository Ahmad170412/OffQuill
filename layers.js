/* ============================================================
   OffQuill — Processing Layers (pure logic, no DOM)
   Layer A: Unicode scrubbing (ported from watermarks-remover)
   Layer B: Gemini Nano paraphrasing via Chrome built-in AI
   Layer C: Phrase swaps (deterministic AI-ism polish)
   Layer D: EN→JA→EN translation round-trip (Chrome Translator API)
   ============================================================ */

// ============================================================
// LAYER A — Unicode Scrubbing
// Ported from guillaumemeyer/watermarks-remover text_unicode.py
// ============================================================

const LayerA = (() => {

  // Characters to strip outright
  const STRIP = new Set([
    0x00AD,   // soft hyphen
    0x034F,   // combining grapheme joiner
    0x061C,   // Arabic letter mark
    0x115F,   // Hangul choseong filler
    0x1160,   // Hangul jungseong filler
    0x17B4, 0x17B5, // Khmer vowels
    0x180B, 0x180C, 0x180D, 0x180E, 0x180F, // Mongolian FVS
    0x200B,  // ZWSP
    0x200C,  // ZWNJ
    0x200D,  // ZWJ
    0x200E, 0x200F, // LRM, RLM
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E, // bidi embeddings/overrides
    0x2060,  // word joiner
    0x2061, 0x2062, 0x2063, 0x2064, // invisible math
    0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
    0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F,
    0xFEFF,  // BOM / ZWNBSP
    0x3164,  // Hangul filler
    0xFFA0,  // halfwidth Hangul filler
    0xFFF9, 0xFFFA, 0xFFFB, // interlinear annotation
  ]);

  // Variation selectors (FE0x + supplementary E010x)
  const VS_SUPPLEMENT_START = 0xE0100;
  const VS_SUPPLEMENT_END   = 0xE01EF;

  // Space homoglyphs → normal space
  const SPACES = new Map([
    [0x00A0, ' '],  // no-break space
    [0x1680, ' '],  // Ogham
    [0x2000, ' '], [0x2001, ' '], [0x2002, ' '], [0x2003, ' '],
    [0x2004, ' '], [0x2005, ' '], [0x2006, ' '], [0x2007, ' '],
    [0x2008, ' '], [0x2009, ' '], [0x200A, ' '],
    [0x202F, ' '],  // narrow no-break space
    [0x205F, ' '],  // medium mathematical space
    [0x3000, ' '],  // ideographic space
  ]);

  // Tag characters (U+E0001-U+E007F)
  function isTagChar(cp) { return cp >= 0xE0001 && cp <= 0xE007F; }

  // Noncharacters: FDD0-FDEF + xFFFE/xFFFF per plane
  function isNoncharacter(cp) {
    return (cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE;
  }

  // Reserved ignorable ranges
  function isReservedIgnorable(cp) {
    if (cp === 0x2065 || cp === 0xE0000) return true;
    if (cp >= 0xFFF0 && cp < 0xFFF9) return true;
    if (cp >= 0xE0080 && cp < 0xE0100) return true;
    if (cp >= 0xE01F0 && cp < 0xE1000) return true;
    return false;
  }

  // Private use (BMP + supplementary)
  function isPrivateUse(cp) {
    return (cp >= 0xE000 && cp <= 0xF8FF)
        || (cp >= 0xF0000 && cp <= 0xFFFFD)
        || (cp >= 0x100000 && cp <= 0x10FFFD);
  }

  // Bidi codepoints
  const BIDI = new Set([
    0x061C, 0x200E, 0x200F,
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
    0x2066, 0x2067, 0x2068, 0x2069,
  ]);

  // Preservable bidi (directional marks/isolates — legitimate in mixed RTL)
  const PRESERVE_BIDI = new Set([0x061C, 0x200E, 0x200F, 0x2066, 0x2067, 0x2068, 0x2069]);

  // Emoji glue
  const EMOJI_GLUE = new Set([0x200D, 0xFE0E, 0xFE0F]);

  // Emoji base detection
  function isEmojiBase(cp) {
    if (cp >= 0x1F000 && cp <= 0x1FAFF) return true;
    if (cp >= 0x2190 && cp <= 0x25FF) return true;
    if (cp >= 0x2600 && cp <= 0x27BF) return true;
    if (cp >= 0x2B00 && cp <= 0x2BFF) return true;
    if ([0x203C, 0x2049, 0x2139, 0x2934, 0x2935,
         0x00A9, 0x00AE, 0x2122, 0x3030, 0x303D, 0x3297, 0x3299].includes(cp)) return true;
    if (cp === 0x0023 || cp === 0x002A || (cp >= 0x0030 && cp <= 0x0039)) return true;
    return false;
  }

  // CJK ideograph detection
  function isCJK(cp) {
    return (cp >= 0x3400 && cp <= 0x4DBF)
        || (cp >= 0x4E00 && cp <= 0x9FFF)
        || (cp >= 0xF900 && cp <= 0xFAFF)
        || (cp >= 0x20000 && cp <= 0x323AF);
  }

  // Script joiners (ZWNJ/ZWJ — orthographic in Arabic/Indic)
  const SCRIPT_JOINERS = new Set([0x200C, 0x200D]);
  const TAG_RANGE_START = 0xE0020;
  const TAG_RANGE_END   = 0xE007E;

  // Mongolian FVS
  const MONG_FVS = new Set([0x180B, 0x180C, 0x180D, 0x180F]);

  // Orthographic Cf (Arabic/Syriac)
  const ORTHO_CF = new Set([0x0600,0x0601,0x0602,0x0603,0x0604,0x0605,0x06DD,0x070F,0x08E2,0x110BD,0x110CD]);

  // Variation selector ranges
  function isVS(cp) {
    return (cp >= 0xFE00 && cp <= 0xFE0F)
        || (cp >= VS_SUPPLEMENT_START && cp <= VS_SUPPLEMENT_END)
        || MONG_FVS.has(cp);
  }

  // Valid flag tag sequences (e.g. subdivision flags like England).
  // All participants are astral (2 UTF-16 units each) — step by whole
  // codepoints, not units, or nothing ever matches. The returned set
  // holds EVERY unit index of valid sequences (clean() may probe low
  // surrogates after its own pair-skip).
  function findValidFlagTags(text) {
    const valid = new Set();
    const step = (idx) => (text.codePointAt(idx) > 0xFFFF ? 2 : 1);
    let i = 0;
    while (i < text.length) {
      if (text.codePointAt(i) !== 0x1F3F4) { i += step(i); continue; }
      let j = i + 2; // skip the 0x1F3F4 surrogate pair
      while (j < text.length) {
        const cp = text.codePointAt(j);
        if (cp >= 0xE0020 && cp <= 0xE007E) { j += 2; continue; }
        break;
      }
      if (j > i + 2 && j < text.length && text.codePointAt(j) === 0xE007F) {
        for (let k = i; k <= j + 1; k++) valid.add(k);
        i = j + 2;
      } else { i += 2; }
    }
    return valid;
  }

  // Mongolian letter check
  function isMongolianLetter(cp) {
    return cp >= 0x1800 && cp <= 0x18AF;
  }

  // Strip decision
  function shouldStrip(cp) {
    if (STRIP.has(cp)) return true;
    if (cp >= VS_SUPPLEMENT_START && cp <= VS_SUPPLEMENT_END) return true;
    if (isTagChar(cp)) return true;
    if (isNoncharacter(cp)) return true;
    if (isReservedIgnorable(cp)) return true;
    if (isPrivateUse(cp)) return true;
    return false;
  }

  /**
   * Clean text: strip invisible Unicode, normalize spaces.
   * Returns { cleaned, stats }
   */
  function clean(text) {
    const validFlags = findValidFlagTags(text);
    let removed = 0, replaced = 0;
    const out = [];
    const kinds = new Map();

    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i);
      // Full character (astral chars are 2 UTF-16 units — pushing text[i]
      // alone would emit a lone surrogate and corrupt emoji/CJK-ext).
      const ch = cp > 0xFFFF ? text.slice(i, i + 2) : text[i];
      // Skip surrogate pair low halves
      if (cp > 0xFFFF) i++;

      // Preservable bidi — keep
      if (PRESERVE_BIDI.has(cp)) {
        out.push(ch);
        continue;
      }

      // Emoji glue — keep if part of emoji sequence
      if (EMOJI_GLUE.has(cp)) {
        const prev = i > 0 ? text.codePointAt(i - 1) : null;
        const next = i + 1 < text.length ? text.codePointAt(i + 1) : null;
        if (cp === 0xFE0E || cp === 0xFE0F) {
          if (prev !== null && isEmojiBase(prev)) { out.push(ch); continue; }
        }
        if (cp === 0x200D && prev !== null && next !== null) {
          if (isEmojiBase(prev) && isEmojiBase(next)) { out.push(ch); continue; }
        }
      }

      // Script joiners in valid script context
      if (SCRIPT_JOINERS.has(cp)) {
        const prev = i > 0 ? text.codePointAt(i - 1) : null;
        const next = i + 1 < text.length ? text.codePointAt(i + 1) : null;
        if (prev !== null && next !== null && isMongolianLetter(prev) && isMongolianLetter(next)) {
          out.push(ch); continue;
        }
      }

      // Valid flag tag chars (+ E007F terminator of a valid sequence)
      if ((cp >= TAG_RANGE_START && cp <= TAG_RANGE_END) || cp === 0xE007F) {
        if (validFlags.has(i)) { out.push(ch); continue; }
      }

      // Mongolian FVS after Mongolian letter
      if (MONG_FVS.has(cp)) {
        const prev = i > 0 ? text.codePointAt(i - 1) : null;
        if (prev !== null && isMongolianLetter(prev)) { out.push(ch); continue; }
      }

      // CJK VS
      if (isVS(cp)) {
        const prev = i > 0 ? text.codePointAt(i - 1) : null;
        if (prev !== null && isCJK(prev)) { out.push(ch); continue; }
      }

      // Orthographic Cf
      if (ORTHO_CF.has(cp)) { out.push(ch); continue; }

      // Main strip check
      if (shouldStrip(cp)) {
        removed++;
        const kind = tagKind(cp);
        kinds.set(kind, (kinds.get(kind) || 0) + 1);
        continue;
      }

      // Space normalization
      if (SPACES.has(cp)) {
        out.push(' ');
        replaced++;
        kinds.set('space', (kinds.get('space') || 0) + 1);
        continue;
      }

      // Cf category (other format chars)
      if (cp >= 0x200 && cp <= 0x206F && !SPACES.has(cp) && !BIDI.has(cp)) {
        // Some Cf in this range are legitimate punctuation, skip broad filter
      }

      out.push(ch);
    }

    return {
      cleaned: out.join(''),
      stats: { removed, replaced, kinds: Object.fromEntries(kinds) }
    };
  }

  function tagKind(cp) {
    if (isTagChar(cp)) return 'tag_chars';
    if (isNoncharacter(cp)) return 'noncharacter';
    if (isReservedIgnorable(cp)) return 'reserved_ignorable';
    if (isVS(cp)) return 'variation_selector';
    if (BIDI.has(cp)) return 'bidi';
    if ([0x200B,0x200C,0x200D,0x2060,0xFEFF,0x180E].includes(cp)) return 'zwj_family';
    if (isPrivateUse(cp)) return 'private_use';
    return 'strip';
  }

  return { clean };

})();


// ============================================================
// FIDELITY — locked terms + divergence scoring
// ============================================================

const STOP_WORDS = new Set([
  'A', 'An', 'The', 'This', 'That', 'These', 'Those',
  'Every', 'Each', 'Then', 'Suddenly', 'Next', 'After', 'Since',
  'Well', 'Okay', 'Please', 'And', 'But', 'Or', 'If', 'When',
  'He', 'She', 'It', 'They', 'We', 'His', 'Her', 'Its', 'Their', 'Our',
  'There', 'Here', 'More', 'Most', 'Such', 'Same', 'Other', 'Another',
]);

function cleanSpan(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function findProtectedSpans(text, max = 20) {
  const spans = new Map(); // span -> count
  const add = (s) => {
    s = cleanSpan(s);
    if (!s || s.length > 60) return;
    spans.set(s, (spans.get(s) || 0) + 1);
  };

  let m;
  const quoted = /"([^"\n]{1,60})"|'([^'\n]{1,60})'|“([^”\n]{1,60})”|‘([^’\n]{1,60})’/g;
  while ((m = quoted.exec(text))) add(m[1] || m[2] || m[3] || m[4]);

  const contact = /\b(?:https?:\/\/[^\s)]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
  while ((m = contact.exec(text))) add(m[0]);

  const month = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\b/g;
  while ((m = month.exec(text))) add(m[0]);

  const numeric = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:19|20)\d{2}\b|\b\d+(?:[.,]\d+)?(?:\s?(?:%|percent|USD|EUR|GBP|kg|g|km|ms|s|px|GB|MB|KB|years?|months?|weeks?|days?|hours?|minutes?|seconds?))?\b/gi;
  while ((m = numeric.exec(text))) add(m[0]);

  const acronym = /\b[A-Z0-9]{2,}(?:[-/][A-Z0-9]+)*\b/g;
  while ((m = acronym.exec(text))) add(m[0]);

  // Word-form numbers with units ("three seconds", "twenty people") —
  // the digit-only pattern misses these, and MT rewrites them freely.
  const wordNum = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)(?:\s+(?:hundred|thousand|million))?\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|people|men|women|children|times)\b/gi;
  while ((m = wordNum.exec(text))) add(m[0]);

  // Conservative name lock: repeated capitalized tokens (likely names),
  // not one-off sentence starters or generic style phrases.
  // Occurrence counting early-exits at 3 (we only need "≥2") — a full
  // split() per candidate is O(n²) and hangs on large pastes.
  const title = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g;
  while ((m = title.exec(text))) {
    const phrase = cleanSpan(m[0]);
    if (STOP_WORDS.has(phrase)) continue;
    if (phrase.length < 3) continue;
    let occurrences = 0;
    let pos = -1;
    while (occurrences < 3 && (pos = text.indexOf(phrase, pos + 1)) !== -1) {
      occurrences++;
    }
    if (occurrences < 2) continue;
    add(phrase);
  }

  return [...spans.keys()]
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}

function countMissingSpans(output, spans) {
  return spans.filter((s) => !output.includes(s));
}

function wordBigrams(text) {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  const set = new Set();
  for (let i = 0; i + 1 < words.length; i++) set.add(words[i] + ' ' + words[i + 1]);
  return set;
}

function lexicalDivergence(a, b) {
  const A = wordBigrams(a);
  const B = wordBigrams(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? 1 - inter / union : 0;
}

function countWords(text) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// Race a promise against a timeout so a hung on-device call can never
// wedge the UI (button stays disabled) forever. Rejects on timeout;
// the caller's existing try/catch turns it into a graceful fallback.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// First-person pronoun count. Used as a POV-tripwire: if translation
// introduces I/me/my/we/etc. that weren't in the source, the MT broke
// narrator voice ("My computer screen" in a third-person story).
function countFirstPerson(text) {
  const m = String(text).match(/\b(I|me|my|mine|we|us|our|ours|myself|ourselves)\b/gi);
  return m ? m.length : 0;
}


// ============================================================
// LAYER B — Gemini Nano Paraphrasing (Chrome Built-in AI)
// ============================================================

const LayerB = (() => {

  let session = null;
  let availabilityState = 'unavailable';

  // Check if the API is available
  async function checkAvailability() {
    if (typeof LanguageModel === 'undefined') {
      availabilityState = 'unavailable';
      return 'unavailable';
    }
    try {
      availabilityState = await LanguageModel.availability();
      return availabilityState;
    } catch {
      availabilityState = 'unavailable';
      return 'unavailable';
    }
  }

  // Create or get session
  async function getSession(onProgress) {
    if (session) return session;

    const avail = await checkAvailability();
    if (avail === 'unavailable') {
      throw new Error('Gemini Nano is not available on this device. Check Chrome flags.');
    }

    session = await LanguageModel.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          // e.loaded is a fraction 0..1 — multiply by 100 for display
          if (onProgress) onProgress(e.loaded * 100);
        });
      },
    });

    return session;
  }

  // Build paraphrase prompt based on strength
  function buildPrompt(text, strength, locked = []) {
    const human = `You are rewriting text to sound like a natural, confident human wrote it — not a bot, not a thesaurus, not an AI. No filler phrases like "delve into" or "it's not just X, it's Y." No unnecessary superlatives. No corporate jargon. Write like a real person talking to a smart friend.`;

    const facts = `RULE 1 (absolute): Every fact, name, date, number, and data point MUST stay EXACTLY as-is. Do not add, remove, or alter any information.`;

    const pov = `RULE 2 (absolute): Keep the EXACT same point of view, tense, and narrator. If the text is third-person ("Leo climbed"), it stays third-person — never switch to first-person ("I noticed", "I was telling"). Never insert yourself as a narrator, never add "you know" style framing, never change who speaks, acts, or observes. Same characters, same roles, same perspective.`;

    const lockedRule = locked.length
      ? `LOCKED TERMS (absolute): These exact strings must appear UNCHANGED in the output, same spelling and case: ${locked.map((s) => `"${s}"`).join(', ')}. Never drop, reword, or "synonymize" them.`
      : '';

    const voice = `VOICE RULE (absolute): Write plainly. Prefer short, direct sentences over long flowing ones. FORBIDDEN — never use these or anything shaped like them:
- Poetic metaphors: "woven into the fabric of", "tapestry", "landscape", "symphony", "dance", "journey" (unless the text is literally about travel)
- Emotion formulas: "a surge of", "a wave of", "a mixture of", "was filled with", "overwhelmed by"
- Solemn filler: "with a certain gravity", "with a sense of", "profoundly", "poignant"
- Inflated verbs: "embark", "unleash", "harness", "showcase", "illuminate", "underscore"
Say the plain thing. "He was confused and nervous" beats "he felt a surge of confusion mixed with a touch of unease" every time. Plain words, plain order, no decoration.`;

    const output = `OUTPUT RULE: Return ONLY the rewritten text. No explanations, no bullet points, no notes about what you changed. Just the clean rewritten text and nothing else. MARKDOWN RULE: Keep any markdown formatting (bold, italics, headers, lists) EXACTLY as it appears in the original — same spans, same markers. Never add new markdown formatting that wasn't in the original.`;

    const instructions = {
      light: `${human}\n${facts}\n${pov}\n${voice}\n${lockedRule}\n${output}\n\nThis is LIGHT editing only. Keep the sentence structure almost identical. Only change obvious filler words and awkward phrasing. Do NOT replace key nouns, verbs, or adjectives with synonyms — keep specific terms like "artificial intelligence", "efficiency", "team" etc EXACTLY as written. This is a polish pass, not a rewrite.\n\nText:\n${text}`,

      medium: `${human}\n${facts}\n${pov}\n${voice}\n${lockedRule}\n${output}\n\nRewrite this so it sounds like the SAME narrator wrote it from scratch, keeping the same meaning and same point of view. Vary sentence length. Use plain language. Cut anything that sounds robotic or padded. The result should feel effortless, like natural speech — but from the same voice, not a new one.\n\nText:\n${text}`,

      strong: `${human}\n${facts}\n${pov}\n${voice}\n${lockedRule}\n${output}\n\nCompletely rewrite this with new sentence structures, fresh phrasing, and zero copied patterns — but retold by the SAME narrator, in the SAME person and tense. Do not frame it as your own retelling ("you know", "I was telling", "let me explain"). Sound like a real person — clear and confident. If the original sounds like AI, make this sound like the opposite, without changing who is telling the story.\n\nText:\n${text}`,
    };

    return instructions[strength] || instructions.medium;
  }

  // Paraphrase text — optionally generates multiple candidates and
  // returns the most lexically diverged one that keeps locked terms.
  async function paraphrase(text, strength, onProgress, opts = {}) {
    const candidates = Math.max(1, opts.candidates || 1);
    const locked = opts.locked || [];
    const s = await getSession(onProgress);

    const results = [];
    for (let i = 0; i < candidates; i++) {
      if (opts.onVariant) opts.onVariant(i + 1, candidates);
      const prompt = i === 0
        ? buildPrompt(text, strength, locked)
        : `Write another DIFFERENT version of the same text. Same facts, same locked terms, same point of view, same output rule: return only the rewritten text.`;
      const result = await withTimeout(s.prompt(prompt), 120000, 'Paraphrase');
      const missing = countMissingSpans(result, locked);
      results.push({
        text: result,
        missing: missing.length,
        missingSpans: missing,
        divergence: lexicalDivergence(text, result),
      });
    }

    results.sort((a, b) => (a.missing - b.missing) || (b.divergence - a.divergence));
    const best = results[0];
    return {
      text: best.text,
      candidates: results.map((r) => ({ missing: r.missing, divergence: r.divergence })),
      missingSpans: best.missingSpans,
      divergence: best.divergence,
    };
  }

  // Repair pass: fix ONLY grammar and word order in MT output.
  // Separate from paraphrase on purpose — minimal-change prompt, single
  // candidate, no creativity. Locked terms enforced the same way.
  // Returns { text, missingSpans } so the caller can discard bad repairs.
  async function repair(text, locked = []) {
    const s = await getSession();
    const lockedRule = locked.length
      ? `LOCKED TERMS (absolute): These exact strings must appear UNCHANGED in the output, same spelling and case: ${locked.map((x) => `"${x}"`).join(', ')}.`
      : '';
    const prompt = `Fix ONLY the grammar and word order of this text. Do NOT rephrase, do NOT substitute synonyms, do NOT add ideas, flourishes, or new words beyond minimal glue (articles, prepositions) needed for grammatical sentences. You may move words and fix verb forms. Every fact, name, number, and locked term stays byte-identical.\n${lockedRule}\nReturn ONLY the repaired text, nothing else.\n\nText:\n${text}`;
    const out = await withTimeout(s.prompt(prompt), 90000, 'Repair');
    return { text: out, missingSpans: countMissingSpans(out, locked) };
  }

  // Destroy session (cleanup)
  function destroy() {
    if (session) {
      session.destroy();
      session = null;
    }
  }

  return { checkAvailability, getSession, paraphrase, repair, destroy, getState: () => availabilityState };

})();


// ============================================================
// LAYER C — Phrase swaps (deterministic AI-ism polish)
// Runs after Layer B / Layer D. Phrase-level only — no single-word
// context-dependent swaps. No AI calls.
// ============================================================

const PHRASE_SWAPS = [
  // === Deletable filler (replaced with nothing) ===
  { from: 'it is important to note that', to: [''] },
  { from: 'it is worth noting that', to: [''] },
  { from: 'it should be noted that', to: [''] },
  { from: 'it is important to note,', to: [''] },
  { from: 'it is worth noting,', to: [''] },
  { from: 'it should be noted,', to: [''] },
  { from: 'it goes without saying that', to: [''] },
  { from: 'needless to say,', to: [''] },
  { from: 'as a matter of fact,', to: [''] },
  { from: "in today's world,", to: [''] },
  { from: 'in this day and age,', to: [''] },
  { from: 'at the end of the day,', to: [''] },
  { from: "it's hard to believe", to: [''] },

  // === Verbose → concise ===
  { from: 'in order to', to: ['to'] },
  { from: 'due to the fact that', to: ['because'] },
  { from: 'because of the fact that', to: ['because'] },
  { from: 'at this point in time', to: ['now', 'right now'] },
  { from: 'for the purpose of', to: ['to', 'for'] },
  { from: 'in the event that', to: ['if'] },
  { from: 'on a daily basis', to: ['daily', 'every day'] },
  { from: 'on a regular basis', to: ['regularly', 'often'] },
  { from: 'in the near future', to: ['soon'] },
  { from: 'there was a time when', to: ['once,', 'one day,'] },
  { from: 'in many areas', to: ['in a lot of places', 'everywhere'] },
  { from: 'in the process of', to: ['while'] },
  { from: 'has the ability to', to: ['can'] },
  { from: 'is able to', to: ['can'] },

  // === AI jargon → plain English ===
  { from: 'delve deeper into', to: ['look at', 'explore'] },
  { from: 'delve into', to: ['look at', 'explore', 'dig into'] },
  { from: 'robust solutions', to: ['strong tools', 'solid solutions'] },
  { from: 'paradigm shift', to: ['big change', 'major shift'] },
  { from: 'seamless integration', to: ['smooth connection', 'easy integration'] },
  { from: 'game-changing', to: ['major', 'big', 'huge'] },
  { from: 'cutting-edge', to: ['advanced', 'modern', 'latest'] },
  { from: 'state-of-the-art', to: ['modern', 'advanced', 'latest'] },
  { from: 'holistic approach', to: ['full approach', 'complete approach'] },
  { from: 'leverage', to: ['use'] },
  { from: 'foster', to: ['encourage', 'support'] },
  { from: 'utilize', to: ['use'] },
  { from: 'streamline', to: ['simplify', 'speed up'] },
  { from: 'facilitate', to: ['help', 'enable'] },
  { from: 'endeavor', to: ['try', 'attempt'] },
  { from: 'unprecedented', to: ['new', 'huge', 'massive'] },

  // === Verb inflections (tense-correct replacements) ===
  { from: 'leverages', to: ['uses'] },
  { from: 'leveraged', to: ['used'] },
  { from: 'leveraging', to: ['using'] },
  { from: 'fosters', to: ['encourages'] },
  { from: 'fostered', to: ['encouraged'] },
  { from: 'fostering', to: ['encouraging'] },
  { from: 'utilizes', to: ['uses'] },
  { from: 'utilized', to: ['used'] },
  { from: 'utilizing', to: ['using'] },
  { from: 'streamlines', to: ['simplifies'] },
  { from: 'streamlined', to: ['simplified'] },
  { from: 'streamlining', to: ['simplifying'] },
  { from: 'facilitates', to: ['helps'] },
  { from: 'facilitated', to: ['helped'] },
  { from: 'facilitating', to: ['helping'] },
  { from: 'endeavors', to: ['tries'] },
  { from: 'endeavored', to: ['tried'] },
  { from: 'endeavoring', to: ['trying'] },
  { from: 'delves into', to: ['looks at'] },
  { from: 'delved into', to: ['looked at'] },
  { from: 'delving into', to: ['looking at'] },

  // === Quick patches (38% run survivors) ===
  { from: "in ways he hadn't imagined", to: ['completely'] },
  { from: "in ways she hadn't imagined", to: ['completely'] },
  { from: "in ways they hadn't imagined", to: ['completely'] },
  { from: "in ways I hadn't imagined", to: ['completely'] },
  { from: 'in ways nobody imagined', to: ['completely'] },
  { from: 'felt completely', to: ['felt', 'seemed'] },
  { from: 'seemed to consider', to: ['considered'] },

  // === Transitions ===
  { from: 'furthermore,', to: ['Also,', 'Plus,'] },
  { from: 'moreover,', to: ['Also,'] },
  { from: 'consequently,', to: ['So,', 'As a result,'] },
  { from: 'subsequently,', to: ['Then,', 'After that,'] },
  { from: 'nevertheless,', to: ['But,', 'Still,'] },
  { from: 'hence,', to: ['So,'] },
  { from: 'thus,', to: ['So,'] },
  { from: 'additionally,', to: ['Also,'] },
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchCase(original, replacement) {
  if (!replacement) return '';
  const letters = original.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Common abbreviations — never capitalize the word after these,
// even when a deletion happened nearby.
const ABBREV_GUARD = /(\be\.g|\bi\.e|\betc|\bvs|\bmr|\bmrs|\bms|\bdr|\bst|\bno)\.?$/i;

function applyPhraseSwaps(text) {
  let result = text;
  let count = 0;
  let didDelete = false;

  for (const swap of PHRASE_SWAPS) {
    const deletable = swap.to.length === 1 && swap.to[0] === '';
    // Deletable filler also absorbs a trailing comma + whitespace:
    // "It is important to note, X" → "X", not ", X".
    const pattern = deletable
      ? new RegExp(`\\b${escapeRegExp(swap.from)}(?!\\w)\\s*,?\\s*`, 'gi')
      : new RegExp(`\\b${escapeRegExp(swap.from)}(?!\\w)`, 'gi');
    result = result.replace(pattern, (match) => {
      count++;
      if (deletable) didDelete = true;
      const pick = swap.to[Math.floor(Math.random() * swap.to.length)];
      return matchCase(match, pick);
    });
  }

  // Tidy up after deletions: collapse double spaces, fix orphan spacing
  // before punctuation, trim.
  result = result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();

  // After deletions a sentence can start lowercase ("AI. just how...").
  // Capitalize sentence starts, guarding common abbreviations.
  if (didDelete) {
    result = result.replace(/(^|[.!?…]\s+)(["“']?)([a-z])/g, (m, pre, quote, ch, off, str) => {
      const tail = str.slice(0, off + pre.length).trimEnd();
      if (ABBREV_GUARD.test(tail)) return m;
      return pre + quote + ch.toUpperCase();
    });
  }

  return { text: result, count };
}


// ============================================================
// LAYER D — EN→JA→EN Translation Round-Trip
// Chrome built-in Translator API. Optional step between Layer B
// and Layer C. Reconstructs text through Japanese, breaking
// English AI-idiom patterns at the distribution level.
// ============================================================

const LayerD = (() => {

  // Translators created during the current run (destroyed after).
  let active = [];
  let availabilityState = 'unknown';

  function supported() {
    return typeof Translator !== 'undefined';
  }

  async function pairAvailability(sourceLanguage, targetLanguage) {
    if (!supported()) return 'unavailable';
    try {
      return await Translator.availability({ sourceLanguage, targetLanguage });
    } catch {
      return 'unavailable';
    }
  }

  // 'available' | 'downloadable' (packs needed) | 'unavailable' | 'unsupported'
  async function checkAvailability() {
    if (!supported()) {
      availabilityState = 'unsupported';
      return 'unsupported';
    }
    try {
      const [enJa, jaEn] = await Promise.all([
        pairAvailability('en', 'ja'),
        pairAvailability('ja', 'en'),
      ]);
      if (enJa === 'available' && jaEn === 'available') {
        availabilityState = 'available';
      } else if (enJa === 'unavailable' || jaEn === 'unavailable') {
        availabilityState = 'unavailable';
      } else {
        availabilityState = 'downloadable';
      }
      return availabilityState;
    } catch {
      availabilityState = 'unavailable';
      return 'unavailable';
    }
  }

  // Translators cached by pair for the current run.
  const cache = {};

  async function getTranslator(sourceLanguage, targetLanguage, onProgress) {
    const key = sourceLanguage + '-' + targetLanguage;
    if (cache[key]) return cache[key];
    const t = await Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          // e.loaded is a fraction 0..1
          if (onProgress) onProgress(e.loaded * 100);
        });
      },
    });
    cache[key] = t;
    active.push(t);
    return t;
  }

  // Warm up both translators. MUST be called synchronously inside the
  // click handler: create() for a downloadable pair consumes transient
  // user activation, which expires ~5s after the click — long before
  // Layer B finishes. Downloads then run in parallel with Layers A/B.
  // Resolves true on success, or the Error on failure (never rejects).
  let warmupPromise = null;
  function warmup(onProgress) {
    if (!warmupPromise) {
      warmupPromise = Promise.all([
        getTranslator('en', 'ja', (pct) => onProgress && onProgress('en-ja', pct)),
        getTranslator('ja', 'en', (pct) => onProgress && onProgress('ja-en', pct)),
      ])
        .then(() => true)
        .catch((err) => {
          warmupPromise = null;
          return err instanceof Error ? err : new Error(String(err));
        });
    }
    return warmupPromise;
  }

  // Long texts go through streaming to avoid timeouts.
  // Streaming yields progressively longer strings — last chunk wins.
  async function translateText(t, text) {
    if (text.length > 2000 && typeof t.translateStreaming === 'function') {
      return withTimeout((async () => {
        let out = '';
        let saw = false;
        const stream = t.translateStreaming(text);
        for await (const chunk of stream) { out = chunk; saw = true; }
        if (saw && out) return out;
        return t.translate(text);
      })(), 180000, 'Streaming translation');
    }
    return withTimeout(t.translate(text), 120000, 'Translation');
  }

  // Full round-trip. onProgress(pair, a, b):
  //   ('en-ja' | 'ja-en', pct) — download progress (warmup phase)
  //   ('segments', done, total) — per-piece translation progress
  // opts.locked: spans to placeholder through translation and restore
  // byte-identical afterwards (names, quotes, numbers survive JA→EN).
  // Structure: text is split on newline runs; each piece is translated
  // separately and separators are passed through verbatim, so paragraph
  // and line breaks survive. Returns { text, unrestored }.
  async function roundTrip(text, onProgress, opts = {}) {
    const locked = (opts.locked || []).slice().sort((a, b) => b.length - a.length);

    // 1. Substitute placeholders (longest spans first).
    let working = String(text).replace(/\r\n?/g, '\n');
    const tokens = [];
    locked.forEach((span, i) => {
      if (!span || !working.includes(span)) return;
      const token = `ZZZ${i}ZZZ`;
      working = working.split(span).join(token);
      tokens.push({ token, span });
    });

    // 2. Split structure: odd indices are newline runs, kept verbatim.
    const parts = working.split(/([ \t]*\n[ \t]*)/);
    const segments = [];
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i].trim()) segments.push(i);
    }

    const enJa = await getTranslator('en', 'ja',
      (pct) => onProgress && onProgress('en-ja', pct));
    const jaEn = await getTranslator('ja', 'en',
      (pct) => onProgress && onProgress('ja-en', pct));

    let done = 0;
    let kept = 0;
    for (const idx of segments) {
      const before = parts[idx];
      const preVoice = countFirstPerson(before);
      const ja = await translateText(enJa, before);
      const en = await translateText(jaEn, ja);
      // Length guard: a sane translation stays within ~3x word count.
      // Extreme ratios mean the MT scrambled or hallucinated — keep the
      // pre-translation segment (placeholders still get restored later).
      // Skipped for tiny segments where variance is naturally high.
      const wb = countWords(before);
      const wa = countWords(en);
      const scrambled = wb >= 6 && (wa / wb > 2.5 || wa / wb < 0.3);
      // POV guard: translation must not introduce first-person pronouns
      // the source segment didn't have ("My computer" in third-person).
      // Tokens are pronoun-neutral, locked spans cancel out — only NEW
      // intrusions trip it. Applies at any segment length.
      const voiceBreak = countFirstPerson(en) > preVoice;
      if (scrambled || voiceBreak) {
        kept++;
      } else {
        parts[idx] = en;
      }
      done++;
      if (onProgress) onProgress('segments', done, segments.length);
    }

    // 3. Restore placeholders. Case-insensitive — MT may fold token case.
    let result = parts.join('');
    for (const { token, span } of tokens) {
      result = result.replace(new RegExp(token, 'gi'), span);
    }
    // Fidelity signal: locked spans missing after restore + tokens the
    // MT mangled beyond recognition.
    const lost = tokens.filter(({ span }) => !result.includes(span)).length;
    const leftover = result.match(/ZZZ\d+ZZZ/gi) || [];
    const unrestored = lost + leftover.length;

    return { text: result, unrestored, kept };
  }

  // Destroy translators created during the run (cleanup)
  function destroy() {
    for (const t of active) {
      try { t.destroy(); } catch { /* ignore */ }
    }
    active = [];
    for (const k of Object.keys(cache)) delete cache[k];
    warmupPromise = null;
  }

  return { supported, checkAvailability, warmup, roundTrip, destroy, getState: () => availabilityState };

})();
