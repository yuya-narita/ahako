/*
 * Scene Player Core v1.13.0
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
  const SILENT_AUDIO_DATA_URI = 'data:audio/wav;base64,UklGRqQCAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YYACAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

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
      this.playbackTimelineStartedAt = 0;
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
      this.backgroundMotionEpoch = 0;
      this.audioUnlocked = false;
      // AudioContext unlock and story playback are separate states.
      // A restarted story must wait for the reader's next stage gesture even
      // when the AudioContext itself is already unlocked.
      this.audioPlaybackArmed = false;
      this.audioPending = [];
      // Ending one-shot is started from the final trusted pointer/touch gesture
      // on iOS. Keep a per-reading guard so finish() cannot fire it twice.
      this._endingAudioStarted = false;
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
      // Dedicated preloaded ending SE. It is played directly from the final
      // physical press on iPhone instead of relying on a later synthetic click.
      this.endingAudio = this._createAudioElement('ending');
      this.oneshots = new Set();
      // iOS/WebKit can reject media started later by AUTO timers even after the
      // reader unlocked audio earlier. Keep a small bank of reusable one-shot
      // elements and pre-authorize them from a trusted gesture. Reusing an
      // already-authorized media element lets future Scene SE / ending SE start
      // without requiring another tap.
      this.oneshotPool = Array.from({ length: 8 }, (_, i) => {
        const audio = this._createAudioElement(`oneshot-${i + 1}`);
        audio.__spInUse = false;
        audio.__spPriming = false;
        return audio;
      });
      this.muted = false;
      this._audioRenderMode = 'restore';

      // iOS V2.15: keep every real media source alive from the trusted START
      // gesture. Later Scene/AUTO transitions only seek/unmute an already-playing
      // HTMLMediaElement; they never ask Safari to authorize a new play().
      this._iosStableMediaBank = this._isIOSWebKit();
      this._iosAudioBank = new Map();
      this._iosBankPrimed = false;
      this._iosPersistentEntry = { bgm: null, ambient: null };
      // V2.13 AudioBuffer transport is intentionally disabled on iOS. Device
      // traces showed BufferSource.start() succeeding while hardware output stayed
      // silent, whereas native HTMLMediaElement output was audible.
      this._iosBufferAudio = false;
      this._bufferAudioCache = new Map();
      this._bufferAudioPromises = new Map();
      this._bufferPersistent = { bgm: null, ambient: null };
      this._bufferOneShots = new Set();

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
      const armFromStageGesture = (e) => {
        pressPaper();
        this.unlockAudio(true);

        // V2.19 iPhone ending SE: Scene SE is proven reliable when its already-
        // running bank entry is opened directly from the physical pointerdown.
        // Do the same for the final SE BEFORE click -> finish() performs any
        // session/ending bookkeeping. finish() sees _endingAudioStarted and will
        // not fire it twice. Ignore controls/images so merely pressing UI on the
        // last Scene cannot trigger the ending sound.
        const target = e?.target;
        const isControl = target?.closest?.('button, a, .sp-scene-image.is-zoomable');
        const isEditableText = this.host.classList.contains('live-edit-enabled')
          && target?.closest?.('.sp-scene.is-active .sp-text, .sp-scene.is-active .sp-subtext');
        const atLastScene = !!this.document && !this.ended
          && this.index >= Math.max(0, (this.document.scenes?.length || 1) - 1);
        if (atLastScene && !isControl && !isEditableText) this._playEndingAudio();
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
        // startAuto() owns the exact audio start/prime ordering.
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
        // Keep the click itself as a second trusted audio-unlock point.
        // On iPhone, a one-shot started from pointerdown can reject asynchronously
        // (for example while the media element is still becoming ready). That
        // rejection is queued before the synthetic click; re-arming here lets the
        // same physical tap flush it instead of waiting for another user action.
        this.unlockAudio(true);
        if(!this.typingState)emit(this.host,'sceneplayer:advanceintent',{index:this.index,scene:this.currentScene,at:performance.now()});
        this.next();
      });

      if (this.options.keyboard) {
        this._on(this.els.stage, 'keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            this.unlockAudio(true);
            if(!this.typingState)emit(this.host,'sceneplayer:advanceintent',{index:this.index,scene:this.currentScene,at:performance.now()});
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
            else if (dy < 0) { if(!this.typingState)emit(this.host,'sceneplayer:advanceintent',{index:this.index,scene:this.currentScene,at:performance.now()}); this.next(); }
          } else {
            if (dx > 0 && this.options.allowPrevious) this.openHistory({ dragDistance: dx });
            else { if(!this.typingState)emit(this.host,'sceneplayer:advanceintent',{index:this.index,scene:this.currentScene,at:performance.now()}); this.next(); }
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

    _isIOSWebKit() {
      try {
        const ua = navigator.userAgent || '';
        const platform = navigator.platform || '';
        const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
        return /iP(hone|ad|od)/.test(ua) || touchMac;
      } catch (_) { return false; }
    }

    _allDocumentAudioSources() {
      const out = new Set();
      const push = (commands) => {
        if (!Array.isArray(commands)) return;
        commands.forEach((c) => {
          if (!c?.src) return;
          const action = c.action || 'play';
          if (action === 'play' || action === 'start') out.add(String(c.src));
        });
      };
      (this.document?.scenes || []).forEach((scene) => push(scene?.audio));
      push(this.document?.ending?.audio);
      return Array.from(out);
    }

    _resolveCoreAudioSrc(src) {
      let value = String(src || '').trim();
      if (!value) return value;
      if (/^[A-Za-z0-9_-]{20,}$/.test(value) && !value.includes('.') && !value.includes('/')) {
        value = `https://scene-studio-api.a-hako.workers.dev/asset/${encodeURIComponent(value)}`;
      }
      return value;
    }

    _collectIOSMediaBankSpecs() {
      const specs = new Map();
      if (!this.document) return specs;
      const add = (channel, src) => {
        const value = this._resolveCoreAudioSrc(src);
        if (!value || !(channel === 'bgm' || channel === 'ambient' || channel === 'oneshot')) return;
        const key = `${channel}:${value}`;
        if (!specs.has(key)) specs.set(key, { key, channel, src: value });
      };
      const scan = (commands) => {
        if (!Array.isArray(commands)) return;
        commands.forEach((command) => {
          if (!command?.src) return;
          const action = command.action || 'play';
          if (!(action === 'play' || action === 'start')) return;
          add(command.channel, command.src);
        });
      };
      (this.document.scenes || []).forEach((scene) => scan(scene?.audio));
      // V2.18: Ending SE must use the SAME source-stable iOS one-shot bank as
      // Scene SE. Scene one-shots are now proven audible on iPhone, while the
      // old dedicated ending element could remain authorized yet still produce
      // silence at finish(). Resolve and prime the ending source with the rest
      // of the document so finish() only seeks/unmutes an already-running bank
      // element and never depends on a special late transport.
      scan(this.document?.ending?.audio);
      return specs;
    }

    _disposeIOSMediaBank() {
      if (!this._iosAudioBank) return;
      this._iosAudioBank.forEach((entry) => {
        if (!entry?.audio) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        try { entry.audio.pause(); } catch (_) {}
        try { entry.sourceNode?.disconnect(); } catch (_) {}
        try { entry.gainNode?.disconnect(); } catch (_) {}
        entry.sourceNode = null; entry.gainNode = null; entry.useGain = false;
        try { entry.audio.removeAttribute('src'); entry.audio.load(); } catch (_) {}
      });
      this._iosAudioBank.clear();
      this._iosBankPrimed = false;
      this._iosPersistentEntry = { bgm: null, ambient: null };
    }

    _ensureIOSBankGain(entry) {
      if (!entry?.audio || !(entry.channel === 'bgm' || entry.channel === 'ambient')) return null;
      if (!this._isCorsWebAudioAsset(entry.src)) return null;
      if (entry.gainNode) return entry.gainNode;
      const ctx = this._ensureAudioContext();
      if (!ctx) return null;
      try {
        const source = ctx.createMediaElementSource(entry.audio);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(ctx.destination);
        entry.sourceNode = source;
        entry.gainNode = gain;
        entry.useGain = true;
        try { entry.audio.volume = 1; } catch (_) {}
        emit(this.host, 'sceneplayer:iosmediabankgainready', { channel:entry.channel, src:entry.src, contextState:ctx.state });
        return gain;
      } catch (error) {
        entry.useGain = false;
        emit(this.host, 'sceneplayer:iosmediabankgainerror', { channel:entry.channel, src:entry.src, error });
        return null;
      }
    }

    _prepareIOSMediaBank() {
      if (!this._iosStableMediaBank || !this.document) return false;
      this._disposeIOSMediaBank();
      const specs = this._collectIOSMediaBankSpecs();
      specs.forEach((spec) => {
        const audio = this._createAudioElement(`ios-bank-${spec.channel}-${this._iosAudioBank.size + 1}`);
        // Never route this bank through createMediaElementSource on iOS. The
        // native media path is the only path that device tracing proved audible.
        audio.__spNativeOnly = true;
        audio.__spTransportSrc = spec.src;
        audio.__spLoadedSrc = spec.src;
        // Stable A-Hako BGM/Ambient may use a GainNode for real fades on iPhone,
        // where HTMLMediaElement.volume can be volume-locked. The source never
        // changes after this point, avoiding the old WebKit src-swap silence bug.
        if ((spec.channel === 'bgm' || spec.channel === 'ambient') && this._isCorsWebAudioAsset(spec.src)) {
          try { audio.crossOrigin = 'anonymous'; } catch (_) {}
        } else {
          try { audio.crossOrigin = null; } catch (_) {}
        }
        try { audio.preload = 'auto'; audio.playsInline = true; audio.loop = true; } catch (_) {}
        try { audio.muted = true; audio.volume = 0; } catch (_) {}
        audio.src = spec.src;
        try { audio.load(); } catch (_) {}
        this._iosAudioBank.set(spec.key, {
          ...spec,
          audio,
          active: false,
          targetVolume: 1,
          timer: null,
          primed: false,
          sourceNode: null,
          gainNode: null,
          useGain: false
        });
      });
      this._iosAudioBank.forEach((entry) => this._ensureIOSBankGain(entry));
      emit(this.host, 'sceneplayer:iosmediabankready', { count: this._iosAudioBank.size });
      return true;
    }

    _primeIOSMediaBank() {
      if (!this._iosStableMediaBank || !this._iosAudioBank?.size) return Promise.resolve(false);
      // IMPORTANT: every play() call is issued synchronously before the first
      // await/microtask, while START/AUTO still owns the trusted iOS gesture.
      const jobs = [];

      // Prime the dedicated ending SE FIRST. Large works can contain many audio
      // elements and iPhone may suspend later background media sessions. Keeping
      // the final SE on its own element and authorizing it before the Scene bank
      // makes manual and AUTO endings use the same already-running element.
      if (this.endingAudio?.src) {
        try {
          this.endingAudio.loop = true;
          this.endingAudio.muted = true;
          this.endingAudio.volume = 1;
          if (this.endingAudio.ended) this.endingAudio.currentTime = 0;
          const endingPrime = this.endingAudio.paused ? this.endingAudio.play() : null;
          if (endingPrime?.then) jobs.push(endingPrime.then(() => { this.endingAudio.__spPrimed = true; return true; }).catch((error) => { this.endingAudio.__spPrimed = false; emit(this.host,'sceneplayer:endingaudioprimeblocked',{src:this.endingAudio.src,error}); return false; }));
          else this.endingAudio.__spPrimed = !this.endingAudio.paused;
        } catch (error) { emit(this.host,'sceneplayer:endingaudioprimeblocked',{src:this.endingAudio.src,error}); }
      }
      this._iosAudioBank.forEach((entry) => {
        const audio = entry.audio;
        if (!audio) return;
        // START calls this before Scene 1 is rendered. AUTO may call it later
        // while Scene audio is already active; never mute/reset an active source.
        if (!entry.active) {
          try { audio.loop = true; audio.muted = true; audio.volume = entry.gainNode ? 1 : 0; } catch (_) {}
          if (entry.gainNode && this.audioContext) {
            try { entry.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime); } catch (_) { entry.gainNode.gain.value = 0; }
          }
          try { if (audio.ended) audio.currentTime = 0; } catch (_) {}
        }
        let result;
        try { result = audio.paused ? audio.play() : null; }
        catch (error) {
          emit(this.host, 'sceneplayer:iosmediabankblocked', { channel: entry.channel, src: entry.src, error });
          jobs.push(Promise.resolve(false));
          return;
        }
        if (result && typeof result.then === 'function') {
          jobs.push(result.then(() => {
            entry.primed = true;
            emit(this.host, 'sceneplayer:iosmediabankprimed', { channel: entry.channel, src: entry.src });
            return true;
          }).catch((error) => {
            entry.primed = false;
            emit(this.host, 'sceneplayer:iosmediabankblocked', { channel: entry.channel, src: entry.src, error });
            return false;
          }));
        } else {
          entry.primed = !audio.paused;
          jobs.push(Promise.resolve(entry.primed));
        }
      });
      this._iosBankPrimed = true;
      return Promise.allSettled(jobs).then(() => true);
    }

    _iosAudioSrcAliases(src) {
      const value = String(src || '').trim();
      const out = new Set();
      if (!value) return out;
      out.add(value);
      // Public Player normally hydrates bare R2 ids to /asset/<id>, but ending
      // audio can pass through a different shell/update path. Treat the raw id
      // and its public asset URL as the same source so the START-authorized bank
      // is always reused at finish().
      if (/^[A-Za-z0-9_-]{20,}$/.test(value) && !value.includes('.') && !value.includes('/')) {
        out.add(`https://scene-studio-api.a-hako.workers.dev/asset/${encodeURIComponent(value)}`);
      } else {
        try {
          const u = new URL(value, global.location?.href || undefined);
          const m = u.pathname.match(/\/asset\/([^/?#]+)$/);
          if (m?.[1]) out.add(decodeURIComponent(m[1]));
        } catch (_) {}
      }
      return out;
    }

    _iosBankEntry(channel, src) {
      if (!this._iosStableMediaBank) return null;
      const aliases = this._iosAudioSrcAliases(src);
      for (const alias of aliases) {
        const hit = this._iosAudioBank?.get(`${channel}:${alias}`);
        if (hit) return hit;
      }
      // Last-resort alias scan handles a bank built before/after public source
      // hydration without creating a new late-playing HTMLAudioElement.
      for (const entry of this._iosAudioBank?.values?.() || []) {
        if (entry?.channel !== channel) continue;
        const entryAliases = this._iosAudioSrcAliases(entry.src);
        for (const alias of aliases) if (entryAliases.has(alias)) return entry;
      }
      return null;
    }

    _setIOSBankEntryVolume(entry, target, duration = 0, done) {
      if (!entry?.audio) { if (done) done(); return; }
      const audio = entry.audio;
      const to = clamp(asNumber(target, entry.targetVolume ?? 1), 0, 1);
      entry.targetVolume = to;
      const ms = Math.max(0, asNumber(duration, 0));

      // iPhone media elements can be :volume-locked. For stable A-Hako
      // BGM/Ambient sources, route the already-authorized element through one
      // persistent GainNode. This restores authored 10s+ fades without changing
      // src or issuing a late play().
      const gain = entry.gainNode;
      const ctx = this.audioContext;
      if (gain && ctx) {
        const now = ctx.currentTime;
        const from = Number.isFinite(gain.gain.value) ? gain.gain.value : 0;
        try {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(from, now);
          if (ms > 0) gain.gain.linearRampToValueAtTime(to, now + ms / 1000);
          else gain.gain.setValueAtTime(to, now);
        } catch (_) { gain.gain.value = to; }
        if (done) { if (ms > 0) this._audioTimeout(done, ms); else done(); }
        return;
      }

      const from = clamp(asNumber(audio.volume, 0), 0, 1);
      if (!ms) {
        try { audio.volume = to; } catch (_) {}
        if (done) done();
        return;
      }
      const started = performance.now();
      const step = (now) => {
        const t = clamp((now - started) / ms, 0, 1);
        try { audio.volume = from + (to - from) * t; } catch (_) {}
        if (t < 1) requestAnimationFrame(step);
        else if (done) done();
      };
      requestAnimationFrame(step);
    }

    _silenceIOSBankEntry(entry, reset = false) {
      if (!entry?.audio) return;
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      entry.active = false;
      if (entry.gainNode && this.audioContext) {
        try { entry.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime); entry.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime); } catch (_) { entry.gainNode.gain.value = 0; }
        try { entry.audio.volume = 1; entry.audio.muted = true; entry.audio.loop = true; } catch (_) {}
      } else {
        try { entry.audio.volume = 0; entry.audio.muted = true; entry.audio.loop = true; } catch (_) {}
      }
      if (reset) { try { entry.audio.currentTime = 0; } catch (_) {} }
    }

    _scheduleIOSOneShotSilence(entry, command, startAt) {
      if (!entry?.audio) return;
      if (entry.timer) clearTimeout(entry.timer);
      const schedule = () => {
        const audio = entry.audio;
        let ms = Math.max(0, asNumber(command.stopAfter, 0));
        if (!(ms > 0) && command.stopAt != null) {
          ms = Math.max(0, (Math.max(0, asNumber(command.stopAt, 0)) - startAt) * 1000);
        }
        if (!(ms > 0) && Number.isFinite(audio.duration) && audio.duration > startAt) {
          ms = Math.max(30, (audio.duration - startAt) * 1000 - 20);
        }
        // Keep the authorized element PLAYING forever; only silence it. Pausing
        // here would require a future Safari play() permission on a repeated SE.
        if (!(ms > 0)) ms = 1500;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          this._silenceIOSBankEntry(entry, true);
        }, ms);
      };
      if (Number.isFinite(entry.audio.duration) && entry.audio.duration > 0) schedule();
      else entry.audio.addEventListener('loadedmetadata', schedule, { once: true });
    }

    _activateIOSBankEntry(entry, options = {}) {
      if (!entry?.audio) return false;
      const audio = entry.audio;
      const startAt = Math.max(0, asNumber(options.startAt, 0));
      const target = this.muted ? 0 : clamp(asNumber(options.target, 1), 0, 1);
      const fadeIn = Math.max(0, asNumber(options.fadeIn, 0));
      const seek = options.seek !== false;

      // V2.16: source-stable media is already PLAYING from START. The pop was
      // produced by seek + unmute happening in the same instant. Keep it muted
      // while seeking, establish zero gain first, then open the gate only after
      // WebKit has settled the seek. On current iOS versions volume ramps are
      // honoured when applied after this gate; on older versions this still
      // removes the hard seek transient even if volume is system-controlled.
      try { audio.loop = true; audio.muted = true; audio.volume = entry.gainNode ? 1 : 0; } catch (_) {}
      if (entry.gainNode && this.audioContext) {
        try { entry.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime); entry.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime); } catch (_) { entry.gainNode.gain.value = 0; }
      }
      if (seek) { try { audio.currentTime = startAt; } catch (_) {} }
      entry.active = true;
      entry.targetVolume = target;

      if (audio.paused) {
        try { const p = audio.play(); if (p?.catch) p.catch(() => {}); } catch (_) {}
      }

      let opened = false;
      const openGate = () => {
        if (opened || !entry.active) return;
        opened = true;
        try { audio.volume = entry.gainNode ? 1 : 0; audio.muted = this.muted; } catch (_) {}
        if (this.muted) return;
        if (fadeIn > 0) this._setIOSBankEntryVolume(entry, target, fadeIn);
        else this._setIOSBankEntryVolume(entry, target, 0);
      };

      if (seek && typeof audio.addEventListener === 'function') {
        const onSeeked = () => openGate();
        audio.addEventListener('seeked', onSeeked, { once: true });
        // Some cached MP3s do not emit seeked for a 0 -> 0 assignment. Keep a
        // short fallback, still long enough to avoid exposing the seek click.
        this._audioTimeout(openGate, 45);
      } else {
        this._audioTimeout(openGate, 16);
      }
      return true;
    }

    _playIOSBankOneShot(command) {
      const entry = this._iosBankEntry('oneshot', command?.src);
      if (!entry?.audio) return false;
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      const startAt = Math.max(0, asNumber(command.startAt, 0));
      const target = this.muted ? 0 : clamp(asNumber(command.volume, 1), 0, 1);
      const fadeIn = Math.max(0, asNumber(command.fadeIn, 0));
      this._activateIOSBankEntry(entry, { startAt, target, fadeIn, seek:true });
      this._scheduleIOSOneShotSilence(entry, command, startAt);
      emit(this.host, 'sceneplayer:audioplaystarted', { channel:'oneshot', role:command.role || 'se', action:'play', src:command.src, transport:'ios-live-media-bank' });
      emit(this.host, 'sceneplayer:oneshot', { command, transport:'ios-live-media-bank' });
      return true;
    }

    _startIOSBankPersistent(channel, command, reconstruct = false, forceSeek = false) {
      const entry = this._iosBankEntry(channel, command?.src);
      if (!entry?.audio) return false;
      const previous = this._iosPersistentEntry?.[channel];
      if (previous && previous !== entry) this._silenceIOSBankEntry(previous, false);
      const audio = entry.audio;
      const sameSrc = this.audioState[channel]?.src === command.src;
      const shouldSeek = forceSeek || !sameSrc || (!reconstruct && command.restart === true);
      const startAt = Math.max(0, asNumber(command.startAt, 0));
      const target = this.muted ? 0 : clamp(asNumber(command.volume, 1), 0, 1);
      const fadeIn = reconstruct ? 0 : Math.max(0, asNumber(command.fadeIn, 0));
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      entry.active = true;
      entry.targetVolume = target;
      this._iosPersistentEntry[channel] = entry;
      this._activateIOSBankEntry(entry, {
        startAt,
        target,
        fadeIn,
        seek: shouldSeek
      });
      this.audioState[channel] = {
        src: command.src,
        volume: target,
        loop: command.loop !== false,
        startAt,
        stopAt: command.stopAt == null ? null : Math.max(0, asNumber(command.stopAt, 0)),
        fadeOut: Math.max(0, asNumber(command.fadeOut, 0))
      };
      const stopAfter = Math.max(0, asNumber(command.stopAfter, 0));
      if (stopAfter > 0) entry.timer = setTimeout(() => this._stopPersistentChannel(channel, command.fadeOut || 0), stopAfter);
      else if (command.loop === false) {
        const schedule = () => {
          const remain = Math.max(0, (audio.duration - Math.max(0, audio.currentTime || startAt)) * 1000 - 20);
          if (remain > 0) entry.timer = setTimeout(() => this._stopPersistentChannel(channel, command.fadeOut || 0), remain);
        };
        if (Number.isFinite(audio.duration) && audio.duration > 0) schedule();
        else audio.addEventListener('loadedmetadata', schedule, { once:true });
      }
      emit(this.host, 'sceneplayer:audioplaystarted', { channel, action:'start', src:command.src, transport:'ios-live-media-bank' });
      emit(this.host, 'sceneplayer:audiostart', { channel, command, reconstruct, transport:'ios-live-media-bank' });
      return true;
    }

    _preloadAudioBuffer(src) {
      const key = String(src || '').trim();
      if (!key || !this._iosBufferAudio) return Promise.resolve(null);
      if (this._bufferAudioCache.has(key)) return Promise.resolve(this._bufferAudioCache.get(key));
      if (this._bufferAudioPromises.has(key)) return this._bufferAudioPromises.get(key);
      const ctx = this._ensureAudioContext();
      if (!ctx || typeof fetch !== 'function') return Promise.resolve(null);
      const job = fetch(key, { mode: 'cors', credentials: 'omit' })
        .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.arrayBuffer(); })
        .then((bytes) => new Promise((resolve, reject) => {
          try {
            const cloned = bytes.slice(0);
            const maybe = ctx.decodeAudioData(cloned, resolve, reject);
            if (maybe && typeof maybe.then === 'function') maybe.then(resolve).catch(reject);
          } catch (e) { reject(e); }
        }))
        .then((buffer) => {
          this._bufferAudioCache.set(key, buffer);
          emit(this.host, 'sceneplayer:audiobufferready', { src: key, duration: buffer?.duration || 0 });
          return buffer;
        })
        .catch((error) => {
          emit(this.host, 'sceneplayer:audiobuffererror', { src: key, error });
          return null;
        })
        .finally(() => this._bufferAudioPromises.delete(key));
      this._bufferAudioPromises.set(key, job);
      return job;
    }

    _preloadDocumentAudioBuffers() {
      if (!this._iosBufferAudio) return Promise.resolve(false);
      const sources = this._allDocumentAudioSources();
      if (!sources.length) return Promise.resolve(true);
      return Promise.allSettled(sources.map((src) => this._preloadAudioBuffer(src))).then(() => true);
    }

    _fadeBufferGain(gainNode, target, duration = 0) {
      const ctx = this.audioContext;
      if (!ctx || !gainNode) return;
      const t = ctx.currentTime;
      const current = Number.isFinite(gainNode.gain.value) ? gainNode.gain.value : 1;
      try {
        gainNode.gain.cancelScheduledValues(t);
        gainNode.gain.setValueAtTime(current, t);
        if (duration > 0) gainNode.gain.linearRampToValueAtTime(target, t + duration / 1000);
        else gainNode.gain.setValueAtTime(target, t);
      } catch (_) { gainNode.gain.value = target; }
    }

    _playBufferedOneShot(command) {
      if (!this._iosBufferAudio || !command?.src) return false;
      const buffer = this._bufferAudioCache.get(String(command.src));
      const ctx = this._ensureAudioContext();
      if (!buffer || !ctx || ctx.state !== 'running') return false;
      try {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        source.loop = command.loop === true;
        const target = this.muted ? 0 : clamp(asNumber(command.volume, 1), 0, 1);
        const fadeIn = Math.max(0, asNumber(command.fadeIn, 0));
        gain.gain.value = fadeIn > 0 ? 0 : target;
        source.connect(gain); gain.connect(ctx.destination);
        const startAt = Math.max(0, asNumber(command.startAt, 0));
        source.start(0, Math.min(startAt, Math.max(0, buffer.duration - 0.001)));
        if (fadeIn > 0) this._fadeBufferGain(gain, target, fadeIn);
        const record = { source, gain, command };
        this._bufferOneShots.add(record);
        const cleanup = () => { this._bufferOneShots.delete(record); try { source.disconnect(); gain.disconnect(); } catch (_) {} };
        source.onended = cleanup;
        const stopAfter = Math.max(0, asNumber(command.stopAfter, 0));
        if (stopAfter > 0) this._audioTimeout(() => { try { source.stop(); } catch (_) {} }, stopAfter);
        if (command.stopAt != null) {
          const stopAt = Math.max(0, asNumber(command.stopAt, 0));
          const remain = Math.max(0, stopAt - startAt) * 1000;
          if (remain > 0) this._audioTimeout(() => { try { source.stop(); } catch (_) {} }, remain);
        }
        emit(this.host, 'sceneplayer:audioplaystarted', { channel:'oneshot', role:command.role || 'se', action:'play', src:command.src, transport:'audio-buffer' });
        emit(this.host, 'sceneplayer:oneshot', { command });
        return true;
      } catch (error) {
        emit(this.host, 'sceneplayer:audiobufferplayerror', { channel:'oneshot', src:command.src, error });
        return false;
      }
    }

    _stopBufferedPersistent(channel, fadeOut = 0) {
      const rec = this._bufferPersistent?.[channel];
      if (!rec) return false;
      const stop = () => {
        try { rec.source.stop(); } catch (_) {}
        try { rec.source.disconnect(); rec.gain.disconnect(); } catch (_) {}
        if (this._bufferPersistent[channel] === rec) this._bufferPersistent[channel] = null;
      };
      if (fadeOut > 0) { this._fadeBufferGain(rec.gain, 0, fadeOut); this._audioTimeout(stop, fadeOut + 20); }
      else stop();
      return true;
    }

    _startBufferedPersistent(channel, command, reconstruct = false, forceSeek = false) {
      if (!this._iosBufferAudio || !command?.src) return false;
      const buffer = this._bufferAudioCache.get(String(command.src));
      const ctx = this._ensureAudioContext();
      if (!buffer || !ctx || ctx.state !== 'running') return false;
      const existing = this._bufferPersistent[channel];
      const sameSrc = existing?.src === command.src;
      if (sameSrc && reconstruct && channel === 'bgm' && !forceSeek) return true;
      if (existing) this._stopBufferedPersistent(channel, 0);
      try {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        source.buffer = buffer;
        source.loop = command.loop !== false;
        const target = this.muted ? 0 : clamp(asNumber(command.volume, 1), 0, 1);
        const fadeIn = reconstruct ? 0 : Math.max(0, asNumber(command.fadeIn, 0));
        gain.gain.value = fadeIn > 0 ? 0 : target;
        source.connect(gain); gain.connect(ctx.destination);
        const startAt = Math.max(0, asNumber(command.startAt, 0));
        source.start(0, Math.min(startAt, Math.max(0, buffer.duration - 0.001)));
        if (fadeIn > 0) this._fadeBufferGain(gain, target, fadeIn);
        const rec = { source, gain, src: command.src, volume: target, command };
        this._bufferPersistent[channel] = rec;
        source.onended = () => { if (this._bufferPersistent[channel] === rec) this._bufferPersistent[channel] = null; };
        const stopAfter = Math.max(0, asNumber(command.stopAfter, 0));
        if (stopAfter > 0) this._audioTimeout(() => this._stopBufferedPersistent(channel, command.fadeOut || 0), stopAfter);
        if (command.stopAt != null) {
          const stopAt = Math.max(0, asNumber(command.stopAt, 0));
          const remain = Math.max(0, stopAt - startAt) * 1000;
          if (remain > 0) this._audioTimeout(() => this._stopBufferedPersistent(channel, command.fadeOut || 0), remain);
        }
        this.audioState[channel] = { src:command.src, volume:target, loop:command.loop !== false, startAt, stopAt:command.stopAt ?? null, fadeOut:Math.max(0, asNumber(command.fadeOut,0)) };
        emit(this.host, 'sceneplayer:audioplaystarted', { channel, action:'start', src:command.src, transport:'audio-buffer' });
        emit(this.host, 'sceneplayer:audiostart', { channel, command, reconstruct, transport:'audio-buffer' });
        return true;
      } catch (error) {
        emit(this.host, 'sceneplayer:audiobufferplayerror', { channel, src:command.src, error });
        return false;
      }
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
              // Do NOT pre-connect idle BGM/Ambient elements here.
              // iOS/WebKit can successfully resolve media.play() after a later
              // src swap while producing silence if that element was already
              // bound to createMediaElementSource(). Let the REAL source start
              // first in _safePlay(), then attach its GainNode there.
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

        // AUTO priming leaves the element muted on purpose. Real playback must
        // unmute synchronously before play(), otherwise WebKit may report
        // "started" while the authorized element remains inaudible.
        try { audio.muted = false; } catch (_) {}
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
          // Manual reading can retry a blocked sound on the next trusted tap.
          // AUTO has no future trusted taps, so globally disarming playback here
          // would make every BGM / Ambient / SE after the first rejection silent.
          // In AUTO, skip only the blocked item and leave the transport armed so
          // later commands still get a chance to play.
          const retryable = detail?.channel !== 'oneshot' && detail?.channel !== 'ending';
          if (!this.auto && retryable) {
            this.audioPlaybackArmed = false;
            this.audioPending.push(() => this._safePlay(audio, detail, onStarted));
          }
          // SE is an event. Never replay a blocked Scene SE on the NEXT tap;
          // doing so made Scene 1 SE overlap Scene 2's own SE.
          emit(this.host, 'sceneplayer:audioblocked', { ...detail, error, auto: this.auto });
          return;
        }
        if (promise && typeof promise.then === 'function') {
          promise.then(finishStart).catch((error) => {
            const retryable = detail?.channel !== 'oneshot' && detail?.channel !== 'ending';
            if (!this.auto && retryable) {
              this.audioPlaybackArmed = false;
              this.audioPending.push(() => this._safePlay(audio, detail, onStarted));
            }
            emit(this.host, 'sceneplayer:audioblocked', { ...detail, error, auto: this.auto });
          });
        } else finishStart();
      };
      this._queueAudio(play);
    }


    _collectFutureAudioSources() {
      const sources = { bgm: '', ambient: '', oneshot: [] };
      if (!this.document) return sources;
      const seen = new Set();
      const scenes = Array.isArray(this.document.scenes) ? this.document.scenes : [];
      for (let i = Math.max(0, this.index); i < scenes.length; i += 1) {
        const commands = Array.isArray(scenes[i]?.audio) ? scenes[i].audio : [];
        for (const command of commands) {
          if (!command?.src) continue;
          const action = command.action || 'play';
          if (!(action === 'play' || action === 'start')) continue;
          if (command.channel === 'bgm' && !sources.bgm) sources.bgm = command.src;
          else if (command.channel === 'ambient' && !sources.ambient) sources.ambient = command.src;
          else if (command.channel === 'oneshot' && !seen.has(command.src)) {
            seen.add(command.src);
            sources.oneshot.push(command.src);
          }
        }
      }
      const ending = Array.isArray(this.document?.ending?.audio) ? this.document.ending.audio : [];
      for (const command of ending) {
        if (command?.channel !== 'oneshot' || !command.src || seen.has(command.src)) continue;
        const action = command.action || 'play';
        if (!(action === 'play' || action === 'start')) continue;
        seen.add(command.src);
        sources.oneshot.push(command.src);
      }
      return sources;
    }

    _primeMediaElement(audio, src = '') {
      if (!audio || audio.__spInUse || audio.__spPriming || !audio.paused) return Promise.resolve(true);

      // AUTO on iPhone needs each future HTMLMediaElement to have been started
      // once by the AUTO button gesture. Prime the ACTUAL source on the SAME
      // stable element while muted, await the play(), then pause it BEFORE any
      // AUTO timer is scheduled. Because we wait for every prime to settle,
      // no delayed pause can race with the real Scene playback.
      const targetSrc = String(src || audio.__spLoadedSrc || '').trim();
      if (!targetSrc) return Promise.resolve(true);
      const token = (audio.__spPrimeToken || 0) + 1;
      audio.__spPrimeToken = token;
      audio.__spPriming = true;
      audio.__spAuthorized = false;
      try {
        audio.pause();
        audio.loop = false;
        // Keep priming off the Web Audio graph. The real source is connected
        // only after its audible play() succeeds.
        if (this.audioSourceNodes.has(audio) || this.audioGainNodes.has(audio)) {
          // A graph-bound element is source-stable; never repurpose it.
          audio.__spPriming = false;
          return Promise.resolve(audio.__spLoadedSrc === targetSrc);
        }
        this._prepareAudioTransport(audio, targetSrc);
        if (audio.src !== targetSrc && audio.currentSrc !== targetSrc) {
          audio.src = targetSrc;
          try { audio.load(); } catch (_) {}
        }
        audio.__spLoadedSrc = targetSrc;
        try { audio.muted = true; } catch (_) {}
        const promise = audio.play();
        return Promise.resolve(promise).then(() => {
          if (audio.__spPrimeToken !== token) return true;
          try { audio.pause(); } catch (_) {}
          try { audio.currentTime = 0; } catch (_) {}
          audio.__spPriming = false;
          audio.__spAuthorized = true;
          emit(this.host, 'sceneplayer:audioprimed', { src: targetSrc, channel: audio.dataset.scenePlayerChannel || '' });
          return true;
        }).catch((error) => {
          if (audio.__spPrimeToken === token) audio.__spPriming = false;
          emit(this.host, 'sceneplayer:audioprimeblocked', { src: targetSrc, channel: audio.dataset.scenePlayerChannel || '', error });
          return false;
        });
      } catch (error) {
        if (audio.__spPrimeToken === token) audio.__spPriming = false;
        emit(this.host, 'sceneplayer:audioprimeblocked', { src: targetSrc, channel: audio.dataset.scenePlayerChannel || '', error });
        return Promise.resolve(false);
      }
    }

    _oneShotElementForSource(src) {
      const targetSrc = String(src || '').trim();
      if (!targetSrc) return null;
      // Once an Audio element is routed through MediaElementSource on iOS,
      // changing its src can yield play()=resolved but SILENT audio. Pin each
      // reusable one-shot element to one source instead of recycling it across
      // Scene SE / ending SE files.
      let audio = this.oneshotPool.find((item) => item && item.__spLoadedSrc === targetSrc && !item.__spInUse && !item.__spPriming && item.paused);
      if (!audio) {
        audio = this.oneshotPool.find((item) => item && !item.__spLoadedSrc && !item.__spInUse && !item.__spPriming && item.paused);
      }
      if (!audio) {
        audio = this._createAudioElement(`oneshot-${this.oneshotPool.length + 1}`);
        audio.__spInUse = false;
        audio.__spPriming = false;
        audio.__spAuthorized = false;
        this.oneshotPool.push(audio);
      }
      if (!audio.__spLoadedSrc) audio.__spLoadedSrc = targetSrc;
      return audio;
    }

    _primeFutureAudioPlayback(options = {}) {
      if (!this.document || !this.audioUnlocked || !this.audioPlaybackArmed) return Promise.resolve(false);
      const primePersistent = options.persistent !== false;
      const sources = this._collectFutureAudioSources();
      const jobs = [];

      if (primePersistent) {
        if (sources.bgm && this.audioEls?.bgm?.paused) jobs.push(this._primeMediaElement(this.audioEls.bgm, sources.bgm));
        if (sources.ambient && this.audioEls?.ambient?.paused) jobs.push(this._primeMediaElement(this.audioEls.ambient, sources.ambient));
      }

      for (const src of sources.oneshot) {
        const audio = this._oneShotElementForSource(src);
        if (audio && !audio.__spInUse && !audio.__spPriming && audio.paused) jobs.push(this._primeMediaElement(audio, src));
      }

      return Promise.allSettled(jobs).then(() => true);
    }

    _acquireOneShotElement(src = '') {
      const audio = this._oneShotElementForSource(src);
      if (!audio) return null;
      audio.__spPrimeToken = (audio.__spPrimeToken || 0) + 1;
      audio.__spPriming = false;
      audio.__spInUse = true;
      return audio;
    }

    _stopPersistentChannel(channel, fadeOut = 0) {
      if (this._iosStableMediaBank) {
        const entry = this._iosPersistentEntry?.[channel];
        if (entry) {
          const finish = () => { this._silenceIOSBankEntry(entry, true); if (this._iosPersistentEntry[channel] === entry) this._iosPersistentEntry[channel] = null; this.audioState[channel] = null; emit(this.host, 'sceneplayer:audiostop', { channel, transport:'ios-live-media-bank' }); };
          if (fadeOut > 0 && entry.active) this._setIOSBankEntryVolume(entry, 0, fadeOut, finish);
          else finish();
        } else this.audioState[channel] = null;
        return;
      }
      if (this._bufferPersistent?.[channel]) { this._stopBufferedPersistent(channel, fadeOut); this.audioState[channel] = null; return; }
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
      if (this._iosStableMediaBank && this._startIOSBankPersistent(channel, command, reconstruct, forceSeek)) return;
      if (this._startBufferedPersistent(channel, command, reconstruct, forceSeek)) return;
      let audio = this.audioEls[channel];
      if (!audio || !command.src) return;
      audio.__spPrimeToken = (audio.__spPrimeToken || 0) + 1;
      audio.__spPriming = false;

      const desiredNativeOnly = this._isExternalHttpAudio(command.src) && !this._isCorsWebAudioAsset(command.src);
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
      if (this._iosStableMediaBank) {
        const entry = this._iosPersistentEntry?.[channel];
        if (!entry || !this.audioState[channel]) return;
        const target = this.muted ? 0 : clamp(asNumber(command.volume, this.audioState[channel].volume), 0, 1);
        this.audioState[channel].volume = target; entry.targetVolume = target;
        this._setIOSBankEntryVolume(entry, target, Math.max(0, asNumber(command.fade, 0)));
        emit(this.host, 'sceneplayer:audiovolume', { channel, volume: target, transport:'ios-live-media-bank' });
        return;
      }
      const buffered = this._bufferPersistent?.[channel];
      if (buffered) {
        const target = this.muted ? 0 : clamp(asNumber(command.volume, buffered.volume ?? 1), 0, 1);
        buffered.volume = target;
        if (this.audioState[channel]) this.audioState[channel].volume = target;
        this._fadeBufferGain(buffered.gain, target, Math.max(0, asNumber(command.fade, 0)));
        emit(this.host, 'sceneplayer:audiovolume', { channel, volume: target, transport:'audio-buffer' });
        return;
      }
      const audio = this.audioEls[channel];
      if (!audio || !this.audioState[channel]) return;
      const target = clamp(asNumber(command.volume, this.audioState[channel].volume), 0, 1);
      this.audioState[channel].volume = target;
      this._fadeVolume(audio, target, Math.max(0, asNumber(command.fade, 0)), channel);
      emit(this.host, 'sceneplayer:audiovolume', { channel, volume: target });
    }

    _duckPersistentChannel(channel, command) {
      if (this._iosStableMediaBank) {
        const entry = this._iosPersistentEntry?.[channel];
        const state = this.audioState[channel];
        if (!entry || !state) return;
        const restore = state.volume;
        const target = clamp(asNumber(command.volume, 0.22), 0, 1);
        const fade = Math.max(0, asNumber(command.fade, 250));
        const hold = Math.max(0, asNumber(command.hold, 1200));
        this._setIOSBankEntryVolume(entry, target, fade);
        this._audioTimeout(() => this._setIOSBankEntryVolume(entry, this.muted ? 0 : restore, fade), fade + hold);
        emit(this.host, 'sceneplayer:audioduck', { channel, volume: target, hold, transport:'ios-live-media-bank' });
        return;
      }
      const buffered = this._bufferPersistent?.[channel];
      if (buffered) {
        const restore = buffered.volume ?? 1;
        const target = clamp(asNumber(command.volume, 0.22), 0, 1);
        const fade = Math.max(0, asNumber(command.fade, 250));
        const hold = Math.max(0, asNumber(command.hold, 1200));
        this._fadeBufferGain(buffered.gain, target, fade);
        this._audioTimeout(() => this._fadeBufferGain(buffered.gain, restore, fade), fade + hold);
        emit(this.host, 'sceneplayer:audioduck', { channel, volume: target, hold, transport:'audio-buffer' });
        return;
      }
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
      if (this._iosStableMediaBank && this._playIOSBankOneShot(command)) return;
      if (this._playBufferedOneShot(command)) return;
      const audio = this._acquireOneShotElement(command.src);
      if (!audio) return;
      this._prepareAudioTransport(audio, command.src);
      if (audio.src !== command.src && audio.currentSrc !== command.src) {
        // This should only happen on a fresh, not-yet-graph-bound element.
        audio.src = command.src;
        audio.__spLoadedSrc = command.src;
        try { audio.load(); } catch (_) {}
      }
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
        audio.__spInUse = false;
        audio.loop = false;
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
      this.oneshots.forEach((audio) => {
        try { audio.pause(); } catch (_) {}
        audio.__spInUse = false;
        audio.loop = false;
      });
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
      if (this._iosStableMediaBank) {
        this._iosAudioBank?.forEach((entry) => this._silenceIOSBankEntry(entry, true));
        this._iosPersistentEntry = { bgm:null, ambient:null };
        this.audioState = { bgm:null, ambient:null };
      }
      ['bgm', 'ambient'].forEach((channel) => this._stopPersistentChannel(channel, 0));
      Array.from(this._bufferOneShots || []).forEach((rec) => { try { rec.source.stop(); } catch (_) {} });
      if (this._bufferOneShots) this._bufferOneShots.clear();
      this.oneshots.forEach((audio) => {
        try { audio.pause(); } catch (_) {}
        audio.__spInUse = false;
        audio.loop = false;
      });
      this.oneshots.clear();
      (this.oneshotPool || []).forEach((audio) => {
        try { audio.pause(); } catch (_) {}
        audio.__spPrimeToken = (audio.__spPrimeToken || 0) + 1;
        audio.__spPriming = false;
        audio.__spInUse = false;
        audio.loop = false;
      });
      if (resetPending) this.audioPending.length = 0;
    }

    // Graceful shell/cover exit. Public Player calls this before replacing or
    // hiding Core; previously that API did not exist, so audio stayed at full
    // volume until destroy() and ended with an audible hard cut.
    fadeOutAudio(duration = 700) {
      const ms = Math.max(0, asNumber(duration, 700));
      this._clearAudioTimers();

      if (this._iosStableMediaBank) {
        this._iosAudioBank?.forEach((entry) => {
          if (!entry?.active || !entry.audio || entry.audio.muted) return;
          this._setIOSBankEntryVolume(entry, 0, ms, () => this._silenceIOSBankEntry(entry, false));
        });
        return true;
      }

      ['bgm', 'ambient'].forEach((channel) => {
        const buffered = this._bufferPersistent?.[channel];
        if (buffered) {
          this._fadeBufferGain(buffered.gain, 0, ms);
          this._audioTimeout(() => this._stopBufferedPersistent(channel, 0), ms + 20);
          return;
        }
        const audio = this.audioEls[channel];
        if (!audio || audio.paused) return;
        const key = `exit:${channel}`;
        this._fadeVolume(audio, 0, ms, key, () => {
          try { audio.pause(); } catch (_) {}
          this.audioState[channel] = null;
        });
      });

      Array.from(this._bufferOneShots || []).forEach((rec) => {
        this._fadeBufferGain(rec.gain, 0, ms);
        this._audioTimeout(() => { try { rec.source.stop(); } catch (_) {} }, ms + 20);
      });
      Array.from(this.oneshots).forEach((audio, i) => {
        if (!audio || audio.paused) return;
        const key = `exit:oneshot:${i}:${Date.now()}`;
        this._fadeVolume(audio, 0, ms, key, () => {
          try { audio.pause(); } catch (_) {}
          this.oneshots.delete(audio);
        });
      });

      if (!ms) this.audioPending.length = 0;
      emit(this.host, 'sceneplayer:audiofadeout', { duration: ms });
      return ms;
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
      this._endingAudioStarted = false;

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
      this.playbackTimelineStartedAt = 0;
      this.document = assertSceneDocument(doc);

      // iOS: build a source-stable native-media bank now. Actual play() calls
      // happen together in the trusted START gesture in _beginFromCover().
      if (this._iosStableMediaBank) this._prepareIOSMediaBank();

      // Preload Ending SE only. Playback waits for the final trusted press.
      try {
        this.endingAudio.pause();
        this.endingAudio.removeAttribute('src');
        const endingCommand = (Array.isArray(this.document?.ending?.audio) ? this.document.ending.audio : [])
          .find((command) => command?.channel === 'oneshot' && command?.src && ['play','start'].includes(command.action || 'play'));
        if (endingCommand?.src) {
          const endingSrc = this._resolveCoreAudioSrc(endingCommand.src);
          this.endingAudio.__spPrimed = false;
          this.endingAudio.__spLoadedSrc = endingSrc;
          this.endingAudio.src = endingSrc;
          this.endingAudio.preload = 'auto';
          this.endingAudio.loop = true;
          this.endingAudio.muted = true;
          try { this.endingAudio.load(); } catch (_) {}
        }
      } catch (_) {}

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
      this.backgroundMotionEpoch = 0;
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
        // A completed reading can leave the swipe/click guard armed on iOS.
        // Returning to Cover starts a genuinely fresh input session.
        this.suppressNextClick = false;
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
        const viewportWidth=Math.max(1,Number(this.host?.clientWidth)||Number(global.innerWidth)||1),viewportHeight=Math.max(1,Number(this.host?.clientHeight)||Number(global.innerHeight)||1),coverDevice=Math.min(viewportWidth,viewportHeight)<=600?'phone':viewportWidth>=1100?'pc':'tablet';
        this.els.coverBg.style.backgroundPosition=cover.positions?.[coverDevice]||cover.position||'center center';
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
      // Cover -> Scene 1 must always re-arm navigation as well as audio.
      // Without this reset a synthetic click suppressed at the end of the first
      // read could consume the first input of the second read and leave the
      // restarted Player apparently frozen while Scene 1 SE still played.
      this.suppressNextClick = false;
      this.ended = false;
      this._endingAudioStarted = false;
      this.unlockAudio(true);
      // V2.15 iOS: authorize EVERY real source synchronously from this START
      // gesture and keep the elements silently playing. Scene changes merely
      // seek/unmute those already-authorized elements.
      if (this._iosStableMediaBank) this._primeIOSMediaBank();
      this.els.cover.hidden=true;
      this.host.classList.remove('sp-cover-open');
      // Treat the first render after the cover as a fresh load so Scene 1
      // one-shot SE is queued/played from the same trusted start gesture.
      // `restore` only reconstructs persistent BGM/Ambient and intentionally
      // skips one-shots, which made Scene 1 SE silent.
      this._audioRenderMode='load';
      this.playbackTimelineStartedAt=performance.now();
      this._render();
      emit(this.host,'sceneplayer:coverstart',{document:this.document,index:this.index,at:this.playbackTimelineStartedAt});
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
      this._endingAudioStarted = false;

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

    _playEndingAudio() {
      if (this._endingAudioStarted) return false;
      const commands = Array.isArray(this.document?.ending?.audio) ? this.document.ending.audio : [];
      const playable = commands.filter((command) => command?.channel === 'oneshot' && command?.src && ['play','start'].includes(command.action || 'play'));
      if (!playable.length) return false;
      this._endingAudioStarted = true;

      // V2.18 iOS: use exactly the same live-media one-shot bank that already
      // works for Scene 1 / Scene 2 SE. The ending source was added to that bank
      // during load() and primed in the trusted START/AUTO gesture, so finish()
      // performs only seek + gate-open on an already-playing stable element.
      if (this._iosStableMediaBank) {
        const command = {
          ...playable[0],
          src: this._resolveCoreAudioSrc(playable[0].src),
          action: 'play',
          role: 'ending-se'
        };
        if (this._playIOSBankOneShot(command)) return true;

        // Keep the dedicated element only as a diagnostic last resort. It is no
        // longer the primary iPhone path because device testing showed that its
        // muted long-running playback could stay silent when reopened at ending.
        emit(this.host, 'sceneplayer:endingbankmiss', { src: command.src });
      }

      playable.forEach((item) => this._playOneShot({
        ...item,
        src: this._resolveCoreAudioSrc(item.src),
        action: 'play',
        role: 'ending-se'
      }));
      return true;
    }

    finish() {
      if (!this.document || this.ended) return;
      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this.ended = true;
      this.els.ending.classList.remove('is-visible');
      this.els.ending.hidden = false;
      this._playEndingAudio();

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
      if (this._iosStableMediaBank) {
        this._iosAudioBank?.forEach((entry) => {
          if (!entry?.audio) return;
          try { entry.audio.muted = this.muted || !entry.active; } catch (_) {}
          if (entry.gainNode && this.audioContext && (this.muted || !entry.active)) {
            try { entry.gainNode.gain.setValueAtTime(0, this.audioContext.currentTime); } catch (_) { entry.gainNode.gain.value = 0; }
          }
          if (!this.muted && entry.active) this._setIOSBankEntryVolume(entry, entry.targetVolume ?? 1, 0);
        });
      }
      Object.values(this.audioEls || {}).forEach((audio) => {
        try { audio.muted = this.muted; } catch (_) {}
      });
      this.oneshots.forEach((audio) => {
        try { audio.muted = this.muted; } catch (_) {}
      });
      Object.values(this._bufferPersistent || {}).forEach((rec) => {
        if (rec?.gain) this._fadeBufferGain(rec.gain, this.muted ? 0 : (rec.volume ?? 1), 0);
      });
      (this._bufferOneShots || []).forEach((rec) => {
        const vol = clamp(asNumber(rec?.command?.volume, 1), 0, 1);
        if (rec?.gain) this._fadeBufferGain(rec.gain, this.muted ? 0 : vol, 0);
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
      this.unlockAudio(true);
      this.auto = true;
      this.els.auto.classList.add('is-on');
      this.els.auto.setAttribute('aria-pressed', 'true');

      // Current Scene audio is already in its proper manual state. Before AUTO
      // timers take over, silently authorize the stable BGM/Ambient/SE elements
      // that future Scenes will need. Do not schedule Scene advancement until
      // those synchronous-gesture play() attempts have settled.
      const prime = this._iosStableMediaBank
        ? this._primeIOSMediaBank()
        : (this._iosBufferAudio ? this._preloadDocumentAudioBuffers() : this._primeFutureAudioPlayback());
      Promise.resolve(prime).finally(() => {
        if (!this.auto || this.ended) return;
        this._scheduleAuto();
      });
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
      const cue=asNumber(this.currentScene.cueAt,NaN);
      if(!this.playbackTimelineStartedAt)this.playbackTimelineStartedAt=performance.now()-(Number.isFinite(cue)?Math.max(0,cue):0);
      const nextCue=asNumber(this.document?.scenes?.[this.index+1]?.cueAt,NaN);
      const pause=Math.max(0,asNumber(this.currentScene.pause,this.options.autoDelay));
      const targetElapsed=Number.isFinite(nextCue)?Math.max(0,nextCue):(Number.isFinite(cue)?Math.max(0,cue)+pause:NaN);
      const delay=Number.isFinite(targetElapsed)?Math.max(0,(this.playbackTimelineStartedAt+targetElapsed)-performance.now()):pause;
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.index >= this.document.scenes.length - 1) {
          // V2.19: open the already-primed ending-SE bank entry while AUTO's
          // audio session is still fully active. finish() then only changes UI.
          this._playEndingAudio();
          this.finish();
        } else this.next();
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

    _measureSceneGeometry(node, stageRect) {
      node.classList.add('sp-layout-measuring');
      const nodeRect=node.getBoundingClientRect();
      const boxHeight=Math.max(1,nodeRect.height);
      const text=node.querySelector('.sp-text');
      const frame=node.querySelector('.sp-handdrawn-frame');
      const vertical=text?.dataset?.writingMode==='vertical-rl';
      let inkLeft=0,inkRight=Math.max(1,nodeRect.width),inkTop=0,inkBottom=boxHeight;
      const contentRects=[];
      const addElementRect=(element)=>{
        if(!element)return;
        const rect=element.getBoundingClientRect();
        if(rect.width>0&&rect.height>0)contentRects.push(rect);
      };
      const addTextRects=(element)=>{
        if(!element)return;
        try{
          const range=document.createRange();
          range.selectNodeContents(element);
          const rects=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0);
          range.detach?.();
          if(rects.length)contentRects.push(...rects);else addElementRect(element);
        }catch(_){addElementRect(element);}
      };

      // Measure the complete painted Scene. Previously only the main text or
      // frame participated in stack placement, so subtext and foreground
      // images could occupy the landing space reserved for the next Scene.
      const chatRow=node.querySelector(':scope > .sp-chat-row');
      if(chatRow){
        addElementRect(chatRow);
      }else{
        if(frame)addElementRect(frame);else addTextRects(text);
        addTextRects(node.querySelector(':scope > .sp-subtext'));
        addElementRect(node.querySelector(':scope > .sp-sound-mark'));
      }
      addElementRect(node.querySelector(':scope > .sp-scene-image > .sp-scene-image-media')||node.querySelector(':scope > .sp-scene-image'));
      if(contentRects.length){
        inkLeft=Math.min(...contentRects.map(rect=>rect.left))-nodeRect.left;
        inkRight=Math.max(...contentRects.map(rect=>rect.right))-nodeRect.left;
        inkTop=Math.min(...contentRects.map(rect=>rect.top))-nodeRect.top;
        inkBottom=Math.max(...contentRects.map(rect=>rect.bottom))-nodeRect.top;
      }
      const inkHeight=Math.max(1,inkBottom-inkTop);
      const height=vertical?Math.min(boxHeight,Math.max(48,Math.min(stageRect.height*.52,inkHeight+8))):boxHeight;
      node.classList.remove('sp-layout-measuring');
      return {height,inkLeft,inkRight,inkTop,inkBottom,inkCenterX:(inkLeft+inkRight)/2,inkCenterY:(inkTop+inkBottom)/2};
    }

    _framePosition(scene) {
      const common=scene?.presentation?.text?.position||scene?.presentation?.frame?.position||{};
      const viewportWidth=Math.max(1,Number(this.host?.clientWidth)||Number(global.innerWidth)||1);
      const source=viewportWidth>=1100&&common?.pc&&typeof common.pc==='object'?common.pc:common;
      const preset=String(source.preset||'auto');
      const presets={
        'top-left':[.18,.18],top:[.5,.18],'top-right':[.82,.18],
        left:[.18,.5],center:[.5,.5],right:[.82,.5],
        'bottom-left':[.18,.82],bottom:[.5,.82],'bottom-right':[.82,.82]
      };
      if(preset==='custom'){
        const x=Number(source.x),y=Number(source.y);
        return {preset,x:Number.isFinite(x)?Math.max(0,Math.min(1,x)):.5,y:Number.isFinite(y)?Math.max(0,Math.min(1,y)):.5};
      }
      if(presets[preset])return {preset,x:presets[preset][0],y:presets[preset][1]};
      return {preset:'auto'};
    }

    _customPositionTransform(item, position, stageWidth, stageHeight, margin) {
      const contentWidth=Math.max(1,item.node.clientWidth||item.node.getBoundingClientRect().width);
      const contentLeft=Math.max(0,(stageWidth-contentWidth)/2);
      const width=item.inkRight-item.inkLeft,height=item.inkBottom-item.inkTop;
      const centerX=width+margin*2>=stageWidth?stageWidth/2:Math.max(width/2+margin,Math.min(stageWidth-width/2-margin,stageWidth*position.x));
      const centerY=height+margin*2>=stageHeight?stageHeight/2:Math.max(height/2+margin,Math.min(stageHeight-height/2-margin,stageHeight*position.y));
      return {x:centerX-contentLeft-item.inkCenterX,y:centerY-item.inkCenterY};
    }

    _measureCarriedOverlayPositions(metrics, sceneEntries, stageWidth, stageHeight, focusY, extraGap = 0) {
      const margin=stageWidth<=600?10:16;
      const positions=metrics.map(item=>{
        const position=this._framePosition(item.scene);
        let x=0,y=focusY-item.inkCenterY-(item.scene.type==='dialogue'?12:0);
        if(position.preset!=='auto'){
          ({x,y}=this._customPositionTransform(item,position,stageWidth,stageHeight,margin));
        }
        return {x,y};
      });
      const groups=[];
      metrics.forEach((item,i)=>{const attach=i>0&&(item.scene?.presentation?.display||'stack')==='overlay';if(attach&&groups.length)groups[groups.length-1].push(i);else groups.push([i]);});
      const bounds=indices=>{const left=Math.min(...indices.map(i=>positions[i].x+metrics[i].inkLeft)),right=Math.max(...indices.map(i=>positions[i].x+metrics[i].inkRight)),top=Math.min(...indices.map(i=>positions[i].y+metrics[i].inkTop)),bottom=Math.max(...indices.map(i=>positions[i].y+metrics[i].inkBottom));return {left,right,top,bottom,centerX:(left+right)/2,centerY:(top+bottom)/2};};
      for(let g=groups.length-2;g>=0;g-=1){
        const current=groups[g],next=groups[g+1],currentBounds=bounds(current),nextBounds=bounds(next),currentLast=metrics[current[current.length-1]],nextFirst=metrics[next[0]],flow=nextFirst.scene?.presentation?.flow==='horizontal'?'horizontal':'vertical';
        let dx=0,dy=0;
        if(flow==='horizontal'){const gap=Math.max(this._sceneGap(currentLast.scene,nextFirst.scene),stageWidth*.09)+extraGap,verticalReading=nextFirst.scene?.presentation?.text?.writingMode==='vertical-rl';dx=verticalReading?nextBounds.right+gap-currentBounds.left:nextBounds.left-gap-currentBounds.right;dy=nextBounds.centerY-currentBounds.centerY;}
        else{const eitherVertical=currentLast.scene?.presentation?.text?.writingMode==='vertical-rl'||nextFirst.scene?.presentation?.text?.writingMode==='vertical-rl',gap=this._sceneGap(currentLast.scene,nextFirst.scene)+(eitherVertical?Math.max(28,Math.min(56,stageHeight*.05)):0)+extraGap;dx=0;dy=nextBounds.top-gap-currentBounds.bottom;}
        current.forEach(i=>{positions[i].x+=dx;positions[i].y+=dy;});
      }
      metrics.forEach((item,i)=>{item.node.style.visibility='';item.node.style.zIndex=String(20+i);});
      return metrics.map((item,i)=>({...item,...positions[i]}));
    }

    _measureScenePositions(nodes, sceneEntries, extraGap = 0) {
      if (!nodes.length) return [];
      const stageRect = this.els.stage.getBoundingClientRect();
      const stageHeight = stageRect.height;
      const stageWidth = Math.max(1,this.els.stage.clientWidth||stageRect.width);
      const focusRatio = global.innerWidth <= 600 ? this.options.focusYMobile : this.options.focusYDesktop;
      const focusY = stageHeight * focusRatio;

      const metrics = nodes.map((node, i) => ({
        node,
        scene: sceneEntries[i].scene,
        index: sceneEntries[i].index,
        ...this._measureSceneGeometry(node,stageRect)
      }));
      metrics.forEach(item=>{item.node.style.visibility='';item.node.style.zIndex='';});

      if(metrics.some((item,i)=>i>0&&(item.scene?.presentation?.display||'stack')==='overlay')){
        return this._measureCarriedOverlayPositions(metrics,sceneEntries,stageWidth,stageHeight,focusY,extraGap);
      }

      const newest = metrics[metrics.length - 1];
      let newestTop = focusY - newest.inkCenterY;
      if (newest.scene.type === 'dialogue') newestTop -= 12;

      const positions = new Array(metrics.length);
      positions[metrics.length - 1] = {x:0,y:newestTop};

      for (let i = metrics.length - 2; i >= 0; i -= 1) {
        const current = metrics[i];
        const next = metrics[i + 1];
        const nextPosition=positions[i+1];
        const flow=next.scene?.presentation?.flow==='horizontal'?'horizontal':'vertical';
        const eitherVertical=current.scene?.presentation?.text?.writingMode==='vertical-rl'||next.scene?.presentation?.text?.writingMode==='vertical-rl';
        if(flow==='horizontal'){
          const gap=Math.max(this._sceneGap(current.scene,next.scene),stageRect.width*.09)+extraGap;
          const verticalReading=next.scene?.presentation?.text?.writingMode==='vertical-rl';
          positions[i]={
            x:verticalReading
              ? nextPosition.x+next.inkRight+gap-current.inkLeft
              : nextPosition.x+next.inkLeft-gap-current.inkRight,
            y:nextPosition.y+next.inkCenterY-current.inkCenterY
          };
        }else{
          const verticalGap=eitherVertical?Math.max(28,Math.min(56,stageHeight*.05)):0;
          const gap=this._sceneGap(current.scene,next.scene)+verticalGap+extraGap;
          const ownPosition=this._framePosition(current.scene);
          const ownX=ownPosition.preset==='auto'?0:this._customPositionTransform(current,ownPosition,stageWidth,stageHeight,global.innerWidth<=600?10:16).x;
          positions[i]={x:ownX,y:nextPosition.y+next.inkTop-gap-current.inkBottom};
        }
      }

      const currentFrame=newest.node.querySelector('.sp-handdrawn-frame');
      if(currentFrame&&metrics.length>1)metrics.slice(0,-2).forEach(item=>{item.node.style.visibility='hidden';});
      if(currentFrame&&metrics.length>1&&this._framePosition(newest.scene).preset==='auto'){
        const previous=metrics[metrics.length-2];
        const previousFrame=previous.node.querySelector('.sp-handdrawn-frame');
        if(previousFrame){
          const flow=newest.scene?.presentation?.flow==='horizontal'?'horizontal':'vertical';
          const gap=global.innerWidth<=600?14:24;
          const currentWidth=newest.inkRight-newest.inkLeft;
          const previousWidth=previous.inkRight-previous.inkLeft;
          const currentHeight=newest.inkBottom-newest.inkTop;
          const previousHeight=previous.inkBottom-previous.inkTop;
          const availableWidth=Math.max(1,newest.node.getBoundingClientRect().width);
          const availableHeight=stageHeight*.86;
          const margin=global.innerWidth<=600?10:16;
          previous.node.style.visibility='';
          previous.node.style.zIndex='20';
          newest.node.style.zIndex='30';
          if(flow==='horizontal'){
            const verticalReading=newest.scene?.presentation?.text?.writingMode==='vertical-rl';
            const fits=currentWidth+previousWidth+gap<=availableWidth-margin*2;
            const groupWidth=currentWidth+previousWidth+gap;
            const groupLeft=(availableWidth-groupWidth)/2;
            const currentLeft=fits?(verticalReading?groupLeft:groupLeft+previousWidth+gap):(verticalReading?margin:availableWidth-margin-currentWidth);
            const previousLeft=fits?(verticalReading?groupLeft+currentWidth+gap:groupLeft):(verticalReading?availableWidth-margin-previousWidth:margin);
            const centerY=stageHeight*.48;
            positions[metrics.length-1]={x:currentLeft-newest.inkLeft,y:centerY-newest.inkCenterY};
            positions[metrics.length-2]={x:previousLeft-previous.inkLeft,y:centerY-previous.inkCenterY};
          }else{
            const fits=currentHeight+previousHeight+gap<=availableHeight;
            const groupHeight=currentHeight+previousHeight+gap;
            const groupTop=(stageHeight-groupHeight)/2;
            const previousTop=fits?groupTop:margin;
            const currentTop=fits?groupTop+previousHeight+gap:stageHeight-margin-currentHeight;
            positions[metrics.length-2]={x:availableWidth/2-previous.inkCenterX,y:previousTop-previous.inkTop};
            positions[metrics.length-1]={x:availableWidth/2-newest.inkCenterX,y:currentTop-newest.inkTop};
          }
        }
      }

      metrics.forEach((item,i)=>{
        if(i!==metrics.length-1)return;
        if(!item.node.querySelector(':scope > .sp-text, :scope > .sp-handdrawn-frame'))return;
        const position=this._framePosition(item.scene);
        if(position.preset==='auto')return;
        const margin=global.innerWidth<=600?10:16;
        positions[i]=this._customPositionTransform(item,position,stageWidth,stageHeight,margin);
      });

      if(currentFrame&&metrics.length>1){
        const previous=metrics[metrics.length-2],previousFrame=previous.node.querySelector('.sp-handdrawn-frame');
        previous.node.style.zIndex='20';newest.node.style.zIndex='30';
        if(previousFrame&&this._framePosition(newest.scene).preset!=='auto'&&this._framePosition(previous.scene).preset==='auto'){
          const availableWidth=Math.max(1,newest.node.getBoundingClientRect().width),margin=global.innerWidth<=600?10:16,flow=newest.scene?.presentation?.flow==='horizontal'?'horizontal':'vertical';
          if(flow==='horizontal'){
            const verticalReading=newest.scene?.presentation?.text?.writingMode==='vertical-rl',previousWidth=previous.inkRight-previous.inkLeft,previousLeft=verticalReading?availableWidth-margin-previousWidth:margin;
            positions[metrics.length-2]={x:previousLeft-previous.inkLeft,y:positions[metrics.length-1].y+newest.inkCenterY-previous.inkCenterY};
          }else positions[metrics.length-2]={x:availableWidth/2-previous.inkCenterX,y:margin-previous.inkTop};
        }
      }

      return metrics.map((item, i) => ({ ...item, ...positions[i] }));
    }

    _positionSceneNodes(nodes, sceneEntries, extraGap = 0) {
      const measured = this._measureScenePositions(nodes, sceneEntries, extraGap);
      measured.forEach(({ node, x, y }) => {
        node.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
      });
      return measured;
    }

    _positionOverlayNodes(nodes, sceneEntries) {
      if (!nodes.length) return [];
      const stageRect = this.els.stage.getBoundingClientRect();
      const stageWidth=Math.max(1,this.els.stage.clientWidth||stageRect.width),stageHeight=Math.max(1,this.els.stage.clientHeight||stageRect.height);
      const focusY = stageHeight * (stageWidth <= 520 ? .48 : .46);
      return nodes.map((node, i) => {
        const geometry=this._measureSceneGeometry(node,stageRect);
        const position=node.querySelector(':scope > .sp-text, :scope > .sp-handdrawn-frame')?this._framePosition(sceneEntries[i]?.scene):{preset:'auto'};
        let x=0,y=focusY-Math.max(1,node.getBoundingClientRect().height)/2;
        if(position.preset!=='auto'){
          ({x,y}=this._customPositionTransform({...geometry,node},position,stageWidth,stageHeight,global.innerWidth<=600?10:16));
        }
        node.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
        node.style.zIndex = String(20 + i);
        return { node, scene: sceneEntries[i]?.scene, x, y, height: geometry.height };
      });
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
          newestCreated.style.transform = `translate3d(${Math.round(newestMetric.x)}px,${Math.round(newestMetric.y)}px,0)`;
          newestCreated.style.opacity = '0';
          newestCreated.style.filter = 'none';
        }

        requestAnimationFrame(() => {
          // Previous text may still move into its new stack position. The incoming
          // still Scene is deliberately excluded from every geometry transition.
          final.forEach(({node,x,y}) => {
            if (node === newestCreated) return;
            node.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
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
        if ((active?.presentation?.display || 'stack') === 'overlay') this._positionOverlayNodes(nodes, visible);
        else this._positionSceneNodes(nodes, visible, this.options.whitespaceBreath);

        // Jump/Shino wait two frames before retargeting to the final geometry.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.host.classList.remove('sp-whitespace-inhale');
            this.host.classList.add('sp-whitespace-exhale');

            // Same transform clock for both previous and current text.
            if ((active?.presentation?.display || 'stack') === 'overlay') this._positionOverlayNodes(nodes, visible);
            else this._positionSceneNodes(nodes, visible, 0);

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
      const isForwardStack = this._audioRenderMode === 'advance' && (display === 'stack' || display === 'overlay');

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
        if (display === 'overlay') this._positionOverlayNodes(nodes, visible);
        else this._positionSceneNodes(nodes, visible, 0);
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
      this.host.dataset.sceneFlow = active.presentation?.flow==='horizontal'?'horizontal':'vertical';
      this.host.dataset.writingMode = active.presentation?.text?.writingMode==='vertical-rl'?'vertical-rl':'horizontal-tb';

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

      if (display === 'overlay') {
        let start = this.index;
        while (start > 0 && (scenes[start - 1].presentation?.display || 'stack') === 'overlay') start -= 1;
        // Keep one preceding Scene as the visual base, then accumulate overlay Scenes on it.
        if (start > 0) start -= 1;
        start = Math.max(start, this.index - this.options.maxStackVisible + 1);
        return scenes.slice(start, this.index + 1).map((scene, offset) => ({ scene, index: start + offset }));
      }

      if (scenes[this.index]?.presentation?.flow === 'horizontal') {
        const start=Math.max(0,this.index-1);
        return scenes.slice(start,this.index+1).map((scene,offset)=>({scene,index:start+offset}));
      }

      // A previous solo scene resets the visual stack, but that solo Scene itself
      // becomes the new base. Later `stack` Scenes must build on top of it.
      let start = 0;
      for (let i = this.index - 1; i >= 0; i -= 1) {
        if (scenes[i].presentation?.flow === 'horizontal') {
          start = i;
          break;
        }
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
      const exit = sceneBg?.exit || 'auto';
      const srcChanged = !previous || previous.src !== next.src;
      const nextMotion = next.motion;
      const carryMotion = nextMotion?.continuity === 'carry'
        && previous?.motion?.type === nextMotion?.type
        && this.backgroundMotionEpoch > 0;
      const motionPhase = carryMotion ? Math.max(0, performance.now() - this.backgroundMotionEpoch) : 0;
      if (nextMotion?.type && nextMotion.type !== 'none' && !carryMotion) this.backgroundMotionEpoch = performance.now();
      if (!nextMotion || nextMotion.type === 'none') this.backgroundMotionEpoch = 0;

      this._resetBackgroundRuntime();
      this.backgroundState = next;
      const leavingBackground = Boolean(previous?.src) && !next.src && srcChanged;
      // Keep the outgoing layer drawable until its exit animation completes.
      this.host.classList.toggle('sp-has-background', Boolean(next.src) || leavingBackground);

      if (srcChanged) this._swapBackground(next, transition, exit, motionPhase, leavingBackground);
      else this._styleCurrentBackground(next, Boolean(sceneBg?.motion), motionPhase);

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

    _swapBackground(state, transition, exit = 'auto', motionPhase = 0, clearHostAfter = false) {
      const current = this._currentBackgroundLayer();
      const incoming = this._nextBackgroundLayer();
      const transitionDuration=Math.min(10000,Math.max(0,asNumber(state.transitionDuration,700)));
      incoming.style.setProperty('--sp-bg-transition-duration',`${transitionDuration}ms`);
      current.style.setProperty('--sp-bg-transition-duration',`${transitionDuration}ms`);
      this._prepareBackgroundLayer(incoming, state, motionPhase);

      const mode = ['fade','cut','flash','glitch'].includes(transition) ? transition : 'fade';
      this.host.dataset.bgTransition = mode;
      incoming.classList.add('is-current');
      current.classList.remove('is-current');
      this._applyBackgroundExit(current, exit, transitionDuration);

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
      this._styleCurrentBackground(state, true, motionPhase);
      const hasCustomExit=!['auto','fade'].includes(exit);
      this._backgroundTimeout(() => {
        current.style.backgroundImage = '';
        current.className = current.classList.contains('sp-bg-a') ? 'sp-bg-layer sp-bg-a' : 'sp-bg-layer sp-bg-b';
        if(clearHostAfter) this.host.classList.remove('sp-has-background');
      }, mode === 'cut' && !hasCustomExit ? 20 : transitionDuration+120);
    }

    _prepareBackgroundLayer(layer, state, motionPhase = 0) {
      layer.getAnimations?.().forEach(animation=>animation.cancel());
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
      this._applyBackgroundMotion(layer, state.motion, motionPhase);
    }

    _styleCurrentBackground(state, resetMotion, motionPhase = 0) {
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
      if (resetMotion) this._applyBackgroundMotion(layer, state.motion, motionPhase);
    }

    _applyBackgroundExit(layer, exit, duration) {
      const type=['auto','fade','dark','light','blur','zoomOut','zoomIn','afterimage'].includes(exit)?exit:'auto';
      if(type==='auto'||type==='fade'||duration<=0||!layer?.animate)return;
      const computed=getComputedStyle(layer);
      const transform=computed.transform==='none'?'scale(1.001)':computed.transform;
      const filter=computed.filter==='none'?'':computed.filter;
      const addFilter=value=>`${filter} ${value}`.trim();
      let frames=[{opacity:computed.opacity||1,transform,filter:filter||'none'},{opacity:0,transform,filter:filter||'none'}];
      if(type==='dark')frames[1]={opacity:0,transform,filter:addFilter('brightness(0)')};
      if(type==='light')frames[1]={opacity:0,transform:`${transform} scale(1.015)`,filter:addFilter('brightness(2) blur(2px)')};
      if(type==='blur')frames[1]={opacity:0,transform:`${transform} scale(1.025)`,filter:addFilter('blur(14px)')};
      if(type==='zoomOut')frames[1]={opacity:0,transform:`${transform} scale(.94)`,filter:addFilter('blur(1px)')};
      if(type==='zoomIn')frames[1]={opacity:0,transform:`${transform} scale(1.09)`,filter:addFilter('blur(1px)')};
      if(type==='afterimage')frames=[
        {offset:0,opacity:computed.opacity||1,transform,filter:filter||'none'},
        {offset:.22,opacity:.92,transform:`${transform} scale(1.008)`,filter:addFilter('brightness(1.75) contrast(1.15)')},
        {offset:1,opacity:0,transform:`${transform} scale(1.025)`,filter:addFilter('brightness(.55) blur(5px)')}
      ];
      layer.animate(frames,{duration:Math.max(120,duration),easing:'cubic-bezier(.37,0,.63,1)',fill:'forwards'});
    }

    _applyBackgroundMotion(layer, motion, motionPhase = 0) {
      layer.classList.remove('sp-motion-parallax','sp-motion-breath','sp-motion-slowZoom','sp-motion-zoomOut','sp-motion-panLeft','sp-motion-panRight','sp-motion-panUp','sp-motion-panDown','sp-motion-panUpLeft','sp-motion-panUpRight','sp-motion-panDownLeft','sp-motion-panDownRight');
      layer.style.removeProperty('--sp-bg-duration');
      layer.style.removeProperty('--sp-bg-scale-from');
      layer.style.removeProperty('--sp-bg-scale-to');
      layer.style.removeProperty('--sp-bg-pan');
      layer.style.removeProperty('--sp-bg-delay');
      if (!motion || !motion.type || motion.type === 'none') return;
      const type = ['parallax','breath','slowZoom','zoomOut','panLeft','panRight','panUp','panDown','panUpLeft','panUpRight','panDownLeft','panDownRight'].includes(motion.type) ? motion.type : null;
      if (!type) return;
      layer.classList.add(`sp-motion-${type}`);
      const defaultDuration = type === 'breath' ? 4200 : 6500;
      const defaultFrom = type === 'slowZoom' ? 1.0 : (type === 'zoomOut' ? 1.08 : 1.06);
      const defaultTo = type === 'slowZoom' ? 1.14 : (type === 'zoomOut' ? 1 : (type === 'breath' ? 1.11 : 1.08));
      const duration=Math.max(250,asNumber(motion.duration,defaultDuration));
      layer.style.setProperty('--sp-bg-duration', `${duration}ms`);
      layer.style.setProperty('--sp-bg-scale-from', String(asNumber(motion.scaleFrom, defaultFrom)));
      layer.style.setProperty('--sp-bg-scale-to', String(asNumber(motion.scaleTo, defaultTo)));
      layer.style.setProperty('--sp-bg-pan', `${asNumber(motion.pan, 9)}%`);
      if(motionPhase>0){
        const phase=(type==='breath'||type==='parallax')?motionPhase%duration:Math.min(motionPhase,duration);
        layer.style.setProperty('--sp-bg-delay',`${-phase}ms`);
      }
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
          if (nodes.length === visible.length) {
            if(display==='overlay')this._positionOverlayNodes(nodes,visible);
            else this._positionSceneNodes(nodes,visible,0);
          }
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

    _handdrawnSeed(source) {
      let hash=2166136261;
      const value=String(source||'');
      for(let i=0;i<value.length;i++){
        hash^=value.charCodeAt(i);
        hash=Math.imul(hash,16777619);
      }
      return hash>>>0;
    }

    _handdrawnRandom(seed) {
      let state=seed>>>0;
      return ()=>{
        state=(Math.imul(state,1664525)+1013904223)>>>0;
        return state/4294967296;
      };
    }

    _handdrawnPath(width,height,seed,trace=0,shapeLevel=0,frameType='handdrawn-voice') {
      const random=this._handdrawnRandom((seed+Math.imul(trace+1,2654435761))>>>0);
      const inset=5.5+trace*.35;
      const rx=Math.max(8,(width-inset*2)/2);
      const ry=Math.max(8,(height-inset*2)/2);
      const cx=width/2+(random()-.5)*1.8;
      const cy=height/2+(random()-.5)*1.8;
      const count=32;
      const phase=random()*Math.PI*2;
      const points=[];
      for(let i=0;i<count;i++){
        const angle=(Math.PI*2*i/count)-Math.PI/2;
        const ca=Math.cos(angle),sa=Math.sin(angle);
        const n=frameType==='handdrawn-voice'?2.05+Math.max(0,Math.min(1,shapeLevel))*2.35:(['handdrawn-rounded','handdrawn-panel'].includes(frameType)?4.7:8.5);
        const baseX=Math.sign(ca)*Math.pow(Math.abs(ca),2/n)*rx;
        const baseY=Math.sign(sa)*Math.pow(Math.abs(sa),2/n)*ry;
        const harmonic=Math.sin(angle*3+phase)*.010+Math.sin(angle*5-phase*.7)*.006;
        const grain=(random()-.5)*.018;
        const wobble=1+harmonic+grain+(trace-1)*.0025;
        points.push({x:cx+baseX*wobble,y:cy+baseY*wobble});
      }
      let d=`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
      for(let i=0;i<count;i++){
        const p0=points[(i-1+count)%count],p1=points[i],p2=points[(i+1)%count],p3=points[(i+2)%count];
        const c1x=p1.x+(p2.x-p0.x)/6;
        const c1y=p1.y+(p2.y-p0.y)/6;
        const c2x=p2.x-(p3.x-p1.x)/6;
        const c2y=p2.y-(p3.y-p1.y)/6;
        d+=` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      }
      return `${d} Z`;
    }

    _mountHanddrawnFrame(frame,scene,presentation) {
      const ns='http://www.w3.org/2000/svg';
      const svg=document.createElementNS(ns,'svg');
      svg.classList.add('sp-handdrawn-frame-svg');
      svg.setAttribute('aria-hidden','true');
      svg.setAttribute('preserveAspectRatio','none');
      const defs=document.createElementNS(ns,'defs');
      const filter=document.createElementNS(ns,'filter');
      const filterId=`sp-ink-bleed-${String(scene.id||'scene').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24)}-${this._handdrawnSeed(scene.text)&65535}`;
      filter.id=filterId;
      filter.setAttribute('x','-5%');filter.setAttribute('y','-5%');filter.setAttribute('width','110%');filter.setAttribute('height','110%');
      const blur=document.createElementNS(ns,'feGaussianBlur');blur.setAttribute('stdDeviation','.72');
      filter.appendChild(blur);defs.appendChild(filter);svg.appendChild(defs);
      const makePath=(className)=>{const path=document.createElementNS(ns,'path');path.classList.add(className);svg.appendChild(path);return path;};
      const fill=makePath('sp-handdrawn-fill');
      const bleed=makePath('sp-handdrawn-bleed');bleed.setAttribute('filter',`url(#${filterId})`);
      const ghost=makePath('sp-handdrawn-ghost');
      const ink=makePath('sp-handdrawn-ink');
      const scuff=makePath('sp-handdrawn-scuff');
      frame.prepend(svg);
      let lastWidth=0,lastHeight=0;
      const draw=()=>{
        if(!frame.isConnected)return;
        const text=frame.querySelector(':scope > .sp-text');
        let fitted=false;
        frame.classList.add('sp-frame-measuring');
        if(text&&frame.dataset.writingMode==='vertical-rl'&&!frame.dataset.inkFitted){
          text.style.maxWidth='none';
          text.style.width='max-content';
          const measureRects=()=>{try{
            const range=document.createRange();
            range.selectNodeContents(text);
            const measured=[...range.getClientRects()].filter(item=>item.width>0&&item.height>0);
            range.detach?.();
            return measured;
          }catch(_){return [];}};
          let rects=measureRects();
          const initialTextRect=text.getBoundingClientRect();
          let inkLeft=rects.length?Math.min(...rects.map(item=>item.left)):initialTextRect.left;
          let inkRight=rects.length?Math.max(...rects.map(item=>item.right)):initialTextRect.right;
          const fittedWidth=Math.ceil(Math.max(text.scrollWidth,inkRight-inkLeft,initialTextRect.width)+2);
          text.style.width=`${fittedWidth}px`;
          rects=measureRects();
          const fittedTextRect=text.getBoundingClientRect();
          inkLeft=rects.length?Math.min(...rects.map(item=>item.left)):fittedTextRect.left;
          inkRight=rects.length?Math.max(...rects.map(item=>item.right)):fittedTextRect.right;
          const inkTop=rects.length?Math.min(...rects.map(item=>item.top)):fittedTextRect.top;
          const inkBottom=rects.length?Math.max(...rects.map(item=>item.bottom)):fittedTextRect.bottom;
          const columns=new Set(rects.map(item=>Math.round(item.left/3)*3)).size||1;
          const charCount=Array.from(String(scene.text||'')).filter(char=>char!=='\n').length;
          const shapeLevel=Math.max(Math.min(1,(columns-1)/3),Math.min(1,Math.max(0,(charCount-18)/58)));
          const mobile=global.innerWidth<=600;
          const padX=(mobile?27:34)+shapeLevel*(mobile?8:12);
          const padY=(mobile?30:38)+shapeLevel*(mobile?13:18);
          const inkWidth=Math.max(1,inkRight-inkLeft),inkHeight=Math.max(1,inkBottom-inkTop);
          text.style.position='absolute';
          text.style.margin='0';
          text.style.height=`${Math.ceil(fittedTextRect.height)}px`;
          text.style.left=`${Math.round(padX-(inkLeft-fittedTextRect.left))}px`;
          text.style.top=`${Math.round(padY-(inkTop-fittedTextRect.top))}px`;
          frame.style.padding='0';
          frame.style.width=`${Math.ceil(inkWidth+padX*2)}px`;
          frame.style.height=`${Math.ceil(inkHeight+padY*2)}px`;
          frame.dataset.shapeLevel=String(shapeLevel);
          frame.dataset.inkFitted='true';
          fitted=true;
        }
        frame.classList.remove('sp-frame-measuring');
        const rect=frame.getBoundingClientRect();
        const width=Math.max(24,Math.round(rect.width*10)/10),height=Math.max(24,Math.round(rect.height*10)/10);
        if(Math.abs(width-lastWidth)<.5&&Math.abs(height-lastHeight)<.5)return;
        lastWidth=width;lastHeight=height;
        svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
        const frameType=frame.dataset.frameType||'handdrawn-voice';
        const seed=this._handdrawnSeed(`${scene.id}|${scene.text}|${Math.round(width)}|${Math.round(height)}|${presentation.text?.writingMode||''}|${frameType}`);
        const shapeLevel=Math.max(0,Math.min(1,Number(frame.dataset.shapeLevel)||0));
        const primary=this._handdrawnPath(width,height,seed,0,shapeLevel,frameType);
        fill.setAttribute('d',primary);ink.setAttribute('d',primary);
        bleed.setAttribute('d',this._handdrawnPath(width,height,seed,1,shapeLevel,frameType));
        ghost.setAttribute('d',this._handdrawnPath(width,height,seed,2,shapeLevel,frameType));
        scuff.setAttribute('d',this._handdrawnPath(width,height,seed,3,shapeLevel,frameType));
        const dashA=26+(seed%17),dashB=3+((seed>>>5)%5),dashC=8+((seed>>>9)%9);
        scuff.setAttribute('stroke-dasharray',`${dashA} ${dashB} ${dashC} ${dashB+2}`);
        scuff.setAttribute('stroke-dashoffset',String(seed%29));
        const article=frame.closest('.sp-scene');
        if(fitted&&article&&!article.classList.contains('entering'))requestAnimationFrame(()=>{
          if(!frame.isConnected||!this.document)return;
          const active=this.document.scenes?.[this.index];
          const display=active?.presentation?.display||'stack';
          const entries=this._visibleScenes(display);
          const byId=new Map([...this.els.scenes.querySelectorAll('.sp-scene')].map(node=>[node.dataset.sceneId,node]));
          const present=entries.map(entry=>({entry,node:byId.get(entry.scene.id)})).filter(item=>item.node);
          const presentNodes=present.map(item=>item.node),presentEntries=present.map(item=>item.entry);
          if(display==='overlay')this._positionOverlayNodes(presentNodes,presentEntries);
          else this._positionSceneNodes(presentNodes,presentEntries,0);
        });
      };
      requestAnimationFrame(draw);
      if(typeof ResizeObserver==='function'){
        const observer=new ResizeObserver(()=>{
          if(!frame.isConnected){observer.disconnect();return;}
          draw();
        });
        observer.observe(frame);
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
      article.dataset.sceneFlow=presentation.flow==='horizontal'?'horizontal':'vertical';
      article.dataset.writingMode=presentation.text?.writingMode==='vertical-rl'?'vertical-rl':'horizontal-tb';
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
          if(String(presentation.frame?.type||'').startsWith('handdrawn-')){
            const frame=document.createElement('div');
            frame.className='sp-handdrawn-frame';frame.dataset.frameType=presentation.frame.type;
            frame.dataset.writingMode=presentation.text?.writingMode==='vertical-rl'?'vertical-rl':'horizontal-tb';
            const align=['left','right'].includes(presentation.text?.align)?presentation.text.align:'center';
            frame.dataset.frameAlign=align;
            const inkColor=String(presentation.text?.color||'').trim().toLowerCase();
            if(!inkColor||inkColor==='white'||inkColor==='#fff'||inkColor==='#ffffff')text.style.color='#171512';
            frame.appendChild(text);
            article.appendChild(frame);
            article.dataset.frame=presentation.frame.type;
            this._mountHanddrawnFrame(frame,scene,presentation);
          }else article.appendChild(text);
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
      const verticalFrame=textStyle?.writingMode==='vertical-rl' && String(scene?.presentation?.frame?.type||'').startsWith('handdrawn-');
      if(verticalFrame){
        if(chars>=74 || lines>=8)return 'tight';
        if(chars>=44 || lines>=6)return 'compact';
        if(chars>=30 || lines>=4)return 'medium';
        if(chars>=22 || lines>=3)return 'soft';
      }
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
      if (Number.isFinite(Number(style.fontWeight))) node.style.fontWeight = String(Math.max(100, Math.min(900, Math.round(Number(style.fontWeight) / 100) * 100)));
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
      if (style.writingMode === 'vertical-rl') {
        const lines=String(node.textContent||'').split('\n');
        const longest=Math.max(1,...lines.map(line=>Array.from(line).length));
        node.dataset.writingMode='vertical-rl';
        node.style.writingMode='vertical-rl';
        node.style.textOrientation='mixed';
        node.style.height=`min(52dvh, ${Math.max(4,Math.min(22,longest+1))*1.15}em)`;
        node.style.textAlign='start';
        const blockAlign=style.align==='left'||style.align==='right'?style.align:'center';
        node.dataset.verticalBlockAlign=blockAlign;
        node.style.marginLeft=blockAlign==='left'?'0':'auto';
        node.style.marginRight=blockAlign==='right'?'0':'auto';
      } else {
        delete node.dataset.writingMode;
        node.style.writingMode='';
        node.style.textOrientation='';
        node.style.height='';
        delete node.dataset.verticalBlockAlign;
        node.style.marginLeft='';
        node.style.marginRight='';
      }
      if (style.writingMode !== 'vertical-rl' && Number.isFinite(Number(style.sideMargin)) && Number(style.sideMargin) > 0) {
        const margin=Math.max(0,Math.min(40,Number(style.sideMargin)));
        node.style.width=`calc(100% - ${margin*2}%)`;
        node.style.maxWidth=`calc(100% - ${margin*2}%)`;
        node.style.marginLeft='auto';
        node.style.marginRight='auto';
      }
      if (style.writingMode !== 'vertical-rl' && (style.align === 'left' || style.align === 'center' || style.align === 'right')) node.style.textAlign = style.align;
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
        const motion = ['up','shatter','explode'].includes(disappear?.motion) ? disappear.motion : 'stay';
        const scope=disappear?.scope==='visible'?'visible':'scene';
        const targets=scope==='visible'
          ? [...this.els.scenes.querySelectorAll('.sp-scene')].filter(node=>node.isConnected&&!node.classList.contains('is-disappeared'))
          : [article];
        targets.forEach(target=>{
        target.style.setProperty('--sp-disappear-fade', `${fade}ms`);
        // Shatter / explode animate the Scene at its CURRENT laid-out position.
        // Their keyframes add relative motion on top of this anchor instead of
        // replacing the stack translate and jumping to the stage origin first.
        if (motion === 'shatter' || motion === 'explode') {
          target.style.setProperty('--sp-disappear-anchor-transform', target.style.transform || 'translate3d(0,0,0)');
        } else {
          target.style.removeProperty('--sp-disappear-anchor-transform');
        }
        target.classList.toggle('is-disappear-up', motion === 'up');
        target.classList.toggle('is-disappear-shatter', motion === 'shatter');
        target.classList.toggle('is-disappear-explode', motion === 'explode');
        target.classList.toggle('is-disappear-stay', motion === 'stay');
        });
        this._presentationTimeout(() => {
          if (!article.isConnected) return;
          targets.forEach(target=>{if(target.isConnected)target.classList.add('is-disappearing');});
          emit(this.host, 'sceneplayer:disappear', { index: this.index, scene, phase: 'start', motion, scope });
          this._presentationTimeout(() => {
            if (!article.isConnected) return;
            targets.forEach(target=>{if(target.isConnected)target.classList.add('is-disappeared');});
            emit(this.host, 'sceneplayer:disappear', { index: this.index, scene, phase: 'end', motion, scope });
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
      const preserveHost = options?.preserveHost === true;
      this.stopAuto();
      this._resetPresentationRuntime();
      this._resetBackgroundRuntime();
      this._stopAllAudio(true);
      if (this.endingAudio) {
        try { this.endingAudio.pause(); } catch (_) {}
        try { this.endingAudio.removeAttribute('src'); this.endingAudio.load(); } catch (_) {}
      }
      this._stopBufferedPersistent('bgm', 0);
      this._stopBufferedPersistent('ambient', 0);
      Array.from(this._bufferOneShots || []).forEach((rec) => { try { rec.source.stop(); } catch (_) {} });
      if (this._bufferOneShots) this._bufferOneShots.clear();
      this._disposeIOSMediaBank();
      if (this.audioContext && typeof this.audioContext.close === 'function') {
        try { this.audioContext.close(); } catch (_) {}
      }
      (this.oneshotPool || []).forEach((audio) => this._disposeAudioElement(audio));
      this.oneshotPool = [];
      this._bufferAudioCache?.clear();
      this._bufferAudioPromises?.clear();
      this.audioGainNodes.clear();
      this.audioSourceNodes.clear();
      this._bound.forEach(([el, event, fn, listenerOptions]) => el.removeEventListener(event, fn, listenerOptions));
      this._bound.length = 0;
      // Public Player can cross-fade an old Core instance while a fresh Core
      // instance is already mounted into the same host. In that case the old
      // instance must release its own listeners/audio WITHOUT clearing the
      // shared host, otherwise its delayed destroy wipes out the second read.
      if (!preserveHost) {
        this.host.innerHTML = '';
        this.host.classList.remove('sp-core');
      }
      this.destroyed = true;
    }
  }

  ScenePlayerCore.VERSION = '1.4.8-ios-ending-pre-finish';
  ScenePlayerCore.FORMAT_VERSION = '1.0';
  ScenePlayerCore.validate = assertSceneDocument;

  global.ScenePlayerCore = ScenePlayerCore;
})(typeof window !== 'undefined' ? window : globalThis);
