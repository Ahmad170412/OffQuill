# OffQuill

> **Chrome only.** This app requires Chrome with Gemini Nano and the Translator API enabled via `chrome://flags`. It will not work in Firefox, Safari, Edge, or any browser without these proprietary on-device AI APIs. See the [setup guide](#if-you-see-this-banner) below.

**Remove watermarks. Strip AI-isms. Reclaim your text.**

OffQuill is a browser-native text processing tool that scrubs invisible Unicode artifacts and paraphrases your writing to sound human — no cloud servers, no data leaving your machine. Everything runs on-device using Chrome's built-in AI.

[![Chrome Only](https://img.shields.io/badge/Chrome%20Only-Required-red?style=flat)](https://support.google.com/chrome/answer/14095549)
[![MIT License](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)
[![Layer A](https://img.shields.io/badge/Layer%20A-Unicode%20Scrub-blue?style=flat)](#layer-a--unicode-scrubbing)
[![Layer B](https://img.shields.io/badge/Layer%20B-Paraphrase-purple?style=flat)](#layer-b--gemini-nano-paraphrasing)
[![Layer C](https://img.shields.io/badge/Layer%20C-Phrase%20Swaps-orange?style=flat)](#layer-c--phrase-swaps)
[![Layer D](https://img.shields.io/badge/Layer%20D-EN%C2%B4JA%C2%B7EN-green?style=flat)](#layer-d--enjaen-translation)

---

## What it does

1. **Scrubs invisible Unicode** — zero-width spaces, bidi overrides, variation selectors, tag characters, private use area, and other invisible glyphs that can carry hidden metadata or watermark patterns
2. **Paraphrases with Gemini Nano** — rewrites your text to sound natural and human, preserving facts, names, dates, and quoted material exactly
3. **Polishes AI-isms away** — deterministic phrase swaps that replace verbose filler, jargon, and robotic constructions with plain English
4. **Optionally round-trips through Japanese** — reconstructs text via EN→JA→EN to break English AI-idiom patterns at the distribution level

No text ever leaves your browser. No API keys. No network calls.

---

## The pipeline

```
Input → Layer A (scrub unicode) → Layer B (paraphrase) → [Layer D (translate)] → Layer C (polish) → Output
```

Each layer can fail independently — the pipeline degrades gracefully, so you always get *something* useful.

### Layer A — Unicode Scrubbing

Strips 30+ categories of invisible and ignorable Unicode characters, normalizes whitespace, and preserves legitimate bidi marks, emoji sequences, and CJK variation selectors. Ported from [guillaumeyer/watermarks-remover](https://github.com/guillaumeyer/watermarks-remover).

### Layer B — Gemini Nano Paraphrasing

Uses Chrome's `LanguageModel` API to generate 1–3 paraphrase candidates and picks the one with the highest lexical divergence while keeping "locked terms" intact. Locked terms are auto-detected:

- Quoted text and dialogue
- URLs and email addresses
- Dates and numbers
- Acronyms (NASA, CEO, etc.)
- Word-form numbers with units ("three seconds", "twenty people")
- Repeated capitalized proper nouns

Three strength levels — **light** (polish pass), **medium** (rewrite), **strong** (complete restructuring).

### Layer C — Phrase Swaps

Deterministic find-and-replace of 37+ AI-filler phrases with case-matching and sentence-start capitalization fixes. No AI calls, no latency.

Examples: `delve into` → `look at`, `in order to` → `to`, `leverages` → `uses`, `Furthermore,` → `Also,`.

### Layer D — EN→JA→EN Translation

Uses Chrome's `Translator` API to route text through Japanese, breaking English AI-writing patterns at the distribution level. Includes:

- POV guards (catches first-person pronoun injection)
- Length guards (discards scrambled MT output)
- Placeholder restoration (locked terms survive translation)
- Quality gate (reverts translation if it converges back toward the original)

---

## Quick start

1. **Open in Chrome** on desktop
2. **Enable Chrome flags** (see below)
3. Paste text, choose strength, click **remove watermark**
4. Or press **⌘/Ctrl + Enter**
5. Drop a `.txt` or `.md` file to load it

---

## If you see this banner

Gemini Nano isn't enabled. You need two Chrome flags:

### Flag 1
1. Go to `chrome://flags/#optimization-guide-on-device-model`
2. Set to **Enabled BypassPerfRequirement**

### Flag 2
1. Go to `chrome://flags/#prompt-api-for-gemini-nano`
2. Set to **Enabled**

### Flag 3 (for translation)
1. Go to `chrome://flags/#translation-api`
2. Set to **Enabled**

3. **Relaunch Chrome** and refresh the page.

---

## Requirements

- **Chrome** (desktop) — this is non-negotiable
- **Chrome flags** enabled for Gemini Nano (and Translation API if you want the round-trip feature)
- On-device AI model download (first run requires internet)
- ~512MB RAM recommended for the on-device model

---

## What it won't do

- Work in Firefox, Safari, or Edge
- Work without Chrome flags enabled
- Guarantee watermark removal from documents with complex embedded metadata
- Handle files larger than 5MB
- Replace a proper document redaction tool

---

## Contributing

This is a hobby project. Contributions welcome — especially:

- Tests for the pure functions in `layers.js` (`findProtectedSpans`, `lexicalDivergence`, `applyPhraseSwaps`, `clean`, `countWords`)
- Additional phrase swaps for Layer C
- Improved detection heuristics for locked terms
- Browser compatibility exploration (if the APIs ever land elsewhere)

---

## License

MIT — see [LICENSE](LICENSE).

---

## Acknowledgments

- Unicode scrub logic ported from [guillaumeyer/watermarks-remover](https://github.com/guillaumeyer/watermarks-remover)
- Built entirely with Chrome's on-device AI APIs — no external services, no API keys, no server infrastructure
