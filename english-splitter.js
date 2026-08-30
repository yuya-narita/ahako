(() => {
  'use strict';

  const DEFAULT_LIMITS = Object.freeze({ short: 90, normal: 145, long: 215 });
  const SENTENCE_END = new Set(['.', '!', '?']);
  const TRAILING_CLOSERS = new Set(['"', '\'', '”', '’', ')', ']', '}']);
  const ABBREVIATIONS = new Set([
    'mr.','mrs.','ms.','dr.','prof.','sr.','jr.','st.','vs.','etc.','e.g.','i.e.','a.m.','p.m.',
    'u.s.','u.k.','no.','fig.','dept.','inc.','ltd.','co.'
  ]);

  function normalize(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\t\u00a0]+/g, ' ')
      .replace(/[ \u3000]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isListLine(line) {
    return /^\s*(?:[-*+•●○■□▪▫◆◇▶▷]|\d{1,3}[.)]|[A-Za-z][.)])\s+/u.test(line);
  }

  function isDialogueLine(line) {
    const s = line.trim();
    if (s.length < 2) return false;
    return (/^["“‘].*["”’]$/u.test(s) || /^'.*'$/u.test(s));
  }

  function looksLikeStandaloneBeat(line) {
    const s = line.trim();
    if (!s || s.length > 46) return false;
    return /(?:—|–|\.\.\.|…|:)$/.test(s) || /^(?:—|–|…|\.){2,}$/.test(s);
  }

  function tokenBefore(text, index) {
    const left = text.slice(0, index + 1);
    const m = left.match(/(?:[A-Za-z](?:\.[A-Za-z])+\.|[A-Za-z]+\.)$/);
    return m ? m[0].toLowerCase() : '';
  }

  function protectedPeriod(text, index) {
    const prev = text[index - 1] || '';
    const next = text[index + 1] || '';
    if (/\d/.test(prev) && /\d/.test(next)) return true; // 3.14 / versions
    if (/\w/.test(prev) && /\w/.test(next)) return true; // domains / email-ish tokens
    const before = tokenBefore(text, index);
    if (ABBREVIATIONS.has(before)) return true;
    if (/^[A-Za-z]\.$/.test(before)) return true; // initials
    return false;
  }

  function sentenceTokens(text) {
    const out = [];
    let buffer = '';
    const chars = [...text];

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      buffer += ch;
      if (!SENTENCE_END.has(ch)) continue;
      if (ch === '.' && protectedPeriod(text, i)) continue;

      // Repeated punctuation belongs to the same sentence.
      while (i + 1 < chars.length && SENTENCE_END.has(chars[i + 1])) buffer += chars[++i];
      while (i + 1 < chars.length && TRAILING_CLOSERS.has(chars[i + 1])) buffer += chars[++i];

      const next = chars[i + 1] || '';
      if (next && !/\s|\n/.test(next)) continue;
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    }
    if (buffer.trim()) out.push(buffer.trim());
    return out;
  }

  function splitLongUnpunctuated(text, limit) {
    const s = text.trim();
    if (s.length <= limit) return [s];
    const out = [];
    let rest = s;
    const min = Math.max(38, Math.floor(limit * 0.55));

    while (rest.length > limit) {
      const searchEnd = Math.min(rest.length, Math.floor(limit * 1.12));
      const searchStart = Math.min(min, searchEnd - 1);
      const slice = rest.slice(searchStart, searchEnd + 1);
      let rel = -1;
      for (const mark of [', ', '; ', ': ', ' — ', ' – ', ' ']) {
        const p = slice.lastIndexOf(mark);
        if (p > rel) rel = p + (mark.endsWith(' ') ? mark.length - 1 : mark.length);
      }
      let cut = rel >= 0 ? searchStart + rel : limit;
      if (cut <= 0) cut = limit;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  function packSentences(text, limit) {
    const tokens = sentenceTokens(text);
    if (tokens.length <= 1) return splitLongUnpunctuated(text, limit);
    const out = [];
    let buffer = '';
    for (const token of tokens) {
      const pieces = token.length > Math.floor(limit * 1.35) ? splitLongUnpunctuated(token, limit) : [token];
      for (const piece of pieces) {
        const candidate = buffer ? `${buffer}\n${piece}` : piece;
        if (buffer && candidate.length > limit) {
          out.push(buffer);
          buffer = piece;
        } else buffer = candidate;
      }
    }
    if (buffer) out.push(buffer);
    return out;
  }

  function makeChunk(text, type = 'text', reason = 'paragraph') {
    return { text: text.trim(), type, reason };
  }

  function processPlainLines(lines, limit) {
    const clean = lines.map(v => v.trim()).filter(Boolean);
    if (!clean.length) return [];
    const joined = clean.join('\n');
    if (joined.length <= limit) return [makeChunk(joined, 'text', clean.length > 1 ? 'line-break' : 'paragraph')];

    if (clean.length > 1) {
      const out = [];
      let buffer = '';
      for (const line of clean) {
        const candidate = buffer ? `${buffer}\n${line}` : line;
        if (buffer && candidate.length > limit) {
          out.push(...packSentences(buffer, limit).map(t => makeChunk(t, 'text', 'line-break')));
          buffer = line;
        } else buffer = candidate;
      }
      if (buffer) out.push(...packSentences(buffer, limit).map(t => makeChunk(t, 'text', 'sentence')));
      return out;
    }
    return packSentences(joined, limit).map(t => makeChunk(t, 'text', 'sentence'));
  }

  function processBlock(block, limit) {
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return [];
    if (lines.every(isListLine)) return [makeChunk(lines.join('\n'), 'text', 'list-block')];

    const out = [];
    let plain = [];
    let list = [];
    const flushPlain = () => { if (plain.length) { out.push(...processPlainLines(plain, limit)); plain = []; } };
    const flushList = () => { if (list.length) { out.push(makeChunk(list.join('\n'), 'text', 'list-block')); list = []; } };

    for (const line of lines) {
      if (isDialogueLine(line)) {
        flushPlain(); flushList(); out.push(makeChunk(line, 'dialogue', 'dialogue'));
      } else if (isListLine(line)) {
        flushPlain(); list.push(line);
      } else if (looksLikeStandaloneBeat(line)) {
        flushPlain(); flushList(); out.push(makeChunk(line, 'text', 'beat'));
      } else {
        flushList(); plain.push(line);
      }
    }
    flushPlain(); flushList();
    return out;
  }

  function splitDetailed(text, options = {}) {
    const normalized = normalize(text);
    if (!normalized) return [];
    const density = options.density || 'normal';
    const limits = options.limits || DEFAULT_LIMITS;
    const limit = Number(options.limit) || limits[density] || DEFAULT_LIMITS.normal;
    return normalized.split(/\n\s*\n/).flatMap(block => processBlock(block, limit)).filter(chunk => chunk.text);
  }

  function split(text, options = {}) { return splitDetailed(text, options).map(x => x.text); }

  window.EnglishSceneSplitter = Object.freeze({
    version: '1.0.0', limits: DEFAULT_LIMITS, normalize, split, splitDetailed, isDialogueLine, isListLine
  });
})();
