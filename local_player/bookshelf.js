(()=>{
'use strict';
const DB_NAME='ahako-local-bookshelf';
const DB_VERSION=1;
const WORKS='works';
const HANDOFF='handoff';
const API_BASE='https://scene-studio-api.a-hako.workers.dev';
const td=new TextDecoder('utf-8');
const te=new TextEncoder();
const $=s=>document.querySelector(s);
let currentWorkId='';
let coverUrls=[];

function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains(WORKS))db.createObjectStore(WORKS,{keyPath:'workId'});if(!db.objectStoreNames.contains(HANDOFF))db.createObjectStore(HANDOFF,{keyPath:'key'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function tx(store,mode,fn){const db=await openDb();return new Promise((resolve,reject)=>{const t=db.transaction(store,mode);const s=t.objectStore(store);let out;try{out=fn(s);}catch(e){db.close();reject(e);return;}t.oncomplete=()=>{db.close();resolve(out)};t.onerror=()=>{db.close();reject(t.error)};});}
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function getAllWorks(){const db=await openDb();try{return await request(db.transaction(WORKS,'readonly').objectStore(WORKS).getAll());}finally{db.close();}}
async function putWork(rec){const db=await openDb();try{await request(db.transaction(WORKS,'readwrite').objectStore(WORKS).put(rec));}finally{db.close();}}
async function getWork(id){const db=await openDb();try{return await request(db.transaction(WORKS,'readonly').objectStore(WORKS).get(id));}finally{db.close();}}
async function deleteWork(id){const db=await openDb();try{await request(db.transaction(WORKS,'readwrite').objectStore(WORKS).delete(id));}finally{db.close();}}
async function setHandoff(workId){const db=await openDb();try{await request(db.transaction(HANDOFF,'readwrite').objectStore(HANDOFF).put({key:'studio',workId,createdAt:new Date().toISOString()}));}finally{db.close();}}

async function inflateRaw(bytes){if(typeof DecompressionStream!=='function')throw new Error('このブラウザでは圧縮.sceneを展開できません。');const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));return new Uint8Array(await new Response(stream).arrayBuffer());}
async function readZipEntries(file){const bytes=new Uint8Array(await file.arrayBuffer());const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const out=new Map();let p=0;while(p+4<=bytes.length){const sig=view.getUint32(p,true);if(sig===0x04034b50){if(p+30>bytes.length)throw new Error('ZIP header error');const flags=view.getUint16(p+6,true),method=view.getUint16(p+8,true),compSize=view.getUint32(p+18,true),uncompSize=view.getUint32(p+22,true),nameLen=view.getUint16(p+26,true),extraLen=view.getUint16(p+28,true);if(flags&8)throw new Error('このZIP形式には未対応です。');const ns=p+30,ds=ns+nameLen+extraLen,de=ds+compSize;if(de>bytes.length)throw new Error('ZIP overflow');const name=td.decode(bytes.slice(ns,ns+nameLen));let data=bytes.slice(ds,de);if(method===8)data=await inflateRaw(data);else if(method!==0)throw new Error('未対応のZIP圧縮方式です。');if(uncompSize&&data.length!==uncompSize)throw new Error('ZIP size error');if(name&&!name.endsWith('/'))out.set(name,data);p=de;continue;}if(sig===0x02014b50||sig===0x06054b50)break;p++;}if(!out.size)throw new Error('scene packageを読めませんでした。');return out;}
function mime(name){const n=String(name).toLowerCase();if(/\.jpe?g$/.test(n))return'image/jpeg';if(/\.png$/.test(n))return'image/png';if(/\.webp$/.test(n))return'image/webp';if(/\.gif$/.test(n))return'image/gif';return'application/octet-stream';}
function parseJson(bytes){return JSON.parse(td.decode(bytes).replace(/^\uFEFF/,''));}
async function inspectMaster(file){const entries=await readZipEntries(file);const sceneBytes=entries.get('scene.json');if(!sceneBytes)throw new Error('scene.json がありません。');const doc=parseJson(sceneBytes);const manifest=entries.get('manifest.json')?parseJson(entries.get('manifest.json')):{};const role=String(manifest.packageRole||doc?.package?.role||'').toLowerCase();if(role==='distribution')throw new Error('これは配布版です。本棚には作者の Master .scene を追加してください。');const workId=String(doc?.studio?.identity?.workId||doc?.workId||'').trim();if(!workId)throw new Error('Master の workId を確認できません。');if(!doc?.studio?.identity&&!entries.has('studio-state.json'))throw new Error('Master .scene と確認できないため追加を止めました。');let coverBlob=null;const coverPath=String(doc?.cover?.src||manifest?.cover?.image||'').replace(/^\.\//,'');if(coverPath&&entries.has(coverPath))coverBlob=new Blob([entries.get(coverPath)],{type:mime(coverPath)});return{workId,title:String(doc.title||manifest.title||'Untitled'),author:String(doc.author||manifest.author||''),sceneCount:Array.isArray(doc.scenes)?doc.scenes.length:0,revision:Number(doc?.studio?.identity?.revision||0)||0,masterCreatedAt:String(doc?.studio?.identity?.createdAt||''),coverBlob,blob:new Blob([await file.arrayBuffer()],{type:'application/octet-stream'})};}
async function addMaster(file,{silent=false}={}){const info=await inspectMaster(file);const old=await getWork(info.workId);const now=new Date().toISOString();await putWork({...info,fileName:file.name||`${info.title}.scene`,addedAt:old?.addedAt||now,updatedAt:now});if(!silent)toast(old?'同じ作品のMasterを更新しました。':'Masterを本棚に追加しました。');return info.workId;}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtDate(v){if(!v)return'—';const d=new Date(v);if(Number.isNaN(d.getTime()))return'—';return new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);}
function coverHtml(w,cls=''){if(w.coverBlob){const u=URL.createObjectURL(w.coverBlob);coverUrls.push(u);return`<div class="${cls}"><img src="${u}" alt=""></div>`;}return`<div class="${cls}"><div class="cover-fallback">□</div></div>`;}
async function render(){coverUrls.forEach(URL.revokeObjectURL);coverUrls=[];const works=(await getAllWorks()).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));$('#countText').textContent=`${works.length}作品`;$('#emptyState').hidden=works.length>0;$('#grid').innerHTML=works.map(w=>`<button class="book" data-id="${escapeHtml(w.workId)}" type="button"><div class="cover">${w.coverBlob?(()=>{const u=URL.createObjectURL(w.coverBlob);coverUrls.push(u);return`<img src="${u}" alt="">`})():`<div class="cover-fallback">□</div>`}<span class="badge">MASTER</span></div><div class="book-meta"><h3>${escapeHtml(w.title)}</h3><p>${escapeHtml(w.author||'作者未設定')} · ${w.sceneCount||0} Scene</p></div></button>`).join('');document.querySelectorAll('.book').forEach(b=>b.addEventListener('click',()=>openDetail(b.dataset.id)));}
async function openDetail(id){const w=await getWork(id);if(!w)return;currentWorkId=id;const cover=w.coverBlob?(()=>{const u=URL.createObjectURL(w.coverBlob);coverUrls.push(u);return`<div class="detail-cover"><img src="${u}" alt=""></div>`})():`<div class="detail-cover"><div class="cover-fallback">□</div></div>`;$('#detailContent').innerHTML=`<div class="detail-hero">${cover}<div class="detail-copy"><p class="eyebrow">MASTER</p><h2>${escapeHtml(w.title)}</h2><p>${escapeHtml(w.author||'作者未設定')}</p><p>${w.sceneCount||0} Scene · revision ${w.revision||0}</p><p>本棚更新 ${escapeHtml(fmtDate(w.updatedAt))}</p></div></div><section id="journeyPanel" class="journey-panel" hidden></section><div class="actions"><button id="editWork" class="edit" type="button">Studioで編集</button><button id="viewJourney" class="journey" type="button">旅を見る</button><button id="exportMaster" type="button">Masterを書き出す</button><button id="replaceMaster" type="button">Masterを更新</button><button id="removeWork" class="danger" type="button">本棚から外す</button></div><p class="detail-note">「本棚から外す」は、このブラウザ内の本棚コピーだけを削除します。手元に書き出した .scene ファイルまでは削除しません。</p>`;$('#detailDialog').showModal();$('#editWork').onclick=()=>editInStudio(w);$('#viewJourney').onclick=()=>loadJourney(w);$('#exportMaster').onclick=()=>downloadBlob(w.blob,w.fileName||`${w.title}.scene`);$('#replaceMaster').onclick=()=>{$('#fileInput').dataset.replace=id;$('#fileInput').click();};$('#removeWork').onclick=async()=>{if(!confirm(`「${w.title}」を本棚から外しますか？`))return;await deleteWork(id);$('#detailDialog').close();await render();toast('本棚から外しました。');};}
async function loadJourney(w){const panel=$('#journeyPanel'),button=$('#viewJourney');if(!panel||!button)return;panel.hidden=false;panel.innerHTML='<div class="journey-loading">旅の記録を読み込んでいます…</div>';button.disabled=true;button.textContent='読み込み中…';try{const res=await fetch(`${API_BASE}/bookshelf-insights/${encodeURIComponent(w.workId)}?days=7`,{headers:{Accept:'application/json'},cache:'no-store'});const data=await res.json().catch(()=>null);if(!res.ok||!data?.ok)throw new Error(data?.error||`HTTP ${res.status}`);renderJourney(panel,data);button.textContent='旅を更新';}catch(err){console.error(err);panel.innerHTML=`<div class="journey-error"><strong>旅の記録を読み込めませんでした。</strong><span>通信状態またはWorkerの更新を確認してください。</span></div>`;button.textContent='もう一度読み込む';}finally{button.disabled=false;}}
function workJourneyTreeSvg(journeys){
  if(!Array.isArray(journeys)||!journeys.length)return'';
  // workId を一本の根として、動きのある copyId を枝に束ねる。
  // copyId / relayId は表示せず、各一冊は「発行」の節としてだけ描画する。
  const root={type:'work',children:journeys.map(j=>j&&j.tree).filter(Boolean)};
  const nodes=[],edges=[];let leaf=0,maxLevel=0;
  function levelOf(node){
    if(node.type==='work')return 0;
    if(node.type==='issue')return 1;
    return Math.max(2,Math.max(0,Number(node.depth||0))+2);
  }
  function place(node,parent=null){
    const children=Array.isArray(node.children)?node.children:[];
    const level=levelOf(node);maxLevel=Math.max(maxLevel,level);
    let y;
    if(children.length){
      const ys=children.map(c=>place(c,node));
      y=ys.reduce((a,b)=>a+b,0)/ys.length;
    }else{y=26+(leaf++*34);}
    node.__x=30+level*78;node.__y=y;nodes.push(node);if(parent)edges.push([parent,node]);return y;
  }
  place(root);
  const width=Math.max(330,72+(maxLevel+1)*78),height=Math.max(88,54+Math.max(1,leaf-1)*34);
  const paths=edges.map(([a,b])=>{const x1=a.__x,y1=a.__y,x2=b.__x,y2=b.__y,m=(x1+x2)/2;return`<path d="M${x1} ${y1} C${m} ${y1},${m} ${y2},${x2} ${y2}"/>`;}).join('');
  const marks=nodes.map(n=>{
    if(n.type==='work')return`<g class="work-root"><path d="M${n.__x-8} ${n.__y-5}h16l-3 11h-10z"/><line x1="${n.__x}" y1="${n.__y-12}" x2="${n.__x}" y2="${n.__y-5}"/><text x="${n.__x}" y="${n.__y+20}" text-anchor="middle">作品</text></g>`;
    if(n.type==='issue')return`<g class="issue"><circle cx="${n.__x}" cy="${n.__y}" r="5"/><text x="${n.__x}" y="${n.__y+17}" text-anchor="middle">発行</text></g>`;
    if(n.type==='pending')return`<circle class="pending" cx="${n.__x}" cy="${n.__y}" r="5"/>`;
    return`<circle class="reader" cx="${n.__x}" cy="${n.__y}" r="5"/>`;
  }).join('');
  return`<div class="journey-tree-scroll"><svg class="journey-tree-svg work-tree" viewBox="0 0 ${width} ${height}" role="img" aria-label="一つの作品から読者へ広がっていく旅の木"><g class="branches">${paths}</g>${marks}</svg></div>`;
}
function renderJourney(panel,data){
  const all=data.allTime||{},recent=data.period||{},journeys=Array.isArray(data.journeys)?data.journeys:[];
  const activeCopies=journeys.length;
  const treeBlock=journeys.length?`<div class="journey-list"><div class="journey-list-head"><div><strong>作品の木</strong><small>一つの作品から、届いた分だけ枝が育ちます</small></div><span>● 到達　○ 送り出し中</span></div><div class="work-tree-meta"><span>動いている一冊 ${activeCopies}</span><span>最長 ${Math.max(0,Number(all.maxHop||0))}人</span></div>${workJourneyTreeSvg(journeys)}</div>`:`<div class="journey-empty">まだ木は育っていません。「この作品を回す」で送り出したRELAY.sceneが次のLocal Playerで開かれると、作品から枝が伸びます。</div>`;
  panel.innerHTML=`<div class="journey-head"><div><p class="eyebrow">OUTSIDE THE BOX</p><h3>外で起きていること</h3></div><span>匿名集計</span></div><div class="journey-section-label"><strong>これまで</strong><span>作品が外で動いた累計</span></div><div class="journey-stats"><div><small>観測された読者+</small><strong>${Math.max(0,Number(all.observedReaders||0))}+</strong></div><div><small>読了</small><strong>${Math.max(0,Number(all.completions||0))}</strong></div><div><small>観測された一冊</small><strong>${Math.max(0,Number(all.observedCopies||0))}</strong></div><div><small>旅に出た一冊</small><strong>${Math.max(0,Number(all.relayedCopies||0))}</strong></div><div><small>届いた回数</small><strong>${Math.max(0,Number(all.relayArrivals||0))}</strong></div><div><small>最長の旅</small><strong>${Math.max(0,Number(all.maxHop||0))}人</strong></div></div><div class="journey-recent"><div><strong>最近7日間</strong><span>いまも動いているかを見る</span></div><p><b>${Math.max(0,Number(recent.observedReaders||0))}+</b> 読者 <b>${Math.max(0,Number(recent.completions||0))}</b> 読了 <b>${Math.max(0,Number(recent.relayArrivals||0))}</b> 届いた <small>（送り出し ${Math.max(0,Number(recent.relayGenerations||0))}）</small></p></div>${treeBlock}<p class="journey-note">作品を根に、正規に発行された一冊ごとの旅を枝としてまとめています。● はRELAY.sceneが次のLocal Playerで実際に観測された到達、○ は送り出されたもののまだ次で観測されていない枝です。内部では一冊ごとのcopyIdを分けたまま保持します。Master本体・氏名・送受信相手は送信しません。</p>`;
}

async function editInStudio(w){await setHandoff(w.workId);location.href='../studio/?from=bookshelf';}
function downloadBlob(blob,name){const a=document.createElement('a');const u=URL.createObjectURL(blob);a.href=u;a.download=name||'master.scene';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),3000);}
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2500);}
function zipU16(v,o,x){v.setUint16(o,x,true)}function zipU32(v,o,x){v.setUint32(o,x>>>0,true)}function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
async function makeStoreZip(entries){const locals=[],centrals=[];let offset=0;for(const e of entries){const nb=te.encode(e.name),data=e.bytes instanceof Uint8Array?e.bytes:new Uint8Array(e.bytes),crc=crc32(data);const l=new Uint8Array(30+nb.length+data.length),lv=new DataView(l.buffer);zipU32(lv,0,0x04034b50);zipU16(lv,4,20);zipU16(lv,6,0x0800);zipU16(lv,8,0);zipU32(lv,14,crc);zipU32(lv,18,data.length);zipU32(lv,22,data.length);zipU16(lv,26,nb.length);l.set(nb,30);l.set(data,30+nb.length);locals.push(l);const c=new Uint8Array(46+nb.length),cv=new DataView(c.buffer);zipU32(cv,0,0x02014b50);zipU16(cv,4,20);zipU16(cv,6,20);zipU16(cv,8,0x0800);zipU32(cv,16,crc);zipU32(cv,20,data.length);zipU32(cv,24,data.length);zipU16(cv,28,nb.length);zipU32(cv,42,offset);c.set(nb,46);centrals.push(c);offset+=l.length;}const centralOffset=offset,centralSize=centrals.reduce((n,x)=>n+x.length,0),end=new Uint8Array(22),ev=new DataView(end.buffer);zipU32(ev,0,0x06054b50);zipU16(ev,8,entries.length);zipU16(ev,10,entries.length);zipU32(ev,12,centralSize);zipU32(ev,16,centralOffset);return new Blob([...locals,...centrals,end],{type:'application/zip'});}
async function backupShelf(){const works=await getAllWorks();if(!works.length){toast('バックアップする作品がありません。');return;}const meta={format:'ahako-local-bookshelf-backup',version:'1',exportedAt:new Date().toISOString(),works:works.map(w=>({workId:w.workId,title:w.title,fileName:w.fileName}))};const entries=[{name:'bookshelf.json',bytes:te.encode(JSON.stringify(meta,null,2))}];for(const w of works)entries.push({name:`masters/${w.workId}.scene`,bytes:new Uint8Array(await w.blob.arrayBuffer())});downloadBlob(await makeStoreZip(entries),`ahako_bookshelf_backup_${new Date().toISOString().slice(0,10)}.zip`);toast(`${works.length}作品をバックアップしました。`);}
async function restoreShelf(file){const entries=await readZipEntries(file);const metaBytes=entries.get('bookshelf.json');if(!metaBytes)throw new Error('あ箱 本棚のバックアップではありません。');const meta=parseJson(metaBytes);if(meta.format!=='ahako-local-bookshelf-backup')throw new Error('バックアップ形式が違います。');let n=0;for(const item of meta.works||[]){const bytes=entries.get(`masters/${item.workId}.scene`);if(!bytes)continue;await addMaster(new File([bytes],item.fileName||`${item.title||item.workId}.scene`),{silent:true});n++;}await render();toast(`${n}作品を復元しました。`);}

$('#addButton').onclick=$('#emptyAddButton').onclick=()=>{$('#fileInput').dataset.replace='';$('#fileInput').click();};
$('#fileInput').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const expected=e.target.dataset.replace||'';const id=await addMaster(file);if(expected&&expected!==id)toast('別作品のMasterだったため、その作品として追加しました。');$('#detailDialog').close();await render();}catch(err){alert(err.message||'Masterを追加できませんでした。');}finally{e.target.value='';e.target.dataset.replace='';}};
$('#backupButton').onclick=()=>backupShelf().catch(e=>alert(e.message));
$('#restoreButton').onclick=()=>$('#restoreInput').click();
$('#restoreInput').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{await restoreShelf(f);}catch(err){alert(err.message||'復元できませんでした。');}finally{e.target.value='';}};
$('#closeDetail').onclick=()=>$('#detailDialog').close();
render().catch(e=>{console.error(e);alert('本棚を開けませんでした。');});
})();
