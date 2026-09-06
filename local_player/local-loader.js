(() => {
  'use strict';
  const launcher=document.getElementById('localLauncher');
  const dropZone=document.getElementById('localDropZone');
  const openButton=document.getElementById('localOpenButton');
  const fileInput=document.getElementById('localFileInput');
  const status=document.getElementById('localStatus');
  const backButton=document.getElementById('localBackButton');
  let assetUrls=[];

  const u16=(v,o)=>v.getUint16(o,true);
  const u32=(v,o)=>v.getUint32(o,true);
  const norm=path=>String(path||'').replace(/^\.\//,'').replace(/^\//,'').replace(/\\/g,'/');

  function revokeAssets(){for(const url of assetUrls){try{URL.revokeObjectURL(url)}catch(_){}}assetUrls=[];}
  function setStatus(text){if(status)status.textContent=text||'';}

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
      // Validate/build first; revoke previous package only after the new package is ready.
      const nextUrls=[];const previousUrls=assetUrls;assetUrls=[];
      let doc;
      try{const map=buildAssetMap(files);doc=rewriteAssets(raw,map);await window.ScenePublicPlayer.loadDocument(doc,{sourceKey:`local:${file.name}:${file.size}:${file.lastModified||0}`});}
      catch(error){for(const u of assetUrls){try{URL.revokeObjectURL(u)}catch(_){}}assetUrls=previousUrls;throw error;}
      for(const u of previousUrls){try{URL.revokeObjectURL(u)}catch(_){}}
      launcher.hidden=true;if(backButton)backButton.hidden=false;setStatus('');
    }catch(error){console.error(error);setStatus(String(error?.message||error));}
    finally{openButton.disabled=false;fileInput.value='';}
  }
  function returnToLauncher(){
    // Let the current public Player own Core/audio teardown, then release only
    // the Blob URLs that belong to the local package.
    try{window.ScenePublicPlayer?.unloadDocument?.();}catch(error){console.warn(error);}
    revokeAssets();
    setStatus('');
    fileInput.value='';
    if(backButton)backButton.hidden=true;
    launcher.hidden=false;
  }
  function openPicker(){fileInput.click();}
  openButton.addEventListener('click',e=>{e.stopPropagation();openPicker();});
  backButton?.addEventListener('click',returnToLauncher);
  fileInput.addEventListener('change',()=>openScene(fileInput.files?.[0]));
  ['dragenter','dragover'].forEach(type=>dropZone.addEventListener(type,e=>{e.preventDefault();dropZone.classList.add('is-over');}));
  ['dragleave','drop'].forEach(type=>dropZone.addEventListener(type,e=>{e.preventDefault();dropZone.classList.remove('is-over');}));
  dropZone.addEventListener('drop',e=>openScene(e.dataTransfer?.files?.[0]));
  dropZone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPicker();}});
  window.SceneLocalLoader={version:'3.0-current-public-player',openFile:openScene,openPicker,returnToLauncher};
})();
