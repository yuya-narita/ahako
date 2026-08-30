(() => {
  'use strict';

  const VERSION = '1.2.0';

  function languageStats(text) {
    const s = String(text ?? '');
    const ja = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    return { ja, latin };
  }

  function detectLanguage(text) {
    const raw = String(text ?? '');
    const { ja, latin } = languageStats(raw);
    // Technical tokens should not decide the prose language. Strip common URL / email
    // payloads for a second look while keeping surrounding words such as "URLは…です".
    const prose = raw
      .replace(/https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/gi, ' ')
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, ' ')
      .replace(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/\S*)?/g, ' ');
    const clean = languageStats(prose);
    // Japanese wins whenever it is meaningfully present. This keeps Japanese prose
    // containing URLs / product names from being misclassified as English.
    if (ja >= 4 && ja >= latin * 0.08) return 'ja';
    if (clean.ja >= 2 && clean.ja >= clean.latin * 0.25) return 'ja';
    if (latin >= 4) return 'en';
    return ja > 0 ? 'ja' : 'en';
  }

  function getSplitter(language) {
    return language === 'en' ? window.EnglishSceneSplitter : window.JapaneseSceneSplitter;
  }

  function normalizeLanguageTag(tag, fallback = '') {
    const value = String(tag ?? '').trim();
    if (!value) return fallback;
    if (value === 'auto' || value === 'inherit') return value;
    // Lightweight BCP 47 shape validation. Full registry validation belongs outside runtime.
    return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) ? value : fallback;
  }

  function splitWith(language, text, options) {
    const splitter = getSplitter(language);
    if (!splitter?.splitDetailed) throw new Error(`No Scene splitter available for ${language}`);
    return splitter.splitDetailed(text, { ...options, language }).map(chunk => ({ ...chunk, language }));
  }

  function splitBlock(block, options) {
    const lines = String(block).split('\n');
    const meaningful = lines.filter(line => line.trim());
    const lineLanguages = meaningful.map(detectLanguage);
    const hasMixedLines = new Set(lineLanguages).size > 1;

    // Multilingual authoring commonly uses one language per line / paragraph.
    // Preserve that boundary and delegate each run to its language-specific splitter.
    if (hasMixedLines) {
      const runs = [];
      let lang = null;
      let buffer = [];
      const flush = () => {
        const text = buffer.join('\n').trim();
        if (text) runs.push({ language: lang || detectLanguage(text), text });
        buffer = [];
      };
      for (const line of lines) {
        if (!line.trim()) { buffer.push(line); continue; }
        const next = detectLanguage(line);
        if (lang && next !== lang && buffer.some(x => x.trim())) flush();
        lang = next;
        buffer.push(line);
      }
      flush();
      return runs.flatMap(run => splitWith(run.language, run.text, options));
    }

    const language = detectLanguage(block);
    return splitWith(language, block, options);
  }

  function splitMultilingualDetailed(text, options = {}) {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];
    const blocks = normalized.split(/(?:\n[ \t]*){2,}/).map(x => x.trim()).filter(Boolean);
    return blocks.flatMap(block => splitBlock(block, options));
  }

  function summarizeLanguages(chunks) {
    const languages = [];
    for (const chunk of chunks || []) {
      const lang = normalizeLanguageTag(chunk?.language);
      if (lang && !languages.includes(lang)) languages.push(lang);
    }
    return {
      language: languages.length > 1 ? 'mul' : (languages[0] || 'und'),
      languages
    };
  }

  function splitDetailed(text, options = {}) {
    const requested = normalizeLanguageTag(options.language, 'auto');
    if (requested && !['auto', 'mul'].includes(requested)) {
      return splitWith(requested, text, options);
    }
    if (requested === 'mul' || options.multilingual === true) {
      return splitMultilingualDetailed(text, options);
    }

    // v1.2 Auto policy:
    // Decide the prose language from the WHOLE document and delegate the whole
    // document to one language splitter. Do not switch splitter just because a
    // short paragraph/line contains English product names or technical tokens
    // such as "Scene", "TAP", "Splitter", "BGM", etc.
    //
    // True multilingual authoring is still available explicitly with:
    //   language: 'mul'  or  multilingual: true
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!normalized) return [];

    const language = detectLanguage(normalized);
    return splitWith(language, normalized, options);
  }

  function split(text, options = {}) { return splitDetailed(text, options).map(x => x.text); }

  window.SceneTextSplitter = Object.freeze({
    version: VERSION,
    detectLanguage,
    languageStats,
    normalizeLanguageTag,
    summarizeLanguages,
    split,
    splitDetailed,
    splitMultilingualDetailed,
    getSplitter
  });
})();
