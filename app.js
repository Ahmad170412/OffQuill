/* ============================================================
   OffQuill — UI Wiring (DOM glue, pipeline orchestration)
   Logic lives in layers.js. This file touches the DOM only.
   Pipeline: Layer A → Layer B → [Layer D] → Layer C → output
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  const input     = document.getElementById('inputText');
  const output    = document.getElementById('outputText');
  const btnGo     = document.getElementById('btnGo');
  const btnCopy   = document.getElementById('btnCopy');
  const status    = document.getElementById('status');
  const setup     = document.getElementById('setupBanner');
  const metaLine  = document.getElementById('metaLine');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const wordCount = document.getElementById('wordCount');
  const btnClear  = document.getElementById('btnClear');
  const editorIn  = document.getElementById('editorInput');
  const toggleTranslate = document.getElementById('toggleTranslate');
  const translateWrap = document.getElementById('translateToggleWrap');

  let strength = 'light';

  // --- Persisted prefs (strength + toggle survive refresh) ---
  const PREFS_KEY = 'offquill.prefs';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
    catch { return {}; }
  }
  function savePrefs(patch) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
    } catch { /* private mode etc. */ }
  }

  const prefs = loadPrefs();
  if (prefs.strength && ['light', 'medium', 'strong'].includes(prefs.strength)) {
    strength = prefs.strength;
    document.querySelectorAll('.pill').forEach(p =>
      p.classList.toggle('active', p.dataset.s === strength));
  }
  if (toggleTranslate && prefs.translate === true) toggleTranslate.checked = true;

  // --- Input state: word counter + clear button ---
  function updateInputState() {
    const hasAny = input.value.trim().length > 0;
    const n = countWords(input.value.trim());
    if (wordCount) wordCount.textContent = n === 1 ? '1 word' : `${n} words`;
    if (btnClear) btnClear.hidden = !hasAny;
  }

  input.addEventListener('input', updateInputState);
  updateInputState();

  // --- Clear button ---
  btnClear.addEventListener('click', () => {
    input.value = '';
    updateInputState();
    input.focus();
  });

  // --- Cmd/Ctrl + Enter to run ---
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      btnGo.click();
    }
  });

  // --- Model status check ---
  async function initStatus() {
    status.className = 'status checking';
    status.textContent = 'checking model...';
    setup.hidden = true;

    try {
      const avail = await LayerB.checkAvailability();

      if (avail === 'available') {
        status.className = 'status ready';
        status.textContent = 'Gemini Nano ready';
        setup.hidden = true;
      } else if (avail === 'downloadable') {
        status.className = 'status checking';
        status.textContent = 'model downloadable';
        setup.hidden = false;
        setup.setAttribute('open', '');
      } else if (avail === 'downloading') {
        status.className = 'status checking';
        status.textContent = 'model downloading...';
        setup.hidden = true;
      } else {
        status.className = 'status unavail';
        status.textContent = 'Gemini Nano unavailable';
        setup.hidden = false;
        setup.setAttribute('open', '');
      }
    } catch {
      status.className = 'status unavail';
      status.textContent = 'API not supported';
      setup.hidden = false;
      setup.setAttribute('open', '');
    }
  }

  initStatus();

  // --- Translate toggle availability (desktop Chrome + JA packs) ---
  async function initTranslate() {
    if (!toggleTranslate || !translateWrap) return;
    if (!LayerD.supported()) {
      toggleTranslate.disabled = true;
      toggleTranslate.checked = false;
      translateWrap.classList.add('disabled');
      translateWrap.title = 'Translation needs desktop Chrome with the Translator API';
      return;
    }
    // 'downloadable' is fine — packs fetch on first run with progress.
    // Only disable when the API or the EN↔JA pair is truly unavailable.
    try {
      const avail = await LayerD.checkAvailability();
      if (avail === 'unsupported' || avail === 'unavailable') {
        toggleTranslate.disabled = true;
        toggleTranslate.checked = false;
        translateWrap.classList.add('disabled');
        translateWrap.title = 'EN↔JA packs unavailable — enable chrome://flags/#translation-api';
      }
    } catch { /* leave toggle enabled; GO handler pre-flights anyway */ }
  }

  initTranslate();

  // --- Copy buttons in setup steps ---
  document.querySelectorAll('.step-copy').forEach(row => {
    const btn = row.querySelector('.copy-link');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = row.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1500);
      } catch { /* silent */ }
    });
  });

  // --- Strength pills ---
  document.querySelector('.strength').addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    strength = pill.dataset.s;
    savePrefs({ strength });
  });

  // --- Persist translate toggle ---
  if (toggleTranslate) {
    toggleTranslate.addEventListener('change', () => {
      savePrefs({ translate: toggleTranslate.checked });
      // NOTE: translateWrap is the <label id="translateToggleWrap"> element
      // (role=switch). Never reference the bare `translateToggleWrap`
      // global — window named-element fallback breaks under modules/CSP.
      if (translateWrap) {
        translateWrap.setAttribute('aria-checked', String(toggleTranslate.checked));
      }
    });
  }

  // --- Toast notifications (click to dismiss early) ---
  // warn toasts stick around longer — they're the most common message.
  function showToast(msg, type = 'error') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);

    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    };
    toast.addEventListener('click', dismiss);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(dismiss, type === 'warn' ? 7000 : type === 'success' ? 3000 : 4000);
  }

  // --- Simple sleep utility for phase transitions ---
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Animated button dots + phase progress ---
  let dotsTimer = null;
  function startDots(base) {
    stopDots();
    let n = 0;
    const tick = () => {
      n = (n + 1) % 4;
      btnGo.innerHTML = `<span class="spinner"></span> ${base}${'.'.repeat(n)}`;
    };
    tick();
    dotsTimer = setInterval(tick, 400);
  }
  function stopDots() {
    if (dotsTimer) { clearInterval(dotsTimer); dotsTimer = null; }
  }
  function setProgress(pct) {
    if (!progressWrap || !progressFill) return;
    progressWrap.classList.add('show');
    progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }
  function hideProgress() {
    if (!progressWrap || !progressFill) return;
    progressWrap.classList.remove('show');
    progressFill.style.width = '0%';
  }

  // --- GO button ---
  btnGo.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) {
      showToast('Paste some text first', 'warn');
      return;
    }

    // Short-input warning — make it visible, not dismissible as background noise.
    const inputWords = countWords(text);
    if (inputWords < 8) {
      showToast(`Only ${inputWords} word${inputWords === 1 ? '' : 's'} — results may be odd. Add more text for best results.`, 'warn');
      btnGo.style.borderColor = 'var(--warn)';
      btnGo.style.boxShadow = '0 0 8px rgba(245,158,11,.3)';
      setTimeout(() => { btnGo.style.borderColor = ''; btnGo.style.boxShadow = ''; }, 3000);
    }

    btnGo.disabled = true;
    const editorOut = document.getElementById('editorOutput');

    // Warm up translators NOW, synchronously in the click handler, while
    // user activation is fresh. Packs download in parallel with Layers A/B.
    let translateReady = null;
    const wantTranslate = toggleTranslate && toggleTranslate.checked && !toggleTranslate.disabled;
    if (wantTranslate) {
      translateReady = LayerD.warmup();
      status.className = 'status checking';
      status.textContent = 'Loading translation packs...';
      setProgress(5);
    }

    try {
      // Phase 1: Unicode scrub
      startDots('scrubbing unicode');
      setProgress(8);
      status.className = 'status checking';
      status.textContent = 'Layer A...';
      editorIn.classList.add('processing');

      const { cleaned: layerA, stats } = LayerA.clean(text);
      const locked = findProtectedSpans(layerA);
      const candidateCounts = { light: 1, medium: 3, strong: 3 };
      const totalCandidates = candidateCounts[strength] || 1;
      setProgress(20);
      await sleep(150);

      // Phase 2: Paraphrase
      startDots('paraphrasing');
      editorOut.classList.add('processing');

      let layerB;
      let meta = '';
      try {
        const result = await LayerB.paraphrase(layerA, strength, (pct) => {
          status.className = 'status checking';
          status.textContent = `model ${Math.round(pct)}%`;
        }, {
          candidates: totalCandidates,
          locked,
          onVariant: (i, n) => {
            if (n > 1) startDots(`variant ${i}/${n}`);
            setProgress(20 + (i / n) * 60);
          },
        });
        layerB = result.text;
        const kept = locked.length - result.missingSpans.length;
        meta = `${countWords(layerA)} → ${countWords(layerB)} words · ${kept}/${locked.length} locked kept`;
        if (totalCandidates > 1) meta += ` · best of ${totalCandidates}`;
        if (result.missingSpans.length) {
          showToast(`Dropped locked terms: ${result.missingSpans.slice(0, 3).join(', ')}`, 'warn');
        }
        status.className = 'status ready';
        status.textContent = 'done';
        await sleep(150);
      } catch (err) {
        console.warn('Layer B failed, using Layer A only:', err.message);
        layerB = layerA;
        meta = `${countWords(layerA)} → ${countWords(layerB)} words · Layer A only`;
        status.className = 'status unavail';
        status.textContent = 'Layer A only';
        showToast('No AI model found — output is Unicode-scrubbed only. Enable Chrome flags to unlock paraphrasing.', 'warn');
        await sleep(150);
      }

      // Phase 3: Translation round-trip (optional, toggle).
      // Translators were warmed up at click time; just await them here.
      let translated = false;
      let preDtext = '';
      let rtKept = 0;
      let didRepair = false;
      if (translateReady) {
        const warmResult = await translateReady;
        if (warmResult instanceof Error) {
          // Warmup failed — pre-flight for a specific reason.
          const davail = await LayerD.checkAvailability();
          if (davail === 'unsupported') {
            showToast('Translator API not available in this browser — skipping', 'warn');
          } else if (davail === 'unavailable') {
            showToast('Japanese translation packs not available — enable chrome://flags/#translation-api', 'warn');
          } else {
            showToast(`Translation packs failed to load (${warmResult.message}) — continuing without it`, 'warn');
          }
        } else {
          try {
            startDots('translating en→ja');
            status.className = 'status checking';
            setProgress(84);
            let sawJaEn = false;
            const rt = await LayerD.roundTrip(layerB, (pair, a, b) => {
              if (pair === 'segments') {
                status.textContent = `translating piece ${a}/${b}`;
                setProgress(84 + (a / Math.max(1, b)) * 6);
                return;
              }
              const arrow = pair === 'en-ja' ? 'EN → JA' : 'JA → EN';
              status.textContent = `${arrow} ${Math.round(a)}%`;
              if (pair === 'ja-en' && !sawJaEn) {
                sawJaEn = true;
                startDots('translating ja→en');
              }
            }, { locked });
            // POV + scramble guards already ran per-segment inside
            // roundTrip — offending pieces were kept pre-translation.
            preDtext = layerB;
            layerB = rt.text;
            translated = true;
            rtKept = rt.kept || 0;
            setProgress(90);
            await sleep(150);
          } catch (err) {
            console.warn('Layer D failed, skipping translation:', err.message);
            showToast('Translation round-trip failed — continuing without it', 'warn');
            await sleep(150);
          }
        }
      }
      // Phase 4: Nano repair (translate runs only) — grammar/word-order
      // fix with a minimal-change prompt. Three anti-watermark defenses:
      //   1. Constrained prompt (glue words only, locked terms absolute).
      //   2. Discard guards: dropped locked terms OR word count shifted
      //      more than ±25% (a repair shouldn't change length much) — if
      //      either trips, the repair is thrown away, translation kept.
      //   3. Re-scrub through Layer A afterwards, so any unicode smuggled
      //      in by the extra Nano call is stripped before output.
      if (translated) {
        try {
          startDots('repairing grammar');
          setProgress(90);
          const fixed = await LayerB.repair(layerB, locked);
          const wcBefore = countWords(layerB);
          const wcAfter = countWords(fixed.text);
          const ratio = wcAfter / Math.max(1, wcBefore);
          if (fixed.missingSpans.length === 0 && ratio >= 0.75 && ratio <= 1.33) {
            layerB = fixed.text;
            didRepair = true;
          } else {
            console.warn('Repair discarded (missing:', fixed.missingSpans.length,
              'ratio:', ratio.toFixed(2) + ') — keeping translation');
          }
        } catch (err) {
          console.warn('Repair failed, keeping translation:', err.message);
        }
      }

      // Phase 4b: MT case-noise cleanup (translate runs only). JA→EN
      // often returns Titlecased fragments ("Machine Learning Grew").
      // Words that were only-ever-lowercase pre-translation get
      // lowercased mid-sentence; sentence starts and locked terms stay.
      if (translated) {
        layerB = fixMtCapitalization(layerB, preDtext, locked);
        layerB = fixMtTense(layerB);
      }

      // Phase 4c: Translation quality gate. The round-trip is a gamble —
      // sometimes JA→EN diverges (good), sometimes it snaps back toward
      // the original phrasing (bad, e.g. 35% runs). If the final text is
      // lexically CLOSER to the scrubbed original than the paraphrase
      // was, translation hurt: revert to the paraphrase. This makes the
      // toggle strictly non-harmful on our divergence proxy.
      if (translated) {
        const divPre = lexicalDivergence(layerA, preDtext);
        const divPost = lexicalDivergence(layerA, layerB);
        if (divPost < divPre - 0.05) {
          console.warn(`Translation converged (div ${divPre.toFixed(2)} → ${divPost.toFixed(2)}) — keeping paraphrase`);
          showToast('Translation converged toward original — kept paraphrase', 'warn');
          layerB = preDtext;
          translated = false;
        }
      }
      if (translated) {
        meta += ' · EN→JA→EN';
        if (didRepair) meta += ' · repaired';
        if (rtKept > 0) meta += ` · ${rtKept} piece${rtKept > 1 ? 's' : ''} kept`;
      }

      // Phase 5: Phrase swaps (deterministic AI-ism polish)
      startDots('polishing');
      setProgress(94);
      // Re-scrub first: kills anything unicode-level the repair call
      // may have introduced, before the final polish.
      layerB = LayerA.clean(layerB).cleaned;
      const polished = applyPhraseSwaps(layerB);
      layerB = polished.text;
      if (polished.count > 0) meta += ` · ${polished.count} phrases polished`;

      // Phase 5b: Rhythm variance (burstiness). Uniform medium-length
      // sentences read as AI; this merges shorts and splits monsters.
      // Paragraphs that are already varied self-skip, so narrative
      // rhythm is never touched. Reference = closest human-voice text.
      const rhythm = varyRhythm(layerB, translated ? preDtext : layerA, locked);
      if (rhythm.merges + rhythm.splits > 0) {
        layerB = rhythm.text;
        meta += ' · rhythm';
      }

      // Phase 5c: Parenthetical asides. Humans bracket appositives in
      // parens; AI leans on comma-appositives. Meaning-identical
      // punctuation swap (inner text verbatim, spans safe), capped.
      const parens = parenthesizeAppositives(layerB);
      if (parens.count > 0) {
        layerB = parens.text;
        meta += ' · parens';
      }
      setProgress(100);
      hideProgress();

      output.value = layerB;
      if (metaLine) metaLine.textContent = meta;
      btnCopy.disabled = false;

      // Success flash — stronger, longer
      editorOut.style.borderColor = 'var(--accent)';
      editorOut.style.boxShadow = '0 0 30px var(--glow), 0 0 60px rgba(6,214,160,0.06)';
      setTimeout(() => { editorOut.style.borderColor = ''; editorOut.style.boxShadow = ''; }, 1800);

      // Success toast
      showToast('Done', 'success');

    } catch (err) {
      console.error(err);
      const msg = err.message || 'Unknown error';
      const friendly = msg.includes('timed out')
        ? 'The AI model took too long to respond — try again'
        : msg.includes('unavailable') || msg.includes('not supported')
        ? 'AI model not available — check Chrome flags'
        : `Something went wrong: ${msg}`;
      showToast(friendly, 'error');
      status.className = 'status unavail';
      status.textContent = 'error';
      if (progressWrap) progressWrap.classList.remove('show');
      if (progressFill) progressFill.style.width = '0%';
    } finally {
      LayerB.destroy();
      LayerD.destroy();
      stopDots();
      btnGo.disabled = false;
      btnGo.textContent = 'remove watermark';
      editorIn.classList.remove('processing');
      editorOut.classList.remove('processing');
    }
  });

  // --- Copy ---
  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(output.value);
      btnCopy.textContent = 'copied!';
      btnCopy.classList.add('copied');
      setTimeout(() => { btnCopy.textContent = 'copy'; btnCopy.classList.remove('copied'); }, 1500);
    } catch {
      showToast('Copy blocked by browser — select the text manually', 'error');
    }
  });

});
