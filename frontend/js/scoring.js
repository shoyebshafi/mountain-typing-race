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

  // ---- showing exactly WHERE a word is wrong ----

  // Which target characters were typed right ('ok') or wrong ('bad')?
  //
  // The typed word is read from left to right and every mistake is pinned to the letter the
  // typist was supposed to type at that moment. A decision is never taken back when more letters
  // arrive, so a red mark stays exactly where the mistake happened (it never jumps around).
  //   - a different letter      -> that target letter is red
  //   - an extra letter         -> the letter it pushed aside is red
  //   - a skipped letter        -> the skipped letter is red
  //   - two letters swapped     -> both are red
  // Returns { marks: 'ok' | 'bad' | '' for every target character, endJ: where the typist is now }.
  function align(typed, target) {
    const n = typed.length;
    const m = target.length;
    const marks = new Array(m).fill('');
    let i = 0;
    let j = 0;
    while (i < n) {
      if (j >= m) {                         // more letters than the word has
        if (m > 0) marks[m - 1] = 'bad';
        i++;
        continue;
      }
      if (sameChar(typed[i], target[j])) { marks[j] = 'ok'; i++; j++; continue; }
      // a mismatch at the letter that was expected
      if (i + 1 < n && j + 1 < m && sameChar(typed[i], target[j + 1]) && sameChar(typed[i + 1], target[j])) {
        marks[j] = 'bad'; marks[j + 1] = 'bad'; i += 2; j += 2; continue;   // swapped
      }
      if (i + 1 < n && sameChar(typed[i + 1], target[j])) {
        marks[j] = 'bad'; i += 2; j++; continue;                            // an extra letter came first
      }
      if (j + 1 < m && sameChar(typed[i], target[j + 1])) {
        marks[j] = 'bad'; marks[j + 1] = 'ok'; i++; j += 2; continue;       // the expected letter was skipped
      }
      marks[j] = 'bad'; i++; j++;                                           // a different letter
    }
    return { marks, endJ: j };
  }

  // Bangla vowel signs and conjuncts are not separate "letters" to the eye: ো is drawn around its consonant.
  // This is the whole visible unit around a character, so a wrong vowel sign shows as a clear block.
  const isMark = (ch) => /\p{M}/u.test(ch);
  function clusterRange(chars, idx) {
    let s = idx;
    while (s > 0 && (isMark(chars[s]) || chars[s - 1] === '\u09CD')) s--;
    let e = idx + 1;
    while (e < chars.length && (isMark(chars[e]) || chars[e - 1] === '\u09CD')) e++;
    return [s, e];
  }

  const api = { norm, sameChar, sameWord, prepare, evaluate, wrongWords, align, clusterRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== 'undefined' ? window : this);
