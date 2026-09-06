(() => {
  'use strict';
  const launcher=document.getElementById('localLauncher');
  const dropZone=document.getElementById('localDropZone');
  const openButton=document.getElementById('localOpenButton');
  const fileInput=document.getElementById('localFileInput');
  const status=document.getElementById('localStatus');
  const backButton=document.getElementById('localBackButton');
  const relayButton=document.getElementById('publicRelay');
  let assetUrls=[];
  let currentPackage=null;

  const u16=(v,o)=>v.getUint16(o,true);
  const u32=(v,o)=>v.getUint32(o,true);
  const norm=path=>String(path||'').replace(/^\.\//,'').replace(/^\//,'').replace(/\\/g,'/');

  function revokeAssets(){for(const url of assetUrls){try{URL.revokeObjectURL(url)}catch(_){}}assetUrls=[];}
  function setStatus(text){if(status)status.textContent=text||'';}


  // ------------------------------------------------------------
  // Phase 4 RELAY
  // Official RELAY does not mint a new copyId. It keeps the same issued copy
  // and adds a new relay node so the journey can be observed without storing
  // recipient identity. The package is rebuilt locally; work assets are not
  // uploaded to the A-Hako API.
  // ------------------------------------------------------------
  const enc=new TextEncoder();
  function randomRelayId(){
    try{return `relay_${crypto.randomUUID().replaceAll('-','')}`;}catch(_){const a=new Uint8Array(16);crypto.getRandomValues(a);return `relay_${[...a].map(v=>v.toString(16).padStart(2,'0')).join('')}`;}
  }
  function validCopyId(v){return /^copy_[a-f0-9]{32}$/i.test(String(v||''));}
  function validRelayId(v){return /^relay_[a-f0-9]{32}$/i.test(String(v||''));}
  function validWorkId(v){return /^[A-Za-z0-9_-]{12,80}$/.test(String(v||''));}
  function relayInfo(raw){
    const workId=String(raw?.workId||'').trim();
    const copyId=String(raw?.distribution?.copyId||'').trim();
    if(!validWorkId(workId)||!validCopyId(copyId))return null;
    const source=raw?.distribution?.relay||{};
    const sourceRelayId=validRelayId(source.relayId)?String(source.relayId):null;
    const sourceHop=Number.isInteger(Number(source.hop))?Math.max(0,Math.min(999,Number(source.hop))):0;
    return {workId,copyId,sourceRelayId,sourceHop};
  }
  function crc32(bytes){
    let c=0xffffffff;
    for(let i=0;i<bytes.length;i++){
      c^=bytes[i];
      for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);
    }
    return (c^0xffffffff)>>>0;
  }
  function dosDateTime(date=new Date()){
    let y=Math.max(1980,date.getFullYear());
    const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
    const d=((y-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
    return {time,date:d};
  }
  function writeU16(a,o,v){a[o]=v&255;a[o+1]=(v>>>8)&255;}
  function writeU32(a,o,v){a[o]=v&255;a[o+1]=(v>>>8)&255;a[o+2]=(v>>>16)&255;a[o+3]=(v>>>24)&255;}
  function buildStoredZip(files){
    const locals=[],centrals=[];let offset=0;const now=dosDateTime(new Date());
    for(const [name0,data0] of files){
      const name=norm(name0),nameBytes=enc.encode(name),data=data0 instanceof Uint8Array?data0:new Uint8Array(data0),crc=crc32(data);
      const local=new Uint8Array(30+nameBytes.length+data.length);
      writeU32(local,0,0x04034b50);writeU16(local,4,20);writeU16(local,6,0x0800);writeU16(local,8,0);writeU16(local,10,now.time);writeU16(local,12,now.date);writeU32(local,14,crc);writeU32(local,18,data.length);writeU32(local,22,data.length);writeU16(local,26,nameBytes.length);writeU16(local,28,0);local.set(nameBytes,30);local.set(data,30+nameBytes.length);locals.push(local);
      const central=new Uint8Array(46+nameBytes.length);
      writeU32(central,0,0x02014b50);writeU16(central,4,20);writeU16(central,6,20);writeU16(central,8,0x0800);writeU16(central,10,0);writeU16(central,12,now.time);writeU16(central,14,now.date);writeU32(central,16,crc);writeU32(central,20,data.length);writeU32(central,24,data.length);writeU16(central,28,nameBytes.length);writeU16(central,30,0);writeU16(central,32,0);writeU16(central,34,0);writeU16(central,36,0);writeU32(central,38,0);writeU32(central,42,offset);central.set(nameBytes,46);centrals.push(central);
      offset+=local.length;
    }
    const centralOffset=offset,centralSize=centrals.reduce((n,a)=>n+a.length,0),count=centrals.length;
    const eocd=new Uint8Array(22);writeU32(eocd,0,0x06054b50);writeU16(eocd,4,0);writeU16(eocd,6,0);writeU16(eocd,8,count);writeU16(eocd,10,count);writeU32(eocd,12,centralSize);writeU32(eocd,16,centralOffset);writeU16(eocd,20,0);
    return new Blob([...locals,...centrals,eocd],{type:'application/octet-stream'});
  }
  function safeFileBase(v){return String(v||'scene').replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').trim().slice(0,80)||'scene';}
  function registerRelay(payload){
    try{fetch('https://scene-studio-api.a-hako.workers.dev/distribution-relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),keepalive:true,cache:'no-store'}).catch(()=>{});}catch(_){}
  }
  async function relayCurrentScene(){
    if(!currentPackage)return;
    const info=relayInfo(currentPackage.raw);
    if(!info)return;
    relayButton.disabled=true;
    const relayId=randomRelayId(),hop=Math.min(1000,info.sourceHop+1),relayedAt=new Date().toISOString();
    try{
      const nextRaw=JSON.parse(JSON.stringify(currentPackage.raw));
      nextRaw.distribution=nextRaw.distribution||{};
      nextRaw.distribution.relay={schemaVersion:'1',relayId,parentRelayId:info.sourceRelayId,hop,relayedAt};
      const nextManifest=JSON.parse(JSON.stringify(currentPackage.manifest));
      nextManifest.relayId=relayId;
      nextManifest.parentRelayId=info.sourceRelayId;
      nextManifest.relayHop=hop;
      nextManifest.relayedAt=relayedAt;
      const nextFiles=new Map(currentPackage.files);
      nextFiles.set('scene.json',enc.encode(JSON.stringify(nextRaw,null,2)));
      nextFiles.set('manifest.json',enc.encode(JSON.stringify(nextManifest,null,2)));
      const blob=buildStoredZip(nextFiles);
      const filename=`${safeFileBase(nextManifest.title||nextRaw.title)}_relay_${hop}.scene`;
      const file=new File([blob],filename,{type:'application/octet-stream',lastModified:Date.now()});
      registerRelay({workId:info.workId,copyId:info.copyId,relayId,parentRelayId:info.sourceRelayId,hop,relayedAt});
      let shared=false;
      try{
        if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:nextManifest.title||nextRaw.title||'あ箱'});shared=true;}
      }catch(e){if(e?.name==='AbortError')return;}
      if(!shared){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
    }catch(error){console.error(error);alert(`RELAYファイルを作れませんでした: ${error?.message||error}`);}
    finally{relayButton.disabled=false;}
  }

  async function inflateRaw(bytes){
    if(typeof DecompressionStream==='undefined')throw new Error('このブラウザは .scene の展開に必要な機能へ対応していません。');
    const ds=new DecompressionStream('deflate-raw');
    const stream=new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function readZip(buffer){
    const bytes=new Uint8Array(buffer),view=new DataView(buffer),min=Math.max(0,bytes.length-65557);let eocd=-1;
    for(let i=bytes.length-22;i>=min;i--){if(u32(view,i)===0x06054b50){eocd=i;break;}}
    if(eocd<0)throw new Error('ZIPコンテナとして認識できません。');
    const count=u16(view,eocd+10);let p=u32(view,eocd+16);const files=new Map(),dec=new TextDecoder('utf-8');
    for(let n=0;n<count;n++){
      if(u32(view,p)!==0x02014b50)throw new Error('ZIP中央ディレクトリが壊れています。');
      const method=u16(view,p+10),csize=u32(view,p+20),usize=u32(view,p+24),nameLen=u16(view,p+28),extraLen=u16(view,p+30),commentLen=u16(view,p+32),localOffset=u32(view,p+42);
      const name=dec.decode(bytes.slice(p+46,p+46+nameLen));p+=46+nameLen+extraLen+commentLen;if(name.endsWith('/'))continue;
      if(u32(view,localOffset)!==0x04034b50)throw new Error(`ZIPヘッダ破損: ${name}`);
      const ln=u16(view,localOffset+26),le=u16(view,localOffset+28),start=localOffset+30+ln+le,packed=bytes.slice(start,start+csize);let data;
      if(method===0)data=packed;else if(method===8)data=await inflateRaw(packed);else throw new Error(`未対応の圧縮方式: ${method}`);
      if(usize&&data.length!==usize)console.warn('size mismatch',name,data.length,usize);files.set(norm(name),data);
    }
    return files;
  }
  function mime(path){
    const p=path.toLowerCase();
    if(p.endsWith('.mp3'))return'audio/mpeg';if(p.endsWith('.wav'))return'audio/wav';if(p.endsWith('.m4a'))return'audio/mp4';if(p.endsWith('.aac'))return'audio/aac';if(p.endsWith('.ogg'))return'audio/ogg';
    if(p.endsWith('.png'))return'image/png';if(p.endsWith('.jpg')||p.endsWith('.jpeg'))return'image/jpeg';if(p.endsWith('.webp'))return'image/webp';if(p.endsWith('.gif'))return'image/gif';if(p.endsWith('.svg'))return'image/svg+xml';
    if(p.endsWith('.woff2'))return'font/woff2';if(p.endsWith('.woff'))return'font/woff';return'application/octet-stream';
  }
  function jsonFile(files,name){
    const b=files.get(norm(name));if(!b)throw new Error(`${name} が .scene 内にありません。`);
    return JSON.parse(new TextDecoder('utf-8').decode(b));
  }
  function buildAssetMap(files){
    const map=new Map();
    for(const[name,data]of files){if(!name.startsWith('assets/'))continue;const url=URL.createObjectURL(new Blob([data],{type:mime(name)}));assetUrls.push(url);map.set(norm(name),url);}
    return map;
  }
  function rewriteAssets(value,map){
    if(Array.isArray(value))return value.map(v=>rewriteAssets(v,map));
    if(!value||typeof value!=='object')return value;
    const out={};
    for(const[k,v]of Object.entries(value)){
      if(typeof v==='string'&&(k==='src'||k==='url'))out[k]=map.get(norm(v))||v;
      else out[k]=rewriteAssets(v,map);
    }
    return out;
  }
  async function openScene(file){
    if(!file)return;
    setStatus('読み込み中…');openButton.disabled=true;
    try{
      const files=await readZip(await file.arrayBuffer());
      const manifest=jsonFile(files,'manifest.json');
      if(manifest.package!=='scene-package')throw new Error(`未対応 package: ${manifest.package||'(なし)'}`);
      if(String(manifest.packageVersion||'')!=='1.0')throw new Error(`未対応 Scene Package version: ${manifest.packageVersion||'(なし)'}`);
      const raw=jsonFile(files,manifest.entry||'scene.json');
      currentPackage={files:new Map(files),manifest:JSON.parse(JSON.stringify(manifest)),raw:JSON.parse(JSON.stringify(raw))};
      if(relayButton)relayButton.hidden=!relayInfo(raw);
      // Validate/build first; revoke previous package only after the new package is ready.
      const nextUrls=[];const previousUrls=assetUrls;assetUrls=[];
      let doc;
      try{const map=buildAssetMap(files);doc=rewriteAssets(raw,map);await window.ScenePublicPlayer.loadDocument(doc,{sourceKey:`local:${file.name}:${file.size}:${file.lastModified||0}`});}
      catch(error){for(const u of assetUrls){try{URL.revokeObjectURL(u)}catch(_){}}assetUrls=previousUrls;throw error;}
      for(const u of previousUrls){try{URL.revokeObjectURL(u)}catch(_){}}
      launcher.hidden=true;if(backButton)backButton.hidden=false;setStatus('');
    }catch(error){console.error(error);currentPackage=null;if(relayButton)relayButton.hidden=true;setStatus(String(error?.message||error));}
    finally{openButton.disabled=false;fileInput.value='';}
  }
  function returnToLauncher(){
    // Let the current public Player own Core/audio teardown, then release only
    // the Blob URLs that belong to the local package.
    try{window.ScenePublicPlayer?.unloadDocument?.();}catch(error){console.warn(error);}
    revokeAssets();
    currentPackage=null;if(relayButton)relayButton.hidden=true;
    setStatus('');
    fileInput.value='';
    if(backButton)backButton.hidden=true;
    launcher.hidden=false;
  }
  function openPicker(){fileInput.click();}
  openButton.addEventListener('click',e=>{e.stopPropagation();openPicker();});
  backButton?.addEventListener('click',returnToLauncher);
  relayButton?.addEventListener('click',relayCurrentScene);
  fileInput.addEventListener('change',()=>openScene(fileInput.files?.[0]));
  ['dragenter','dragover'].forEach(type=>dropZone.addEventListener(type,e=>{e.preventDefault();dropZone.classList.add('is-over');}));
  ['dragleave','drop'].forEach(type=>dropZone.addEventListener(type,e=>{e.preventDefault();dropZone.classList.remove('is-over');}));
  dropZone.addEventListener('drop',e=>openScene(e.dataTransfer?.files?.[0]));
  dropZone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPicker();}});
  window.SceneLocalLoader={version:'4.0-relay',openFile:openScene,openPicker,returnToLauncher,relayCurrentScene};
})();
