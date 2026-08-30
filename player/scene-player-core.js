/*
 * Scene Player Core v1.12.10
 * Runtime for Scene Format v1.0
 * No splitter / studio authoring logic lives here.
 */
(function (global) {
  'use strict';

  const DEFAULTS = Object.freeze({
    autoDelay: 2600,
    transitionMs: 420,
    maxStackVisible: 8,
    focusYMobile: 0.46,
    focusYDesktop: 0.48,
    baseGap: 34,
    dialogueGap: 56,
    largeGap: 48,
    soundGap: 60,
    whitespaceBreath: 9,
    startAt: 0,
    showHeader: true,
    showFooter: true,
    allowPrevious: true,
    keyboard: true,
    swipe: true,
    swipeThreshold: 44,
    endOnNextAction: true,
    uiLanguage: 'ja',
    historyAllScenes: false
  });

  const THEMES = new Set(['light', 'dark', 'cinema']);
  const TYPES = new Set(['text', 'dialogue', 'sound']);

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function asNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function emit(host, name, detail) {
    host.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // Chat bubbles already communicate "this is speech", so an outer Japanese
  // quotation pair is redundant. Keep the authored text untouched in .scene
  // and remove only a matching pair that wraps the ENTIRE displayed message.
  //
  // 「もしもし」        -> もしもし
  // 『聞こえる？』      -> 聞こえる？
  // 彼は「知らない」と言った。 -> unchanged
  function chatDisplayText(value) {
    const source = String(value ?? '');
    const match = source.match(/^(\s*)([「『])([\s\S]*)([」』])(\s*)$/);
    if (!match) return source;

    const open = match[2];
    const close = match[4];
    const matchingPair =
      (open === '「' && close === '」') ||
      (open === '『' && close === '』');

    if (!matchingPair) return source;
    return `${match[1]}${match[3]}${match[5]}`;
  }

  function assertSceneDocument(doc) {
    if (!doc || typeof doc !== 'object') throw new TypeError('Scene document must be an object.');
    if (doc.format !== 'scene-format') throw new Error('Unsupported document: format must be "scene-format".');
    if (doc.version !== '1.0') throw new Error(`Unsupported Scene Format version: ${doc.version ?? '(missing)'}`);
    if (!THEMES.has(doc.theme)) throw new Error(`Unsupported theme: ${doc.theme}`);
    if (!Array.isArray(doc.scenes) || doc.scenes.length === 0) throw new Error('Scene document must contain at least one scene.');

    const ids = new Set();
    doc.scenes.forEach((scene, index) => {
      if (!scene || typeof scene !== 'object') throw new Error(`Scene ${index + 1} must be an object.`);
      if (!scene.id || typeof scene.id !== 'string') throw new Error(`Scene ${index + 1} is missing a stable id.`);
      if (ids.has(scene.id)) throw new Error(`Duplicate scene id: ${scene.id}`);
      ids.add(scene.id);
      if (!TYPES.has(scene.type)) throw new Error(`Unsupported scene type at ${scene.id}: ${scene.type}`);
      if ((scene.type === 'text' || scene.type === 'dialogue') && typeof scene.text !== 'string') {
        throw new Error(`Scene ${scene.id} requires text.`);
      }
    });
    return doc;
  }

  class ScenePlayerCore {
    constructor(host, options = {}) {
      if (typeof host === 'string') host = document.querySelector(host);
      if (!(host instanceof HTMLElement)) throw new TypeError('ScenePlayerCore requires a host HTMLElement.');

      this.host = host;
      this.options = { ...DEFAULTS, ...options };
      this.document = null;
      this.index = -1;
      this.auto = false;
      this.ended = false;
      this.autoTimer = null;
      this.touchStartY = null;
      this.touchStartX = null;
      this.suppressNextClick = false;
      this.maxVisitedIndex = -1;
      this.historyOpen = false;
      this.historyScrollRaf = 0;
      this.historyMetrics = null;
      this.historyDepthItems = new Set();
      this.destroyed = false;
      this._bound = [];
      this.presentationTimers = [];
      this.layoutTimers = [];
      this.typingState = null;
      this.backgroundState = null;
      // Prefix cache for inherited background state. Without this, every Scene
      // advance rescans Scene 1..N, which becomes O(n²) over a long work.
      this._backgroundStateCache = [];
      this._backgroundStateCacheDocument = null;
      this.backgroundLayerIndex = 0;
      this.backgroundTimers = [];
      this.audioUnlocked = false;
      // AudioContext unlock and story playback are separate states.
      // A restarted story must wait for the reader's next stage gesture even
      // when the AudioContext itself is already unlocked.
      this.audioPlaybackArmed = false;
      this.audioPending = [];
      this.audioContext = null;
      this.audioGainNodes = new Map();
      this.audioSourceNodes = new Map();
      this.audioTimers = [];
      this.audioFadeFrames = new Map();
      this.audioState = { bgm: null, ambient: null };
      this.audioEls = {
        bgm: this._createAudioElement('bgm'),
        ambient: this._createAudioElement('ambient')
      };
      this.oneshots = new Set();
      this.muted = false;
      this._audioRenderMode = 'restore';

      this._buildShell();
      this._bindControls();
    }

    _buildShell() {
      this.host.classList.add('sp-core');
      this.host.innerHTML = `
        <div class="sp-background" aria-hidden="true">
          <div class="sp-bg-layer sp-bg-a"></div>
          <div class="sp-bg-layer sp-bg-b"></div>
        </div>
        <div class="sp-bg-textures" aria-hidden="true"></div>
        <div class="sp-bg-flash" aria-hidden="true"></div>
        <div class="sp-veil" aria-hidden="true"></div>
        <section class="sp-cover" hidden>
          <div class="sp-cover-bg" aria-hidden="true"></div>
          <div class="sp-cover-dim" aria-hidden="true"></div>
          <div class="sp-cover-copy">
            <div class="sp-cover-work-block">
              <img class="sp-cover-logo" alt="" hidden>
              <strong class="sp-cover-title"></strong>
              <span class="sp-cover-subtitle"></span>
              <small class="sp-cover-author"></small>
            </div>
            <div class="sp-cover-episode-block">
              <span class="sp-cover-episode"></span>
              <strong class="sp-cover-episode-title"></strong>
            </div>
          </div>
          <button class="sp-cover-start" type="button">はじめる</button>
        </section>
        <header class="sp-header">
          <button class="sp-button sp-prev" type="button" aria-label="Previous scene">‹</button>
          <div class="sp-meta">
            <span class="sp-author"></span>
            <strong class="sp-title"></strong>
          </div>
          <button class="sp-button sp-restart" type="button" aria-label="Restart">↺</button>
        </header>
        <main class="sp-stage" tabindex="0" aria-live="polite">
          <div class="sp-scenes"></div>
          <span class="sp-tap-hint">TAP</span>
        </main>
        <section class="sp-history" hidden aria-label="Past scenes">
          <div class="sp-history-top">
            <span class="sp-history-kicker">PAST</span>
            <span class="sp-history-help">過去Sceneをスクロール</span>
            <button class="sp-history-close" type="button" aria-label="Close history">×</button>
          </div>
          <div class="sp-history-scroll">
            <div class="sp-history-list"></div>
          </div>
        </section>
        <footer class="sp-footer">
          <div class="sp-progress-label"><span class="sp-progress-current">0</span><span> / </span><span class="sp-progress-total">0</span></div>
          <div class="sp-progress-track" aria-hidden="true"><div class="sp-progress-bar"></div></div>
          <button class="sp-auto" type="button" aria-pressed="false">AUTO</button>
        </footer>
        <section class="sp-ending" hidden>
          <div class="sp-ending-copy">
            <span class="sp-ending-kicker">END</span>
            <strong class="sp-ending-title">読了</strong>
            <p class="sp-ending-text"></p>
          </div>
          <div class="sp-ending-three">
            <button class="sp-ending-slot sp-ending-left" type="button" hidden><small></small><strong></strong></button>
            <button class="sp-ending-slot sp-ending-cover" type="button"><small>COVER</small><strong>表紙に戻る</strong></button>
            <button class="sp-ending-slot sp-ending-right" type="button" hidden><small></small><strong></strong></button>
          </div>
        </section>
      `;

      const q = (s) => this.host.querySelector(s);
      this.els = {
        cover: q('.sp-cover'),
        coverBg: q('.sp-cover-bg'),
        coverAuthor: q('.sp-cover-author'),
        coverLogo: q('.sp-cover-logo'),
        coverEpisode: q('.sp-cover-episode'),
        coverEpisodeTitle: q('.sp-cover-episode-title'),
        coverTitle: q('.sp-cover-title'),
        coverSubtitle: q('.sp-cover-subtitle'),
        coverStart: q('.sp-cover-start'),
        background: q('.sp-background'),
        bgA: q('.sp-bg-a'),
        bgB: q('.sp-bg-b'),
        bgTextures: q('.sp-bg-textures'),
        bgFlash: q('.sp-bg-flash'),
        veil: q('.sp-veil'),
        header: q('.sp-header'),
        footer: q('.sp-footer'),
        stage: q('.sp-stage'),
        scenes: q('.sp-scenes'),
        history: q('.sp-history'),
        historyScroll: q('.sp-history-scroll'),
        historyList: q('.sp-history-list'),
        historyClose: q('.sp-history-close'),
        title: q('.sp-title'),
        author: q('.sp-author'),
        prev: q('.sp-prev'),
        restart: q('.sp-restart'),
        auto: q('.sp-auto'),
        current: q('.sp-progress-current'),
        total: q('.sp-progress-total'),
        bar: q('.sp-progress-bar'),
        ending: q('.sp-ending'),
        endingTitle: q('.sp-ending-title'),
        endingCover: q('.sp-ending-cover'),
        endingLeft: q('.sp-ending-left'),
        endingRight: q('.sp-ending-right'),
        endingText: q('.sp-ending-text'),
        historyHelp: q('.sp-history-help'),
        historyClose: q('.sp-history-close'),
        tapHint: q('.sp-tap-hint')
      };

      this.host.classList.toggle('sp-no-header', !this.options.showHeader);
      this.host.classList.toggle('sp-no-footer', !this.options.showFooter);
      this.els.prev.hidden = !this.options.allowPrevious;
      this.setUILanguage(this.options.uiLanguage || 'ja');
    }

    _uiText(key) {
      const I = global.SceneStudioI18n;
      if (I && typeof I.t === 'function' && I.getLocale?.() === this.uiLanguage) return I.t(key);
      const fallback = {
        ja:{
          'player.previous':'過去Scene','player.restart':'最初から','player.history':'過去Sceneをスクロール','player.history.close':'履歴を閉じる',
          'player.ending.title':'読了','player.ending.text':'最後まで読みました。','player.ending.restart':'もう一度読む','player.ending.cover':'表紙に戻る'
        },
        en:{
          'player.previous':'Past Scenes','player.restart':'Restart','player.history':'Scroll past Scenes','player.history.close':'Close history',
          'player.ending.title':'Finished','player.ending.text':'You reached the end.','player.ending.restart':'Read again','player.ending.cover':'Back to cover'
        }
      };
      return fallback[this.uiLanguage]?.[key] || fallback.ja[key] || key;
    }

    setUILanguage(language='ja') {
      this.uiLanguage = language === 'en' ? 'en' : 'ja';
      if (!this.els) return this.uiLanguage;
      this.els.prev.setAttribute('aria-label', this._uiText('player.previous'));
      this.els.restart.setAttribute('aria-label', this._uiText('player.restart'));
      this.els.historyHelp.textContent = this._uiText('player.history');
      this.els.historyClose.setAttribute('aria-label', this._uiText('player.history.close'));
      this.els.endingText.textContent = this._uiText('player.ending.text');
      if(this.els.endingCover){
        const coverLabel = this.uiLanguage==='en' ? 'Back to cover' : '表紙に戻る';
        this.els.endingCover.innerHTML = `<small>COVER</small><strong>${coverLabel}</strong>`;
      }
      if(this.els.coverStart)this.els.coverStart.textContent = this.uiLanguage==='en' ? 'Start' : 'はじめる';
      if (!this.document) this.els.endingTitle.textContent = this._uiText('player.ending.title');
      return this.uiLanguage;
    }

    _on(el, event, fn, options) {
      el.addEventListener(event, fn, options);
      this._bound.push([el, event, fn, options]);
    }


    _bindControls() {
      // iOS/WebKit: the reading gesture unlocks Web Audio and arms playback.
      const pressPaper = () => {
        this.host.classList.remove('sp-paper-press');
        // Force a restart even on rapid taps.
        void this.host.offsetWidth;
        this.host.classList.add('sp-paper-press');
        this._layoutTimeout(() => this.host.classList.remove('sp-paper-press'), 115);
      };
      const armFromStageGesture = () => {
        pressPaper();
        this.unlockAudio(true);
      };
      if ('PointerEvent' in global) this._on(this.els.stage, 'pointerdown', armFromStageGesture, { passive: true });
      else this._on(this.els.stage, 'touchstart', armFromStageGesture, { passive: true });

      // Header back arrow returns to the cover. History remains available by downward gesture.
      this._on(this.els.prev, 'click', (e) => {
        e.stopPropagation();
        this.showCover({restart:true});
      });
      this._on(this.els.restart, 'click', (e) => { e.stopPropagation(); this.restart(); });
      if(this.els.coverStart)this._on(this.els.coverStart,'click',(e)=>{e.stopPropagation();this._beginFromCover();});
      if(this.els.endingCover)this._on(this.els.endingCover,'click',()=>this.showCover({restart:true}));
      this._on(this.els.auto, 'click', (e) => {
        e.stopPropagation();
        this.unlockAudio(true);
        this.toggleAuto();
      });

      this._on(this.els.historyClose, 'click', (e) => {
        e.stopPropagation();
        this.closeHistory();
      });
      this._on(this.els.historyList, 'click', (e) => {
        const item = e.target.closest('.sp-history-item');
        if (!item) return;
        const nextIndex = Number(item.dataset.index);
        if (!Number.isInteger(nextIndex)) return;
        this.closeHistory({ keepVisualState: true });
        this.goToVisited(nextIndex);
        // The swipe that opened History arms suppressNextClick so its synthetic
        // click cannot advance a Scene. Once the author explicitly selects a
        // History Scene, that protection is stale; clear it so the very next tap
        // advances normally.
        this.suppressNextClick = false;
      });
      this._on(this.els.historyScroll, 'scroll', () => this._scheduleHistoryDepth(), { passive: true });

      this._on(this.els.stage, 'click', (e) => {
        if (e.target.closest('button')) return;

        // Foreground Scene images are interactive content, not the stage's
        // generic "next Scene" tap surface. Handle them here at the same level
        // as navigation so Studio and the public Player behave identically.
        const imageTarget = e.target.closest('.sp-scene-image.is-zoomable');
        if (imageTarget) {
          e.preventDefault();
          e.stopPropagation();
          const currentScene = this.document?.scenes?.[this.index];
          const sceneImage = currentScene?.presentation?.image;
          if (sceneImage?.src) this._openSceneImage(sceneImage.src, sceneImage.alt || '');
          return;
        }

        if (this.host.classList.contains('live-edit-enabled')
            && e.target.closest('.sp-scene.is-active .sp-text, .sp-scene.is-active .sp-subtext')) {
          return;
        }
        if (this.suppressNextClick) {
          this.suppressNextClick = false;
          return;
        }
        this.next();
      });

      if (this.options.keyboard) {
        this._on(this.els.stage, 'keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            this.unlockAudio(true);
            this.next();
          } else if (this.options.allowPrevious && (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'Backspace')) {
            e.preventDefault();
            this.openHistory();
          }
        });
      }

      // Desktop/trackpad: scrolling upward opens History. Downward scrolling keeps
      // the future discrete, so it never reveals an unread Scene.
      this._on(this.els.stage, 'wheel', (e) => {
        if (!this.options.allowPrevious || this.historyOpen) return;
        if (e.deltaY < -8) {
          e.preventDefault();
          this.openHistory({ wheelDelta: e.deltaY });
        }
      }, { passive: false });

      if (this.options.swipe) {
        this._on(this.els.stage, 'touchstart', (e) => {
          const t = e.changedTouches[0];
          this.touchStartY = t.clientY;
          this.touchStartX = t.clientX;
        }, { passive: true });

        this._on(this.els.stage, 'touchmove', (e) => {
          // Keep the page itself fixed. History has its own native momentum scroller.
          if (e.cancelable) e.preventDefault();
        }, { passive: false });

        this._on(this.els.stage, 'touchend', (e) => {
          if (this.touchStartY == null || this.touchStartX == null) return;
          const t = e.changedTouches[0];
          const dy = t.clientY - this.touchStartY;
          const dx = t.clientX - this.touchStartX;
          this.touchStartY = null;
          this.touchStartX = null;

          if (Math.max(Math.abs(dx), Math.abs(dy)) < this.options.swipeThreshold) return;
          this.suppressNextClick = true;

          // Pulling down/right enters History Scroll. Pushing up/left still advances
          // only one unread Scene at a time.
          if (Math.abs(dy) >= Math.abs(dx)) {
            if (dy > 0 && this.options.allowPrevious) this.openHistory({ dragDistance: dy });
            else if (dy < 0) this.next();
          } else {
            if (dx > 0 && this.options.allowPrevious) this.openHistory({ dragDistance: dx });
            else this.next();
          }
        }, { passive: true });
      }
    }

    _isExternalHttpAudio(src) {
      return /^https?:\/\//i.test(String(src || '').trim());
    }

    _isCorsWebAudioAsset(src) {
      const value = String(src || '').trim();
      if (!this._isExternalHttpAudio(value)) return false;
      try {
        const url = new URL(value, global.location?.href || undefined);
        // Scene Studio's R2 asset endpoint explicitly returns
        // Access-Control-Allow-Origin: *. These files can therefore be routed
        // through Web Audio safely, which is required for programmable volume
        // and fades on iPhone/iPad Safari (HTMLMediaElement.volume is effectively
        // system-controlled there). Keep arbitrary external URLs on the native
        // path so a third-party server without CORS never turns silent.
        return url.hostname === 'scene-studio-api.a-hako.workers.dev'
          && url.pathname.startsWith('/asset/');
      } catch (_) {
        return false;
      }
    }

    _prepareAudioTransport(audio, src) {
      if (!audio) return;
      const externalHttp = this._isExternalHttpAudio(src);
      const corsWebAudioAsset = this._isCorsWebAudioAsset(src);

      // Arbitrary absolute HTTP(S) audio stays on the native media path because
      // cross-origin MediaElementSource may be silenced without CORS. Assets
      // hosted by Scene Studio are served with permissive CORS, so use Web Audio
      // for them. This is especially important on iOS: native media playback does
      // not provide reliable script-controlled volume/fades, while GainNode does.
      audio.__spNativeOnly = externalHttp && !corsWebAudioAsset;
      audio.__spTransportSrc = src || '';
      if (corsWebAudioAsset) {
        try { audio.crossOrigin = 'anonymous'; } catch (_) {}
      } else if (audio.__spNativeOnly) {
        try { audio.crossOrigin = null; } catch (_) {}
      }
      emit(this.host, 'sceneplayer:audiotransport', {
        src: src || '',
        transport: audio.__spNativeOnly ? 'native-media' : 'web-audio',
        corsWebAudioAsset
      });
    }

    _createAudioElement(channel) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.dataset.scenePlayerChannel = channel;
      audio.playsInline = true;
      audio.addEventListener('error', () => {
        emit(this.host, 'sceneplayer:audioerror', {
          channel,
          src: audio.currentSrc || audio.src || '',
          transport: audio.__spNativeOnly ? 'native-media' : 'web-audio',
          networkState: audio.networkState,
          readyState: audio.readyState,
          error: audio.error || null
        });
      });
      audio.addEventListener('canplay', () => {
        emit(this.host, 'sceneplayer:audioready', {
          channel,
          src: audio.currentSrc || audio.src || '',
          transport: audio.__spNativeOnly ? 'native-media' : 'web-audio'
        });
      });
      audio.addEventListener('timeupdate', () => {
        const state = this.audioState[channel];
        if (!state || state.stopAt == null) return;
        if (audio.currentTime >= state.stopAt) this._stopPersistentChannel(channel, state.fadeOut || 0);
      });
      return audio;
    }

    _disposeAudioElement(audio) {
      if (!audio) return;
      try { audio.pause(); } catch (_) {}

      const source = this.audioSourceNodes.get(audio);
      const gain = this.audioGainNodes.get(audio);
      try { source?.disconnect(); } catch (_) {}
      try { gain?.disconnect(); } catch (_) {}
      this.audioSourceNodes.delete(audio);
      this.audioGainNodes.delete(audio);

      try {
        audio.removeAttribute('src');
        audio.load();
      } catch (_) {}
    }

    _replacePersistentAudioElement(channel, nativeOnly) {
      const oldAudio = this.audioEls[channel];
      const previousVolume = this._getAudioVolume(oldAudio);

      this._disposeAudioElement(oldAudio);

      const fresh = this._createAudioElement(channel);
      fresh.__spNativeOnly = Boolean(nativeOnly);
      fresh.__spGainValue = previousVolume;
      this.audioEls[channel] = fresh;

      emit(this.host, 'sceneplayer:audiotransportreset', {
        channel,
        from: oldAudio?.__spNativeOnly ? 'native-media' : 'web-audio',
        to: nativeOnly ? 'native-media' : 'web-audio'
      });

      return fresh;
    }

    _ensureAudioContext() {
      if (this.audioContext) return this.audioContext;
      const AudioContextClass = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextClass) return null;
      try {
        this.audioContext = new AudioContextClass();
      } catch (_) {
        this.audioContext = null;
      }
      return this.audioContext;
    }

    _ensureAudioNode(audio) {
      if (!audio) return null;
      if (audio.__spNativeOnly) return null;
      if (this.audioGainNodes.has(audio)) return this.audioGainNodes.get(audio);
      const ctx = this._ensureAudioContext();
      // Important on first iPhone playback: do not route a media element into
      // a suspended AudioContext. WebKit can report media playback as active
      // while the graph is still silent. Let the media element start first,
      // then attach it once the context is actually running.
      if (!ctx || ctx.state !== 'running') return null;
      try {
        const source = ctx.createMediaElementSource(audio);
        const gain = ctx.createGain();
        gain.gain.value = Number.isFinite(audio.__spGainValue) ? audio.__spGainValue : 1;
        source.connect(gain);
        gain.connect(ctx.destination);
        this.audioSourceNodes.set(audio, source);
        this.audioGainNodes.set(audio, gain);
        // Once routed through Web Audio, leave HTMLMediaElement volume at unity.
        // GainNode becomes the single source of truth for volume/fades.
        try { audio.volume = 1; } catch (_) {}
        return gain;
      } catch (error) {
        emit(this.host, 'sceneplayer:audiographerror', { error });
        return null;
      }
    }

    _setAudioVolume(audio, value) {
      const target = clamp(asNumber(value, 1), 0, 1);
      audio.__spGainValue = target;
      const gain = this._ensureAudioNode(audio);
      if (gain && this.audioContext) {
        try { gain.gain.setValueAtTime(target, this.audioContext.currentTime); } catch (_) { gain.gain.value = target; }
      } else {
        // Native-media transport is deliberate for external HTTP(S) audio.
        // On iOS the system may own final hardware volume, but playback remains
        // audible instead of being silenced by a cross-origin Web Audio graph.
        try { audio.volume = target; } catch (_) {}
      }
    }

    _getAudioVolume(audio) {
      if (Number.isFinite(audio?.__spGainValue)) return audio.__spGainValue;
      return clamp(asNumber(audio?.volume, 1), 0, 1);
    }

    _primeAudioContext(ctx) {
      if (!ctx) return;
      try {
        // iOS/WebKit can report a resumed context while the output path is not
        // yet producing audio. Starting a one-sample silent buffer inside the
        // same user gesture explicitly primes the Web Audio render path.
        const buffer = ctx.createBuffer(1, 1, Math.max(8000, ctx.sampleRate || 44100));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      } catch (_) {}
    }

    _flushPendingAudio() {
      if (!this.audioUnlocked || !this.audioPlaybackArmed) return;
      const pending = this.audioPending.splice(0);
      pending.forEach((fn) => {
        try { fn(); } catch (_) {}
      });
    }

    unlockAudio(armPlayback = false) {
      const ctx = this._ensureAudioContext();
      this.audioUnlocked = true;
      if (armPlayback) this.audioPlaybackArmed = true;

      // Keep the call to resume inside the trusted reading gesture, but do not
      // pre-connect media elements while the context is suspended.
      this._primeAudioContext(ctx);
      if (ctx && ctx.state === 'suspended') {
        try {
          const resumed = ctx.resume();
          if (resumed && typeof resumed.then === 'function') {
            resumed.then(() => {
              // Any media that started directly during the gesture is routed
              // through GainNode only after Web Audio is genuinely running.
              Object.values(this.audioEls || {}).forEach((audio) => {
                const gain = this._ensureAudioNode(audio);
                if (gain) this._setAudioVolume(audio, this._getAudioVolume(audio));
                try { audio.muted = false; } catch (_) {}
              });
            }).catch(() => {});
          }
        } catch (_) {}
      }

      // Flush now so HTMLMediaElement.play() itself is still called from the
      // user's gesture. _safePlay handles delayed graph attachment.
      this._flushPendingAudio();

      emit(this.host, 'sceneplayer:audiounlock', {
        webAudio: !!ctx,
        armed: this.audioPlaybackArmed,
        contextState: ctx?.state || 'unavailable'
      });
      return true;
    }

    _queueAudio(fn) {
      if (this.audioUnlocked && this.audioPlaybackArmed) return fn();
      this.audioPending.push(fn);
      emit(this.host, 'sceneplayer:audiopending', { count: this.audioPending.length });
      return false;
    }

    _clearAudioTimers() {
      this.audioTimers.forEach((timer) => clearTimeout(timer));
      this.audioTimers.length = 0;
      this.audioFadeFrames.forEach((frame) => cancelAnimationFrame(frame));
      this.audioFadeFrames.clear();
    }

    _audioTimeout(fn, delay) {
      const timer = setTimeout(() => {
        const i = this.audioTimers.indexOf(timer);
        if (i >= 0) this.audioTimers.splice(i, 1);
        fn();
      }, Math.max(0, delay));
      this.audioTimers.push(timer);
      return timer;
    }

    _fadeVolume(audio, target, duration, key, done) {
      target = clamp(asNumber(target, this._getAudioVolume(audio)), 0, 1);
      duration = Math.max(0, asNumber(duration, 0));
      const previous = this.audioFadeFrames.get(key);
      if (previous) cancelAnimationFrame(previous);

      const gain = this._ensureAudioNode(audio);
      const ctx = this.audioContext;
      const from = this._getAudioVolume(audio);
      audio.__spGainValue = target;

      // Web Audio path: reliable gain automation on iOS/WebKit.
      if (gain && ctx) {
        try {
          const now = ctx.currentTime;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(from, now);
          if (!duration) {
            gain.gain.setValueAtTime(target, now);
            if (done) done();
          } else {
            gain.gain.linearRampToValueAtTime(target, now + duration / 1000);
            this._audioTimeout(() => { if (done) done(); }, duration);
          }
          return;
        } catch (_) {
          // Fall through to HTMLMediaElement/rAF fallback.
        }
      }

      if (!duration) {
        try { audio.volume = target; } catch (_) {}
        this.audioFadeFrames.delete(key);
        if (done) done();
        return;
      }
      const start = performance.now();
      const step = (now) => {
        const t = clamp((now - start) / duration, 0, 1);
        const value = from + (target - from) * t;
        try { audio.volume = value; } catch (_) {}
        if (t < 1) this.audioFadeFrames.set(key, requestAnimationFrame(step));
        else {
          this.audioFadeFrames.delete(key);
          if (done) done();
        }
      };
      this.audioFadeFrames.set(key, requestAnimationFrame(step));
    }

    _safePlay(audio, detail, onStarted) {
      const play = () => {
        const ctx = this._ensureAudioContext();
        let startedCallbackDone = false;
        const finishStart = () => {
          if (startedCallbackDone) return;
          startedCallbackDone = true;
          const attach = () => {
            if (!audio.__spNativeOnly) {
              const gain = this._ensureAudioNode(audio);
              if (gain) this._setAudioVolume(audio, this._getAudioVolume(audio));
            } else {
              try { audio.volume = this._getAudioVolume(audio); } catch (_) {}
            }
            try { audio.muted = false; } catch (_) {}
            if (onStarted) onStarted();
          };
          if (audio.__spNativeOnly || !ctx || ctx.state === 'running') attach();
          else {
            try {
              const r = ctx.resume();
              if (r && typeof r.then === 'function') r.then(attach).catch(attach);
              else attach();
            } catch (_) { attach(); }
          }
        };

        // On first iPhone playback, call media.play() before connecting the
        // element to a suspended Web Audio graph. This preserves the trusted
        // user activation that WebKit requires for media start.
        if (!audio.__spNativeOnly && ctx && ctx.state !== 'running' && !this.audioGainNodes.has(audio)) {
          try { audio.muted = true; } catch (_) {}
        } else if (audio.__spNativeOnly) {
          try { audio.muted = false; } catch (_) {}
        }
        let promise;
        try { promise = audio.play(); }
        catch (error) {
          this.audioPlaybackArmed = false;
          this.audioPending.push(() => this._safePlay(audio, detail, onStarted));
          emit(this.host, 'sceneplayer:audioblocked', { ...detail, error });
          return;
        }
        if (promise && typeof promise.then === 'function') {
          promise.then(finishStart).catch((error) => {
            this.audioPlaybackArmed = false;
            this.audioPending.push(() => this._safePlay(audio, detail, onStarted));
            emit(this.host, 'sceneplayer:audioblocked', { ...detail, error });
          });
        } else finishStart();
      };
      this._queueAudio(play);
    }

    _stopPersistentChannel(channel, fadeOut = 0) {
      const audio = this.audioEls[channel];
      if (!audio) return;
      const finish = () => {
        audio.pause();
        try { audio.currentTime = 0; } catch (_) {}
        this.audioState[channel] = null;
        emit(this.host, 'sceneplayer:audiostop', { channel });
      };
      if (fadeOut > 0 && !audio.paused) this._fadeVolume(audio, 0, fadeOut, channel, finish);
      else finish();
    }

    _startPersistentChannel(channel, command, reconstruct = false, forceSeek = false) {
      let audio = this.audioEls[channel];
      if (!audio || !command.src) return;

      const desiredNativeOnly = this._isExternalHttpAudio(command.src);
      const hasWebAudioGraph = this.audioSourceNodes.has(audio) || this.audioGainNodes.has(audio);
      const currentNativeOnly = audio.__spNativeOnly === true;

      // A media element that has ever been routed through
      // createMediaElementSource() is not reused for native external playback.
      // Likewise, switching back to the Web Audio route gets a fresh element.
      if (
        currentNativeOnly !== desiredNativeOnly ||
        (desiredNativeOnly && hasWebAudioGraph)
      ) {
        audio = this._replacePersistentAudioElement(channel, desiredNativeOnly);
      }

      const sameSrc = this.audioState[channel]?.src === command.src;
      // Audio semantics:
      // BGM = continued time -> history keeps the current playback position when
      // the same source is still active.
      // Ambient = sound that existed there -> history restores that Scene-state
      // from its own startAt, even when the same source is already playing.
      // SE = event -> handled separately as a one-shot on explicit Scene landing.
      const shouldSeek = forceSeek || !sameSrc || (!reconstruct && command.restart === true);
      const targetVolume = clamp(asNumber(command.volume, 1), 0, 1);
      const startAt = Math.max(0, asNumber(command.startAt, 0));

      if (!sameSrc) {
        this._prepareAudioTransport(audio, command.src);
        audio.src = command.src;
        try { audio.load(); } catch (_) {}
      }
      audio.loop = command.loop !== false;
      if (shouldSeek) {
        try { audio.currentTime = startAt; } catch (_) {
          audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = startAt; } catch (_) {} }, { once: true });
        }
      }
      const fadeIn = reconstruct ? 0 : Math.max(0, asNumber(command.fadeIn, 0));
      this._setAudioVolume(audio, fadeIn > 0 ? 0 : targetVolume);
      this.audioState[channel] = {
        src: command.src,
        volume: targetVolume,
        loop: command.loop !== false,
        startAt,
        stopAt: command.stopAt == null ? null : Math.max(0, asNumber(command.stopAt, 0)),
        fadeOut: Math.max(0, asNumber(command.fadeOut, 0))
      };
      this._safePlay(audio, { channel, action: 'start', src: command.src }, () => {
        if (fadeIn > 0) this._fadeVolume(audio, targetVolume, fadeIn, channel);
        const stopAfter = Math.max(0, asNumber(command.stopAfter, 0));
        if (stopAfter > 0) this._audioTimeout(() => this._stopPersistentChannel(channel, command.fadeOut || 0), stopAfter);
      });
      emit(this.host, 'sceneplayer:audiostart', { channel, command, reconstruct });
    }

    _volumePersistentChannel(channel, command) {
      const audio = this.audioEls[channel];
      if (!audio || !this.audioState[channel]) return;
      const target = clamp(asNumber(command.volume, this.audioState[channel].volume), 0, 1);
      this.audioState[channel].volume = target;
      this._fadeVolume(audio, target, Math.max(0, asNumber(command.fade, 0)), channel);
      emit(this.host, 'sceneplayer:audiovolume', { channel, volume: target });
    }

    _duckPersistentChannel(channel, command) {
      const audio = this.audioEls[channel];
      const state = this.audioState[channel];
      if (!audio || !state) return;
      const restore = state.volume;
      const target = clamp(asNumber(command.volume, 0.22), 0, 1);
      const fade = Math.max(0, asNumber(command.fade, 250));
      const hold = Math.max(0, asNumber(command.hold, 1200));
      this._fadeVolume(audio, target, fade, channel);
      this._audioTimeout(() => this._fadeVolume(audio, restore, fade, channel), fade + hold);
      emit(this.host, 'sceneplayer:audioduck', { channel, volume: target, hold });
    }

    _playOneShot(command) {
      if (!command.src) return;
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      this._prepareAudioTransport(audio, command.src);
      audio.src = command.src;
      try { audio.load(); } catch (_) {}
      audio.loop = command.loop === true;
      const targetVolume = clamp(asNumber(command.volume, 1), 0, 1);
      const fadeIn = Math.max(0, asNumber(command.fadeIn, 0));
      this._setAudioVolume(audio, fadeIn > 0 ? 0 : targetVolume);
      const startAt = Math.max(0, asNumber(command.startAt, 0));
      if (startAt > 0) {
        audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = startAt; } catch (_) {} }, { once: true });
      }
      const cleanup = () => {
        this.oneshots.delete(audio);
        audio.removeEventListener('ended', cleanup);
      };
      audio.addEventListener('ended', cleanup);
      this.oneshots.add(audio);
      const fadeKey = `oneshot:${Date.now()}:${Math.random()}`;
      this._safePlay(audio, { channel: 'oneshot', role: command.role || 'se', action: 'play', src: command.src }, () => {
        if (fadeIn > 0) this._fadeVolume(audio, targetVolume, fadeIn, fadeKey);
        const stopAfter = Math.max(0, asNumber(command.stopAfter, 0));
        if (stopAfter > 0) this._audioTimeout(() => { audio.pause(); cleanup(); }, stopAfter);
      });
      if (command.stopAt != null) {
        const stopAt = Math.max(0, asNumber(command.stopAt, 0));
        const onTime = () => {
          if (audio.currentTime >= stopAt) { audio.pause(); audio.removeEventListener('timeupdate', onTime); cleanup(); }
        };
        audio.addEventListener('timeupdate', onTime);
      }
      emit(this.host, 'sceneplayer:oneshot', { command });
    }

    _applyAudioCommand(command, reconstruct = false) {
      if (!command || typeof command !== 'object') return;
      const channel = command.channel;
      const action = command.action;
      if (channel === 'oneshot') {
        // One-shots represent an event, so history reconstruction never replays them.
        if (!reconstruct && (action === 'play' || action === 'start')) this._playOneShot(command);
        return;
      }
      if (!(channel === 'bgm' || channel === 'ambient')) return;
      if (action === 'start' || action === 'play') this._startPersistentChannel(channel, command, reconstruct);
      else if (action === 'stop') this._stopPersistentChannel(channel, reconstruct ? 0 : Math.max(0, asNumber(command.fadeOut ?? command.fade, 0)));
      else if (action === 'volume') this._volumePersistentChannel(channel, command);
      else if (action === 'duck' && !reconstruct) this._duckPersistentChannel(channel, command);
    }

    _applySceneAudio(scene, reconstruct = false) {
      if (!Array.isArray(scene?.audio)) return;
      scene.audio.forEach((command) => this._applyAudioCommand(command, reconstruct));
    }

    _queueInitialOneShots(scene) {
      if (!Array.isArray(scene?.audio)) return;
      scene.audio.forEach((command) => {
        if (command?.channel === 'oneshot' && (command.action === 'play' || command.action === 'start')) {
          this._queueAudio(() => this._playOneShot(command));
        }
      });
    }

    _stopOneShots() {
      this.oneshots.forEach((audio) => { try { audio.pause(); } catch (_) {} });
      this.oneshots.clear();
    }

    _derivePersistentAudioState(index) {
      const result = { bgm: null, ambient: null };
      if (!this.document) return result;
      for (let i = 0; i <= index; i += 1) {
        const commands = this.document.scenes[i]?.audio;
        if (!Array.isArray(commands)) continue;
        for (const cmd of commands) {
          if (!(cmd?.channel === 'bgm' || cmd?.channel === 'ambient')) continue;
          const ch = cmd.channel;
          if (cmd.action === 'start' || cmd.action === 'play') {
            result[ch] = {
              src: cmd.src,
              volume: clamp(asNumber(cmd.volume, 1), 0, 1),
              loop: cmd.loop !== false,
              startAt: Math.max(0, asNumber(cmd.startAt, 0)),
              stopAt: cmd.stopAt == null ? null : Math.max(0, asNumber(cmd.stopAt, 0)),
              fadeOut: Math.max(0, asNumber(cmd.fadeOut, 0)),
              restart: true
            };
          } else if (cmd.action === 'stop') result[ch] = null;
          else if (cmd.action === 'volume' && result[ch]) result[ch].volume = clamp(asNumber(cmd.volume, result[ch].volume), 0, 1);
          // duck is transient and deliberately not part of reconstructed state.
        }
      }
      return result;
    }

    _restoreAudioForIndex(index, mode = 'restore') {
      this._clearAudioTimers();
      this._stopOneShots();
      const desired = this._derivePersistentAudioState(index);

      // BGM: 続いていた時間
      // When landing in History, keep time if the same BGM is valid there.
      const bgm = desired.bgm;
      if (!bgm) this._stopPersistentChannel('bgm', 0);
      else this._startPersistentChannel('bgm', bgm, true, false);

      // Ambient: その時そこにあった音
      // History is a state restoration, not a continuous timeline. Restore the
      // Ambient that was active at that Scene and restart it from its configured
      // startAt so rain / room tone / machinery / drones / any sustained asset
      // behaves as the sound of that place/state rather than elapsed time.
      const ambient = desired.ambient;
      if (!ambient) this._stopPersistentChannel('ambient', 0);
      else this._startPersistentChannel('ambient', ambient, true, mode === 'history');
    }

    _stopAllAudio(resetPending = true) {
      this._clearAudioTimers();
      ['bgm', 'ambient'].forEach((channel) => this._stopPersistentChannel(channel, 0));
      this.oneshots.forEach((audio) => { try { audio.pause(); } catch (_) {} });
      this.oneshots.clear();
      if (resetPending) this.audioPending.length = 0;
    }

    _clearPresentationTimers() {
      this.presentationTimers.forEach((timer) => clearTimeout(timer));
      this.presentationTimers.length = 0;
    }

    _clearBackgroundTimers() {
      this.backgroundTimers.forEach((timer) => clearTimeout(timer));
      this.backgroundTimers.length = 0;
    }

    _backgroundTimeout(fn, delay) {
      const timer = setTimeout(() => {
        const i = this.backgroundTimers.indexOf(timer);
        if (i >= 0) this.backgroundTimers.splice(i, 1);
        fn();
      }, Math.max(0, delay));
      this.backgroundTimers.push(timer);
      return timer;
    }

    _stopTyping(complete = false) {
      const state = this.typingState;
      if (!state) return false;
      clearInterval(state.timer);
      if (complete && state.node?.isConnected) {
        state.node.textContent = state.text;
        state.node.classList.remove('is-typing');
      }
      this.typingState = null;
      return true;
    }

    _resetPresentationRuntime() {
      this._clearPresentationTimers();
      this._stopTyping(false);
    }

    _resetBackgroundRuntime() {
      this._clearBackgroundTimers();
      this.els?.bgFlash?.classList.remove('is-active');
      this.host?.classList.remove('sp-bg-glitching');
    }

    _presentationTimeout(fn, delay) {
      const timer = setTimeout(() => {
        const i = this.presentationTimers.indexOf(timer);
        if (i >= 0) this.presentationTimers.splice(i, 1);
        fn();
      }, Math.max(0, delay));
      this.presentationTimers.push(timer);
      return timer;
    }

    load(doc, options = {}) {
      if (this.destroyed) throw new Error('ScenePlayerCore has been destroyed.');
      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this._stopAllAudio(true);

      // Documents can be repeatedly previewed/edited in the same Studio session.
      // Persistent media elements may retain an irreversible Web Audio routing
      // history from the previous document, so begin each load with clean
      // transport elements while preserving the AudioContext itself.
      ['bgm','ambient'].forEach((channel) => {
        const oldAudio = this.audioEls[channel];
        if (this.audioSourceNodes.has(oldAudio) || oldAudio?.__spNativeOnly) {
          this._disposeAudioElement(oldAudio);
          this.audioEls[channel] = this._createAudioElement(channel);
        }
      });

      this.audioPlaybackArmed = false;
      this.document = assertSceneDocument(doc);
      this._backgroundStateCache = [];
      this._backgroundStateCacheDocument = this.document;

      // Scene Format v1: author-level navigation policy.
      // Constructor options remain the fallback for older documents.
      const authorAllowPrevious = doc.player?.navigation?.allowPrevious;
      if (typeof authorAllowPrevious === 'boolean') this.options.allowPrevious = authorAllowPrevious;
      this.els.prev.hidden = !this.options.allowPrevious;
      this.host.classList.toggle('sp-no-previous', !this.options.allowPrevious);

      this.index = clamp(asNumber(options.startAt, this.options.startAt), 0, doc.scenes.length - 1);
      this.maxVisitedIndex = this.index;
      this.historyOpen = false;
      this.els.history.hidden = true;
      this.host.classList.remove('sp-history-open');
      this.ended = false;

      this.host.dataset.theme = doc.theme;
      this.host.dataset.font = doc.appearance?.typography?.fontFamily || 'serif';
      this.host.dataset.cinemaTone = doc.theme === 'cinema' ? (doc.appearance?.cinemaTone === 'light' ? 'light' : 'dark') : '';
      this.host.dataset.language = doc.language || '';
      this.host.dataset.languages = Array.isArray(doc.languages) ? doc.languages.join(' ') : '';
      this.host.dataset.preset = doc.preset || '';
      this.host.setAttribute('lang', doc.language || 'und');
      this.host.setAttribute('dir', doc.direction || 'auto');
      this.els.title.textContent = doc.title || '';
      this.els.author.textContent = doc.author || '';
      this.els.total.textContent = String(doc.scenes.length);
      this.refreshDocumentChrome({document:doc});
      const authoredEndingLabel=String(doc.ending?.label || doc.ending?.title || '').trim();
      this.els.endingTitle.textContent = authoredEndingLabel || this._uiText('player.ending.title');
      const endingFamilies={serif:'var(--sp-font-serif)',sans:'var(--sp-font-sans)',mono:'var(--sp-font-mono)'};
      this.els.endingTitle.style.setProperty('font-family', endingFamilies[doc.ending?.fontFamily]||endingFamilies.serif, 'important');
      this.els.endingText.textContent = '';
      const endingLinks=Array.isArray(doc.ending?.links)?doc.ending.links:[];
      const endingHasPositions=endingLinks.some(x=>x?.position==='left'||x?.position==='right');
      const left=endingHasPositions?(endingLinks.find(x=>x?.position==='left')||null):(endingLinks[0]||null);
      const right=endingHasPositions?(endingLinks.find(x=>x?.position==='right')||null):(endingLinks.length>1?endingLinks[1]:null);
      const applyEndingSlot=(button,item)=>{if(!button)return;const label=String(item?.label||item?.title||'').trim();const kicker=String(item?.kicker||'').trim();button.hidden=!label;const s=button.querySelector('small'),b=button.querySelector('strong');if(s){s.textContent=kicker;s.hidden=!kicker;}if(b)b.textContent=label;button.dataset.previewUrl=String(item?.url||item?.href||'').trim();};
      applyEndingSlot(this.els.endingLeft,left); applyEndingSlot(this.els.endingRight,right);
      this.els.ending.hidden = true;
      this.backgroundState = null;
      this.backgroundLayerIndex = 0;
      this._resetBackgroundLayers();
      // Studio loads Scene 1 underneath the cover for layout/background,
      // but Cover is not a Scene and must not execute Scene audio.
      this._audioRenderMode = 'cover';

      this._render();
      this.showCover();
      emit(this.host, 'sceneplayer:load', { document: doc, index: this.index });
      return this;
    }

    refreshDocumentChrome(options = {}) {
      const nextDocument = options.document || null;
      if (nextDocument) this.document = nextDocument;
      const doc = this.document;
      if (!doc) return false;

      const families = {
        serif: 'var(--sp-font-serif)',
        sans: 'var(--sp-font-sans)',
        mono: 'var(--sp-font-mono)'
      };
      const coverFamily = families[doc.cover?.fontFamily] || families.serif;
      const endingFamily = families[doc.ending?.fontFamily] || families.serif;
      this.host.style.setProperty('--sp-cover-font', coverFamily);

      const canonicalTitle = String(doc.title || '').trim()==='Untitled' ? '' : String(doc.title || '');
      if (this.els.title) this.els.title.textContent = canonicalTitle;
      if (this.els.author) this.els.author.textContent = doc.author || '';

      const logoSrc = String(doc.cover?.logo?.src || '').trim();
      if (this.els.coverLogo) {
        this.els.coverLogo.src = logoSrc;
        this.els.coverLogo.hidden = !logoSrc;
      }
      const coverText = doc.cover?.text || {}; // legacy read-only fallback
      const visibility = doc.cover?.visibility || {};
      const canonicalValue = (key, fallback='') => {
        const clean=String(fallback??'');
        if(clean.trim() && !(key==='title' && clean.trim()==='Untitled')) return clean;
        return Object.prototype.hasOwnProperty.call(coverText,key) ? String(coverText[key] ?? '') : '';
      };
      const coverVisible = (key,value) => {
        if(Object.prototype.hasOwnProperty.call(visibility,key)) return visibility[key]!==false && Boolean(String(value||'').trim());
        if(Object.prototype.hasOwnProperty.call(coverText,key) && String(coverText[key]??'')==='') return false;
        return Boolean(String(value||'').trim());
      };
      if (this.els.coverTitle) { const title=canonicalValue('title',doc.title||''); this.els.coverTitle.textContent=title; this.els.coverTitle.hidden=Boolean(logoSrc)||!coverVisible('title',title); }
      if (this.els.coverAuthor) { const author=canonicalValue('author',doc.author||''); this.els.coverAuthor.textContent=author; this.els.coverAuthor.hidden=!coverVisible('author',author); }
      if (this.els.coverSubtitle) { const subtitle=canonicalValue('subtitle',doc.metadata?.subtitle||doc.subtitle||''); this.els.coverSubtitle.textContent=subtitle; this.els.coverSubtitle.hidden=!coverVisible('subtitle',subtitle); }
      if (this.els.coverEpisode) { const episode=canonicalValue('episode',doc.metadata?.episode||doc.episode||''); this.els.coverEpisode.textContent=episode; this.els.coverEpisode.hidden=!coverVisible('episode',episode); }
      if (this.els.coverEpisodeTitle) { const episodeTitle=canonicalValue('episodeTitle',doc.metadata?.episodeTitle||doc.episodeTitle||''); this.els.coverEpisodeTitle.textContent=episodeTitle; this.els.coverEpisodeTitle.hidden=!coverVisible('episodeTitle',episodeTitle); }

      const coverStyles = doc.cover?.styles || {};
      const coverStyleMap = [
        [this.els.coverTitle,'title'],
        [this.els.coverSubtitle,'subtitle'],
        [this.els.coverAuthor,'author'],
        [this.els.coverEpisode,'episode'],
        [this.els.coverEpisodeTitle,'episodeTitle']
      ];
      const coverSizeScale = { small:.78, normal:1, large:1.28, xl:1.6 };
      const coverFontMap = {
        serif:'var(--sp-font-serif)',
        sans:'var(--sp-font-sans)',
        mono:'var(--sp-font-mono)'
      };
      for (const [el,key] of coverStyleMap) {
        if (!el) continue;
        const st = coverStyles[key] || {};
        el.style.removeProperty('color');
        el.style.removeProperty('font-size');
        el.style.removeProperty('font-family');
        // Resolve size from this field's native CSS size. Do this only after
        // removing the prior inline value, otherwise repeated refreshes compound.
        const baseSize=parseFloat(getComputedStyle(el).fontSize)||16;
        if (st.color) el.style.setProperty('color',String(st.color),'important');
        if (st.size && st.size !== 'auto') {
          const resolved=typeof st.size==='number'
            ? Number(st.size)
            : baseSize*(coverSizeScale[String(st.size)]||1);
          if(Number.isFinite(resolved))el.style.setProperty('font-size',`${resolved}px`,'important');
        }
        if (st.fontFamily && st.fontFamily !== 'inherit') {
          const fam=coverFontMap[st.fontFamily];
          if (fam) el.style.setProperty('font-family',fam,'important');
        }
      }

      const authoredEndingLabel = String(doc.ending?.label || doc.ending?.title || '').trim();
      if (this.els.endingTitle) {
        this.els.endingTitle.textContent = authoredEndingLabel || this._uiText('player.ending.title');
        this.els.endingTitle.style.setProperty('font-family', endingFamily, 'important');
        const endingStyle=doc.ending?.style||{};
        const sizeMap={small:'clamp(15px,3.5vw,22px)',normal:'clamp(18px,4.6vw,30px)',large:'clamp(24px,6.2vw,42px)',xl:'clamp(30px,8vw,56px)'};
        const fontMap={serif:'var(--sp-font-serif)',sans:'var(--sp-font-sans)',mono:'var(--sp-font-mono)'};
        this.els.endingTitle.style.removeProperty('color');
        this.els.endingTitle.style.removeProperty('font-size');
        if(endingStyle.color)this.els.endingTitle.style.setProperty('color',String(endingStyle.color),'important');
        if(endingStyle.size&&endingStyle.size!=='auto'){
          const size=typeof endingStyle.size==='number'?`${endingStyle.size}px`:sizeMap[endingStyle.size];
          if(size)this.els.endingTitle.style.setProperty('font-size',size,'important');
        }
        if(endingStyle.fontFamily&&endingStyle.fontFamily!=='inherit'){
          const fam=fontMap[endingStyle.fontFamily];
          if(fam)this.els.endingTitle.style.setProperty('font-family',fam,'important');
        }
      }
      const endingLinks = Array.isArray(doc.ending?.links) ? doc.ending.links : [];
      const hasPositions = endingLinks.some((x) => x?.position === 'left' || x?.position === 'right');
      const left = hasPositions ? (endingLinks.find((x) => x?.position === 'left') || null) : (endingLinks[0] || null);
      const right = hasPositions ? (endingLinks.find((x) => x?.position === 'right') || null) : (endingLinks.length > 1 ? endingLinks[1] : null);
      const applySlot = (button, item) => {
        if (!button) return;
        const label = String(item?.label || item?.title || '').trim();
        const kicker = String(item?.kicker || '').trim();
        button.hidden = !label;
        const small = button.querySelector('small');
        const strong = button.querySelector('strong');
        if (small) { small.textContent = kicker; small.hidden = !kicker; }
        if (strong) strong.textContent = label;
        button.dataset.previewUrl = String(item?.url || item?.href || '').trim();
      };
      applySlot(this.els.endingLeft, left);
      applySlot(this.els.endingRight, right);
      return true;
    }

    get currentScene() {
      return this.document?.scenes?.[this.index] || null;
    }

    get progress() {
      if (!this.document) return 0;
      return (this.index + 1) / this.document.scenes.length;
    }

    next() {
      if (!this.document || this.ended) return false;
      if (this._stopTyping(true)) {
        emit(this.host, 'sceneplayer:typingend', { index: this.index, scene: this.currentScene, skipped: true });
        this._scheduleAuto();
        return true;
      }
      this._clearAutoTimer();

      // The current Scene's entrance belongs only to its arrival.
      // If the reader advances before the animation naturally ends,
      // finish it NOW before moving that Scene into the past stack.
      this._finishVisibleEntranceEffects();
      this._clearPresentationTimers();

      if (this.index < this.document.scenes.length - 1) {
        this.index += 1;
        this.maxVisitedIndex = Math.max(this.maxVisitedIndex, this.index);
        this._audioRenderMode = 'advance';
        this._render();
        emit(this.host, 'sceneplayer:scenechange', { index: this.index, scene: this.currentScene, direction: 'next' });
        return true;
      }

      if (this.options.endOnNextAction) this.finish();
      else this.finish();
      return false;
    }


    previous() {
      // Kept for API compatibility. "Previous" now means entering History,
      // not stepping backward one Scene.
      return this.openHistory();
    }

    openHistory(options = {}) {
      if (!this.document || !this.options.allowPrevious || (!this.options.historyAllScenes && this.maxVisitedIndex <= 0)) return false;
      this.stopAuto();
      this._clearPresentationTimers();
      this.historyOpen = true;
      this.host.classList.add('sp-history-open');
      this.els.history.hidden = false;
      this._renderHistory();

      requestAnimationFrame(() => {
        const current = this.els.historyList.querySelector(`.sp-history-item[data-index="${this.index}"]`);
        if (current) {
          const box = current.getBoundingClientRect();
          const viewport = this.els.historyScroll.getBoundingClientRect();
          const target = this.els.historyScroll.scrollTop
            + (box.top - viewport.top)
            - ((viewport.height - box.height) / 2);
          this.els.historyScroll.scrollTop = Math.max(0, target);

          // A pull gesture should feel like grabbing the drum and moving into the past.
          // Give it a small initial offset while preserving native momentum afterwards.
          const drag = Math.abs(asNumber(options.dragDistance, 0));
          const wheel = Math.abs(asNumber(options.wheelDelta, 0));
          if (drag > 0 || wheel > 0) {
            this.els.historyScroll.scrollTop = Math.max(
              0,
              this.els.historyScroll.scrollTop - clamp((drag || wheel) * 0.7, 18, 110)
            );
          }
        }
        this._updateHistoryDepth();
      });

      emit(this.host, 'sceneplayer:historyopen', {
        index: this.index,
        maxVisitedIndex: this.maxVisitedIndex
      });
      return true;
    }

    closeHistory(options = {}) {
      if (!this.historyOpen) return false;
      this.historyOpen = false;
      this.host.classList.remove('sp-history-open');
      this.els.history.hidden = true;
      if (!options.keepVisualState) this.els.stage.focus({ preventScroll: true });
      emit(this.host, 'sceneplayer:historyclose', {
        index: this.index,
        maxVisitedIndex: this.maxVisitedIndex
      });
      return true;
    }

    _renderHistory() {
      if (!this.document) return;
      const fragment = document.createDocumentFragment();
      this.els.historyList.innerHTML = '';

      const historyLastIndex = this.options.historyAllScenes ? this.document.scenes.length - 1 : this.maxVisitedIndex;
      for (let i = 0; i <= historyLastIndex; i += 1) {
        const scene = this.document.scenes[i];
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'sp-history-item';
        item.dataset.index = String(i);
        item.dataset.sceneId = scene.id;
        if (i === this.index) item.classList.add('is-current');

        const num = document.createElement('span');
        num.className = 'sp-history-number';
        num.textContent = `${i + 1} / ${this.document.scenes.length}`;

        const body = document.createElement('span');
        body.className = 'sp-history-body';

        const historyPresentation = scene.presentation || {};
        if (historyPresentation.view === 'chat' && (scene.text || scene.subText)) {
          item.classList.add('sp-history-chat');
          const align = historyPresentation.text?.align === 'right' ? 'right' : 'left';
          item.dataset.chatSide = align;

          const chatRow = document.createElement('span');
          chatRow.className = 'sp-history-chat-row';

          const icon = document.createElement('span');
          icon.className = 'sp-history-chat-icon';
          const iconSrc = historyPresentation.chat?.icon || '';
          if (iconSrc) {
            const img = document.createElement('img');
            img.src = iconSrc;
            img.alt = '';
            icon.appendChild(img);
          } else {
            icon.textContent = historyPresentation.chat?.iconText || '●';
          }

          const chatBody = document.createElement('span');
          chatBody.className = 'sp-history-chat-body';

          if (scene.subText) {
            const speaker = document.createElement('span');
            speaker.className = 'sp-history-chat-speaker';
            speaker.textContent = scene.subText;
            this._applyTextStyle(speaker, historyPresentation.subText || {}, true);
            chatBody.appendChild(speaker);
          }

          if (scene.text) {
            const bubble = document.createElement('span');
            bubble.className = 'sp-history-chat-bubble';
            if (historyPresentation.chat?.bubbleColor) {
              bubble.style.background = historyPresentation.chat.bubbleColor;
            }

            const text = document.createElement('span');
            text.className = 'sp-history-chat-text';
            text.textContent = chatDisplayText(scene.text);
            this._applyTextStyle(text, historyPresentation.text || {}, false);
            if (historyPresentation.chat?.bubbleTextColor) {
              text.style.setProperty('color', String(historyPresentation.chat.bubbleTextColor), 'important');
            }
            bubble.appendChild(text);
            chatBody.appendChild(bubble);
          }

          chatRow.append(icon, chatBody);
          body.appendChild(chatRow);
        } else if (scene.type === 'sound' && !scene.text) {
          const mark = document.createElement('span');
          mark.className = 'sp-history-text';
          mark.textContent = '♪';
          body.appendChild(mark);
        } else {
          const text = document.createElement('span');
          text.className = 'sp-history-text';
          text.textContent = scene.text || '';
          // History is still a navigator, but typography should identify the
          // actual Scene the author is reviewing.
          this._applyTextStyle(text, scene.presentation?.text || {}, false);
          body.appendChild(text);

          if (scene.subText) {
            const sub = document.createElement('span');
            sub.className = 'sp-history-subtext';
            sub.textContent = scene.subText;
            this._applyTextStyle(sub, scene.presentation?.subText || {}, true);
            body.appendChild(sub);
          }
        }

        this._appendSceneImage(body, scene, historyPresentation, { history:true });

        item.append(num, body);
        fragment.appendChild(item);
      }
      this.els.historyList.appendChild(fragment);
      // Measure the drum once after rebuilding it. Scroll-time depth updates can
      // then use cached centers instead of forcing layout for every Scene.
      this.historyMetrics = null;
      this.historyDepthItems.clear();
    }

    _scheduleHistoryDepth() {
      if (this.historyScrollRaf) return;
      this.historyScrollRaf = requestAnimationFrame(() => {
        this.historyScrollRaf = 0;
        this._updateHistoryDepth();
      });
    }

    _updateHistoryDepth() {
      if (!this.historyOpen) return;
      const scroll = this.els.historyScroll;
      const items = Array.from(this.els.historyList.querySelectorAll('.sp-history-item'));
      if (!items.length) return;

      // Building this cache may read layout once, when History opens/rebuilds.
      // The hot scroll path below does not call getBoundingClientRect() per Scene.
      if (!this.historyMetrics || this.historyMetrics.length !== items.length) {
        this.historyMetrics = items.map((item) => ({
          item,
          center: item.offsetTop + item.offsetHeight / 2
        }));
      }

      const metrics = this.historyMetrics;
      const center = scroll.scrollTop + scroll.clientHeight / 2;

      // Binary-search the nearest cached Scene center.
      let lo = 0, hi = metrics.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (metrics[mid].center < center) lo = mid + 1;
        else hi = mid;
      }
      let nearestIndex = lo;
      if (nearestIndex > 0 && Math.abs(metrics[nearestIndex - 1].center - center) <= Math.abs(metrics[nearestIndex].center - center)) {
        nearestIndex -= 1;
      }

      // Only the small visible neighbourhood needs the drum depth effect.
      // Clear the previously touched nodes, then update roughly ±6 Scenes.
      this.historyDepthItems.forEach((item) => {
        item.style.removeProperty('--sp-history-depth');
        item.classList.remove('is-nearest');
      });
      this.historyDepthItems.clear();

      const radius = 6;
      const start = Math.max(0, nearestIndex - radius);
      const end = Math.min(metrics.length - 1, nearestIndex + radius);
      const depthRange = Math.max(1, scroll.clientHeight * 0.58);
      for (let i = start; i <= end; i += 1) {
        const entry = metrics[i];
        const distance = Math.abs(entry.center - center);
        const normalized = clamp(distance / depthRange, 0, 1);
        entry.item.style.setProperty('--sp-history-depth', String(normalized));
        if (i === nearestIndex) entry.item.classList.add('is-nearest');
        this.historyDepthItems.add(entry.item);
      }
    }

    refreshCurrent(options = {}) {
      const nextDocument = options.document || null;
      if (nextDocument) this.document = nextDocument;
      if (!this.document || !this.document.scenes?.length) return false;
      this.refreshDocumentChrome();

      let nextIndex = options.index == null ? this.index : Number(options.index);
      if (!Number.isFinite(nextIndex)) nextIndex = this.index;
      nextIndex = Math.max(0, Math.min(nextIndex, this.document.scenes.length - 1));

      this._clearAutoTimer();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this.ended = false;
      if (this.els?.ending) this.els.ending.hidden = true;
      this.index = nextIndex;
      this.maxVisitedIndex = Math.max(this.maxVisitedIndex, nextIndex);
      // Authoring may mutate the current Scene's background while retaining the
      // same document object. Keep earlier prefixes, invalidate this Scene onward.
      if (this._backgroundStateCacheDocument !== this.document) {
        this._backgroundStateCacheDocument = this.document;
        this._backgroundStateCache = [];
      } else if (Array.isArray(this._backgroundStateCache)) {
        this._backgroundStateCache.length = Math.min(this._backgroundStateCache.length, nextIndex);
      }

      // Live-authoring refresh: redraw the current Scene through the real Player
      // renderer and replay its presentation immediately, but do not seek/restart
      // persistent audio unless the caller explicitly asks for it.
      this._audioRenderMode = options.preserveAudio === false ? 'restore' : 'preview';
      this._render();
      emit(this.host, 'sceneplayer:refresh', {
        index: this.index,
        scene: this.currentScene,
        preserveAudio: options.preserveAudio !== false
      });
      return true;
    }

    goToVisited(sceneOrIndex) {
      if (!this.document) return false;
      let nextIndex = -1;
      if (typeof sceneOrIndex === 'number') nextIndex = sceneOrIndex;
      else if (typeof sceneOrIndex === 'string') nextIndex = this.document.scenes.findIndex((s) => s.id === sceneOrIndex);
      if (nextIndex < 0 || nextIndex > (this.options.historyAllScenes ? this.document.scenes.length - 1 : this.maxVisitedIndex)) return false;
      return this.goTo(nextIndex, { audioMode: 'history' });
    }

    goTo(sceneOrIndex, options = {}) {
      if (!this.document) return false;
      let nextIndex = -1;
      if (typeof sceneOrIndex === 'number') nextIndex = sceneOrIndex;
      else if (typeof sceneOrIndex === 'string') nextIndex = this.document.scenes.findIndex((s) => s.id === sceneOrIndex);
      if (nextIndex < 0 || nextIndex >= this.document.scenes.length) return false;

      this._clearAutoTimer();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this.ended = false;
      this.els.ending.hidden = true;
      this.index = nextIndex;
      this._audioRenderMode = options.audioMode === 'history' ? 'history' : 'restore';
      this._render();
      emit(this.host, 'sceneplayer:scenechange', { index: this.index, scene: this.currentScene, direction: 'jump' });
      return true;
    }

    showCover(options = {}) {
      if (!this.document || !this.els?.cover) return false;
      if (options.restart) {
        this._finishVisibleEntranceEffects();
        this._clearAutoTimer();
        this._resetPresentationRuntime();
        this._resetBackgroundRuntime();
        this._stopAllAudio(true);
        this.audioPlaybackArmed = false;
        this.index = 0;
        this.maxVisitedIndex = 0;
        this.closeHistory({ keepVisualState: true });
        this.ended = false;
        this.els.ending.hidden = true;
        this._audioRenderMode = 'restore';
        this._render();
      }
      this.refreshDocumentChrome();

      // Public Player parity:
      // Cover can be reopened/re-rendered after load, so explicitly reapply
      // authored per-field typography here as well. This prevents CSS defaults
      // from restoring the original cover sizes after publication.
      const coverStyles=this.document.cover?.styles||{};
      const coverSizeScale={small:.78,normal:1,large:1.28,xl:1.6};
      const coverFontMap={
        serif:'var(--sp-font-serif)',
        sans:'var(--sp-font-sans)',
        mono:'var(--sp-font-mono)'
      };
      const coverStyleTargets=[
        [this.els.coverTitle,'title'],
        [this.els.coverSubtitle,'subtitle'],
        [this.els.coverAuthor,'author'],
        [this.els.coverEpisode,'episode'],
        [this.els.coverEpisodeTitle,'episodeTitle']
      ];
      for(const [el,key] of coverStyleTargets){
        if(!el)continue;
        const st=coverStyles[key]||{};
        el.style.removeProperty('font-size');
        el.style.removeProperty('font-family');
        el.style.removeProperty('color');
        const baseSize=parseFloat(getComputedStyle(el).fontSize)||16;

        if(st.color){
          el.style.setProperty('color',String(st.color),'important');
        }
        if(st.size && st.size!=='auto'){
          const resolved=typeof st.size==='number'
            ? Number(st.size)
            : baseSize*(coverSizeScale[String(st.size)]||1);
          if(Number.isFinite(resolved))el.style.setProperty('font-size',`${resolved}px`,'important');
        }
        if(st.fontFamily && st.fontFamily!=='inherit'){
          const family=coverFontMap[String(st.fontFamily)];
          if(family)el.style.setProperty('font-family',family,'important');
        }
      }

      const cover=this.document.cover||{};
      const src=String(cover.src||cover.url||cover.image||'').trim();
      if(this.els.coverBg){
        this.els.coverBg.style.backgroundImage=src?`url("${src.replace(/"/g,'\\"')}")`:'none';
        this.els.coverBg.style.backgroundSize=cover.fit==='contain'?'contain':'cover';
        this.els.coverBg.style.backgroundPosition=cover.position||'center center';
      }
      const coverText=this.document.cover?.text||{}; // legacy fallback only
      const visibility=this.document.cover?.visibility||{};
      const coverValue=(key,fallback='')=>{
        const clean=String(fallback??'');
        if(clean.trim() && !(key==='title'&&clean.trim()==='Untitled'))return clean;
        return Object.prototype.hasOwnProperty.call(coverText,key)?String(coverText[key]??''):'';
      };
      const coverVisible=(key,value)=>{
        if(Object.prototype.hasOwnProperty.call(visibility,key))return visibility[key]!==false&&Boolean(String(value||'').trim());
        if(Object.prototype.hasOwnProperty.call(coverText,key)&&String(coverText[key]??'')==='')return false;
        return Boolean(String(value||'').trim());
      };
      const logoSrc=String(this.document.cover?.logo?.src||'').trim();
      if(this.els.coverLogo){this.els.coverLogo.src=logoSrc;this.els.coverLogo.hidden=!logoSrc;}
      if(this.els.coverAuthor){const author=coverValue('author',this.document.author||'');this.els.coverAuthor.textContent=author;this.els.coverAuthor.hidden=!coverVisible('author',author);}
      if(this.els.coverEpisode){const ep=coverValue('episode',this.document.metadata?.episode||this.document.episode||'');this.els.coverEpisode.textContent=ep;this.els.coverEpisode.hidden=!coverVisible('episode',ep);}
      if(this.els.coverEpisodeTitle){const epTitle=coverValue('episodeTitle',this.document.metadata?.episodeTitle||this.document.episodeTitle||'');this.els.coverEpisodeTitle.textContent=epTitle;this.els.coverEpisodeTitle.hidden=!coverVisible('episodeTitle',epTitle);}
      if(this.els.coverTitle){const title=coverValue('title',this.document.title||'');this.els.coverTitle.textContent=title;this.els.coverTitle.hidden=Boolean(logoSrc)||!coverVisible('title',title);}
      if(this.els.coverSubtitle){const sub=coverValue('subtitle',this.document.metadata?.subtitle||this.document.subtitle||'');this.els.coverSubtitle.textContent=sub;this.els.coverSubtitle.hidden=!coverVisible('subtitle',sub);}
      this.els.cover.hidden=false;
      this.host.classList.add('sp-cover-open');
      return true;
    }

    _beginFromCover() {
      if(!this.document || !this.els?.cover)return false;
      this.unlockAudio(true);
      this.els.cover.hidden=true;
      this.host.classList.remove('sp-cover-open');
      this._audioRenderMode='restore';
      this._render();
      emit(this.host,'sceneplayer:coverstart',{document:this.document,index:this.index});
      return true;
    }

    // External shells (Public Player / future Local Player) can own their own
    // cover UI while still starting Core from the same trusted user gesture.
    begin() {
      return this._beginFromCover();
    }

    restart() {
      if (!this.document) return;
      this._finishVisibleEntranceEffects();
      this._clearAutoTimer();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();

      // Restart means a fresh reading session, not an immediate audio restart.
      // Stop current audio, clear old queued work, disarm playback, then rebuild
      // scene-1 audio as pending until the reader taps the stage again.
      this._stopAllAudio(true);
      this.audioPlaybackArmed = false;

      this.index = 0;
      this.maxVisitedIndex = 0;
      this.closeHistory({ keepVisualState: true });
      this.ended = false;
      this.els.ending.hidden = true;
      this._audioRenderMode = 'restore';
      this._render();
      this.showCover();
      emit(this.host, 'sceneplayer:restart', { scene: this.currentScene });
    }

    finish() {
      if (!this.document || this.ended) return;
      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this.ended = true;
      this.els.ending.classList.remove('is-visible');
      this.els.ending.hidden = false;

      // Match the Public Player ending timing:
      // - ending copy begins its own 280ms-delayed fade immediately
      // - action boxes keep their CSS 3000ms afterglow delay
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this.els.ending?.classList.add('is-visible'));
      });

      emit(this.host, 'sceneplayer:end', { document: this.document, index: this.index });
    }

    setMuted(muted = true) {
      this.muted = Boolean(muted);
      Object.values(this.audioEls || {}).forEach((audio) => {
        try { audio.muted = this.muted; } catch (_) {}
      });
      this.oneshots.forEach((audio) => {
        try { audio.muted = this.muted; } catch (_) {}
      });
      emit(this.host, 'sceneplayer:mutechange', { muted: this.muted });
      return this.muted;
    }

    toggleMuted() {
      return this.setMuted(!this.muted);
    }

    isMuted() {
      return Boolean(this.muted);
    }

    startAuto() {
      if (!this.document || this.ended || this.auto) return;
      this.auto = true;
      this.els.auto.classList.add('is-on');
      this.els.auto.setAttribute('aria-pressed', 'true');
      this._scheduleAuto();
      emit(this.host, 'sceneplayer:autochange', { auto: true });
    }

    stopAuto() {
      this.auto = false;
      this._clearAutoTimer();
      if (this.els?.auto) {
        this.els.auto.classList.remove('is-on');
        this.els.auto.setAttribute('aria-pressed', 'false');
      }
      if (this.host) emit(this.host, 'sceneplayer:autochange', { auto: false });
    }

    toggleAuto() {
      this.auto ? this.stopAuto() : this.startAuto();
    }

    _clearAutoTimer() {
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }

    _scheduleAuto() {
      if (!this.auto || this.ended || !this.currentScene || this.typingState) return;
      this._clearAutoTimer();
      const delay = Math.max(0, asNumber(this.currentScene.pause, this.options.autoDelay));
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.index >= this.document.scenes.length - 1) this.finish();
        else this.next();
      }, delay);
    }


    _clearLayoutTimers() {
      this.layoutTimers.forEach((timer) => clearTimeout(timer));
      this.layoutTimers.length = 0;
    }

    _layoutTimeout(fn, delay) {
      const timer = setTimeout(() => {
        const i = this.layoutTimers.indexOf(timer);
        if (i >= 0) this.layoutTimers.splice(i, 1);
        fn();
      }, Math.max(0, delay));
      this.layoutTimers.push(timer);
      return timer;
    }

    _sceneGap(prevScene, nextScene) {
      const prevType = prevScene?.type || 'text';
      const nextType = nextScene?.type || 'text';
      if (prevType === 'sound' || nextType === 'sound') return this.options.soundGap;
      if (prevType !== nextType) return this.options.largeGap;
      if (prevType === 'dialogue') return this.options.dialogueGap;
      return this.options.baseGap;
    }

    _measureScenePositions(nodes, sceneEntries, extraGap = 0) {
      if (!nodes.length) return [];
      const stageHeight = this.els.stage.clientHeight;
      const focusRatio = global.innerWidth <= 600 ? this.options.focusYMobile : this.options.focusYDesktop;
      const focusY = stageHeight * focusRatio;

      const metrics = nodes.map((node, i) => ({
        node,
        scene: sceneEntries[i].scene,
        index: sceneEntries[i].index,
        height: node.getBoundingClientRect().height
      }));

      const newest = metrics[metrics.length - 1];
      let newestTop = focusY - newest.height / 2;
      if (newest.scene.type === 'dialogue') newestTop -= 12;

      const positions = new Array(metrics.length);
      positions[metrics.length - 1] = newestTop;

      for (let i = metrics.length - 2; i >= 0; i -= 1) {
        const current = metrics[i];
        const next = metrics[i + 1];
        positions[i] =
          positions[i + 1]
          - this._sceneGap(current.scene, next.scene)
          - extraGap
          - current.height;
      }

      return metrics.map((item, i) => ({ ...item, y: positions[i] }));
    }

    _positionSceneNodes(nodes, sceneEntries, extraGap = 0) {
      const measured = this._measureScenePositions(nodes, sceneEntries, extraGap);
      measured.forEach(({ node, y }) => {
        node.style.transform = `translate3d(0,${Math.round(y)}px,0)`;
      });
      return measured;
    }

    _updateSceneAges(nodes, sceneEntries) {
      nodes.forEach((node, i) => {
        const distance = sceneEntries.length - 1 - i;
        node.dataset.age = String(distance);
        node.classList.toggle('is-active', distance === 0);
        if (distance > 0) node.classList.add('is-visible');
      });
    }


    _renderStackWithBreathing(visible, active) {
      const oldById = new Map(
        [...this.els.scenes.querySelectorAll('.sp-scene')].map((node) => [node.dataset.sceneId, node])
      );
      const nodes = [];
      let newestCreated = null;

      visible.forEach(({ scene, index }) => {
        let node = oldById.get(scene.id);
        if (node) {
          oldById.delete(scene.id);
        } else {
          node = this._sceneNode(scene, index === this.index, this.index - index);
          node.classList.add('entering');
          newestCreated = node;
        }
        nodes.push(node);
        this.els.scenes.appendChild(node);
      });

      oldById.forEach((node) => {
        node.classList.add('sp-layout-leaving');
        this._layoutTimeout(() => node.remove(), 430);
      });

      this._updateSceneAges(nodes, visible);

      const incomingStill = newestCreated?.dataset.entryMotion === 'still';

      // `still` is intentionally a different layout path, not a variation of the
      // Jump/Shino landing. The incoming Scene is pinned to its FINAL coordinate
      // before it is ever revealed; only older Scene nodes are allowed to travel.
      // This avoids even a single painted frame at the stage origin.
      if (incomingStill) {
        const final = this._measureScenePositions(nodes, visible, 0);
        const newestMetric = final[final.length - 1];
        if (newestMetric) {
          newestCreated.style.transition = 'none';
          newestCreated.style.transform = `translate3d(0,${Math.round(newestMetric.y)}px,0)`;
          newestCreated.style.opacity = '0';
          newestCreated.style.filter = 'none';
        }

        requestAnimationFrame(() => {
          // Previous text may still move into its new stack position. The incoming
          // still Scene is deliberately excluded from every geometry transition.
          final.forEach(({node,y}) => {
            if (node === newestCreated) return;
            node.style.transform = `translate3d(0,${Math.round(y)}px,0)`;
          });

          if (newestCreated) {
            newestCreated.classList.remove('entering');
            newestCreated.classList.add('is-visible');
            // Restore normal opacity without introducing container movement.
            newestCreated.style.opacity = '';
            newestCreated.style.filter = '';
            this._activatePresentation(active, newestCreated);
          }
          // Keep transition disabled for this entrance frame, then hand future
          // stack movement back to the normal Scene transition rules.
          requestAnimationFrame(() => {
            if (newestCreated) newestCreated.style.transition = '';
          });
          this._scheduleAuto();
        });
        return;
      }

      // IMPORTANT: faithful Jump/Shino ordering for normal `flow` entrances.
      // Leave the new Scene in its CSS entering position for one painted frame.
      // Without this frame, the incoming Scene has almost no travel distance.
      requestAnimationFrame(() => {
        this.host.classList.remove('sp-whitespace-exhale');
        this.host.classList.add('sp-whitespace-inhale');

        // Phase 1: move existing Scenes toward the expanded whitespace layout.
        this._positionSceneNodes(nodes, visible, this.options.whitespaceBreath);

        // Jump/Shino wait two frames before retargeting to the final geometry.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.host.classList.remove('sp-whitespace-inhale');
            this.host.classList.add('sp-whitespace-exhale');

            // Same transform clock for both previous and current text.
            this._positionSceneNodes(nodes, visible, 0);

            const newest = newestCreated || nodes[nodes.length - 1];
            if (newest) {
              newest.classList.remove('entering');
              newest.classList.add('is-visible');
              this._activatePresentation(active, newest);
            }

            this._layoutTimeout(() => this.host.classList.remove('sp-whitespace-exhale'), 860);
            this._scheduleAuto();
          });
        });
      });
    }


    _render() {
      if (!this.document) return;
      this._resetPresentationRuntime();
      this._clearLayoutTimers();

      const scenes = this.document.scenes;
      const active = scenes[this.index];
      const display = active?.presentation?.display || 'stack';
      const visible = this._visibleScenes(display);
      const isForwardStack = this._audioRenderMode === 'advance' && display === 'stack';

      if (isForwardStack) {
        this._renderStackWithBreathing(visible, active);
      } else {
        // Restore/load/history jumps should be immediate and deterministic.
        this.els.scenes.innerHTML = '';
        const nodes = [];
        const stillNodes = [];
        visible.forEach(({ scene, index }) => {
          const node = this._sceneNode(scene, index === this.index, this.index - index);
          // Solo/load/history uses this deterministic render path instead of the
          // forward-stack entrance path. A `still` Scene must therefore suppress
          // the Scene-container transition here as well, otherwise the browser
          // interpolates from the base translateY entrance to its measured Y and
          // it visibly drops in even though entryMotion is `still`.
          if (node.dataset.entryMotion === 'still') {
            node.style.transition = 'none';
            stillNodes.push(node);
          }
          node.classList.add('is-visible');
          this.els.scenes.appendChild(node);
          nodes.push(node);
        });
        this._updateSceneAges(nodes, visible);
        this._positionSceneNodes(nodes, visible, 0);
        const newest = nodes[nodes.length - 1];
        if (newest) this._activatePresentation(active, newest);
        if (stillNodes.length) {
          // Keep transition suppression through the first painted frame. Restore it
          // afterwards so later stack reflow/history movement behaves normally.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            stillNodes.forEach((node) => { node.style.transition = ''; });
          }));
        }
      }

      this.els.current.textContent = String(this.index + 1);
      this.els.bar.style.width = `${this.progress * 100}%`;
      this.els.prev.disabled = !this.options.allowPrevious || this.maxVisitedIndex <= 0;
      this.host.dataset.display = display;
      this.host.dataset.sceneId = active.id;
      this.host.dataset.sceneType = active.type;

      this._applyCorePresentation(active);
      this._applyBackgroundForIndex(this.index);

      if (this._audioRenderMode === 'preview') {
        // Authoring refresh leaves the currently playing transport untouched.
      } else if (this._audioRenderMode === 'cover') {
        // Cover preload: visuals only. Scene BGM / Ambient / SE must remain silent.
        this._stopAllAudio(true);
      } else if (this._audioRenderMode === 'advance') {
        this._applySceneAudio(active, false);
      } else {
        const mode = this._audioRenderMode;
        this._restoreAudioForIndex(this.index);
        if (mode === 'load') this._queueInitialOneShots(active);
      }
      this._audioRenderMode = 'advance';

      if (!isForwardStack) this._scheduleAuto();
    }

    _visibleScenes(display) {
      const scenes = this.document.scenes;
      if (display === 'solo') return [{ scene: scenes[this.index], index: this.index }];

      // A previous solo scene resets the visual stack, but that solo Scene itself
      // becomes the new base. Later `stack` Scenes must build on top of it.
      let start = 0;
      for (let i = this.index - 1; i >= 0; i -= 1) {
        if ((scenes[i].presentation?.display || 'stack') === 'solo') {
          start = i;
          break;
        }
      }
      start = Math.max(start, this.index - this.options.maxStackVisible + 1);
      return scenes.slice(start, this.index + 1).map((scene, offset) => ({ scene, index: start + offset }));
    }


    _resetBackgroundLayers() {
      if (!this.els?.bgA || !this.els?.bgB) return;
      [this.els.bgA, this.els.bgB].forEach((layer) => {
        layer.className = layer.classList.contains('sp-bg-a') ? 'sp-bg-layer sp-bg-a' : 'sp-bg-layer sp-bg-b';
        layer.removeAttribute('style');
      });
      this.els.bgA.classList.add('is-current');
      this.els.bgB.classList.remove('is-current');
      if (this.els.veil) this.els.veil.removeAttribute('style');
      if (this.els.bgTextures) {
        this.els.bgTextures.removeAttribute('style');
        this.els.bgTextures.dataset.texture = '';
      }
      this.host.classList.remove('sp-has-background','sp-bg-glitching');
    }

    _backgroundStateAt(index) {
      const doc = this.document;
      const scenes = doc?.scenes || [];
      const target = Math.max(0, Math.min(Number(index) || 0, Math.max(0, scenes.length - 1)));

      // A different document must never inherit cached state from the old one.
      if (this._backgroundStateCacheDocument !== doc) {
        this._backgroundStateCacheDocument = doc;
        this._backgroundStateCache = [];
      }

      const cache = this._backgroundStateCache || (this._backgroundStateCache = []);
      if (cache[target]) return { ...cache[target] };

      const defaults = {
        src: '',
        transition: 'fade',
        dim: null,
        blur: 0,
        fit: 'cover',
        position: 'center center',
        reveal: null,
        motion: null,
        textures: null
      };

      // Continue from the nearest cached prefix instead of rescanning Scene 1.
      let start = 0;
      let state = { ...defaults };
      for (let i = target - 1; i >= 0; i -= 1) {
        if (cache[i]) {
          state = { ...cache[i] };
          start = i + 1;
          break;
        }
      }

      for (let i = start; i <= target; i += 1) {
        const bg = scenes[i]?.presentation?.background;
        if (bg && typeof bg === 'object') {
          Object.keys(bg).forEach((key) => {
            const value = bg[key];
            if (value !== undefined) state[key] = (value && typeof value === 'object' && !Array.isArray(value))
              ? { ...(state[key] && typeof state[key] === 'object' ? state[key] : {}), ...value }
              : value;
          });
        }
        cache[i] = { ...state };
      }
      return { ...cache[target] };
    }

    _applyBackgroundForIndex(index) {
      const next = this._backgroundStateAt(index);
      const previous = this.backgroundState;
      const sceneBg = this.document?.scenes?.[index]?.presentation?.background || null;
      const transition = sceneBg?.transition || next.transition || 'fade';
      const srcChanged = !previous || previous.src !== next.src;

      this._resetBackgroundRuntime();
      this.backgroundState = next;
      this.host.classList.toggle('sp-has-background', Boolean(next.src));

      if (srcChanged) this._swapBackground(next, transition);
      else this._styleCurrentBackground(next, Boolean(sceneBg?.motion));

      this._applyBackgroundOverlays(next);
      this._runBackgroundReveal(sceneBg?.reveal, transition);
      emit(this.host, 'sceneplayer:backgroundchange', { index, scene: this.currentScene, background: { ...next }, srcChanged });
    }

    _currentBackgroundLayer() {
      return this.backgroundLayerIndex === 0 ? this.els.bgA : this.els.bgB;
    }

    _nextBackgroundLayer() {
      return this.backgroundLayerIndex === 0 ? this.els.bgB : this.els.bgA;
    }

    _swapBackground(state, transition) {
      const current = this._currentBackgroundLayer();
      const incoming = this._nextBackgroundLayer();
      const transitionDuration=Math.max(0,asNumber(state.transitionDuration,700));
      incoming.style.setProperty('--sp-bg-transition-duration',`${transitionDuration}ms`);
      current.style.setProperty('--sp-bg-transition-duration',`${transitionDuration}ms`);
      this._prepareBackgroundLayer(incoming, state);

      const mode = ['fade','cut','flash','glitch'].includes(transition) ? transition : 'fade';
      this.host.dataset.bgTransition = mode;
      incoming.classList.add('is-current');
      current.classList.remove('is-current');

      if (mode === 'cut') {
        incoming.classList.add('sp-bg-cut');
        requestAnimationFrame(() => incoming.classList.remove('sp-bg-cut'));
      } else if (mode === 'flash') {
        this.els.bgFlash.classList.remove('is-active');
        void this.els.bgFlash.offsetWidth;
        this.els.bgFlash.classList.add('is-active');
        this._backgroundTimeout(() => this.els.bgFlash.classList.remove('is-active'), 520);
      } else if (mode === 'glitch') {
        this.host.classList.add('sp-bg-glitching');
        this._backgroundTimeout(() => this.host.classList.remove('sp-bg-glitching'), 560);
      }

      this.backgroundLayerIndex = this.backgroundLayerIndex === 0 ? 1 : 0;
      this._styleCurrentBackground(state, true);
      this._backgroundTimeout(() => {
        current.style.backgroundImage = '';
        current.className = current.classList.contains('sp-bg-a') ? 'sp-bg-layer sp-bg-a' : 'sp-bg-layer sp-bg-b';
      }, mode === 'cut' ? 20 : 900);
    }

    _prepareBackgroundLayer(layer, state) {
      layer.className = layer.classList.contains('sp-bg-a') ? 'sp-bg-layer sp-bg-a' : 'sp-bg-layer sp-bg-b';
      layer.style.backgroundImage = state.src ? `url("${String(state.src).replace(/"/g, '\"')}")` : 'none';
      layer.style.backgroundSize = state.fit === 'contain' ? 'contain' : 'cover';
      layer.style.backgroundPosition = state.position || 'center center';
      {
        const filters = [];
        const blur = Math.max(0, asNumber(state.blur, 0));
        const monochrome = clamp(asNumber(state.textures?.monochrome, 0), 0, 1);
        if (blur > 0) filters.push(`blur(${blur}px)`);
        if (monochrome > 0) filters.push(`grayscale(${monochrome})`);
        layer.style.filter = filters.join(' ');
      }
      this._applyBackgroundMotion(layer, state.motion);
    }

    _styleCurrentBackground(state, resetMotion) {
      const layer = this._currentBackgroundLayer();
      if (!layer) return;
      layer.style.backgroundSize = state.fit === 'contain' ? 'contain' : 'cover';
      layer.style.backgroundPosition = state.position || 'center center';
      {
        const filters = [];
        const blur = Math.max(0, asNumber(state.blur, 0));
        const monochrome = clamp(asNumber(state.textures?.monochrome, 0), 0, 1);
        if (blur > 0) filters.push(`blur(${blur}px)`);
        if (monochrome > 0) filters.push(`grayscale(${monochrome})`);
        layer.style.filter = filters.join(' ');
      }
      if (resetMotion) this._applyBackgroundMotion(layer, state.motion);
    }

    _applyBackgroundMotion(layer, motion) {
      layer.classList.remove('sp-motion-parallax','sp-motion-breath','sp-motion-slowZoom','sp-motion-panLeft','sp-motion-panRight','sp-motion-panUp','sp-motion-panDown');
      layer.style.removeProperty('--sp-bg-duration');
      layer.style.removeProperty('--sp-bg-scale-from');
      layer.style.removeProperty('--sp-bg-scale-to');
      layer.style.removeProperty('--sp-bg-pan');
      if (!motion || !motion.type || motion.type === 'none') return;
      const type = ['parallax','breath','slowZoom','panLeft','panRight','panUp','panDown'].includes(motion.type) ? motion.type : null;
      if (!type) return;
      layer.classList.add(`sp-motion-${type}`);
      const defaultDuration = type === 'breath' ? 4200 : 6500;
      const defaultFrom = type === 'slowZoom' ? 1.0 : 1.06;
      const defaultTo = type === 'slowZoom' ? 1.14 : (type === 'breath' ? 1.11 : 1.08);
      layer.style.setProperty('--sp-bg-duration', `${Math.max(250, asNumber(motion.duration, defaultDuration))}ms`);
      layer.style.setProperty('--sp-bg-scale-from', String(asNumber(motion.scaleFrom, defaultFrom)));
      layer.style.setProperty('--sp-bg-scale-to', String(asNumber(motion.scaleTo, defaultTo)));
      layer.style.setProperty('--sp-bg-pan', `${asNumber(motion.pan, 9)}%`);
    }

    _applyBackgroundOverlays(state) {
      const isCinemaLight = this.document?.theme === 'cinema' && this.document?.appearance?.cinemaTone === 'light';
      const sceneTone = state?.tone === 'light' ? 'light' : (state?.tone === 'dark' ? 'dark' : null);
      const useLightWash = sceneTone ? sceneTone === 'light' : isCinemaLight;
      const themeDefaultDim = this.document?.theme === 'cinema' ? (useLightWash ? 0.72 : 0.34) : (useLightWash ? 0.64 : 0);
      const dim = clamp(asNumber(state.dim, themeDefaultDim), 0, 1);
      // A Scene may explicitly choose a light paper wash or a dark veil.
      this.els.veil.style.background = useLightWash
        ? `rgba(250,247,240,${dim})`
        : `rgba(0,0,0,${dim})`;

      const textures = state.textures || {};
      const grain = clamp(asNumber(textures.grain, 0), 0, 1);
      const scanline = clamp(asNumber(textures.scanline, 0), 0, 1);
      const vignette = clamp(asNumber(textures.vignette, 0), 0, 1);
      const monochrome = clamp(asNumber(textures.monochrome, 0), 0, 1);
      const glitch = clamp(asNumber(textures.glitch, 0), 0, 1);
      const blurTexture = clamp(asNumber(textures.blur, 0), 0, 1);
      this.els.bgTextures.style.setProperty('--sp-grain', grain);
      this.els.bgTextures.style.setProperty('--sp-scanline', scanline);
      this.els.bgTextures.style.setProperty('--sp-vignette', vignette);
      this.els.bgTextures.style.setProperty('--sp-texture-glitch', glitch);
      this.els.bgTextures.style.opacity = String(Math.max(grain, scanline, vignette, glitch, blurTexture));
      this.els.bgTextures.classList.toggle('has-texture-glitch', glitch > 0);
      this.els.bgTextures.style.backdropFilter = blurTexture > 0 ? `blur(${blurTexture * 4}px) grayscale(${monochrome})` : `grayscale(${monochrome})`;
      this.els.bgTextures.style.webkitBackdropFilter = this.els.bgTextures.style.backdropFilter;
    }

    _runBackgroundReveal(reveal, fallbackTransition) {
      if (!reveal || !reveal.type || reveal.type === 'none' || reveal.type === 'still') return;
      const type = ['intro','memory','ghost','flash'].includes(reveal.type) ? reveal.type : null;
      if (!type) return;
      const layer = this._currentBackgroundLayer();
      const duration = Math.max(0, asNumber(reveal.duration, 1000));
      const hold = Math.max(0, asNumber(reveal.hold, 0));
      const opacity = clamp(asNumber(reveal.opacity, 1), 0, 1);
      layer.style.setProperty('--sp-reveal-duration', `${duration}ms`);
      layer.style.setProperty('--sp-reveal-opacity', opacity);
      layer.classList.remove('sp-reveal-intro','sp-reveal-memory','sp-reveal-ghost','sp-reveal-flash');
      void layer.offsetWidth;
      layer.classList.add(`sp-reveal-${type}`);
      this._backgroundTimeout(() => layer.classList.remove(`sp-reveal-${type}`), duration + hold + 80);
      if (type === 'flash' && fallbackTransition !== 'flash') {
        this.els.bgFlash.classList.add('is-active');
        this._backgroundTimeout(() => this.els.bgFlash.classList.remove('is-active'), Math.min(520, duration || 520));
      }
    }

    _openSceneImage(src, alt='') {
      if (!src) return;
      let viewer = document.querySelector('.sp-scene-image-viewer');
      if (!viewer) {
        viewer = document.createElement('div');
        viewer.className = 'sp-scene-image-viewer';
        viewer.hidden = true;
        viewer.setAttribute('role','dialog');
        viewer.setAttribute('aria-modal','true');

        const shade = document.createElement('button');
        shade.type = 'button';
        shade.className = 'sp-scene-image-viewer-shade';
        shade.setAttribute('aria-label','Close image');

        const frame = document.createElement('div');
        frame.className = 'sp-scene-image-viewer-frame';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'sp-scene-image-viewer-close';
        close.setAttribute('aria-label','Close image');
        close.textContent = '×';

        const img = document.createElement('img');
        img.className = 'sp-scene-image-viewer-img';
        img.alt = '';

        // Custom image pan / pinch zoom.
        // Native pinch was able to enlarge the image, but the enlarged image
        // stayed visually pinned.  We keep our own transform so a zoomed image
        // can be dragged left/right/up/down on iPhone as well.
        const viewState = {
          scale: 1,
          x: 0,
          y: 0,
          startScale: 1,
          startX: 0,
          startY: 0,
          startDistance: 0,
          startCenterX: 0,
          startCenterY: 0,
          dragging: false,
          moved: false,
          lastX: 0,
          lastY: 0,
          touchStartX: 0,
          touchStartY: 0,
          touchStartTime: 0,
          lastTapTime: 0,
          lastTapX: 0,
          lastTapY: 0
        };

        const viewportSize = () => ({
          w: Math.max(1, frame.clientWidth),
          h: Math.max(1, frame.clientHeight)
        });

        const panBounds = () => {
          const vp = viewportSize();
          const baseW = Math.max(1, img.clientWidth);
          const baseH = Math.max(1, img.clientHeight);
          const scaledW = baseW * viewState.scale;
          const scaledH = baseH * viewState.scale;

          // Keep at least one edge of the image visible at all times and never
          // allow a zoomed image to be thrown completely off-screen.
          const maxX = Math.max(0, (scaledW - vp.w) / 2);
          const maxY = Math.max(0, (scaledH - vp.h) / 2);
          return { maxX, maxY };
        };

        const clampPan = () => {
          const { maxX, maxY } = panBounds();
          viewState.x = Math.max(-maxX, Math.min(maxX, viewState.x));
          viewState.y = Math.max(-maxY, Math.min(maxY, viewState.y));
        };

        let viewAnimTimer = 0;

        const applyView = ({animate=false} = {}) => {
          clampPan();
          clearTimeout(viewAnimTimer);
          img.classList.toggle('is-animating', animate);

          img.style.transform =
            `translate3d(${viewState.x}px, ${viewState.y}px, 0) scale(${viewState.scale})`;
          frame.classList.toggle('is-zoomed', viewState.scale > 1.01);

          if (animate) {
            viewAnimTimer = setTimeout(() => {
              img.classList.remove('is-animating');
            }, 280);
          }
        };

        const resetView = ({animate=false} = {}) => {
          viewState.scale = 1;
          viewState.x = 0;
          viewState.y = 0;
          viewState.dragging = false;
          viewState.moved = false;
          applyView({animate});
        };

        const distance = (a,b) => Math.hypot(b.clientX-a.clientX,b.clientY-a.clientY);
        const center = (a,b) => ({
          x:(a.clientX+b.clientX)/2,
          y:(a.clientY+b.clientY)/2
        });

        const clampScale = (s) => Math.max(1, Math.min(5, s));

        const zoomAt = (clientX, clientY, nextScale, {animate=false} = {}) => {
          const vp = viewportSize();
          const oldScale = viewState.scale;
          const scale = clampScale(nextScale);
          if (Math.abs(scale - oldScale) < 0.001) return;

          // Preserve the image point under the finger while zooming.
          const dx = clientX - vp.w / 2;
          const dy = clientY - vp.h / 2;
          const ratio = scale / oldScale;
          viewState.x = dx - (dx - viewState.x) * ratio;
          viewState.y = dy - (dy - viewState.y) * ratio;
          viewState.scale = scale;
          applyView({animate});
        };

        frame.addEventListener('touchstart',(event)=>{
          if(event.touches.length===2){
            event.preventDefault();
            const c=center(event.touches[0],event.touches[1]);
            viewState.startDistance=distance(event.touches[0],event.touches[1]);
            viewState.startScale=viewState.scale;
            viewState.startX=viewState.x;
            viewState.startY=viewState.y;
            viewState.startCenterX=c.x;
            viewState.startCenterY=c.y;
            viewState.dragging=false;
            viewState.moved=true;
          }else if(event.touches.length===1){
            const t=event.touches[0];
            viewState.touchStartX=t.clientX;
            viewState.touchStartY=t.clientY;
            viewState.touchStartTime=performance.now();
            viewState.moved=false;
            if(viewState.scale>1.01){
              event.preventDefault();
              viewState.dragging=true;
              viewState.lastX=t.clientX;
              viewState.lastY=t.clientY;
            }
          }
        },{passive:false});

        frame.addEventListener('touchmove',(event)=>{
          if(event.touches.length===2){
            event.preventDefault();
            const nowDistance=distance(event.touches[0],event.touches[1]);
            const c=center(event.touches[0],event.touches[1]);
            const nextScale=clampScale(
              viewState.startScale * (nowDistance / Math.max(1,viewState.startDistance))
            );
            viewState.scale=nextScale;
            viewState.x=viewState.startX + (c.x-viewState.startCenterX);
            viewState.y=viewState.startY + (c.y-viewState.startCenterY);
            viewState.moved=true;
            applyView();
          }else if(event.touches.length===1){
            const t=event.touches[0];
            const totalDx=t.clientX-viewState.touchStartX;
            const totalDy=t.clientY-viewState.touchStartY;
            if(Math.hypot(totalDx,totalDy)>6)viewState.moved=true;

            if(viewState.scale>1.01){
              event.preventDefault();
              viewState.x += t.clientX-viewState.lastX;
              viewState.y += t.clientY-viewState.lastY;
              viewState.lastX=t.clientX;
              viewState.lastY=t.clientY;
              applyView();
            }
          }
        },{passive:false});

        frame.addEventListener('touchend',(event)=>{
          if(event.touches.length===0){
            const now=performance.now();
            const duration=now-viewState.touchStartTime;
            const wasMoved=viewState.moved;
            const endTouch=event.changedTouches?.[0];
            const x=endTouch?.clientX ?? viewState.touchStartX;
            const y=endTouch?.clientY ?? viewState.touchStartY;
            const vertical=y-viewState.touchStartY;

            viewState.dragging=false;

            // Downward flick closes only at 1×, so it never fights with image panning.
            if(viewState.scale<=1.01 && !wasMoved && false){
              // reserved
            } else if(viewState.scale<=1.01 && vertical>90 && duration<700){
              const closeButton=viewer.querySelector('.sp-scene-image-viewer-close');
              closeButton?.click();
              return;
            }

            // Touch double-tap: zoom around the tapped point; second double-tap resets.
            if(!wasMoved && duration<320){
              const dt=now-viewState.lastTapTime;
              const near=Math.hypot(x-viewState.lastTapX,y-viewState.lastTapY)<42;
              if(dt<340 && near){
                event.preventDefault();
                if(viewState.scale>1.01) resetView({animate:true});
                else zoomAt(x,y,2.5,{animate:true});
                viewState.lastTapTime=0;
                return;
              }
              viewState.lastTapTime=now;
              viewState.lastTapX=x;
              viewState.lastTapY=y;
            }

            if(viewState.scale<=1.01) resetView();
          }else if(event.touches.length===1 && viewState.scale>1.01){
            viewState.dragging=true;
            viewState.lastX=event.touches[0].clientX;
            viewState.lastY=event.touches[0].clientY;
          }
        },{passive:false});

        // Desktop convenience: wheel to zoom, drag to pan while zoomed.
        frame.addEventListener('wheel',(event)=>{
          event.preventDefault();
          const next=viewState.scale * (event.deltaY<0 ? 1.12 : 0.89);
          zoomAt(event.clientX,event.clientY,next);
          if(viewState.scale<=1.01) resetView();
        },{passive:false});

        frame.addEventListener('pointerdown',(event)=>{
          if(event.pointerType==='touch' || viewState.scale<=1.01) return;
          viewState.dragging=true;
          viewState.moved=false;
          viewState.lastX=event.clientX;
          viewState.lastY=event.clientY;
          frame.setPointerCapture?.(event.pointerId);
          event.preventDefault();
        });
        frame.addEventListener('pointermove',(event)=>{
          if(!viewState.dragging || event.pointerType==='touch' || viewState.scale<=1.01) return;
          const dx=event.clientX-viewState.lastX;
          const dy=event.clientY-viewState.lastY;
          if(Math.hypot(dx,dy)>1)viewState.moved=true;
          viewState.x += dx;
          viewState.y += dy;
          viewState.lastX=event.clientX;
          viewState.lastY=event.clientY;
          applyView();
          event.preventDefault();
        });
        const endPointer=(event)=>{
          if(event.pointerType!=='touch') viewState.dragging=false;
        };
        frame.addEventListener('pointerup',endPointer);
        frame.addEventListener('pointercancel',endPointer);

        img.addEventListener('dblclick',(event)=>{
          event.preventDefault();
          event.stopPropagation();
          if(viewState.scale>1.01) resetView({animate:true});
          else zoomAt(event.clientX,event.clientY,2.5,{animate:true});
        });

        // Tap empty black area to close at 1×. At zoom > 1 the same gesture is
        // reserved for panning, avoiding accidental dismissal.
        frame.addEventListener('click',(event)=>{
          if(event.target===frame && viewState.scale<=1.01){
            event.preventDefault();
            event.stopPropagation();
            viewer.querySelector('.sp-scene-image-viewer-close')?.click();
          }
        });

        window.addEventListener('resize',()=>{ if(!viewer.hidden) applyView(); });

        frame._sceneImageReset = resetView;

        frame.append(close,img);
        viewer.append(shade,frame);
        document.body.appendChild(viewer);

        const shut = (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          viewer.hidden = true;
          document.documentElement.classList.remove('sp-scene-image-open');
        };
        shade.addEventListener('click',shut);
        close.addEventListener('click',shut);
        viewer.addEventListener('click',(event)=>{
          if(event.target===viewer)shut(event);
        });
        document.addEventListener('keydown',(event)=>{
          if(event.key==='Escape' && !viewer.hidden)shut(event);
        });
      }

      const img = viewer.querySelector('.sp-scene-image-viewer-img');
      const frame = viewer.querySelector('.sp-scene-image-viewer-frame');
      frame?._sceneImageReset?.();
      img.src = src;
      img.alt = alt || '';
      viewer.hidden = false;
      document.documentElement.classList.add('sp-scene-image-open');
      viewer.querySelector('.sp-scene-image-viewer-close')?.focus({preventScroll:true});
    }

    _appendSceneImage(container, scene, presentation, { history=false } = {}) {
      const image = presentation?.image;
      if (!image?.src || !container) return;

      const wrap = document.createElement(history ? 'span' : 'div');
      wrap.className = history ? 'sp-history-scene-image' : 'sp-scene-image';
      wrap.dataset.imageSize = ['small','large'].includes(image.size)
        ? image.size
        : ((presentation?.view==='chat') ? 'small' : 'large');

      let imageAlign=image.align||((presentation?.view==='chat')?'speaker':'center');
      if(imageAlign==='speaker'){
        const speakerSide=(presentation?.text?.align==='right')?'right':'left';
        imageAlign=speakerSide;
      }
      wrap.dataset.imageAlign=['left','center','right'].includes(imageAlign)?imageAlign:'center';

      const media = document.createElement(history ? 'span' : 'div');
      media.className = history ? 'sp-history-scene-image-media' : 'sp-scene-image-media';

      const img = document.createElement('img');
      img.alt = image.alt || '';
      img.loading = history ? 'lazy' : 'eager';
      img.decoding = 'async';

      // On the first visit an uncached image has no intrinsic height when the
      // Scene stack is initially measured. The Player therefore centers the
      // text-only height, then the image expands downward after loading.
      // Re-measure the current stack as soon as the foreground image becomes
      // measurable. Cached/revisited Scenes already have the correct geometry.
      const relayoutAfterImageLoad = () => {
        if (history) return;
        const activeNode = wrap.closest('.sp-scene');
        if (!activeNode || !activeNode.isConnected || !activeNode.classList.contains('is-active')) return;

        const run = () => {
          const activeScene = this.document?.scenes?.[this.index];
          if (!activeScene || activeScene.id !== scene.id) return;
          const display = activeScene.presentation?.display || 'stack';
          const visible = this._visibleScenes(display);
          const nodeMap = new Map(
            [...this.els.scenes.querySelectorAll('.sp-scene')]
              .filter(node => !node.classList.contains('sp-layout-leaving'))
              .map(node => [node.dataset.sceneId, node])
          );
          const nodes = visible.map(entry => nodeMap.get(entry.scene.id)).filter(Boolean);
          if (nodes.length === visible.length) this._positionSceneNodes(nodes, visible, 0);
        };

        // Give Safari one painted frame to apply the decoded image dimensions.
        requestAnimationFrame(() => requestAnimationFrame(run));
      };

      img.addEventListener('load', relayoutAfterImageLoad, {once:true});

      // History drum centers are cached for scroll performance. Foreground
      // images can change a history item's height after that cache is built,
      // which makes the visual "focus" point drift to the wrong Scene.
      // Invalidate/rebuild the drum geometry whenever a history image resolves.
      const refreshHistoryGeometryAfterImageLoad = () => {
        if (!history) return;
        this.historyMetrics = null;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => this._scheduleHistoryDepth());
        });
      };
      img.addEventListener('load', refreshHistoryGeometryAfterImageLoad, {once:true});

      img.src = image.src;
      media.appendChild(img);
      wrap.appendChild(media);

      // Data/blob/cached images can already be complete before the load event
      // is observed by this render pass.
      if (img.complete && img.naturalWidth > 0) {
        relayoutAfterImageLoad();
        refreshHistoryGeometryAfterImageLoad();
      }

      if (image.fullscreen !== false) {
        wrap.classList.add('is-zoomable');
        wrap.setAttribute('role','button');
        wrap.setAttribute('tabindex','0');
        wrap.setAttribute('aria-label', image.alt ? `Open image: ${image.alt}` : 'Open image fullscreen');
        const open = (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._openSceneImage(image.src, image.alt || '');
        };
        wrap.addEventListener('click',open);
        wrap.addEventListener('keydown',(event)=>{
          if(event.key==='Enter' || event.key===' '){ open(event); }
        });
      }

      container.appendChild(wrap);
    }

    _sceneNode(scene, active, age) {
      const article = document.createElement('article');
      article.className = `sp-scene sp-type-${scene.type}`;
      article.dataset.sceneId = scene.id;
      article.dataset.age = String(age);
      const sceneLanguage = scene.language || (this.document?.language && this.document.language !== 'mul' ? this.document.language : '');
      if (sceneLanguage) { article.lang = sceneLanguage; article.dataset.language = sceneLanguage; }
      article.dir = scene.direction || this.document?.direction || 'auto';
      article.classList.toggle('is-active', active);
      if (!active) article.classList.add('is-visible');

      const presentation = scene.presentation || {};
      const requestedEffect = presentation.effect || 'auto';
      const effect = this._resolveSceneEffect(scene, requestedEffect);
      if (effect && /^[a-zA-Z0-9_-]+$/.test(effect)) article.dataset.effect = effect;
      const fxTiming = presentation.effectTiming || {};
      const fxDuration = Math.max(.08, Math.min(6, asNumber(fxTiming.duration, 0)));
      const fxDelay = Math.max(0, Math.min(6, asNumber(fxTiming.delay, 0)));
      if (fxDuration > 0) article.style.setProperty('--sp-effect-duration', `${fxDuration}s`);
      if (fxDelay > 0) article.style.setProperty('--sp-effect-delay', `${fxDelay}s`);
      if (requestedEffect === 'auto') article.dataset.autoTransition = 'true';
      if (presentation.view && /^[a-zA-Z0-9_-]+$/.test(presentation.view)) article.dataset.view = presentation.view;
      const entryMotion = presentation.entryMotion === 'still' ? 'still' : 'flow';
      article.dataset.entryMotion = entryMotion;
      article.dataset.fit = this._resolveAutoFit(scene, presentation.text || {});

      if (presentation.view === 'chat' && (scene.text || scene.subText)) {
        article.classList.add('sp-chat-scene');
        const align = presentation.text?.align === 'right' ? 'right' : 'left';
        article.dataset.chatSide = align;
        const row = document.createElement('div');
        row.className = 'sp-chat-row';

        const icon = document.createElement('div');
        icon.className = 'sp-chat-icon';
        const iconSrc = presentation.chat?.icon || '';
        if (iconSrc) {
          const img = document.createElement('img');
          img.src = iconSrc; img.alt = '';
          icon.appendChild(img);
        } else {
          icon.textContent = presentation.chat?.iconText || '●';
        }

        const body = document.createElement('div');
        body.className = 'sp-chat-body';
        if (typeof scene.subText === 'string' && scene.subText.length) {
          const speaker = document.createElement('div');
          speaker.className = 'sp-chat-speaker sp-subtext';
          speaker.textContent = scene.subText;
          this._applyTextStyle(speaker, presentation.subText || {}, true);
          body.appendChild(speaker);
        }
        if (typeof scene.text === 'string' && scene.text.length) {
          const bubble = document.createElement('div');
          bubble.className = 'sp-chat-bubble';
          if (presentation.chat?.bubbleColor) bubble.style.background = presentation.chat.bubbleColor;
          const text = document.createElement('div');
          text.className = 'sp-text';
          text.textContent = chatDisplayText(scene.text);
          this._applyTextStyle(text, presentation.text || {}, false);
          if (presentation.chat?.bubbleTextColor) text.style.setProperty('color', String(presentation.chat.bubbleTextColor), 'important');
          bubble.appendChild(text);
          body.appendChild(bubble);
        }
        row.append(icon, body);
        article.appendChild(row);
      } else {
        if (typeof scene.text === 'string' && scene.text.length) {
          const text = document.createElement('div');
          text.className = 'sp-text';
          text.textContent = scene.text;
          this._applyTextStyle(text, presentation.text || {}, false);
          article.appendChild(text);
        }

        if (typeof scene.subText === 'string' && scene.subText.length) {
          const sub = document.createElement('div');
          sub.className = 'sp-subtext';
          sub.textContent = scene.subText;
          this._applyTextStyle(sub, presentation.subText || {}, true);
          article.appendChild(sub);
        }
      }

      this._appendSceneImage(article, scene, presentation);

      if (scene.type === 'sound' && !scene.text && !scene.subText) {
        const mark = document.createElement('span');
        mark.className = 'sp-sound-mark';
        mark.setAttribute('aria-label', 'Sound scene');
        mark.textContent = '♪';
        article.appendChild(mark);
      }

      return article;
    }

    _resolveAutoFit(scene, textStyle = {}) {
      // Explicit pixel/token sizes are an author override. Auto Fit only owns the default size.
      if (textStyle && textStyle.size && textStyle.size !== 'auto') return 'manual';
      const text = String(scene?.text || '');
      const chars = Array.from(text).length;
      const lines = text ? text.split('\n').length : 0;
      // Preserve v0.1's useful behavior: multi-line/list blocks shrink before they overflow.
      if (lines >= 8 || chars >= 190) return 'tight';
      if (lines >= 6 || chars >= 145) return 'compact';
      if (lines >= 4 || chars >= 105) return 'medium';
      // A smaller viewport-safe tier for dense 3-line prose.
      if (lines >= 3 && chars >= 78) return 'soft';
      return 'normal';
    }

    _resolveSceneEffect(scene, requested) {
      if (requested && requested !== 'auto') return requested;

      // "Auto" is the product default, not an effect lottery.
      // Type, punctuation and text length must never change glyph geometry
      // during the default entrance. True Jump Landing owns the movement;
      // Auto only adds a quiet opacity reveal.
      return 'fadeRise';
    }

    _applyTextStyle(node, style, isSubText) {
      if (!style || typeof style !== 'object') style = {};
      if (style.color) node.style.color = String(style.color);
      const shadows={
        none:'none',
        soft:'0 1px 4px rgba(0,0,0,.48)',
        strong:'0 2px 4px rgba(0,0,0,.86), 0 0 12px rgba(0,0,0,.48)'
      };
      if (style.shadow && shadows[style.shadow]) node.style.textShadow=shadows[style.shadow];

      const family = style.fontFamily || this.document?.appearance?.typography?.fontFamily || 'serif';
      const families = {
        serif: 'var(--sp-font-serif)',
        sans: 'var(--sp-font-sans)',
        mono: 'var(--sp-font-mono)'
      };
      node.style.fontFamily = families[family] || families.serif;

      const size = style.size;
      const tokenSizes = isSubText
        ? { small: '11px', normal: '14px', large: '17px', xl: '20px' }
        : { small: 'clamp(17px,3.8vw,24px)', normal: 'clamp(21px,4.8vw,34px)', large: 'clamp(26px,5.8vw,42px)', xl: 'clamp(32px,7vw,54px)' };
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) node.style.fontSize = `${size}px`;
      else if (typeof size === 'string' && size !== 'auto' && tokenSizes[size]) node.style.fontSize = tokenSizes[size];

      if (style.wrap === 'nowrap') {
        node.style.whiteSpace = 'nowrap';
        node.style.overflowWrap = 'normal';
      }
      if (Number.isFinite(Number(style.lineHeight))) node.style.lineHeight = String(Math.max(1, Math.min(3, Number(style.lineHeight))));
      if (Number.isFinite(Number(style.letterSpacing))) node.style.letterSpacing = `${Math.max(-0.2, Math.min(0.5, Number(style.letterSpacing)))}em`;
      if (Number.isFinite(Number(style.opacity))) node.style.opacity = String(Math.max(0.1, Math.min(1, Number(style.opacity))));
      if (Number.isFinite(Number(style.sideMargin)) && Number(style.sideMargin) > 0) {
        const margin=Math.max(0,Math.min(40,Number(style.sideMargin)));
        node.style.width=`calc(100% - ${margin*2}%)`;
        node.style.maxWidth=`calc(100% - ${margin*2}%)`;
        node.style.marginLeft='auto';
        node.style.marginRight='auto';
      }
      if (style.align === 'left' || style.align === 'center' || style.align === 'right') node.style.textAlign = style.align;
    }

    _applyCorePresentation(scene) {
      const view = scene.presentation?.view || 'world';
      this.host.dataset.view = view;
    }

    _finishVisibleEntranceEffects() {
      if (!this.els?.scenes) return;
      this.els.scenes.querySelectorAll('.sp-scene.sp-fx-play').forEach((node) => {
        node.classList.remove('sp-fx-play');
        const text = node.querySelector('.sp-text');
        if (text) {
          // Freeze immediately into the static post-effect appearance.
          text.style.animation = 'none';
          void text.offsetWidth;
          text.style.animation = '';
        }
      });
    }

    _playEntranceEffectOnce(article) {
      if (!article || article.dataset.fxPlayed === 'true') return;
      article.dataset.fxPlayed = 'true';
      article.classList.remove('sp-fx-play');
      void article.offsetWidth;
      article.classList.add('sp-fx-play');

      // Longest standard effect is fade/slow at ~1.25s.
      // Remove the trigger class afterwards so later layout changes cannot
      // restart the animation. Static effect character (whisper/tilt/loud)
      // is carried by data-effect rules and remains without animation.
      const timing=article.dataset?.sceneId ? (this.currentScene?.presentation?.effectTiming || {}) : {};
      const customDuration=Math.max(0,asNumber(timing.duration,0))*1000;
      const customDelay=Math.max(0,asNumber(timing.delay,0))*1000;
      const cleanupAfter=Math.max(1380,customDelay+customDuration+140);
      this._presentationTimeout(() => {
        if (article.isConnected) article.classList.remove('sp-fx-play');
      }, cleanupAfter);
    }

    _activatePresentation(scene, article) {
      const presentation = scene.presentation || {};
      const textNode = article.querySelector('.sp-text');
      const typing = presentation.typing;

      // Entrance effects belong to the moment the Scene first appears.
      // Never replay merely because the Scene remains in the visible stack
      // or because another Scene is revealed above/below it.
      this._playEntranceEffectOnce(article);

      if (textNode && typing?.enabled && typeof scene.text === 'string' && scene.text.length) {
        this._startTyping(scene, textNode, typing);
      }

      const disappear = presentation.disappear;
      const after = asNumber(disappear?.after, 0);
      if (after > 0) {
        const fade = Math.max(100, asNumber(disappear?.fade, 700));
        const motion = disappear?.motion === 'up' ? 'up' : 'stay';
        article.style.setProperty('--sp-disappear-fade', `${fade}ms`);
        article.classList.toggle('is-disappear-up', motion === 'up');
        article.classList.toggle('is-disappear-stay', motion !== 'up');
        this._presentationTimeout(() => {
          if (!article.isConnected) return;
          article.classList.add('is-disappearing');
          emit(this.host, 'sceneplayer:disappear', { index: this.index, scene, phase: 'start', motion });
          this._presentationTimeout(() => {
            if (!article.isConnected) return;
            article.classList.add('is-disappeared');
            emit(this.host, 'sceneplayer:disappear', { index: this.index, scene, phase: 'end', motion });
          }, fade);
        }, after);
      }
    }

    _startTyping(scene, node, typing) {
      this._stopTyping(true);
      const chars = Array.from(scene.text || '');
      const speed = Math.max(10, asNumber(typing.speed, 55));
      const cursor = typing.cursor === false ? '' : '▍';
      let position = 0;

      node.classList.add('is-typing');
      node.textContent = cursor;
      emit(this.host, 'sceneplayer:typingstart', { index: this.index, scene });

      const timer = setInterval(() => {
        position += 1;
        node.textContent = chars.slice(0, position).join('') + (position < chars.length ? cursor : '');
        if (position >= chars.length) {
          clearInterval(timer);
          if (this.typingState?.timer === timer) this.typingState = null;
          node.classList.remove('is-typing');
          emit(this.host, 'sceneplayer:typingend', { index: this.index, scene, skipped: false });
          this._scheduleAuto();
        }
      }, speed);

      this.typingState = { timer, node, text: scene.text, sceneId: scene.id };
    }

    destroy() {
      if (this.destroyed) return;
      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this._stopAllAudio(true);
      if (this.audioContext && typeof this.audioContext.close === 'function') {
        try { this.audioContext.close(); } catch (_) {}
      }
      this.audioGainNodes.clear();
      this.audioSourceNodes.clear();
      this._bound.forEach(([el, event, fn, options]) => el.removeEventListener(event, fn, options));
      this._bound.length = 0;
      this.host.innerHTML = '';
      this.host.classList.remove('sp-core');
      this.destroyed = true;
    }
  }

  ScenePlayerCore.VERSION = '1.4.2-entry-motion';
  ScenePlayerCore.FORMAT_VERSION = '1.0';
  ScenePlayerCore.validate = assertSceneDocument;

  global.ScenePlayerCore = ScenePlayerCore;
})(typeof window !== 'undefined' ? window : globalThis);
