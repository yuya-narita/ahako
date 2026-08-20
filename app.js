const heroLines=[
  {text:'次の一文は、\nあなたが開く。',mode:'solo'},
  {text:'文章を、',mode:'stack'},
  {text:'一度に見せない。',mode:'stack'},
  {text:'それだけで。',mode:'stack'},
  {text:'読む時間が、\n体験になる。',mode:'solo'},
];
let heroIndex=0;
const heroCurrent=document.getElementById('heroCurrent');
const heroHistory=document.getElementById('heroHistory');
const heroProgress=document.getElementById('heroProgress');
function renderHero(){
  const item=heroLines[heroIndex];
  heroCurrent.innerHTML=item.text.replace(/\n/g,'<br>');
  if(item.mode==='solo') heroHistory.innerHTML='';
  else heroHistory.innerHTML=heroLines.slice(Math.max(0,heroIndex-2),heroIndex).filter(x=>x.mode!=='solo').map(x=>x.text.replace(/\n/g,' ')).join('<br>');
  heroProgress.style.width=((heroIndex+1)/heroLines.length*100)+'%';
}
document.getElementById('heroTap').addEventListener('click',()=>{heroIndex=(heroIndex+1)%heroLines.length;renderHero()});
renderHero();

const demos={
  story:{title:'物語',kicker:'STORY DEMO',note:'「次の一文がまだ見えない」こと自体を演出に使います。',lines:[
    {text:'夜の廊下に、\n足音がひとつ。',mode:'solo'},
    {text:'止まった。',mode:'stack'},
    {text:'私も、止まる。',mode:'stack'},
    {text:'もう一度。',mode:'stack'},
    {text:'今度は、\n私の後ろから。',mode:'solo',class:'warning'}]},
  letter:{title:'手紙・メッセージ',kicker:'LETTER DEMO',note:'文章を積み重ね、伝えたい一言だけを単独表示できます。',lines:[
    {text:'あなたへ。',mode:'solo'},
    {text:'普段は、\nこういうことを言わないけど。',mode:'stack'},
    {text:'いてくれて良かったなって',mode:'stack'},
    {text:'よく思います。',mode:'stack'},
    {text:'ありがとう。',mode:'solo'}]},
  museum:{title:'展示ガイド',kicker:'EXHIBIT GUIDE',note:'スマホの画面ではなく、目の前の実物へ視線を戻す使い方です。',lines:[
    {text:'まず、スマホを少し下げてください。',mode:'solo'},
    {text:'目の前の作品を見てください。',mode:'stack'},
    {text:'右下に、\n小さな欠けがあります。',mode:'solo'},
    {text:'そこだけ、\n少し色が違いませんか？',mode:'stack'},
    {text:'もう一度、\n作品全体を見てください。',mode:'solo'}]},
  showroom:{title:'ショールーム',kicker:'SHOWROOM GUIDE',note:'商品知識を並べるのではなく、見る・触る順番を設計します。',lines:[
    {text:'この車、\nまずドアノブを探してください。',mode:'solo'},
    {text:'……見つかりましたか？',mode:'stack'},
    {text:'目立たないのは、\n意図的です。',mode:'stack'},
    {text:'次に、\nドアを閉める音を聞いてください。',mode:'solo'},
    {text:'この音も、\n設計されています。',mode:'solo'}]},
  quiz:{title:'クイズ・教材',kicker:'LEARNING DEMO',note:'考える時間を確保してから、答えを開示できます。',lines:[
    {text:'1kgの鉄と\n1kgの綿。',mode:'solo'},
    {text:'重いのは、\nどちら？',mode:'stack'},
    {text:'考えてから、\n次へ。',mode:'stack'},
    {text:'同じ。',mode:'solo'},
    {text:'では、なぜ綿の方が\n軽く感じる？',mode:'solo'}]},
  asmr:{title:'瞑想・ASMR',kicker:'SILENCE DEMO',note:'文章のない時間や、環境音を聞く時間もSceneとして設計できます。',lines:[
    {text:'目を閉じてください。',mode:'solo',class:'soft'},
    {text:'一度だけ、\nゆっくり息を吐く。',mode:'solo',class:'soft'},
    {text:'……',mode:'solo',class:'soft'},
    {text:'今、聞こえた音を\n一つだけ覚えてください。',mode:'solo',class:'soft'},
    {text:'それで十分です。',mode:'solo',class:'soft'}]},
  horror:{title:'ホラー・サスペンス',kicker:'SUSPENSE DEMO',note:'画像を見せすぎず、文章と間で読者の想像を残します。',lines:[
    {text:'誰もいない。',mode:'solo'},
    {text:'そう思って、\n電気を消した。',mode:'stack'},
    {text:'暗くなった。',mode:'stack'},
    {text:'それから。',mode:'solo'},
    {text:'部屋の奥で、\n誰かが息を吐いた。',mode:'solo',class:'warning'}]},
};

const modal=document.getElementById('demoModal'),current=document.getElementById('demoCurrent'),historyEl=document.getElementById('demoHistory'),sub=document.getElementById('demoSub'),count=document.getElementById('demoCount'),bar=document.getElementById('demoBar'),note=document.getElementById('demoNote'),title=document.getElementById('demoTitle'),kicker=document.getElementById('demoKicker');
let demoKey='story',demoIndex=0;
function renderDemo(){
  const d=demos[demoKey],item=d.lines[demoIndex];
  current.textContent=item.text; current.className='demo-current'+(item.mode==='solo'?' solo':'')+(item.class?' '+item.class:'');
  if(item.mode==='solo') historyEl.innerHTML=''; else {
    const prev=d.lines.slice(Math.max(0,demoIndex-3),demoIndex).filter(x=>x.mode!=='solo');
    historyEl.innerHTML=prev.map((x,i)=>`<div style="opacity:${.25+i*.18}">${x.text.replace(/\n/g,' ')}</div>`).join('');
  }
  sub.textContent= demoIndex===0 ? 'タップして進む' : '';
  count.textContent=`${demoIndex+1} / ${d.lines.length}`;bar.style.width=((demoIndex+1)/d.lines.length*100)+'%';
}
function openDemo(key){demoKey=key;demoIndex=0;const d=demos[key];title.textContent=d.title;kicker.textContent=d.kicker;note.textContent=d.note;renderDemo();modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden'}
function closeDemo(){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.style.overflow=''}
document.querySelectorAll('.js-open-demo').forEach(b=>b.addEventListener('click',()=>openDemo(b.dataset.demo)));
document.getElementById('demoTap').addEventListener('click',()=>{const len=demos[demoKey].lines.length;demoIndex=(demoIndex+1)%len;renderDemo()});
document.getElementById('demoRestart').addEventListener('click',()=>{demoIndex=0;renderDemo()});
document.getElementById('demoClose').addEventListener('click',closeDemo);document.getElementById('demoBackdrop').addEventListener('click',closeDemo);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDemo()});

const menu=document.getElementById('mobileMenu');document.getElementById('menuButton').addEventListener('click',()=>menu.classList.add('open'));document.getElementById('closeMenu').addEventListener('click',()=>menu.classList.remove('open'));menu.querySelectorAll('a,.js-open-demo').forEach(x=>x.addEventListener('click',()=>menu.classList.remove('open')));
