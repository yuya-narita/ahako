(() => {
  'use strict';

  const host = document.getElementById('scenePlayer');
  const opening = document.getElementById('publicOpening');
  const openingImage = document.getElementById('publicOpeningImage');
  const openingDim = document.getElementById('publicOpeningDim');
  const intro = document.getElementById('publicIntro');
  const introLogo = document.getElementById('publicIntroLogo');
  const introTitle = document.getElementById('publicIntroTitle');
  const introAuthor = document.getElementById('publicIntroAuthor');
  const introEpisode = document.getElementById('publicIntroEpisode');
  const introEpisodeTitle = document.getElementById('publicIntroEpisodeTitle');
  const introDescription = document.getElementById('publicIntroDescription');
  const introCover = document.getElementById('publicIntroCover');
  const introCoverDim = document.getElementById('publicIntroCoverDim');
  const startButton = document.getElementById('publicStart');
  const continueButton = document.getElementById('publicContinue');

  const ending = document.getElementById('publicEnding');
  const endingLabel = document.getElementById('publicEndingLabel');
  const endingLeft = document.getElementById('publicEndingLeft');
  const endingRight = document.getElementById('publicEndingRight');
  const endingCoverButton = document.getElementById('publicEndingCover');
  const restartButton = document.getElementById('publicRestart');

  const errorPanel = document.getElementById('publicError');
  const errorTitle = document.getElementById('publicErrorTitle');
  const errorMessage = document.getElementById('publicErrorMessage');
  const retryButton = document.getElementById('publicRetry');

  let player = null;
  let documentData = null;
  let shellBound = false;
  let muted = false;
  const reportButton=document.getElementById('publicReportButton');
  const reportDialog=document.getElementById('publicReportDialog');
  const reportWorkId=document.getElementById('publicReportWorkId');
  const reportUrl=document.getElementById('publicReportUrl');
  const reportCopy=document.getElementById('publicReportCopy');
  const reportStatus=document.getElementById('publicReportStatus');
  const reportSubject=document.getElementById('publicReportSubject');
  const reportEvidenceUrl=document.getElementById('publicReportEvidenceUrl');
  const reportDetails=document.getElementById('publicReportDetails');
  const reportContact=document.getElementById('publicReportContact');
  const reportConfirm=document.getElementById('publicReportConfirm');
  const reportEvidenceRequired=document.getElementById('publicReportEvidenceRequired');
  const reportContactRequired=document.getElementById('publicReportContactRequired');
  const reportContactHint=document.getElementById('publicReportContactHint');

  const params = new URLSearchParams(location.search);
  const requested = (params.get('src') || '').trim();
  const DEFAULT_SCENE = './works/external-signal/scene.json';
  const source = () => requested || DEFAULT_SCENE;
  const storageKey = () => `scene-public-progress:${source()}`;

  // v0.3.64 — anonymous, work-level analytics.
  // One small R2 session record is overwritten as reading progresses, so
  // Scene taps do not create one object per tap. No account / personal ID is used.
  const analyticsSessionId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  let analyticsSceneAdvances = 0;
  let analyticsCompleted = false;
  let analyticsViewSent = false;

  // Optional author/reader pacing resonance. No judgement is shown during reading;
  // the comparison appears only on the ending screen.
  let resonanceSession = null;

  function resonanceIsEnabled(){
    const resonance=documentData?.player?.resonance;
    // Strict, versioned opt-in.
    // Earlier development builds may already contain enabled/authorOptIn,
    // so only a fresh author action in the finalized v2 opt-in UI counts.
    return resonance?.enabled===true
      && resonance?.authorOptIn===true
      && Number(resonance?.authorOptInVersion)===2;
  }
  function resonanceHasCompleteAuthorTiming(){
    const scenes=documentData?.scenes;
    return Array.isArray(scenes)&&scenes.length>0&&scenes.every(scene=>Number.isFinite(Number(scene?.pause))&&Number(scene.pause)>0);
  }
  function resetResonanceSession(startAt=0){
    resonanceSession=(resonanceIsEnabled()&&resonanceHasCompleteAuthorTiming()&&Number(startAt)===0)
      ? {valid:true,lastAt:0,samples:[]}
      : null;
    renderResonanceResult(null);
  }
  function beginResonanceClock(){if(resonanceSession?.valid)resonanceSession.lastAt=performance.now();}
  function invalidateResonance(){if(resonanceSession)resonanceSession.valid=false;}
  function recordResonanceBoundary(sceneIndex){
    const session=resonanceSession;if(!session?.valid||!session.lastAt)return;
    const expected=Number(documentData?.scenes?.[sceneIndex]?.pause);
    if(!Number.isFinite(expected)||expected<=0){invalidateResonance();return;}
    const now=performance.now();
    const actual=Math.max(0,now-session.lastAt);
    session.lastAt=now;
    session.samples.push({sceneIndex,expected,actual});
  }
  function resonanceScore(){
    const session=resonanceSession;
    if(!session?.valid||session.samples.length!==(documentData?.scenes?.length||0))return null;
    const values=session.samples.map(({expected,actual})=>{
      const diff=Math.abs(actual-expected);
      // No visible notes: this is a comparison of pacing, not a strict rhythm-game judgement.
      // 100% remains possible only at exact coincidence, but nearby taps stay meaningful.
      const tolerance=Math.max(1500,expected*.75);
      const ratio=diff/tolerance;
      return 1/(1+ratio*ratio);
    });
    return Math.max(0,Math.min(100,(values.reduce((a,b)=>a+b,0)/values.length)*100));
  }
  function resonanceResultNode(){
    let node=document.getElementById('publicResonanceResult');
    if(node||!endingLabel?.parentElement)return node;
    node=document.createElement('div');
    node.id='publicResonanceResult';
    node.className='public-resonance-result';
    node.hidden=true;
    node.innerHTML='<small>RESONANCE</small><strong></strong><p>あなたと作者の「間」の共鳴率</p>';
    endingLabel.insertAdjacentElement('afterend',node);
    return node;
  }
  function renderResonanceResult(score){
    const node=resonanceResultNode();
    if(!node)return;

    // IMPORTANT: Number(null) === 0.
    // v1.8 converted null before checking validity, so disabled / legacy works
    // were mistakenly rendered as RESONANCE 0.0%. Treat null/undefined as
    // "no result" before numeric conversion.
    const hasScore=score!==null && score!==undefined && score!=='';
    const value=hasScore ? Number(score) : NaN;
    node.hidden=!Number.isFinite(value);
    ending?.classList.toggle('has-resonance',!node.hidden);

    const strong=node.querySelector('strong');
    if(!node.hidden){
      if(strong)strong.textContent=`${value.toFixed(1)}%`;
    }else if(strong){
      strong.textContent='';
    }
  }

  function analyticsEndpoint(){
    try{
      const u=new URL(source(),location.href);
      return (u.pathname.includes('/work/')?u.origin:'https://scene-studio-api.a-hako.workers.dev') + '/analytics';
    }catch{
      return 'https://scene-studio-api.a-hako.workers.dev/analytics';
    }
  }

  function sendAnalytics(event, extra={}){
    const workId=currentWorkId();
    if(!workId)return;
    const payload={
      event, workId, sessionId:analyticsSessionId,
      title:String(documentData?.title||'').slice(0,200),
      sceneCount:Array.isArray(documentData?.scenes)?documentData.scenes.length:0,
      sceneAdvances:analyticsSceneAdvances,
      completed:analyticsCompleted,
      ...extra
    };
    try{
      fetch(analyticsEndpoint(),{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload), keepalive:true, cache:'no-store'
      }).catch(()=>{});
    }catch(_){}
  }

  function safeProgress() {
    const n = Number(localStorage.getItem(storageKey()));
    return Number.isInteger(n) && n > 0 && documentData?.scenes?.[n] ? n : 0;
  }

  function showError(error) {
    console.error(error);
    host.hidden = true;
    intro.hidden = true;
    opening.hidden = true;
    ending.hidden = true;
    errorPanel.hidden = false;

    const status = Number(error?.status) || 0;

    if (status === 410) {
      errorTitle.textContent = '公開を停止しています';
      errorMessage.textContent = 'この作品は現在公開されていません。';
      retryButton.hidden = true;
      return;
    }

    if (status === 404) {
      errorTitle.textContent = '作品が見つかりません';
      errorMessage.textContent = 'この作品は削除されたか、URLが無効です。';
      retryButton.hidden = true;
      return;
    }

    errorTitle.textContent = 'Sceneを開けませんでした';
    errorMessage.textContent = `${error?.message || error}`;
    retryButton.hidden = false;
  }

  function setTheme(doc) {
    // Public chrome / ending must follow the same visual theme contract as
    // Scene Player Core. CINEMA can be authored with a light tone; treating
    // every CINEMA document as dark makes only the public ending flip to the
    // dark palette even while the work itself is visibly light.
    const light = doc.theme === 'light'
      || (doc.theme === 'cinema' && doc.appearance?.cinemaTone === 'light');
    const bg = light ? '#f7f6f1' : '#0b1016';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
    document.documentElement.style.setProperty('--public-bg', bg);
    document.documentElement.style.setProperty('--public-text', light ? '#211d18' : '#f5f5f2');
    document.documentElement.style.setProperty('--public-sub', light ? 'rgba(33,29,24,.48)' : 'rgba(245,245,242,.58)');
    document.documentElement.style.setProperty('--public-line', light ? 'rgba(33,29,24,.18)' : 'rgba(245,245,242,.16)');
  }

  function coverSource(doc){
    return String(doc?.cover?.src || doc?.cover?.url || doc?.cover?.image || '').trim();
  }
  function applyCover(doc){
    const src=coverSource(doc);
    const families={serif:'"Yu Mincho","Hiragino Mincho ProN",serif',sans:'-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Yu Gothic",sans-serif',mono:'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'};
    intro?.style.setProperty('--public-cover-font',families[doc?.cover?.fontFamily]||families.serif);
    if(introCover){
      introCover.style.backgroundImage=src?`url("${src.replace(/"/g,'\\"')}")`:'none';
      introCover.style.backgroundSize=doc?.cover?.fit==='contain'?'contain':'cover';
      introCover.style.backgroundPosition=doc?.cover?.position||'center';
    }
    if(introCoverDim)introCoverDim.style.opacity=src?'1':'0';
    intro.classList.toggle('has-cover',Boolean(src));
  }

  function normalizedExternalLinks(doc) {
    const raw = doc.ending?.links || doc.navigation?.links || doc.player?.navigation?.links || [];
    if (!Array.isArray(raw)) return [];
    return raw
      .map(item => {
        if (typeof item === 'string') return { label: item, url: item };
        return {
          label: String(item?.label || item?.title || '').trim(),
          url: String(item?.url || item?.href || '').trim()
        };
      })
      .filter(item => item.label && item.url);
  }

  function buildEnding(doc) {
    const families={serif:'"Yu Mincho","Hiragino Mincho ProN",serif',sans:'-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Yu Gothic",sans-serif',mono:'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'};
    endingLabel.style.fontFamily=families[doc?.ending?.fontFamily]||families.serif;
    const label=String(doc.ending?.label ?? doc.ending?.title ?? '').trim(); endingLabel.textContent=label; endingLabel.hidden=!label;
    const links=Array.isArray(doc.ending?.links)?doc.ending.links:[];
    const hasPositions=links.some(x=>x?.position==='left'||x?.position==='right'); const left=hasPositions?(links.find(x=>x?.position==='left')||null):(links[0]||null); const right=hasPositions?(links.find(x=>x?.position==='right')||null):(links.length>1?links[1]:null);
    const applyBox=(node,item,delay)=>{if(!node)return;const text=String(item?.label||item?.title||'').trim(),kicker=String(item?.kicker||'').trim(),url=String(item?.url||item?.href||'').trim();node.hidden=!(text&&url);if(node.hidden)return;const s=node.querySelector('small'),b=node.querySelector('strong');if(s){s.textContent=kicker;s.hidden=!kicker;}if(b)b.textContent=text;node.href=url;node.style.setProperty('--ending-delay',`${delay}ms`);};
    applyBox(endingLeft,left,3000); applyBox(endingRight,right,3200);
    const cs=endingCoverButton?.querySelector('small'),cb=endingCoverButton?.querySelector('strong'); if(cs)cs.textContent=doc.ending?.coverButton?.kicker||'COVER'; if(cb)cb.textContent=doc.ending?.coverButton?.label||'表紙に戻る'; endingCoverButton?.style.setProperty('--ending-delay','3100ms');
  }

  function firstSceneBackground(doc) {
    const scene = doc?.scenes?.[0];
    return scene?.presentation?.background || scene?.background || null;
  }

  function prepareOpening(doc) {
    const bg = firstSceneBackground(doc);
    const src = String(bg?.src || '').trim();

    openingImage.style.backgroundImage = src ? `url("${src.replace(/"/g, '\\"')}")` : 'none';
    openingImage.style.backgroundSize =
      bg?.fit === 'contain' ? 'contain' :
      bg?.fit === 'fill' ? '100% 100%' :
      'cover';
    openingImage.style.backgroundPosition = 'center';
    openingImage.style.backgroundRepeat = 'no-repeat';

    const dim = Math.max(0, Math.min(1, Number(bg?.dim ?? 0)));
    openingDim.style.background = `rgba(0,0,0,${dim})`;
  }

  async function openingBreath() {
    prepareOpening(documentData);

    // Intro disappears first. The reader gets a short moment with only the
    // work's first background before Scene 1 begins.
    intro.classList.add('is-leaving');
    await new Promise(resolve => setTimeout(resolve, 240));

    intro.hidden = true;
    intro.classList.remove('is-leaving');

    opening.hidden = false;
    requestAnimationFrame(() => opening.classList.add('is-visible'));

    await new Promise(resolve => setTimeout(resolve, 450));

    opening.classList.remove('is-visible');
    opening.hidden = true;
  }

  function applyPublicCoverTypography(doc){
    const styles=doc?.cover?.styles||{};
    const baseFamily={
      serif:'"Yu Mincho","Hiragino Mincho ProN",serif',
      sans:'-apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Yu Gothic",sans-serif',
      mono:'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
    };
    const sizeScale={small:.78,normal:1,large:1.28,xl:1.6};
    const fields=[
      [introTitle,'title'],
      [introDescription,'subtitle'],
      [introAuthor,'author'],
      [introEpisode,'episode'],
      [introEpisodeTitle,'episodeTitle']
    ];

    for(const [el,key] of fields){
      if(!el)continue;
      const st=styles[key]||{};
      el.style.removeProperty('font-size');
      el.style.removeProperty('font-family');
      el.style.removeProperty('color');
      const baseSize=parseFloat(getComputedStyle(el).fontSize)||16;

      const family=st.fontFamily && st.fontFamily!=='inherit'
        ? baseFamily[st.fontFamily]
        : baseFamily[doc?.cover?.fontFamily];
      if(family)el.style.setProperty('font-family',family,'important');

      if(st.color)el.style.setProperty('color',String(st.color),'important');

      if(st.size && st.size!=='auto'){
        const resolved=typeof st.size==='number'
          ? Number(st.size)
          : baseSize*(sizeScale[String(st.size)]||1);
        if(Number.isFinite(resolved))el.style.setProperty('font-size',`${resolved}px`,'important');
      }
    }
  }

  function applyDocumentMeta(doc) {
    const cleanTitle=String(doc.title||'').trim()==='Untitled'?'':String(doc.title||'');
    document.title = cleanTitle || 'Scene';

    const legacyText=doc.cover?.text||{};
    const visibility=doc.cover?.visibility||{};
    const visible=(key,value)=>{
      if(Object.prototype.hasOwnProperty.call(visibility,key)){
        return visibility[key]!==false && Boolean(String(value||'').trim());
      }
      if(Object.prototype.hasOwnProperty.call(legacyText,key) && String(legacyText[key]??'')===''){
        return false;
      }
      return Boolean(String(value||'').trim());
    };

    const logoSrc=String(doc.cover?.logo?.src||'').trim();
    if(introLogo){introLogo.src=logoSrc;introLogo.hidden=!logoSrc;}

    const title=cleanTitle;
    const subtitle=String(doc.metadata?.subtitle||doc.subtitle||'');
    const author=String(doc.author||'');
    const ep=String(doc.metadata?.episode||doc.episode||'');
    const et=String(doc.metadata?.episodeTitle||doc.episodeTitle||'');

    introTitle.textContent=title;
    introTitle.hidden=Boolean(logoSrc)||!visible('title',title);

    introAuthor.textContent=author;
    introAuthor.hidden=!visible('author',author);

    if(introEpisode){
      introEpisode.textContent=ep;
      introEpisode.hidden=!visible('episode',ep);
    }
    if(introEpisodeTitle){
      introEpisodeTitle.textContent=et;
      introEpisodeTitle.hidden=!visible('episodeTitle',et);
    }

    // This node is the public cover's subtitle slot.
    // Do not substitute the long work description here.
    introDescription.textContent=subtitle;
    introDescription.hidden=!visible('subtitle',subtitle);

    setTheme(doc);
    applyCover(doc);
    applyPublicCoverTypography(doc);
    buildEnding(doc);
    continueButton.hidden = safeProgress() <= 0;
  }

  function currentWorkId(){
    const src=source();
    const m=src.match(/\/work\/([^/?#]+)/i);
    return m?decodeURIComponent(m[1]):'';
  }

  function bindReportControls(){
    if(!reportButton||!reportDialog)return;
    const reason=()=>reportDialog.querySelector('input[name="reportReason"]:checked')?.value||'other';
    const rightsClaim=()=>reason()==='copyright'||reason()==='unauthorized';
    const updateRequirements=()=>{
      const required=rightsClaim();
      if(reportEvidenceRequired)reportEvidenceRequired.hidden=!required;
      if(reportContactRequired)reportContactRequired.hidden=!required;
      if(reportEvidenceUrl)reportEvidenceUrl.required=required;
      if(reportContact)reportContact.required=required;
      if(reportContactHint)reportContactHint.textContent=required
        ? '権利関係の確認が必要な場合に運営から連絡します。'
        : '「その他」の報告では任意です。';
    };
    const sync=()=>{
      const id=currentWorkId()||'不明';
      if(reportWorkId)reportWorkId.textContent=id;
      if(reportUrl)reportUrl.textContent=location.href;
      if(reportStatus)reportStatus.textContent='根拠を確認できる情報と一緒に運営へ送信します。';
      if(reportCopy){reportCopy.disabled=false;reportCopy.textContent='運営に申立てを送る';}
      updateRequirements();
    };
    reportDialog.querySelectorAll('input[name="reportReason"]').forEach(el=>el.addEventListener('change',updateRequirements));
    reportButton.addEventListener('click',()=>{sync();reportDialog.showModal();});

    // v0.3.61 — iOS Safari: the close control must never participate in
    // form validation, and the terminating touch must not fall through to
    // a field underneath the dialog after it closes.
    const reportClose=document.getElementById('publicReportClose');
    const closeReportDialog=(event)=>{
      if(event){
        event.preventDefault();
        event.stopPropagation();
        if(typeof event.stopImmediatePropagation==='function')event.stopImmediatePropagation();
      }
      const active=document.activeElement;
      if(active&&typeof active.blur==='function')active.blur();
      if(reportDialog.open)reportDialog.close('cancel');
    };
    if(reportClose){
      reportClose.addEventListener('pointerdown',(event)=>{
        event.preventDefault();
        event.stopPropagation();
      });
      reportClose.addEventListener('touchstart',(event)=>{
        event.preventDefault();
        event.stopPropagation();
      },{passive:false});
      reportClose.addEventListener('touchend',closeReportDialog,{passive:false});
      reportClose.addEventListener('click',closeReportDialog);
    }

    reportCopy?.addEventListener('click',async()=>{
      const workId=currentWorkId();
      const claimReason=reason();
      const subject=reportSubject?.value||'other';
      const evidenceUrl=(reportEvidenceUrl?.value||'').trim();
      const details=(reportDetails?.value||'').trim();
      const contact=(reportContact?.value||'').trim();
      const required=rightsClaim();
      if(!workId){if(reportStatus)reportStatus.textContent='公開作品IDを取得できませんでした。';return;}
      if(!details){if(reportStatus)reportStatus.textContent='詳しい内容を入力してください。';reportDetails?.focus();return;}
      if(required&&!evidenceUrl){if(reportStatus)reportStatus.textContent='元作品・権利を確認できるURLを入力してください。';reportEvidenceUrl?.focus();return;}
      if(evidenceUrl){try{const u=new URL(evidenceUrl);if(!/^https?:$/.test(u.protocol))throw new Error();}catch{if(reportStatus)reportStatus.textContent='元作品URLを http(s):// から入力してください。';reportEvidenceUrl?.focus();return;}}
      if(required&&!contact){if(reportStatus)reportStatus.textContent='連絡先メールを入力してください。';reportContact?.focus();return;}
      if(contact&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)){if(reportStatus)reportStatus.textContent='連絡先メールの形式を確認してください。';reportContact?.focus();return;}
      if(!reportConfirm?.checked){if(reportStatus)reportStatus.textContent='報告内容が正確であることを確認してください。';reportConfirm?.focus();return;}
      const originalText=reportCopy.textContent;
      reportCopy.disabled=true;reportCopy.textContent='送信中…';
      if(reportStatus)reportStatus.textContent='運営へ申立てを送信しています。';
      try{
        const srcUrl=new URL(source(),location.href);
        const apiBase=srcUrl.pathname.includes('/work/')?srcUrl.origin:'https://scene-studio-api.a-hako.workers.dev';
        const response=await fetch(`${apiBase}/report`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({workId,reason:claimReason,subject,evidenceUrl,details,contact,confirmed:true,url:location.href,sourceUrl:srcUrl.toString()})
        });
        const data=await response.json().catch(()=>({}));
        if(!response.ok||!data.ok)throw new Error(data.error||`HTTP ${response.status}`);
        if(reportStatus)reportStatus.textContent='申立てを受け付けました。運営が内容を確認します。';
        reportCopy.textContent='送信済み';
      }catch(error){
        console.warn('Report submission failed',error);
        if(reportStatus)reportStatus.textContent='送信できませんでした。入力内容を確認してもう一度お試しください。';
        reportCopy.disabled=false;reportCopy.textContent=originalText;
      }
    });
  }

  async function fetchScene() {
    errorPanel.hidden = true;
    const src = source();
    const response = await fetch(src, { cache: 'no-store' });
    if (!response.ok) {
      const error = new Error(`Scene JSONを取得できませんでした (${response.status})\n${src}`);
      error.status = response.status;
      error.source = src;
      throw error;
    }

    const doc = await response.json();
    ScenePlayerCore.validate(doc);
    documentData = doc;
    applyDocumentMeta(doc);
    if(!analyticsViewSent && currentWorkId()){
      analyticsViewSent=true;
      sendAnalytics('view');
    }

    intro.hidden = false;
    host.hidden = true;
    ending.hidden = true;
  }

  function bindPublicControls() {
    if (!player || shellBound) return;
    shellBound = true;

    const left = player.els?.prev;
    const right = player.els?.restart;

    if (left) {
      left.hidden = false;
      left.disabled = false;
      left.textContent = '‹';
      left.setAttribute('aria-label', '表紙に戻る');
      left.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();

        // Public Player: the left header control is always an exit to the cover.
        // Past Scenes remain available only through the author's navigation setting
        // and the downward swipe gesture.
        returnToCover();
      }, true);
    }

    if (right) {
      right.textContent = '♪';
      right.setAttribute('aria-label', '音声をオン・オフ');
      right.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        muted = player.toggleMuted();
        right.classList.toggle('is-muted', muted);
        right.setAttribute('aria-pressed', muted ? 'false' : 'true');
      }, true);
    }

    host.addEventListener('sceneplayer:scenechange', onSceneChange);
    host.addEventListener('sceneplayer:end', onEnd);
    host.addEventListener('sceneplayer:autochange', onResonanceAutoChange);
    host.addEventListener('sceneplayer:historyopen', invalidateResonance);
  }

  function onSceneChange(e) {
    const index = Number(e.detail?.index);
    if (Number.isInteger(index) && index > 0) {
      localStorage.setItem(storageKey(), String(index));
    }
    if(e.detail?.direction==='next'){
      analyticsSceneAdvances += 1;
      sendAnalytics('progress',{index});
      if(player?.auto)invalidateResonance();
      else if(Number.isInteger(index)&&index>0)recordResonanceBoundary(index-1);
    }

    // Core disables Previous on Scene 1 / when author history is disabled.
    // In Public Player this control is not Previous: it is the always-available cover exit.
    if (player?.els?.prev) {
      player.els.prev.hidden = false;
      player.els.prev.disabled = false;
    }
  }

  function onEnd() {
    localStorage.removeItem(storageKey());
    if(resonanceSession?.valid){
      if(player?.auto)invalidateResonance();
      else recordResonanceBoundary((documentData?.scenes?.length||1)-1);
    }
    renderResonanceResult(resonanceScore());
    if(!analyticsCompleted){
      analyticsCompleted=true;
      sendAnalytics('complete',{index:Array.isArray(documentData?.scenes)?documentData.scenes.length-1:0});
    }

    // Keep player/audio alive underneath the ending screen.
    // This preserves BGM/Ambient as the work's afterglow unless the Scene itself
    // explicitly issued a stop command.
    ending.classList.remove('is-visible');
    ending.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => ending.classList.add('is-visible'));
    });
  }

  function onResonanceAutoChange(e){if(e.detail?.auto)invalidateResonance();}

  function removeShellListeners() {
    host.removeEventListener('sceneplayer:scenechange', onSceneChange);
    host.removeEventListener('sceneplayer:end', onEnd);
    host.removeEventListener('sceneplayer:autochange', onResonanceAutoChange);
    host.removeEventListener('sceneplayer:historyopen', invalidateResonance);
  }

  const PUBLIC_EXIT_FADE_MS = 1600;

  function fadePublicAudio(duration = PUBLIC_EXIT_FADE_MS) {
    if (!player || typeof player.fadeOutAudio !== 'function') return 0;
    try { return player.fadeOutAudio(duration); } catch (_) { return 0; }
  }

  function destroyAfterFade(targetPlayer, duration = PUBLIC_EXIT_FADE_MS) {
    if (!targetPlayer) return;
    window.setTimeout(() => {
      try {
        // The old and new Player instances can share #scenePlayer.
        // Clean up the old instance without clearing the host used by the new one.
        targetPlayer.destroy({ preserveHost: true });
      } catch (_) {}
    }, Math.max(0, duration) + 80);
  }

  function destroyPlayer({ stopAudio = true } = {}) {
    if (!player) return;
    removeShellListeners();

    if (stopAudio) {
      try { player.destroy(); } catch (_) {}
    }
    player = null;
    shellBound = false;
  }

  function stopForExit() {
    if (player) {
      const exitingPlayer = player;
      fadePublicAudio();
      player = null;
      shellBound = false;
      destroyAfterFade(exitingPlayer);
    }
  }

  function returnToCover() {
    if (player) {
      const exitingPlayer = player;
      fadePublicAudio();
      removeShellListeners();
      player = null;
      shellBound = false;
      destroyAfterFade(exitingPlayer);
    }

    ending.classList.remove('is-visible');
    ending.hidden = true;
    showIntro();
  }

  function closeToSource() {
    const ret = returnConfig(documentData || {});
    stopForExit();

    if (ret.url) {
      location.href = ret.url;
      return;
    }

    if (history.length > 1) {
      history.back();
      return;
    }

    // Direct-open fallback: return to the lightweight intro instead of trapping the reader.
    showIntro();
  }

  async function ensurePlayer(startAt = 0) {
    if (player) {
      const previousPlayer = player;
      try { previousPlayer.fadeOutAudio(PUBLIC_EXIT_FADE_MS); } catch (_) {}
      destroyAfterFade(previousPlayer);
      player = null;
    }

    shellBound = false;
    muted = false;

    ending.hidden = true;
    ending.classList.remove('is-visible');
    ending.classList.remove('has-resonance');
    resetResonanceSession(startAt);

    /*
      Public Player owns the visible cover, but Core also has its own cover.
      Previously we did:
        openingBreath() -> Core.load() -> unlockAudio()
      That had two side effects:
      1) Core stayed in its internal cover state, so authored episode text leaked
         into the reading surface as a large "第9話" at the upper-left.
      2) The first Scene audio was never actually entered. On iPhone the later
         unlock also happened after ~690ms of awaits, outside the trusted START
         gesture. Scene 1 therefore became audible only after History restored it.

      Build/load/begin Core synchronously, before the first await. This lets
      Scene 1 audio receive the actual START/CONTINUE gesture and removes Core's
      internal cover immediately. Keep the reading surface visually hidden while
      the public opening breath plays, then replay presentation only.
    */
    host.hidden = false;
    host.style.visibility = 'hidden';
    host.style.pointerEvents = 'none';

    player = new ScenePlayerCore(host, {
      allowPrevious: true,
      endOnNextAction: true
    });

    bindPublicControls();

    player.load(documentData, { startAt });
    const ep=String(documentData?.metadata?.episode||documentData?.episode||'').trim();
    const epTitle=String(documentData?.metadata?.episodeTitle||documentData?.episodeTitle||'').trim();
    if(player.els?.title)player.els.title.textContent=[ep,epTitle].filter(Boolean).join(' ・ ') || documentData.title || '';
    if(player.els?.author)player.els.author.textContent=documentData.author||'';

    // Critical: no await before this call.
    // begin() unlocks audio and enters Scene 1/continue Scene from the same
    // trusted user gesture that pressed START / CONTINUE.
    player.begin();

    // Use the same zero point as Scene 1 / its audio.
    beginResonanceClock();

    await openingBreath();

    // The Scene's audio has already started from the trusted gesture. Reveal the
    // Player now and replay only its visual presentation so the entrance effect
    // is not consumed while the host was invisible.
    host.style.visibility = '';
    host.style.pointerEvents = '';
    if (player) {
      player.refreshCurrent({ preserveAudio: true });
      if(player.els?.title)player.els.title.textContent=[ep,epTitle].filter(Boolean).join(' ・ ') || documentData.title || '';
      if(player.els?.author)player.els.author.textContent=documentData.author||'';
    }
  }


  function showIntro() {
    ending.classList.remove('is-visible');
    ending.hidden = true;

    if (player) {
      const introPlayer = player;
      fadePublicAudio();
      player = null;
      shellBound = false;
      destroyAfterFade(introPlayer);
    }

    opening.hidden = true;
    opening.classList.remove('is-visible');
    host.hidden = true;
    intro.hidden = false;
    applyDocumentMeta(documentData);
  }

  startButton.addEventListener('click', () => {
    localStorage.removeItem(storageKey());
    ensurePlayer(0);
  });

  continueButton.addEventListener('click', () => {
    ensurePlayer(safeProgress());
  });

  endingCoverButton?.addEventListener('click', () => {
    returnToCover();
  });

  restartButton.addEventListener('click', () => {
    localStorage.removeItem(storageKey());
    ending.classList.remove('is-visible');
    ending.hidden = true;
    ensurePlayer(0);
  });

  retryButton.addEventListener('click', () => fetchScene().catch(showError));

  // Best-effort graceful audio exit when the browser/app closes or replaces
  // the page. A browser may terminate the document immediately, so a full
  // fade cannot be guaranteed on a hard tab/app close.
  window.addEventListener('pagehide', () => {
    fadePublicAudio(PUBLIC_EXIT_FADE_MS);
  });

  window.ScenePublicPlayer = {
    version: '0.3.21',
    get player(){ return player; },
    get document(){ return documentData; },
    get source(){ return source(); },
    reload(){ return fetchScene(); },
    start(index = 0){ return ensurePlayer(index); },
    close(){ return closeToSource(); }
  };

  fetchScene().catch(showError);
  bindReportControls();
})();
