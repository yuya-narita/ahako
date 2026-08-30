(() => {
  'use strict';

  /*
   * Japanese Splitter v2.0
   *
   * Goal:
   *   "この文章をTAPして読むなら、どこで次を隠すのが気持ちいいか"
   *
   * v1 compatibility:
   * - split(text, options)
   * - splitDetailed(text, options)
   *
   * Production release consolidated from the v2.1–v2.11 experiments.
   * Exposed as window.JapaneseSceneSplitter for Scene Studio compatibility.
   */

  const VERSION = '2.0.0';

  const OPENERS = new Set(['「','『','（','(','【','［','[','〈','《','“','‘']);
  const CLOSERS = new Set(['」','』','）',')','】','］',']','〉','》','”','’']);
  const QUOTE_OPENERS = new Set(['「','『','“','‘']);
  const QUOTE_CLOSERS = new Set(['」','』','”','’']);
  const SENTENCE_END = new Set(['。','！','？','!','?']);
  const TRAILING_CLOSERS = new Set(['」','』','）',')','】','］',']','〉','》','”','’']);

  const STRONG_TRANSITIONS = [
    'そのとき','その時','すると','ところが','しかし','だが','けれど','けれども',
    '次の瞬間','突然','ふと','やがて','それでも','なのに','だというのに'
  ];
  const MEDIUM_TRANSITIONS = [
    'そして','そこで','一方','一方で','ただ','とはいえ','つまり','だがしかし',
    'その後','しばらくして','やがて'
  ];
  const DEPENDENT_STARTS = [
    'だから','なので','そのため','つまり','というのも','なぜなら','そしてまた'
  ];

  const DEFAULT_PROFILE = Object.freeze({
    density: 'normal',
    preserveParagraphs: true,
    preserveDialogueLines: true,
    minScene: 28,
    maxScene: 150
  });

  function normalize(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\t\u00a0]+/g, ' ')
      .replace(/[ \u3000]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function isListLine(line) {
    return /^\s*(?:[-*+・●○■□▪▫◆◇▶▷]|\d{1,3}[.)、]|[①-⑳])\s*/u.test(line);
  }

  function isDialogueLine(line) {
    const s = line.trim();
    if (s.length < 2) return false;
    const pairs = [['「','」'],['『','』'],['“','”'],['‘','’']];
    return pairs.some(([a,b]) => s.startsWith(a) && s.endsWith(b));
  }

  function looksLikeStandaloneBeat(line) {
    const s = line.trim();
    if (!s || s.length > 32) return false;
    return /(?:——|――|…|\.\.\.|：|:)$/.test(s) || /^[—―…]+$/.test(s);
  }

  function charLength(text) {
    return [...String(text ?? '')].length;
  }

  function startsWithAny(text, list) {
    const s = String(text ?? '').trim();
    return list.some(x => s.startsWith(x));
  }

  function adaptiveTargets(totalLength, density = 'normal') {
    // TAP fatigue control. Longer works get slightly more text per Scene.
    let target;
    if (totalLength <= 500) target = 58;
    else if (totalLength <= 1200) target = 72;
    else if (totalLength <= 2200) target = 88;
    else if (totalLength <= 3500) target = 102;
    else target = 116;

    const factor = density === 'short' ? 0.78 : density === 'long' ? 1.24 : 1;
    target = Math.round(target * factor);

    return {
      target,
      min: Math.max(18, Math.round(target * 0.42)),
      softMax: Math.round(target * 1.42),
      hardMax: Math.round(target * 1.75)
    };
  }


  function densityPolicy(totalLength, density='normal') {
    const base = adaptiveTargets(totalLength, density);

    // Scene Density Control:
    // character count is not a forced cut. It only changes how strongly
    // we look for a usable internal boundary.
    const comfort = Math.max(42, Math.round(base.target * 0.82));
    const alert = Math.max(64, Math.round(base.target * 1.08));
    const heavy = Math.max(88, Math.round(base.target * 1.30));

    return {
      ...base,
      comfort,
      alert,
      heavy,
      minReadable: Math.max(18, Math.round(base.min * 0.90))
    };
  }

  /*
   * Quote-aware sentence tokenizer.
   * Unlike v1, punctuation immediately before a closing quote can end a token:
   *   「誰？」 -> one dialogue token
   */
  function sentenceTokens(text) {
    const chars = [...String(text ?? '')];
    const tokens = [];
    let buffer = '';
    const stack = [];

    const matchingCloser = opener => ({
      '「':'」','『':'』','（':'）','(' : ')','【':'】','［':'］','[':']',
      '〈':'〉','《':'》','“':'”','‘':'’'
    })[opener];

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      buffer += ch;

      if (OPENERS.has(ch)) {
        stack.push(ch);
        continue;
      }

      if (CLOSERS.has(ch)) {
        if (stack.length && matchingCloser(stack[stack.length - 1]) === ch) stack.pop();
        continue;
      }

      if (!SENTENCE_END.has(ch)) continue;

      // If punctuation is inside a quote, allow the quote closer(s) to trail
      // and end the token when the punctuation closes the outermost quote run.
      let j = i + 1;
      let tmpStack = stack.slice();
      let suffix = '';
      while (j < chars.length && TRAILING_CLOSERS.has(chars[j])) {
        const closer = chars[j];
        suffix += closer;
        if (tmpStack.length && matchingCloser(tmpStack[tmpStack.length - 1]) === closer) tmpStack.pop();
        j++;
      }

      if (stack.length === 0 || tmpStack.length === 0) {
        if (suffix) {
          buffer += suffix;
          i = j - 1;
          stack.length = 0;
        }
        const t = buffer.trim();
        if (t) tokens.push({ text: t, endMark: ch });
        buffer = '';
      }
    }

    const rest = buffer.trim();
    if (rest) tokens.push({ text: rest, endMark: '' });
    return tokens;
  }

  function boundaryScore(prev, next, meta = {}) {
    const a = String(prev?.text ?? prev ?? '').trim();
    const b = String(next?.text ?? next ?? '').trim();
    if (!a || !b) return { score: 0, reasons: [] };

    let score = 28; // ordinary sentence boundary
    const reasons = ['sentence'];

    if (meta.authorLineBreak) {
      score += 38;
      reasons.push('author-line-break');
    }

    if (/[！？!?]$/.test(a)) {
      score += 22;
      reasons.push('question-or-exclamation');
    }

    if (/(?:…|——|――|\.\.\.)[」』”’]?$/.test(a)) {
      score += 24;
      reasons.push('pause-or-beat');
    }

    if (isDialogueLine(a) || /^[「『“‘]/.test(a)) {
      score += 18;
      reasons.push('dialogue-end');
    }
    if (isDialogueLine(b) || /^[「『“‘]/.test(b)) {
      score += 28;
      reasons.push('dialogue-start');
    }

    if (startsWithAny(b, STRONG_TRANSITIONS)) {
      score += 28;
      reasons.push('strong-transition');
    } else if (startsWithAny(b, MEDIUM_TRANSITIONS)) {
      score += 14;
      reasons.push('transition');
    }

    if (startsWithAny(b, DEPENDENT_STARTS)) {
      score -= 16;
      reasons.push('dependent-start');
    }

    const la = charLength(a);
    const lb = charLength(b);

    // Rhythm change is often an intentional reveal point.
    if (la <= 22 && lb >= 38) {
      score += 16;
      reasons.push('short-to-long');
    } else if (la >= 45 && lb <= 20) {
      score += 14;
      reasons.push('long-to-short');
    }

    // Very short fragments usually want company unless there is another strong signal.
    if (la <= 12 && score < 65) {
      score -= 13;
      reasons.push('avoid-tiny-scene');
    }

    return { score: Math.max(0, Math.min(100, score)), reasons };
  }

  function tokenisePlainText(lines) {
    const tokens = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex].trim();
      if (!line) continue;
      const lineTokens = sentenceTokens(line);
      for (let i = 0; i < lineTokens.length; i++) {
        tokens.push({
          ...lineTokens[i],
          authorLineBreakAfter: i === lineTokens.length - 1 && lineIndex < lines.length - 1
        });
      }
    }
    return tokens;
  }

  function splitLongToken(text, hardMax) {
    const s = String(text ?? '').trim();
    if (charLength(s) <= hardMax) return [s];

    const chars = [...s];
    const out = [];
    let start = 0;
    while (chars.length - start > hardMax) {
      const minCut = start + Math.round(hardMax * 0.58);
      const maxCut = Math.min(chars.length, start + hardMax);
      let cut = -1;

      for (let i = maxCut; i >= minCut; i--) {
        if (['、','，',',','；',';', '：',':',' '].includes(chars[i - 1])) {
          cut = i;
          break;
        }
      }
      if (cut < 0) cut = maxCut;
      out.push(chars.slice(start, cut).join('').trim());
      start = cut;
    }
    const rest = chars.slice(start).join('').trim();
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }

  function expandOversizeTokens(tokens, hardMax) {
    const out = [];
    for (const token of tokens) {
      const pieces = splitLongToken(token.text, hardMax);
      pieces.forEach((piece, i) => {
        out.push({
          text: piece,
          endMark: i === pieces.length - 1 ? token.endMark : '',
          authorLineBreakAfter: i === pieces.length - 1 ? token.authorLineBreakAfter : false,
          forcedPiece: pieces.length > 1
        });
      });
    }
    return out;
  }

  function sceneCost(length, target, min, softMax, densityMeta={}) {
    const delta = Math.abs(length - target) / Math.max(1, target);
    let cost = delta * delta * 34;

    // TAP fatigue: each extra Scene still has a fixed cost.
    cost += 16;

    if (length < min) cost += ((min - length) / min) * 40;
    if (length > softMax) cost += ((length - softMax) / softMax) * 50;

    const comfort = densityMeta.comfort || Math.round(target * 0.82);
    const alert = densityMeta.alert || Math.round(target * 1.08);
    const heavy = densityMeta.heavy || Math.round(target * 1.30);

    // Scene Density Control:
    // one Scene can be semantically correct but visually heavy.
    if (length > comfort) {
      cost += ((length - comfort) / Math.max(1, target)) * 8;
    }
    if (length > alert) {
      cost += ((length - alert) / Math.max(1, target)) * 18;
    }
    if (length > heavy) {
      cost += ((length - heavy) / Math.max(1, target)) * 34;
    }

    return cost;
  }

  function packByHideScore(tokens, targets) {
    if (!tokens.length) return [];
    if (tokens.length === 1) return [{ start:0, end:1, score:0, reasons:['single-token'] }];

    const n = tokens.length;
    const boundaries = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      boundaries[i] = boundaryScore(tokens[i], tokens[i + 1], {
        authorLineBreak: !!tokens[i].authorLineBreakAfter
      });
    }

    // Prefix character counts. We use a newline between source sentences in a Scene.
    const lens = tokens.map(t => charLength(t.text));
    const prefix = [0];
    for (let i = 0; i < n; i++) prefix.push(prefix[i] + lens[i]);
    const chunkLen = (a,b) => prefix[b] - prefix[a] + Math.max(0, b-a-1);

    // Dynamic programming:
    // choose Scene boundaries that balance readable size vs. Hide Score.
    const dp = new Array(n + 1).fill(Infinity);
    const prev = new Array(n + 1).fill(-1);
    const cutInfo = new Array(n + 1).fill(null);
    dp[0] = 0;

    for (let end = 1; end <= n; end++) {
      for (let start = Math.max(0, end - 12); start < end; start++) {
        const len = chunkLen(start, end);
        if (len > targets.hardMax && end - start > 1) continue;

        let cost = dp[start] + sceneCost(
          len,
          targets.target,
          targets.min,
          targets.softMax,
          targets
        );
        let info = { score: 0, reasons: ['end'] };

        if (end < n) {
          info = boundaries[end - 1];

          // A high Hide Score makes this cut cheaper.
          cost -= info.score * 0.62;

          // v2.1: once the current Scene starts feeling visually heavy,
          // even a medium-strength boundary becomes more valuable.
          if (len > targets.alert && info.score >= 36) {
            cost -= Math.min(18, (len - targets.alert) * 0.18);
          }
          if (len > targets.heavy && info.score >= 28) {
            cost -= Math.min(28, (len - targets.heavy) * 0.28);
          }

          // Explicit single line breaks are respected strongly, but not absolutely.
          if (tokens[end - 1].authorLineBreakAfter) cost -= 18;
        }

        // Avoid crossing extremely strong author/rhythm boundaries.
        // v2.1 also discourages swallowing several medium boundaries into
        // one visually heavy Scene.
        let mediumCrossings = 0;
        for (let k = start; k < end - 1; k++) {
          if (boundaries[k].score >= 82) cost += 18;
          if (boundaries[k].score >= 42) mediumCrossings++;
        }
        if (len > targets.alert && mediumCrossings >= 2) {
          cost += mediumCrossings * 4;
        }
        if (len > targets.heavy && mediumCrossings >= 1) {
          cost += mediumCrossings * 7;
        }

        if (cost < dp[end]) {
          dp[end] = cost;
          prev[end] = start;
          cutInfo[end] = info;
        }
      }
    }

    const segments = [];
    let end = n;
    while (end > 0) {
      const start = prev[end] >= 0 ? prev[end] : end - 1;
      const info = end < n ? boundaries[end - 1] : { score: 0, reasons: ['end'] };
      segments.push({ start, end, score: info.score, reasons: info.reasons });
      end = start;
    }
    segments.reverse();
    return segments;
  }

  function makeChunk(text, type='text', reason='v2', debug={}) {
    return { text: text.trim(), type, reason, debug };
  }

  function processPlainLines(lines, totalLength, options) {
    const globallyPlanned = planPlainTextGlobally(lines, totalLength, options);
    if (globallyPlanned && globallyPlanned.length) return globallyPlanned;
    const density = options.density || DEFAULT_PROFILE.density;
    const policy = densityPolicy(totalLength, density);
    const targets = {
      ...policy,
      min: Number(options.minScene) || policy.min,
      hardMax: Number(options.maxScene) || policy.hardMax
    };
    targets.softMax = Math.min(targets.softMax, targets.hardMax);

    let tokens = tokenisePlainText(lines);
    tokens = expandOversizeTokens(tokens, targets.hardMax);

    if (!tokens.length) return [];
    const segments = packByHideScore(tokens, targets);

    return segments.map(seg => {
      const part = tokens.slice(seg.start, seg.end);
      const text = part.map(t => t.text).join('\n');
      return makeChunk(text, 'text', 'hide-score', {
        hideScoreAfter: seg.score,
        boundaryReasons: seg.reasons,
        charCount: charLength(text),
        target: targets.target,
        min: targets.min,
        softMax: targets.softMax,
        hardMax: targets.hardMax
      });
    });
  }



  /*
   * v2.3 — role-aware boundary layer
   *
   * We still do not "understand" the prose with AI.
   * Instead, lightweight lexical/structural cues estimate a sentence role:
   * intro / turn / summary / next-step / list-item / ordinary.
   *
   * Goal:
   * prefer "role changes" over visually perfect 50/50 cuts.
   */

  const ROLE_STARTERS = {
    intro: [
      '最初は','はじめは','初めは','まず','そもそも','今回','ここでは'
    ],
    turn: [
      'しかし','でも','ただ','ところが','一方で','とはいえ','けれど','けど',
      'もちろん','しかも','逆に','むしろ'
    ],
    summary: [
      'つまり','要するに','結局','結果として','これで','こうして',
      'やることだけ書けば','言い換えると'
    ],
    next: [
      '次は','次に','そこで','さて','では','じゃあ','ここから'
    ]
  };

  const PARALLEL_START_RE = /^(?:チャット|Scene画像|背景|BGM|Ambient|SE|画像|音|文字|文章|話者|アイコン|左右|吹き出し|表示|演出)(?:なら|では|は|を|が)/;

  function sentenceRole(text=''){
    const t=String(text).trim();
    for(const [role, starters] of Object.entries(ROLE_STARTERS)){
      if(startsWithAny(t, starters)) return role;
    }
    if(PARALLEL_START_RE.test(t)) return 'list-item';
    return 'ordinary';
  }

  function roleBoundaryScore(prevText='', nextText=''){
    const prevRole=sentenceRole(prevText);
    const nextRole=sentenceRole(nextText);
    let score=0;
    const reasons=[];

    // A new rhetorical phase is a good hiding point.
    if(nextRole==='turn'){
      score+=34; reasons.push('role-turn');
    }
    if(nextRole==='summary'){
      score+=42; reasons.push('role-summary');
    }
    if(nextRole==='next'){
      score+=46; reasons.push('role-next');
    }

    // Intro -> explanation is often a satisfying first TAP.
    if(prevRole==='intro' && (nextRole==='ordinary' || nextRole==='list-item')){
      score+=30; reasons.push('intro-to-body');
    }

    // Keep parallel explanation/list items together where possible.
    if(prevRole==='list-item' && nextRole==='list-item'){
      score-=30; reasons.push('keep-parallel');
    }

    // Summary should usually stay after the explanatory group, not be
    // swallowed into it merely to create a balanced Scene.
    if(prevRole==='list-item' && nextRole==='summary'){
      score+=34; reasons.push('parallel-to-summary');
    }

    return {score,reasons,prevRole,nextRole};
  }

  /*
   * v2.2 — second-pass Scene density refinement
   *
   * First pass:
   *   build semantically natural Scenes with Hide Score.
   *
   * Second pass:
   *   only for visually heavy Scenes, search for the "second-best"
   *   internal boundary worth hiding behind.
   */
  function bestInternalDensityCut(text, totalLength, options={}) {
    const density = options.density || DEFAULT_PROFILE.density;
    const policy = densityPolicy(totalLength, density);
    const lines = String(text ?? '').split('\n').map(s=>s.trim()).filter(Boolean);

    let tokens = tokenisePlainText(lines);
    tokens = expandOversizeTokens(tokens, policy.hardMax);

    // Never split a single sentence just because it is long.
    if (tokens.length < 2) return null;

    const tokenLens = tokens.map(t=>charLength(t.text));
    const prefix=[0];
    for(let i=0;i<tokens.length;i++) prefix.push(prefix[i]+tokenLens[i]);
    const partLen=(a,b)=>prefix[b]-prefix[a]+Math.max(0,b-a-1);
    const fullLen=partLen(0,tokens.length);

    if (fullLen <= policy.alert) return null;

    let best=null;

    for(let cut=1;cut<tokens.length;cut++){
      const leftLen=partLen(0,cut);
      const rightLen=partLen(cut,tokens.length);

      // Avoid creating nuisance Scenes.
      if(leftLen < policy.minReadable || rightLen < policy.minReadable) continue;

      const boundary=boundaryScore(tokens[cut-1],tokens[cut],{
        authorLineBreak:!!tokens[cut-1].authorLineBreakAfter
      });
      const role=roleBoundaryScore(tokens[cut-1]?.text||'',tokens[cut]?.text||'');
      const semanticBoundaryScore=boundary.score + role.score;

      // v2.3: a rhetorical role change can validate a boundary even when
      // the generic Hide Score alone is only moderate.
      const minBoundary = fullLen >= policy.heavy ? 24 : 28;
      if(semanticBoundaryScore < minBoundary) continue;

      // Balance is intentionally weaker than v2.2. We would rather produce
      // 31/69 at a meaningful transition than 50/50 in the middle of a thought.
      const imbalance=Math.abs(leftLen-rightLen)/Math.max(1,fullLen);
      const balanceBonus=(1-imbalance)*8;

      let relief=0;
      if(leftLen<=policy.alert) relief+=8;
      if(rightLen<=policy.alert) relief+=8;
      if(leftLen<=policy.comfort) relief+=4;
      if(rightLen<=policy.comfort) relief+=4;

      const nextText=tokens[cut]?.text||'';
      const dependentPenalty=startsWithAny(nextText,DEPENDENT_STARTS)?18:0;

      const score=boundary.score*1.05 + role.score*1.35 + balanceBonus + relief - dependentPenalty;

      if(!best || score>best.score){
        best={
          cut, score,
          boundary:{
            ...boundary,
            score:semanticBoundaryScore,
            reasons:[...(boundary.reasons||[]),...(role.reasons||[])]
          },
          role,
          leftLen, rightLen,
          policy, tokens
        };
      }
    }

    return best;
  }

  function refineDenseChunk(chunk,totalLength,options={},depth=0){
    if(!chunk?.text || chunk.reason!=='hide-score') return [chunk];
    if(depth>=2) return [chunk];

    const cut=bestInternalDensityCut(chunk.text,totalLength,options);
    if(!cut) return [chunk];

    const leftTokens=cut.tokens.slice(0,cut.cut);
    const rightTokens=cut.tokens.slice(cut.cut);
    const leftText=leftTokens.map(t=>t.text).join('\n');
    const rightText=rightTokens.map(t=>t.text).join('\n');

    const left=makeChunk(leftText,'text','density-refine',{
      hideScoreAfter:cut.boundary.score,
      boundaryReasons:[...(cut.boundary.reasons||[]),'density-refine'],
      charCount:charLength(leftText),
      target:cut.policy.target,
      comfort:cut.policy.comfort,
      alert:cut.policy.alert,
      heavy:cut.policy.heavy,
      refinedFromChars:charLength(chunk.text)
    });

    const right=makeChunk(rightText,'text','hide-score',{
      ...(chunk.debug||{}),
      charCount:charLength(rightText),
      refinedFromChars:charLength(chunk.text)
    });

    return [
      ...refineDenseChunk(left,totalLength,options,depth+1),
      ...refineDenseChunk(right,totalLength,options,depth+1)
    ];
  }

  function refineDenseScenes(chunks,totalLength,options={}){
    const out=[];
    for(const chunk of chunks){
      out.push(...refineDenseChunk(chunk,totalLength,options,0));
    }
    return out;
  }





  /*
   * v2.7 — Dependency / Merge Value
   *
   * Standalone Value asks:
   *   "Can the next Scene stand on its own?"
   *
   * Dependency Value asks:
   *   "Even if it can, do these two pieces belong together strongly enough
   *    that forcing a TAP between them would damage the thought?"
   *
   * Higher dependency => prefer keeping together.
   */

  const STRONG_DEPENDENT_NEXT = [
    'だから','なので','そのため','その結果','つまり','要するに','というわけで',
    'ということで','ゆえに','従って','したがって','そこで'
  ];

  const SOFT_DEPENDENT_NEXT = [
    'でも','しかし','ただ','けれど','けれども','とはいえ','逆に','一方で',
    'しかも','もちろん','また','さらに'
  ];

  function dependencyValue(prevText='', nextText='', context={}){
    const prev=String(prevText||'').trim();
    const next=String(nextText||'').trim();
    if(!prev || !next) return {value:0,reasons:[]};

    let value=8;
    const reasons=[];

    if(startsWithAny(next, STRONG_DEPENDENT_NEXT)){
      value+=46; reasons.push('dep-strong-connector');
    } else if(startsWithAny(next, SOFT_DEPENDENT_NEXT)){
      value+=24; reasons.push('dep-soft-connector');
    }

    // Colon / declaration -> short naming sentence:
    // "次に育てたいのは..." -> "Splitterだ。"
    // This can be intentionally dramatic, so do not force a merge.
    if(
      /(?:もの|部分|正体|答え|名前|理由|結論|問題)[。！？!?]?$/.test(prev) &&
      charLength(next)<=18
    ){
      value-=18; reasons.push('dep-allow-reveal-label');
    }

    // Previous sentence explicitly opens an explanation.
    if(/(?:ということだ|という意味だ|という話だ|というわけだ|ことになる)[。！？!?]?$/.test(prev)){
      value+=18; reasons.push('dep-explanation-chain');
    }

    // Pronoun / anaphora: next sentence depends on what was just introduced.
    if(/^(?:これ|それ|この|その|こう|そう|そこ|ここ|そんな|こんな)/.test(next)){
      value+=22; reasons.push('dep-anaphora');
    }

    // Short setup followed by explanation often belongs together.
    const lp=charLength(prev), ln=charLength(next);
    if(lp<=28 && ln>=34 && !/[！？!?]$/.test(prev)){
      value+=12; reasons.push('dep-short-setup');
    }

    // Parallel/list items belong together.
    const pr=sentenceRole(prev), nr=sentenceRole(next);
    if(pr==='list-item' && nr==='list-item'){
      value+=34; reasons.push('dep-parallel');
    }

    // Intro -> body often belongs together unless TAP value is very high.
    if(pr==='intro' && (nr==='ordinary' || nr==='list-item')){
      value+=14; reasons.push('dep-intro-body');
    }

    // Summary / next-step boundaries should remain separable.
    if(nr==='summary' || nr==='next'){
      value-=18; reasons.push('dep-allow-phase-change');
    }

    // Strong punctuation reduces dependency.
    if(/[！？!?][」』”’]?$/.test(prev)){
      value-=18; reasons.push('dep-punctuation-break');
    }
    if(/(?:…|——|――|\.\.\.)[」』”’]?$/.test(prev)){
      value-=16; reasons.push('dep-pause-break');
    }

    // Explicit author line break: respect the author's potential rhythm.
    if(context.authorLineBreak){
      value-=10; reasons.push('dep-author-line-break');
    }

    return {value:Math.max(0,Math.min(100,value)),reasons};
  }

  /*
   * v2.6 — Standalone Value
   *
   * TAP Value asks whether a boundary deserves a TAP.
   * Standalone Value asks whether the Scene created by that TAP
   * is strong enough to stand on its own.
   *
   * This prevents weak one-sentence explanatory Scenes from surviving
   * merely because both neighboring boundaries looked natural.
   */

  const STANDALONE_STARTERS = [
    'しかし','でも','ただ','ところが','逆に','むしろ','つまり','結局',
    '次は','そこで','さて','では','じゃあ','そのとき','その時','すると',
    'しかも','もちろん'
  ];

  function standaloneSceneValue(text, context={}){
    const t=String(text??'').trim();
    const len=charLength(t);
    let value=18;
    const reasons=[];

    if(!t) return {value:0,reasons:['empty']};

    const sentences=sentenceTokens(t);
    const sentenceCount=sentences.length || 1;

    // Strong scene-like shapes.
    if(isDialogueLine(t) || /^[「『“‘]/.test(t)){
      value+=34; reasons.push('standalone-dialogue');
    }
    if(/[！？!?][」』”’]?$/.test(t)){
      value+=22; reasons.push('standalone-question-exclamation');
    }
    if(/(?:…|——|――|\.\.\.)[」』”’]?$/.test(t)){
      value+=20; reasons.push('standalone-pause');
    }
    if(startsWithAny(t, STANDALONE_STARTERS)){
      value+=18; reasons.push('standalone-transition');
    }

    const role=sentenceRole(t);
    if(role==='summary'){
      value+=22; reasons.push('standalone-summary');
    }
    if(role==='next'){
      value+=24; reasons.push('standalone-next');
    }
    if(role==='turn'){
      value+=18; reasons.push('standalone-turn');
    }

    // Very short declarative facts are often weak standalone Scenes unless
    // another signal above makes them feel like a beat.
    if(len<=24 && sentenceCount===1){
      value-=18; reasons.push('standalone-short-fact');
    }else if(len<=34 && sentenceCount===1){
      value-=8; reasons.push('standalone-short');
    }

    // Multi-sentence chunks usually have enough internal substance.
    if(sentenceCount>=2){
      value+=12; reasons.push('standalone-multi-sentence');
    }

    // Context: a Scene bounded by high-value TAPs is more defensible.
    const beforeTap=Number(context.beforeTap??0);
    const afterTap=Number(context.afterTap??0);
    value += Math.min(14, Math.round(beforeTap*0.12));
    value += Math.min(14, Math.round(afterTap*0.12));

    // If both adjacent TAPs are weak, standalone value should fall quickly.
    if(beforeTap<18 && afterTap<18){
      value-=20; reasons.push('standalone-weak-neighbors');
    }

    return {value:Math.max(0,Math.min(100,value)),reasons};
  }

  /*
   * v2.5 — TAP Value
   *
   * Boundary Score asks:
   *   "Is this a natural place to split?"
   *
   * TAP Value asks:
   *   "Even if it is natural, is it worth making the reader TAP here?"
   *
   * This deliberately suppresses low-value explanatory cuts while preserving
   * reveals, transitions, author pauses, dialogue, questions and summaries.
   */
  function tapValueAtBoundary(tokens, cut){
    if(cut<=0 || cut>=tokens.length)return {value:0,reasons:['edge']};

    const prev=tokens[cut-1]?.text||'';
    const next=tokens[cut]?.text||'';
    const base=plannedBoundaryScore(tokens,cut);
    const role=roleBoundaryScore(prev,next);

    let value=8;
    const reasons=[];

    // Author intent is expensive to ignore.
    if(tokens[cut-1]?.authorLineBreakAfter){
      value+=28; reasons.push('tap-author-intent');
    }

    // Strong reader-facing moments.
    if(/[！？!?][」』”’]?$/.test(prev)){
      value+=20; reasons.push('tap-question-exclamation');
    }
    if(/(?:…|——|――|\.\.\.)[」』”’]?$/.test(prev)){
      value+=22; reasons.push('tap-pause');
    }
    if(isDialogueLine(prev) || isDialogueLine(next) || /^[「『“‘]/.test(next)){
      value+=22; reasons.push('tap-dialogue');
    }

    if(role.nextRole==='turn'){
      value+=26; reasons.push('tap-turn');
    }
    if(role.nextRole==='summary'){
      value+=30; reasons.push('tap-summary');
    }
    if(role.nextRole==='next'){
      value+=32; reasons.push('tap-next-step');
    }
    if(role.prevRole==='intro' && (role.nextRole==='ordinary'||role.nextRole==='list-item')){
      value+=18; reasons.push('tap-intro-to-body');
    }

    // Parallel explanations should usually be consumed together.
    if(role.prevRole==='list-item' && role.nextRole==='list-item'){
      value-=34; reasons.push('tap-keep-parallel');
    }

    // Generic sentence boundaries are natural, but often not worth a TAP.
    const strongReason=(base.reasons||[]).some(r =>
      ['strong-transition','dialogue-start','dialogue-end','question-or-exclamation','pause-or-beat'].includes(r)
    );
    if(!strongReason && role.nextRole==='ordinary' && role.prevRole==='ordinary'){
      value-=12; reasons.push('tap-ordinary-continuation');
    }

    // Very short preceding statement can be a deliberate beat, but only if
    // the next sentence changes phase. Otherwise it should usually merge.
    if(charLength(prev)<=22 && role.nextRole==='ordinary' && !tokens[cut-1]?.authorLineBreakAfter){
      value-=8; reasons.push('tap-short-fact');
    }

    // Base boundary quality still matters, but much less than in v2.4.
    value += Math.max(0, Math.min(18, Math.round((base.score-28)*0.22)));

    return {value:Math.max(0,Math.min(100,value)),reasons,baseScore:base.score};
  }


  /*
   * v2.8 — Local TAP Density / TAP interval
   *
   * Each individual boundary may be valid, but several short Scenes in a row
   * can make reading feel like "tap, tap, tap".
   *
   * This layer asks:
   *   "How much text has the reader received since the last few TAPs?"
   *
   * It does NOT globally reduce Scene count. It only raises the cost of a new
   * boundary when the immediately preceding reading rhythm is already too dense.
   */
  function localTapDensityPenalty(recentLens=[], currentLen=0, boundaryInfo={}){
    const lens=[...(recentLens||[]), Number(currentLen)||0].filter(n=>n>0).slice(-3);
    if(!lens.length) return {penalty:0,level:'none',reasons:[]};

    const reasons=[];
    const last=lens[lens.length-1]||0;
    const prev=lens[lens.length-2]||0;
    const prev2=lens[lens.length-3]||0;

    let penalty=0;

    // Two short Scene intervals in succession.
    if(prev>0 && prev<=34 && last<=34){
      penalty+=18;
      reasons.push('local-two-short');
    }

    // Three locally dense TAP intervals.
    if(prev2>0){
      const avg=(prev2+prev+last)/3;
      const sum=prev2+prev+last;
      if(avg<=36){
        penalty+=20;
        reasons.push('local-three-dense');
      }
      if(sum<=92){
        penalty+=12;
        reasons.push('local-low-text-between-taps');
      }
    }

    // Very short new interval right after a short one.
    if(prev>0 && prev<=28 && last<=24){
      penalty+=14;
      reasons.push('local-tap-burst');
    }

    // A genuinely valuable boundary can "pay" part of the rhythm cost.
    const tap=Number(boundaryInfo.tapValue||0);
    const hide=Number(boundaryInfo.hideScore||0);
    if(tap>=48){
      penalty-=16;
      reasons.push('local-strong-tap-relief');
    }else if(tap>=36){
      penalty-=8;
      reasons.push('local-medium-tap-relief');
    }
    if(hide>=82){
      penalty-=8;
      reasons.push('local-strong-hide-relief');
    }

    penalty=Math.max(0,penalty);

    return {
      penalty,
      level: penalty>=28?'high':(penalty>=12?'medium':'low'),
      reasons
    };
  }


  /*
   * v2.9 — TAP Rhythm
   *
   * Local TAP Density counts how tightly TAPs are packed.
   * TAP Rhythm looks at the SHAPE of the recent Scene sequence.
   *
   * Examples:
   *   short -> short -> short : tiring burst
   *   short -> long -> short  : acceptable breathing rhythm
   *   long  -> short          : can feel like a reveal
   *   strong TAP -> short     : preserve when the short Scene is a payoff
   *
   * The planner keeps recent Scene lengths + recent TAP values as state,
   * so rhythm can actually change the chosen path rather than only annotate it.
   */
  function tapRhythmPenalty(recentLens=[], recentTaps=[], currentLen=0, currentTap=0, currentHide=0){
    const lens=[...(recentLens||[]),Number(currentLen)||0].filter(n=>n>0).slice(-4);
    const taps=[...(recentTaps||[]),Number(currentTap)||0].slice(-4);
    const reasons=[];
    let penalty=0;

    const n=lens.length;
    const cur=lens[n-1]||0;
    const p1=lens[n-2]||0;
    const p2=lens[n-3]||0;
    const p3=lens[n-4]||0;
    const prevTap=taps[taps.length-2]||0;

    const isShort=x=>x>0 && x<=30;
    const isMedium=x=>x>30 && x<=64;
    const isLong=x=>x>=65;

    // Burst rhythm: several short Scenes in a row.
    if(isShort(p1) && isShort(cur)){
      penalty+=22; reasons.push('rhythm-short-short');
    }
    if(isShort(p2) && isShort(p1) && isShort(cur)){
      penalty+=28; reasons.push('rhythm-short-short-short');
    }

    // Four-scene tap burst.
    if(isShort(p3) && isShort(p2) && isShort(p1) && cur<=38){
      penalty+=30; reasons.push('rhythm-four-burst');
    }

    // Medium-small-small is also tiring even when the average is not tiny.
    if(isMedium(p2) && isShort(p1) && isShort(cur)){
      penalty+=14; reasons.push('rhythm-tail-burst');
    }

    // Alternation can be pleasant: long -> short -> long or short -> long -> short.
    if(p2>0){
      if((isLong(p2)&&isShort(p1)&&isLong(cur)) || (isShort(p2)&&isLong(p1)&&isShort(cur))){
        penalty-=12; reasons.push('rhythm-alternation-relief');
      }
    }

    // A short Scene after a long Scene can be a payoff/reveal.
    if(isLong(p1) && isShort(cur)){
      penalty-=8; reasons.push('rhythm-payoff-shape');
    }

    // But a short Scene following another weak TAP is usually not worth it.
    if(isShort(cur) && prevTap<20 && currentTap<24){
      penalty+=18; reasons.push('rhythm-weak-tap-short');
    }

    // Strong semantic TAPs are allowed to break the rhythm.
    if(currentTap>=50){
      penalty-=22; reasons.push('rhythm-strong-tap-relief');
    }else if(currentTap>=38){
      penalty-=10; reasons.push('rhythm-medium-tap-relief');
    }
    if(currentHide>=84){
      penalty-=10; reasons.push('rhythm-strong-hide-relief');
    }

    penalty=Math.max(0,penalty);
    return {
      penalty,
      level:penalty>=32?'high':(penalty>=14?'medium':'low'),
      reasons
    };
  }

  // v2.4: score every sentence boundary first, then choose the best Scene sequence globally.
  function plannedBoundaryScore(tokens, cut){
    if(cut<=0 || cut>=tokens.length)return {score:0,reasons:[]};
    const base=boundaryScore(tokens[cut-1],tokens[cut],{authorLineBreak:!!tokens[cut-1].authorLineBreakAfter});
    const role=roleBoundaryScore(tokens[cut-1]?.text||'',tokens[cut]?.text||'');
    let score=base.score+role.score;
    const reasons=[...(base.reasons||[]),...(role.reasons||[])];
    if(tokens[cut-1].authorLineBreakAfter){score+=18;reasons.push('author-intent');}
    return {score,reasons};
  }

  function sceneSpanUtility(tokens,start,end,policy){
    const text=tokens.slice(start,end).map(t=>t.text).join('\n');
    const len=charLength(text);
    let score=0; const reasons=[];
    if(len>=policy.minReadable && len<=policy.comfort){score+=22;reasons.push('comfortable');}
    else if(len<=policy.alert){score+=12;reasons.push('acceptable');}
    else if(len<=policy.heavy){score-=10;reasons.push('dense');}
    else{score-=38+(len-policy.heavy)*0.8;reasons.push('heavy');}
    if(len<policy.minReadable){score-=34+(policy.minReadable-len)*1.3;reasons.push('too-short');}
    score-=Math.abs(len-policy.target)*0.10;
    if(end<tokens.length && sentenceRole(tokens[end-1]?.text||'')==='list-item' && sentenceRole(tokens[end]?.text||'')==='list-item'){
      score-=44; reasons.push('parallel-break');
    }
    return {score,len,text,reasons};
  }

  function planPlainTextGlobally(lines,totalLength,options={}){
    const policy=densityPolicy(totalLength,options.density||DEFAULT_PROFILE.density);
    let tokens=tokenisePlainText(lines);
    tokens=expandOversizeTokens(tokens,policy.hardMax);
    const n=tokens.length;
    if(n<=1)return null;
    const dp=Array(n+1).fill(null);
    dp[0]={score:0,prev:-1,recentLens:[],recentTaps:[]};
    for(let end=1;end<=n;end++){
      let best=null;
      for(let start=0;start<end;start++){
        if(!dp[start])continue;
        const span=sceneSpanUtility(tokens,start,end,policy);
        if(span.len>policy.hardMax && end-start>1)continue;
        const boundary=end<n?plannedBoundaryScore(tokens,end):{score:0,reasons:['end']};
        const tap=end<n?tapValueAtBoundary(tokens,end):{value:0,reasons:['end']};

        const beforeTap=start>0?tapValueAtBoundary(tokens,start):{value:0,reasons:['start']};
        const standalone=standaloneSceneValue(span.text,{
          beforeTap:beforeTap.value,
          afterTap:tap.value
        });

        const dep=end<n?dependencyValue(
          tokens[end-1]?.text||'',
          tokens[end]?.text||'',
          {authorLineBreak:!!tokens[end-1]?.authorLineBreakAfter}
        ):{value:0,reasons:['end']};

        // v2.7:
        // Natural / TAP-worthy / standalone are not enough.
        // If the next sentence strongly depends on this one, a boundary
        // should become more expensive.
        const reward=end<n ? (boundary.score*0.26 + tap.value*1.03) : 8;
        const weak=end<n && tap.value<14 ? 24 : 0;

        let standaloneTerm=(standalone.value-40)*0.34;
        if(standalone.value<22) standaloneTerm-=16;

        let dependencyPenalty=end<n ? dep.value*0.72 : 0;
        if(dep.value>=52) dependencyPenalty+=14;

        const localDensity=end<n
          ? localTapDensityPenalty(dp[start].recentLens||[],span.len,{
              tapValue:tap.value,
              hideScore:boundary.score
            })
          : {penalty:0,level:'none',reasons:['end']};

        const rhythm=end<n
          ? tapRhythmPenalty(
              dp[start].recentLens||[],
              dp[start].recentTaps||[],
              span.len,
              tap.value,
              boundary.score
            )
          : {penalty:0,level:'none',reasons:['end']};

        const total=
          dp[start].score+
          span.score+
          reward-
          weak+
          standaloneTerm-
          dependencyPenalty-
          localDensity.penalty-
          rhythm.penalty;

        const nextRecent=[...(dp[start].recentLens||[]),span.len].slice(-4);
        const nextTaps=[...(dp[start].recentTaps||[]),tap.value].slice(-4);

        if(!best||total>best.score)best={
          score:total,
          prev:start,
          span,
          tap,
          standalone,
          dep,
          localDensity,
          rhythm,
          recentLens:nextRecent,
          recentTaps:nextTaps
        };
      }
      dp[end]=best;
    }
    if(!dp[n])return null;
    const spans=[]; let cur=n;
    while(cur>0){
      const node=dp[cur]; if(!node||node.prev<0)break;
      spans.push({start:node.prev,end:cur,span:node.span}); cur=node.prev;
    }
    spans.reverse();
    if(spans.length<=1)return null;
    return spans.map((x,i)=>{
      const b=x.end<n?plannedBoundaryScore(tokens,x.end):{score:0,reasons:['end']};
      const tap=x.end<n?tapValueAtBoundary(tokens,x.end):{value:0,reasons:['end']};
      const beforeTap=x.start>0?tapValueAtBoundary(tokens,x.start):{value:0,reasons:['start']};
      const standalone=standaloneSceneValue(x.span.text,{
        beforeTap:beforeTap.value,
        afterTap:tap.value
      });
      const dep=x.end<n?dependencyValue(
        tokens[x.end-1]?.text||'',
        tokens[x.end]?.text||'',
        {authorLineBreak:!!tokens[x.end-1]?.authorLineBreakAfter}
      ):{value:0,reasons:['end']};

      // Reconstruct local rhythm for diagnostics from already chosen spans.
      const recentLens=spans.slice(Math.max(0,i-2),i).map(s=>s.span.len);
      const localDensity=x.end<n?localTapDensityPenalty(recentLens,x.span.len,{
        tapValue:tap.value,
        hideScore:b.score
      }):{penalty:0,level:'none',reasons:['end']};

      const recentTaps=spans.slice(Math.max(0,i-2),i).map(s=>{
        const bx=s.end<n?plannedBoundaryScore(tokens,s.end):{score:0};
        return s.end<n?tapValueAtBoundary(tokens,s.end).value:0;
      });
      const rhythm=x.end<n?tapRhythmPenalty(
        recentLens,
        recentTaps,
        x.span.len,
        tap.value,
        b.score
      ):{penalty:0,level:'none',reasons:['end']};

      return makeChunk(x.span.text,'text','global-plan',{
        charCount:x.span.len,
        hideScoreAfter:b.score,
        tapValueAfter:tap.value,
        standaloneValue:standalone.value,
        dependencyAfter:dep.value,
        localTapDensityPenalty:localDensity.penalty,
        localTapDensityLevel:localDensity.level,
        tapRhythmPenalty:rhythm.penalty,
        tapRhythmLevel:rhythm.level,
        boundaryReasons:[
          ...(b.reasons||[]),
          ...(tap.reasons||[]),
          ...(standalone.reasons||[]),
          ...(dep.reasons||[]),
          ...(localDensity.reasons||[]),
          ...(rhythm.reasons||[]),
          ...(x.span.reasons||[]),
          'global-plan'
        ],
        target:policy.target,comfort:policy.comfort,alert:policy.alert,heavy:policy.heavy,
        planIndex:i,planScenes:spans.length
      });
    });
  }


  function filterLowValueTaps(chunks,totalLength,options={}){
    if(!chunks?.length)return chunks||[];
    const policy=densityPolicy(totalLength,options.density||DEFAULT_PROFILE.density);
    const out=[];

    for(const chunk of chunks){
      const prev=out[out.length-1];

      if(prev && prev.reason==='global-plan' && chunk.reason==='global-plan'){
        const tap=Number(prev.debug?.tapValueAfter ?? 0);
        const standalone=Number(chunk.debug?.standaloneValue ?? 0);
        const dependency=Number(prev.debug?.dependencyAfter ?? 0);
        const combinedText=`${prev.text}\n${chunk.text}`;
        const combinedLen=charLength(combinedText);

        // v2.7:
        // merge when TAP is weak, next Scene is weak, OR the sentence pair
        // has strong dependency — provided density remains acceptable.
        const weakTap=tap<20;
        const weakStandalone=standalone<26;
        const strongDependency=dependency>=44;
        const safeMerge=combinedLen<=policy.alert;

        if((weakTap || weakStandalone || strongDependency) && safeMerge){
          prev.text=combinedText;
          prev.debug={
            ...(prev.debug||{}),
            charCount:combinedLen,
            tapValueAfter:chunk.debug?.tapValueAfter ?? 0,
            hideScoreAfter:chunk.debug?.hideScoreAfter ?? 0,
            standaloneValue:standaloneSceneValue(combinedText,{
              beforeTap:0,
              afterTap:chunk.debug?.tapValueAfter ?? 0
            }).value,
            dependencyAfter:chunk.debug?.dependencyAfter ?? 0,
            boundaryReasons:[
              ...((prev.debug?.boundaryReasons)||[]),
              weakTap?'tap-filter-merged':(weakStandalone?'standalone-filter-merged':'dependency-filter-merged')
            ],
            mergedLowTap:weakTap||undefined,
            mergedLowStandalone:weakStandalone||undefined,
            mergedDependency:strongDependency||undefined
          };
          continue;
        }
      }
      out.push(chunk);
    }
    return out;
  }


  function smoothTapRhythm(chunks,totalLength,options={}){
    if(!chunks?.length)return chunks||[];
    const policy=densityPolicy(totalLength,options.density||DEFAULT_PROFILE.density);
    const out=[];
    let i=0;

    while(i<chunks.length){
      const a=chunks[i], b=chunks[i+1], c=chunks[i+2];

      // Conservative post-pass:
      // if two adjacent short global-plan Scenes form a weak TAP burst,
      // merge the weaker boundary as long as density remains acceptable.
      if(
        a && b &&
        a.reason==='global-plan' && b.reason==='global-plan'
      ){
        const la=charLength(a.text), lb=charLength(b.text);
        const tapA=Number(a.debug?.tapValueAfter??0);
        const hideA=Number(a.debug?.hideScoreAfter??0);
        const depA=Number(a.debug?.dependencyAfter??0);
        const combinedLen=la+lb+1;

        const weakBurst=la<=30 && lb<=30 && tapA<38 && hideA<82;
        const dependentBurst=la<=34 && lb<=34 && depA>=28 && tapA<42;

        if((weakBurst || dependentBurst) && combinedLen<=policy.alert){
          const merged={...a};
          merged.text=`${a.text}\n${b.text}`;
          merged.debug={
            ...(a.debug||{}),
            charCount:combinedLen,
            tapValueAfter:b.debug?.tapValueAfter??0,
            hideScoreAfter:b.debug?.hideScoreAfter??0,
            standaloneValue:standaloneSceneValue(`${a.text}\n${b.text}`,{
              beforeTap:0,
              afterTap:b.debug?.tapValueAfter??0
            }).value,
            dependencyAfter:b.debug?.dependencyAfter??0,
            localTapDensityPenalty:0,
            tapRhythmPenalty:0,
            boundaryReasons:[
              ...((a.debug?.boundaryReasons)||[]),
              weakBurst?'rhythm-filter-merged':'rhythm-dependency-merged'
            ],
            mergedTapRhythm:true
          };
          out.push(merged);
          i+=2;
          continue;
        }
      }

      out.push(a);
      i++;
    }
    return out;
  }



  /*
   * v2.10 — Sequence Optimizer / Scene列最適化
   *
   * v2.4-v2.9 evaluate boundaries while creating Scenes.
   * v2.10 adds a second planner over the RESULTING Scene sequence.
   *
   * It can remove a boundary even when that boundary looked locally valid,
   * if the whole local sequence reads better after merging.
   *
   * It optimizes per author paragraph/block and never crosses blank-line
   * paragraph boundaries.
   */

  function isProtectedSequenceChunk(chunk){
    if(!chunk) return true;
    if(chunk.type==='dialogue') return true;
    if(chunk.reason==='author-dialogue-line') return true;
    if(chunk.reason==='author-beat') return true;
    if(chunk.reason==='list-block') return true;
    return false;
  }

  function sequenceBoundaryValue(left,right){
    if(!left || !right) return {value:100,reasons:['edge']};

    let value=0;
    const reasons=[];

    const debug=left.debug||{};
    const tap=Number(debug.tapValueAfter);
    const hide=Number(debug.hideScoreAfter);
    const dep=Number(debug.dependencyAfter);

    if(Number.isFinite(tap)){
      value += tap*0.72;
      reasons.push('seq-debug-tap');
    }
    if(Number.isFinite(hide)){
      value += hide*0.24;
      reasons.push('seq-debug-hide');
    }
    if(Number.isFinite(dep)){
      value -= dep*0.46;
      reasons.push('seq-debug-dependency');
    }

    // Many legacy/single-token chunks do not carry v2.5+ diagnostics.
    // Re-estimate the boundary directly from their last/first sentences.
    const leftTokens=sentenceTokens(left.text||'');
    const rightTokens=sentenceTokens(right.text||'');
    const prev=leftTokens[leftTokens.length-1]?.text || left.text || '';
    const next=rightTokens[0]?.text || right.text || '';

    const base=boundaryScore({text:prev},{text:next});
    const role=roleBoundaryScore(prev,next);
    const dep2=dependencyValue(prev,next,{authorLineBreak:false});

    if(!Number.isFinite(tap)) value += Math.max(0,base.score+role.score)*0.52;
    if(!Number.isFinite(dep)) value -= dep2.value*0.46;

    if(startsWithAny(next,STRONG_DEPENDENT_NEXT)){
      value-=24;
      reasons.push('seq-strong-dependency');
    }

    // Strong reveal/dialogue shapes should stay separate.
    if(isDialogueLine(left.text||'') || isDialogueLine(right.text||'')){
      value+=40;
      reasons.push('seq-dialogue');
    }
    if(/[！？!?][」』”’]?$/.test((left.text||'').trim())){
      value+=18;
      reasons.push('seq-question-exclamation');
    }

    return {
      value:Math.max(0,Math.min(100,value)),
      reasons
    };
  }

  function sequenceSceneUtility(text,policy,sourceCount=1){
    const len=charLength(text);
    let value=0;
    const reasons=[];

    // Wide readable plateau.
    if(len>=policy.minReadable && len<=policy.comfort){
      value+=30; reasons.push('seq-comfortable');
    }else if(len<=policy.alert){
      value+=18; reasons.push('seq-acceptable');
    }else if(len<=policy.heavy){
      value-=12; reasons.push('seq-dense');
    }else{
      value-=48+(len-policy.heavy)*0.9; reasons.push('seq-heavy');
    }

    if(len<20){
      value-=28; reasons.push('seq-very-short');
    }else if(len<30){
      value-=14; reasons.push('seq-short');
    }

    // One removed TAP has a small intrinsic benefit, but not enough to
    // override a meaningful boundary by itself.
    if(sourceCount>1){
      value+=(sourceCount-1)*10;
      reasons.push('seq-tap-saved');
    }

    return {value,len,reasons};
  }

  function optimizeSceneSequence(chunks,totalLength,options={}){
    if(!chunks?.length) return chunks||[];
    const policy=densityPolicy(totalLength,options.density||DEFAULT_PROFILE.density);

    // Work independently inside each original paragraph/block.
    const groups=[];
    let current=[];
    let currentBlock=null;

    for(const chunk of chunks){
      const block=chunk.debug?.sourceBlock ?? null;
      if(current.length && block!==currentBlock){
        groups.push(current);
        current=[];
      }
      currentBlock=block;
      current.push(chunk);
    }
    if(current.length) groups.push(current);

    const optimized=[];

    for(const group of groups){
      const n=group.length;
      if(n<=1){
        optimized.push(...group);
        continue;
      }

      const dp=Array(n+1).fill(null);
      dp[0]={score:0,prev:-1,span:1};

      for(let end=1;end<=n;end++){
        let best=null;

        // Merge at most 3 existing Scenes at once. Re-running the optimizer
        // can still produce larger groups, but this avoids over-merging.
        for(let start=Math.max(0,end-3);start<end;start++){
          if(!dp[start]) continue;
          const parts=group.slice(start,end);

          // Protected Scene types remain exact.
          if(parts.length>1 && parts.some(isProtectedSequenceChunk)) continue;

          const mergedText=parts.map(c=>c.text).join('\n');
          const scene=sequenceSceneUtility(mergedText,policy,parts.length);

          if(scene.len>policy.alert && parts.length>1) continue;

          let score=dp[start].score+scene.value;

          // Removing internal boundaries costs their keep-value.
          for(let k=start;k<end-1;k++){
            const b=sequenceBoundaryValue(group[k],group[k+1]);
            score-=b.value*0.86;
          }

          // Keeping the boundary after this output Scene earns its value.
          if(end<n){
            const keep=sequenceBoundaryValue(group[end-1],group[end]);
            score+=keep.value*0.56;
          }

          // Specifically discourage a resulting short-short run.
          const prevOutLen=dp[start].lastLen||0;
          if(prevOutLen>0 && prevOutLen<=28 && scene.len<=28){
            score-=22;
          }

          if(!best || score>best.score){
            best={
              score,
              prev:start,
              span:parts.length,
              lastLen:scene.len,
              scene
            };
          }
        }
        dp[end]=best;
      }

      if(!dp[n]){
        optimized.push(...group);
        continue;
      }

      const spans=[];
      let cursor=n;
      while(cursor>0){
        const node=dp[cursor];
        if(!node || node.prev<0) break;
        spans.push({start:node.prev,end:cursor,node});
        cursor=node.prev;
      }
      spans.reverse();

      for(const span of spans){
        const parts=group.slice(span.start,span.end);
        if(parts.length===1){
          const c={...parts[0],debug:{...(parts[0].debug||{})}};
          c.debug.sequenceOptimized=false;
          optimized.push(c);
          continue;
        }

        const text=parts.map(c=>c.text).join('\n');
        const last=parts[parts.length-1];
        const c={
          ...parts[0],
          text,
          reason:'sequence-optimized',
          debug:{
            ...(parts[0].debug||{}),
            charCount:charLength(text),
            hideScoreAfter:last.debug?.hideScoreAfter ?? 0,
            tapValueAfter:last.debug?.tapValueAfter ?? 0,
            standaloneValue:standaloneSceneValue(text,{
              beforeTap:0,
              afterTap:last.debug?.tapValueAfter ?? 0
            }).value,
            dependencyAfter:last.debug?.dependencyAfter ?? 0,
            localTapDensityPenalty:0,
            tapRhythmPenalty:0,
            sequenceOptimized:true,
            sequenceMergedScenes:parts.length,
            sequenceSourceReasons:parts.map(p=>p.reason),
            boundaryReasons:[
              ...((parts[0].debug?.boundaryReasons)||[]),
              `sequence-optimizer-merged-${parts.length}`
            ]
          }
        };
        optimized.push(c);
      }
    }

    return optimized;
  }



  /*
   * v2.11 — KEEP VALUE / Boundary Pruner
   *
   * Previous versions mostly asked "is there a reason to cut here?"
   * v2.11 flips the final decision:
   *
   *   "Is there enough reason to KEEP this TAP?"
   *
   * Final pruning is deliberately simple and conservative:
   * - protected author/dialogue boundaries stay
   * - compute KEEP VALUE for each remaining boundary
   * - if KEEP VALUE is low and merge stays <= alert, remove the boundary
   */

  function keepValueAtBoundary(left,right){
    if(!left || !right) return {value:100,reasons:['keep-edge']};

    const reasons=[];
    let value=18;

    const ltxt=String(left.text||'').trim();
    const rtxt=String(right.text||'').trim();

    const ldebug=left.debug||{};
    const tap=Number(ldebug.tapValueAfter);
    const hide=Number(ldebug.hideScoreAfter);
    const dep=Number(ldebug.dependencyAfter);
    const standalone=Number(right.debug?.standaloneValue);

    // Preserve explicit / authored / dialogue boundaries.
    if(
      left.type==='dialogue' || right.type==='dialogue' ||
      left.reason==='author-dialogue-line' || right.reason==='author-dialogue-line'
    ){
      value+=80;
      reasons.push('keep-dialogue');
    }

    if(left.reason==='author-beat' || right.reason==='author-beat'){
      value+=85;
      reasons.push('keep-author-beat');
    }

    // Existing semantic scores are evidence, not final authority.
    if(Number.isFinite(tap)){
      value += tap*0.70;
      reasons.push('keep-tap');
    }
    if(Number.isFinite(hide)){
      value += hide*0.22;
      reasons.push('keep-hide');
    }
    if(Number.isFinite(dep)){
      value -= dep*0.55;
      reasons.push('keep-dependency');
    }

    // Re-estimate old chunks that lack modern debug.
    const lparts=sentenceTokens(ltxt);
    const rparts=sentenceTokens(rtxt);
    const prev=lparts[lparts.length-1]?.text || ltxt;
    const next=rparts[0]?.text || rtxt;

    const role=roleBoundaryScore(prev,next);
    const dep2=dependencyValue(prev,next,{authorLineBreak:false});
    const base=boundaryScore({text:prev},{text:next});

    if(!Number.isFinite(tap)){
      value += Math.max(0,base.score+role.score)*0.46;
      reasons.push('keep-reestimated');
    }
    if(!Number.isFinite(dep)){
      value -= dep2.value*0.44;
    }

    // Strong keep shapes.
    if(/[！？!?][」』”’]?$/.test(prev)){
      value+=28;
      reasons.push('keep-question-exclamation');
    }
    if(/(?:…|——|――|\.\.\.)[」』”’]?$/.test(prev)){
      value+=24;
      reasons.push('keep-pause');
    }

    const nextRole=sentenceRole(next);
    if(nextRole==='turn'){
      value+=22;
      reasons.push('keep-turn');
    }
    if(nextRole==='summary'){
      value+=28;
      reasons.push('keep-summary');
    }
    if(nextRole==='next'){
      value+=30;
      reasons.push('keep-next');
    }

    // Very short Scene on either side weakens the case for keeping a TAP,
    // unless another strong signal above compensates for it.
    const ll=charLength(ltxt);
    const rl=charLength(rtxt);
    if(ll<=24){
      value-=14;
      reasons.push('keep-left-short');
    }
    if(rl<=24){
      value-=14;
      reasons.push('keep-right-short');
    }
    if(ll<=24 && rl<=24){
      value-=18;
      reasons.push('keep-short-short');
    }

    // Weak standalone right-hand Scene: usually merge.
    if(Number.isFinite(standalone) && standalone<26){
      value-=18;
      reasons.push('keep-weak-standalone');
    }

    // Strong dependency connectors should normally stay together.
    if(startsWithAny(next,STRONG_DEPENDENT_NEXT)){
      value-=28;
      reasons.push('keep-strong-dependent-next');
    }else if(startsWithAny(next,SOFT_DEPENDENT_NEXT)){
      value-=12;
      reasons.push('keep-soft-dependent-next');
    }

    return {
      value:Math.max(0,Math.min(100,Math.round(value))),
      reasons
    };
  }

  function pruneLowKeepBoundaries(chunks,totalLength,options={}){
    if(!chunks?.length) return chunks||[];
    const policy=densityPolicy(totalLength,options.density||DEFAULT_PROFILE.density);
    const out=[];
    let i=0;

    while(i<chunks.length){
      const current=chunks[i];
      const next=chunks[i+1];

      if(!next){
        out.push(current);
        break;
      }

      // Never cross original paragraph boundaries.
      const blockA=current.debug?.sourceBlock ?? null;
      const blockB=next.debug?.sourceBlock ?? null;
      if(blockA!==blockB){
        out.push(current);
        i++;
        continue;
      }

      if(isProtectedSequenceChunk(current) || isProtectedSequenceChunk(next)){
        out.push(current);
        i++;
        continue;
      }

      const keep=keepValueAtBoundary(current,next);
      const mergedText=`${current.text}\n${next.text}`;
      const mergedLen=charLength(mergedText);

      // Main v2.11 rule:
      // if there is not enough reason to keep the TAP, remove it.
      const shouldMerge =
        keep.value < 50 &&
        mergedLen <= policy.alert;

      if(shouldMerge){
        const merged={
          ...current,
          text:mergedText,
          reason:'keep-pruned',
          debug:{
            ...(current.debug||{}),
            charCount:mergedLen,
            hideScoreAfter:next.debug?.hideScoreAfter ?? 0,
            tapValueAfter:next.debug?.tapValueAfter ?? 0,
            standaloneValue:standaloneSceneValue(mergedText,{
              beforeTap:0,
              afterTap:next.debug?.tapValueAfter ?? 0
            }).value,
            dependencyAfter:next.debug?.dependencyAfter ?? 0,
            localTapDensityPenalty:0,
            tapRhythmPenalty:0,
            keepValueRemoved:keep.value,
            keepPruned:true,
            keepMergedScenes:
              Number(current.debug?.keepMergedScenes||1)+
              Number(next.debug?.keepMergedScenes||1),
            boundaryReasons:[
              ...((current.debug?.boundaryReasons)||[]),
              ...keep.reasons,
              `keep-pruned-${keep.value}`
            ]
          }
        };

        // Put the merged Scene back into the stream so it can be tested
        // against the following Scene as well.
        chunks = [
          ...chunks.slice(0,i),
          merged,
          ...chunks.slice(i+2)
        ];
        continue;
      }

      const kept={
        ...current,
        debug:{
          ...(current.debug||{}),
          keepValueAfter:keep.value,
          boundaryReasons:[
            ...((current.debug?.boundaryReasons)||[]),
            ...keep.reasons
          ]
        }
      };
      out.push(kept);
      i++;
    }

    return out;
  }



  function processBlock(block, totalLength, options) {
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return [];

    if (lines.every(isListLine)) {
      return [makeChunk(lines.join('\n'), 'text', 'list-block', {
        charCount: charLength(lines.join('\n'))
      })];
    }

    const out = [];
    let plain = [];
    let list = [];

    const flushPlain = () => {
      if (!plain.length) return;
      out.push(...processPlainLines(plain, totalLength, options));
      plain = [];
    };
    const flushList = () => {
      if (!list.length) return;
      out.push(makeChunk(list.join('\n'), 'text', 'list-block', {
        charCount: charLength(list.join('\n'))
      }));
      list = [];
    };

    for (const line of lines) {
      if (options.preserveDialogueLines !== false && isDialogueLine(line)) {
        flushPlain(); flushList();
        out.push(makeChunk(line, 'dialogue', 'author-dialogue-line', {
          hideScoreAfter: 88,
          boundaryReasons:['dialogue-line'],
          charCount:charLength(line)
        }));
      } else if (isListLine(line)) {
        flushPlain();
        list.push(line);
      } else if (looksLikeStandaloneBeat(line)) {
        flushPlain(); flushList();
        out.push(makeChunk(line, 'text', 'author-beat', {
          hideScoreAfter: 90,
          boundaryReasons:['beat'],
          charCount:charLength(line)
        }));
      } else {
        flushList();
        plain.push(line);
      }
    }

    flushPlain();
    flushList();
    return out;
  }

  function postMergeTinyChunks(chunks, options = {}) {
    if (chunks.length < 2) return chunks;
    const out = [];
    const min = Number(options.absoluteMin) || 16;

    for (const chunk of chunks) {
      const len = charLength(chunk.text);
      const prev = out[out.length - 1];

      if (
        prev &&
        len < min &&
        chunk.reason === 'hide-score' &&
        prev.reason === 'hide-score' &&
        (prev.debug?.hideScoreAfter || 0) < 62
      ) {
        prev.text = `${prev.text}\n${chunk.text}`;
        prev.debug = {
          ...(prev.debug || {}),
          charCount: charLength(prev.text),
          mergedTinyTail: true
        };
      } else {
        out.push(chunk);
      }
    }
    return out;
  }

  function splitDetailed(text, options = {}) {
    const normalized = normalize(text);
    if (!normalized) return [];

    const mergedOptions = { ...DEFAULT_PROFILE, ...options };
    const totalLength = charLength(normalized);

    // Blank-line paragraphs are author intent and remain hard boundaries by default.
    const blocks = mergedOptions.preserveParagraphs === false
      ? [normalized]
      : normalized.split(/\n\s*\n/);

    const chunks = blocks
      .flatMap((block,blockIndex) => processBlock(block, totalLength, mergedOptions)
        .map(chunk=>({
          ...chunk,
          debug:{...(chunk.debug||{}),sourceBlock:blockIndex}
        }))
      )
      .filter(chunk => chunk.text);

    const tapFiltered = filterLowValueTaps(chunks, totalLength, mergedOptions);
    const rhythmSmoothed = smoothTapRhythm(tapFiltered, totalLength, mergedOptions);
    const densityRefined = refineDenseScenes(rhythmSmoothed, totalLength, mergedOptions);
    const tinyMerged = postMergeTinyChunks(densityRefined, mergedOptions);
    const sequenceOptimized = optimizeSceneSequence(tinyMerged, totalLength, mergedOptions);
    return pruneLowKeepBoundaries(sequenceOptimized, totalLength, mergedOptions);
  }

  function split(text, options = {}) {
    return splitDetailed(text, options).map(x => x.text);
  }

  function analyze(text, options = {}) {
    const chunks = splitDetailed(text, options);
    const total = charLength(normalize(text));
    const sceneCount = chunks.length;
    return {
      version: VERSION,
      totalChars: total,
      sceneCount,
      tapsToFinish: Math.max(0, sceneCount - 1),
      averageCharsPerScene: sceneCount ? Math.round(total / sceneCount) : 0,
      chunks
    };
  }

  const api = Object.freeze({
    version: VERSION,
    normalize,
    split,
    splitDetailed,
    analyze,
    sentenceTokens,
    boundaryScore,
    adaptiveTargets,
    densityPolicy,
    bestInternalDensityCut,
    refineDenseScenes,
    sentenceRole,
    roleBoundaryScore,
    planPlainTextGlobally,
    plannedBoundaryScore,
    tapValueAtBoundary,
    standaloneSceneValue,
    dependencyValue,
    localTapDensityPenalty,
    tapRhythmPenalty,
    smoothTapRhythm,
    optimizeSceneSequence,
    sequenceBoundaryValue,
    sequenceSceneUtility,
    keepValueAtBoundary,
    pruneLowKeepBoundaries,
    filterLowValueTaps,
    sceneSpanUtility,
    isDialogueLine,
    isListLine
  });

  // Official Scene Studio API. Keep the V2 alias for compatibility with test tools.
  window.JapaneseSceneSplitter = api;
  window.JapaneseSceneSplitterV2 = api;
})();
