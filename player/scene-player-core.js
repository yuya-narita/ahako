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
    uiLanguage: 'ja'
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
      this.destroyed = false;
      this._bound = [];
      this.presentationTimers = [];
      this.layoutTimers = [];
      this.typingState = null;
      this.backgroundState = null;
      this.backgroundLayerIndex = 0;
      this.backgroundTimers = [];
      this.audioUnlocked = false;
      this.muted = false;
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
      this._audioRenderMode = 'restore';

      this._buildShell();
      this._bindControls();
      this._bindPageLifecycle();
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
        <header class="sp-header">
          <button class="sp-button sp-prev" type="button" aria-label="Past scenes">‹</button>
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
            <p class="sp-ending-text">最後まで読みました。</p>
          </div>
          <button class="sp-ending-restart" type="button">最初から読む</button>
        </section>
      `;

      const q = (s) => this.host.querySelector(s);
      this.els = {
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
        endingRestart: q('.sp-ending-restart'),
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
          'player.ending.title':'読了','player.ending.text':'最後まで読みました。','player.ending.restart':'最初から読む'
        },
        en:{
          'player.previous':'Past Scenes','player.restart':'Restart','player.history':'Scroll past Scenes','player.history.close':'Close history',
          'player.ending.title':'Finished','player.ending.text':'You reached the end.','player.ending.restart':'Read from start'
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
      this.els.endingRestart.textContent = this._uiText('player.ending.restart');
      if (!this.document) this.els.endingTitle.textContent = this._uiText('player.ending.title');
      return this.uiLanguage;
    }

    _on(el, event, fn, options) {
      el.addEventListener(event, fn, options);
      this._bound.push([el, event, fn, options]);
    }


    _bindPageLifecycle() {
      const suspend = () => this._suspendForBackground();
      this._on(document, 'visibilitychange', () => {
        if (document.hidden) suspend();
      }, { passive: true });
      this._on(global, 'pagehide', suspend, { passive: true });
      // Supported by some Chromium/WebKit lifecycle implementations.
      this._on(global, 'freeze', suspend, { passive: true });
      // iOS fallback: lock/home may blur before visibilitychange settles.
      this._on(global, 'blur', () => {
        setTimeout(() => {
          if (document.hidden || !document.hasFocus()) suspend();
        }, 0);
      }, { passive: true });
    }

    _suspendForBackground() {
      if (this.destroyed || this._backgroundSuspended) return;
      this._backgroundSuspended = true;

      // AUTO must not advance Scenes while the browser/app is in background.
      this.stopAuto();

      // Pause persistent channels in-place so currentTime is preserved.
      Object.values(this.audioEls || {}).forEach((audio) => {
        try { audio.pause(); } catch (_) {}
      });

      // One-shots/SE should never continue in background and should not replay.
      this.oneshots.forEach((audio) => {
        try { audio.pause(); } catch (_) {}
      });
      this.oneshots.clear();

      // Also suspend WebAudio if available; this is important on iOS lock.
      if (this.audioContext?.state === 'running') {
        try { this.audioContext.suspend(); } catch (_) {}
      }

      emit(this.host, 'sceneplayer:backgroundsuspend', { index: this.index });
    }

    _resumeAudioAfterBackgroundGesture() {
      if (!this._backgroundSuspended) return;
      this._backgroundSuspended = false;

      // Resume only persistent channels that are still logically active.
      ['bgm', 'ambient'].forEach((channel) => {
        if (!this.audioState?.[channel]) return;
        const audio = this.audioEls?.[channel];
        if (!audio) return;
        this._safePlay(audio);
      });

      emit(this.host, 'sceneplayer:backgroundresume', { index: this.index });
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

      // Previous is no longer a one-scene step. It opens the continuous History Scroll.
      this._on(this.els.prev, 'click', (e) => {
        e.stopPropagation();
        this.openHistory();
      });
      this._on(this.els.restart, 'click', (e) => { e.stopPropagation(); this.restart(); });
      this._on(this.els.endingRestart, 'click', () => this.restart());
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

        // A swipe used to open History sets suppressNextClick so the synthetic
        // click following that gesture cannot advance the story accidentally.
        // Once the reader deliberately chooses a History item, that protection
        // has served its purpose. Leaving it armed would swallow the first
        // intentional tap after returning to the selected Scene.
        this.suppressNextClick = false;

        this.closeHistory({ keepVisualState: true });
        this.goToVisited(nextIndex);
      });
      this._on(this.els.historyScroll, 'scroll', () => this._scheduleHistoryDepth(), { passive: true });

      this._on(this.els.stage, 'click', (e) => {
        if (e.target.closest('button')) return;
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

          // Navigation is intentionally vertical on mobile:
          // pull down = Past Scenes (only when the author allows it),
          // push up = next Scene. Horizontal swipes do nothing.
          if (Math.abs(dy) >= Math.abs(dx)) {
            if (dy > 0 && this.options.allowPrevious) this.openHistory({ dragDistance: dy });
            else if (dy < 0) this.next();
          }
        }, { passive: true });
      }
    }

    _isExternalHttpAudio(src) {
      return /^https?:\/\//i.test(String(src || '').trim());
    }

    _prepareAudioTransport(audio, src) {
      if (!audio) return;
      // Absolute HTTP(S) assets are intentionally played through the native
      // HTMLMediaElement path. Routing them into MediaElementSource can become
      // silent when the remote server/browser CORS combination is not suitable
      // for Web Audio, even though the media element itself is perfectly able
      // to play the file.
      audio.__spNativeOnly = this._isExternalHttpAudio(src);
      audio.__spTransportSrc = src || '';
      if (audio.__spNativeOnly) {
        try { audio.crossOrigin = null; } catch (_) {}
      }
      emit(this.host, 'sceneplayer:audiotransport', {
        src: src || '',
        transport: audio.__spNativeOnly ? 'native-media' : 'web-audio'
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

      // If iOS/backgrounding paused media, only a new trusted reader gesture
      // is allowed to resume the persistent BGM/Ambient channels.
      if (armPlayback) this._resumeAudioAfterBackgroundGesture();

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
      audio.muted = Boolean(this.muted);
      audio.muted = Boolean(this.muted);
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
      this.els.ending.hidden = true;
      this.backgroundState = null;
      this.backgroundLayerIndex = 0;
      this._resetBackgroundLayers();
      this._audioRenderMode = 'load';

      this._render();
      emit(this.host, 'sceneplayer:load', { document: doc, index: this.index });
      return this;
    }

    refreshDocumentChrome(options = {}) {
      const nextDocument = options.document || null;
      if (nextDocument) this.document = nextDocument;
      const doc = this.document;
      if (!doc) return false;
      if (this.els.title) this.els.title.textContent = doc.title || '';
      if (this.els.author) this.els.author.textContent = doc.author || '';
      const families = {
        serif: 'var(--sp-font-serif)',
        sans: 'var(--sp-font-sans)',
        mono: 'var(--sp-font-mono)'
      };
      const authoredEndingLabel = String(doc.ending?.label || doc.ending?.title || '').trim();
      if (this.els.endingTitle) {
        this.els.endingTitle.textContent = authoredEndingLabel || this._uiText('player.ending.title');
        this.els.endingTitle.style.fontFamily = families[doc.ending?.fontFamily] || families.serif;
      }
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
      if (!this.document || !this.options.allowPrevious || this.maxVisitedIndex <= 0) return false;
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
      this.suppressNextClick = false;
      this.host.classList.remove('sp-history-open');
      this.els.history.hidden = true;
      if (!options.keepVisualState) this.els.stage.focus({ preventScroll: true });
      emit(this.host, 'sceneplayer:historyclose', {
        index: this.index,
        maxVisitedIndex: this.maxVisitedIndex
      });
      return true;
    }

    _applyHistoryTypography(node, scene) {
      if (!node || !scene) return;

      const sceneTextStyle = scene?.presentation?.text || {};
      const workTypography = this.document?.appearance?.typography || {};

      const family = sceneTextStyle.fontFamily || workTypography.fontFamily || 'serif';
      const families = {
        serif: 'var(--sp-font-serif)',
        sans: 'var(--sp-font-sans)',
        mono: 'var(--sp-font-mono)'
      };

      node.style.fontFamily = families[family] || families.serif;

      if (sceneTextStyle.fontWeight != null) {
        node.style.fontWeight = String(sceneTextStyle.fontWeight);
      }

      if (sceneTextStyle.fontStyle) {
        node.style.fontStyle = String(sceneTextStyle.fontStyle);
      }

      if (sceneTextStyle.letterSpacing != null) {
        const v = sceneTextStyle.letterSpacing;
        node.style.letterSpacing = typeof v === 'number' ? `${v}em` : String(v);
      }
    }

    _renderHistory() {
      if (!this.document) return;
      const fragment = document.createDocumentFragment();
      this.els.historyList.innerHTML = '';

      for (let i = 0; i <= this.maxVisitedIndex; i += 1) {
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

        if (scene.type === 'sound' && !scene.text) {
          const mark = document.createElement('span');
          mark.className = 'sp-history-text';
          mark.textContent = '♪';
          this._applyHistoryTypography(mark, scene);
          body.appendChild(mark);
        } else {
          const text = document.createElement('span');
          text.className = 'sp-history-text';
          text.textContent = scene.text || '';
          this._applyHistoryTypography(text, scene);
          body.appendChild(text);
        }

        if (scene.subText) {
          const sub = document.createElement('span');
          sub.className = 'sp-history-subtext';
          sub.textContent = scene.subText;
          this._applyHistoryTypography(sub, scene);
          body.appendChild(sub);
        }

        item.append(num, body);
        fragment.appendChild(item);
      }
      this.els.historyList.appendChild(fragment);
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
      const viewport = this.els.historyScroll.getBoundingClientRect();
      const center = viewport.top + viewport.height / 2;
      let nearest = null;
      let nearestDistance = Infinity;

      this.els.historyList.querySelectorAll('.sp-history-item').forEach((item) => {
        const rect = item.getBoundingClientRect();
        const itemCenter = rect.top + rect.height / 2;
        const distance = Math.abs(itemCenter - center);
        const normalized = clamp(distance / Math.max(1, viewport.height * 0.58), 0, 1);
        item.style.setProperty('--sp-history-depth', String(normalized));
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = item;
        }
      });

      this.els.historyList.querySelectorAll('.is-nearest').forEach((el) => el.classList.remove('is-nearest'));
      if (nearest) nearest.classList.add('is-nearest');
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
      if (nextIndex < 0 || nextIndex > this.maxVisitedIndex) return false;
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
      emit(this.host, 'sceneplayer:restart', { scene: this.currentScene });
    }

    finish() {
      if (!this.document || this.ended) return;
      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this.ended = true;
      this.els.ending.hidden = false;
      emit(this.host, 'sceneplayer:end', { document: this.document, index: this.index });
    }

    fadeOutAudio(duration = 1600, { includeOneShots = true } = {}) {
      const ms = Math.max(0, Number(duration) || 0);
      this._clearAudioTimers();

      ['bgm', 'ambient'].forEach((channel) => {
        this._stopPersistentChannel(channel, ms);
      });

      if (includeOneShots) {
        this.oneshots.forEach((audio) => {
          if (!audio || audio.paused) return;
          const startVolume = Number.isFinite(audio.volume) ? audio.volume : 1;
          const startedAt = performance.now();
          const step = (now) => {
            if (!this.oneshots.has(audio)) return;
            const t = Math.min(1, (now - startedAt) / Math.max(1, ms));
            try { audio.volume = Math.max(0, startVolume * (1 - t)); } catch (_) {}
            if (t < 1) requestAnimationFrame(step);
            else {
              try { audio.pause(); } catch (_) {}
              this.oneshots.delete(audio);
            }
          };
          if (ms > 0) requestAnimationFrame(step);
          else {
            try { audio.pause(); } catch (_) {}
            this.oneshots.delete(audio);
          }
        });
      }

      return ms;
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

      // A previous solo scene is a visual barrier: stack starts after it.
      let start = 0;
      for (let i = this.index - 1; i >= 0; i -= 1) {
        if ((scenes[i].presentation?.display || 'stack') === 'solo') {
          start = i + 1;
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
      const state = {
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
      for (let i = 0; i <= index; i += 1) {
        const bg = this.document?.scenes?.[i]?.presentation?.background;
        if (!bg || typeof bg !== 'object') continue;
        Object.keys(bg).forEach((key) => {
          const value = bg[key];
          if (value !== undefined) state[key] = (value && typeof value === 'object' && !Array.isArray(value))
            ? { ...(state[key] && typeof state[key] === 'object' ? state[key] : {}), ...value }
            : value;
        });
      }
      return state;
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
      layer.style.setProperty('--sp-bg-duration', `${Math.max(250, asNumber(motion.duration, 12000))}ms`);
      layer.style.setProperty('--sp-bg-scale-from', String(asNumber(motion.scaleFrom, 1)));
      layer.style.setProperty('--sp-bg-scale-to', String(asNumber(motion.scaleTo, type === 'slowZoom' ? 1.08 : 1.04)));
      layer.style.setProperty('--sp-bg-pan', `${asNumber(motion.pan, 4)}%`);
    }

    _applyBackgroundOverlays(state) {
      const isCinemaLight = this.document?.theme === 'cinema' && this.document?.appearance?.cinemaTone === 'light';
      const sceneTone = state?.tone === 'light' ? 'light' : (state?.tone === 'dark' ? 'dark' : null);
      const useLightWash = sceneTone ? sceneTone === 'light' : isCinemaLight;
      const themeDefaultDim = this.document?.theme === 'cinema' ? (useLightWash ? 0.72 : 0.34) : (useLightWash ? 0.64 : 0);
      const dim = clamp(asNumber(state.dim, themeDefaultDim), 0, 1);
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

    destroy(options = {}) {
      if (this.destroyed) return;
      const preserveHost = Boolean(options?.preserveHost);

      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this._stopAllAudio(true);

      if (this.audioContext && typeof this.audioContext.close === 'function') {
        try { this.audioContext.close(); } catch (_) {}
      }

      this.audioGainNodes.clear();
      this.audioSourceNodes.clear();
      this._bound.forEach(([el, event, fn, eventOptions]) => {
        el.removeEventListener(event, fn, eventOptions);
      });
      this._bound.length = 0;

      // Public Player may keep an old instance alive briefly only so its audio
      // can fade out. A newer instance can already be using the SAME host.
      // Never let delayed cleanup of the old instance erase the new DOM.
      if (!preserveHost) {
        this.host.innerHTML = '';
        this.host.classList.remove('sp-core');
      }

      this.destroyed = true;
    }
  }

  ScenePlayerCore.VERSION = '1.12.15-public.19-entry-motion';
  ScenePlayerCore.FORMAT_VERSION = '1.0';
  ScenePlayerCore.validate = assertSceneDocument;

  global.ScenePlayerCore = ScenePlayerCore;
})(typeof window !== 'undefined' ? window : globalThis);
