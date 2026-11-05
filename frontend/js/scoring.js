// Word-based scoring, shared by the browser and the server so both always agree.
//
// The rules:
//  - Text is compared word by word. A word is either right or wrong.
//  - A mistake never stops the race: the race ends when the last word has been typed.
//  - Wrong words are left out of the speed (WPM). They only lower the accuracy.
//  - Accuracy = right words / all words.
(function (root) {
  const BN_DIGITS = '\u09E6\u09E7\u09E8\u09E9\u09EA\u09EB\u09EC\u09ED\u09EE\u09EF';
  const ALIASES = { '\u0964': '.', '\u2019': "'", '\u2018': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-' };

  // NFC makes different ways of typing the same Bangla letter equal (for example ে + া and ো).
  // Zero-width characters that some keyboards insert are ignored.
  function norm(s) {
    return String(s || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ');
  }

  // Characters that different keyboards type differently count as the same:
  // Bangla digits and ASCII digits, the danda and the full stop, curly and straight quotes.
  function charKey(ch) {
    const d = BN_DIGITS.indexOf(ch);
    if (d >= 0) return String(d);
    return ALIASES[ch] || ch;
  }
  function sameChar(a, b) {
    return a === b || charKey(a) === charKey(b);
  }
  function sameWord(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameChar(a[i], b[i])) return false;
    return true;
  }

  // Split the race text into words (arrays of characters) and remember where each word starts.
  function prepare(text) {
    const chars = Array.from(norm(text));
    const words = [];
    const starts = [];
    let cur = [];
    let start = 0;
    chars.forEach((ch, i) => {
      if (ch === ' ') {
        if (cur.length) { words.push(cur); starts.push(start); cur = []; }
      } else {
        if (!cur.length) start = i;
        cur.push(ch);
      }
    });
    if (cur.length) { words.push(cur); starts.push(start); }
    return { chars, words, starts, length: chars.length };
  }

  function splitTyped(chars) {
    const words = [];
    let cur = [];
    for (const ch of chars) {
      if (ch === ' ') {
        if (cur.length) { words.push(cur); cur = []; }
      } else {
        cur.push(ch);
      }
    }
    const inProgress = cur.length > 0;
    if (inProgress) words.push(cur);
    return { words, inProgress };
  }

  // opts.timed:    timed test (the text never "ends", the clock does)
  // opts.timedEnd: the clock just ran out (the half-typed last word is not judged)
  function evaluate(prep, typed, opts) {
    const o = opts || {};
    const chars = Array.from(norm(typed));
    const tw = splitTyped(chars);
    const words = tw.words;
    const n = prep.words.length;
    const done = words.length - (tw.inProgress ? 1 : 0); // words that are completely typed
    const cur = tw.inProgress ? words[words.length - 1] : [];

    // The race ends when the last word is typed, right or wrong.
    let finished = false;
    if (!o.timed && n > 0) {
      if (done >= n) finished = true;
      else if (tw.inProgress && done === n - 1 && cur.length >= prep.words[n - 1].length) finished = true;
      else if (tw.inProgress && words.length >= n - 1 && sameWord(cur, prep.words[n - 1])) finished = true; // the last word is typed (words may have been glued together before)
      else if (chars.length >= prep.length) finished = true;
    }

    let judged = done;
    if (finished && tw.inProgress && done < n) judged = Math.min(done + 1, n);
    if (o.timedEnd && tw.inProgress && done < n && sameWord(cur, prep.words[done])) judged = done + 1;
    judged = Math.min(judged, n);

    const flags = [];
    let correctWords = 0;
    let correctChars = 0;
    for (let i = 0; i < judged; i++) {
      const ok = sameWord(words[i], prep.words[i]);
      flags.push(ok);
      if (ok) {
        correctWords++;
        correctChars += prep.words[i].length + (i < n - 1 ? 1 : 0);
      }
    }
    const wrongWords = judged - correctWords;

    // live speed also counts the word being typed, as long as it is correct so far
    let partial = 0;
    if (!finished && !o.timedEnd && tw.inProgress && done < n && cur.length <= prep.words[done].length) {
      let ok = true;
      for (let i = 0; i < cur.length; i++) if (!sameChar(cur[i], prep.words[done][i])) { ok = false; break; }
      if (ok) partial = cur.length;
    }

    const total = finished ? n : judged; // skipped words count against accuracy once the race is over
    const accuracy = total > 0 ? Math.round((correctWords / total) * 100) : 100;

    let cursor;
    if (finished || done >= n) cursor = prep.length;
    else cursor = prep.starts[done] + (tw.inProgress ? Math.min(cur.length, prep.words[done].length) : 0);

    let lastOk = true;
    if (tw.inProgress && done < n) {
      const idx = cur.length - 1;
      const target = prep.words[done];
      lastOk = idx < target.length && sameChar(cur[idx], target[idx]);
    }

    return {
      done, judged, flags, inProgress: tw.inProgress, cur, finished,
      correctWords, wrongWords, correctChars, wpmChars: correctChars + partial,
      accuracy, cursor, lastOk, typedWords: words
    };
  }

  // The wrong words, for the "words to practice" list: what the text said, and what was typed.
  function wrongWords(prep, typed) {
    const ev = evaluate(prep, typed, {});
    const out = [];
    const limit = ev.finished ? prep.words.length : ev.judged;
    for (let i = 0; i < limit; i++) {
      if (i < ev.flags.length && ev.flags[i]) continue;
      out.push({ expected: prep.words[i].join(''), typed: (ev.typedWords[i] || []).join('') });
    }
    return out;
  }

  const api = { norm, sameChar, sameWord, prepare, evaluate, wrongWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== 'undefined' ? window : this);
