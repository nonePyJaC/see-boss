import {LEVELS,ANIMALS,EMOJI,coord,typeOf,Position,Session,blankResult,newState,validateState,importDesktop,makeExam} from './engine.mjs';
import {Storage} from './storage.mjs';
import {gradeFor,gradeLabel,rankLabel,awardExam,ensurePerson,importLegacy,RULES_TEXT} from './legacy-rules.mjs';
const clone=value=>JSON.parse(JSON.stringify(value));
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let bank=[],state=newState(),store,session=null,level=0,category='',mode='all',examMode=false,selected=null,hints=[],wrong=null,review=null,playTimer=null,list=[],saveChain=Promise.resolve(),backupAt=0,syncMeta={token:'',version:0,pending:false},syncTimer,syncBusy=false,dirty=0,conflict=null,lastLogical='';
const profile=()=>state.profiles[state.book], exam=()=>profile().exam;
const stats=q=>(profile().results[q.id]??=blankResult());
let toastTimer;function toast(text){$('toast').textContent=text;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500);}
function status(text){$('saveStatus').textContent=text;}
function stopPlayback(){clearInterval(playTimer);playTimer=null;$('reviewPlay').textContent='播放';}
function remember(){if(!session)return;if(examMode){if(!exam().finished)exam().current=session.data();}else{profile().practice=session.data();profile().lastId=session.q.id;}}
async function save({cloud=true}={}){
  remember();const snapshot=clone(state),logical=JSON.stringify(snapshot),changed=logical!==lastLogical;lastLogical=logical;if(changed)dirty++;if(syncMeta.token&&cloud&&changed)syncMeta.pending=true;
  saveChain=saveChain.catch(()=>{}).then(async()=>{
    if(Date.now()-backupAt>15000){const prior=await store.get('state');if(prior)await store.set('backup',prior);backupAt=Date.now();}
    await store.set('state',snapshot);await store.set('sync',syncMeta);status(syncMeta.token?(syncMeta.pending?'已保存本机，等待同步':'本机与服务器已保存'):'已自动保存到本机');
  }).catch(error=>{status('保存失败，请立即导出备份');toast('浏览器未能保存：'+error.message);});
  if(syncMeta.token&&cloud&&(changed||syncMeta.pending)){clearTimeout(syncTimer);syncTimer=setTimeout(()=>synchronize(),1800);}return saveChain;
}
function fresh(q,resume=null){const s=new Session(q);if(resume&&!s.restore(resume))return new Session(q);return s;}
function loadQuestion(q,resume=null,persist=true){stopPlayback();review=null;selected=null;hints=[];wrong=null;session=q?fresh(q,resume):null;if(q&&!examMode)profile().lastId=q.id;render();if(persist)save();}
function filtered(){return bank.filter(q=>q.level===level&&(!category||typeOf(q)===category)&&(mode==='all'||(mode==='wrong'?profile().results[q.id]?.wrongActive:profile().results[q.id]?.favorite)));}
function rebuild(choose=false){list=filtered();if(choose)loadQuestion(list[0]??null);else render();}
function restorePractice(persist=true){examMode=false;mode='all';category='';const data=profile().practice;const q=bank[data?.id]??bank[profile().lastId]??bank[0];level=q.level;$('level').value=level;$('category').value='';list=filtered();loadQuestion(q,data,persist);musicTrack();}
function switchMode(next){remember();examMode=false;mode=next;list=filtered();loadQuestion(list.find(q=>q.id===session?.q.id)??list[0]??null);musicTrack();}
function canPlay(){return session&&!review&&!session.done&&(!examMode||(!exam().answered&&!exam().finished));}
function pick(i){if(!canPlay())return;if(session.board.cells[i]){toast('这里已经有棋子');return;}if(state.confirm){selected=i;renderBoard();renderPlacement();}else play(i);}
function play(i){if(!canPlay())return;selected=null;hints=[];wrong=null;const r=session.try(i),s=stats(session.q);if(!['illegal','inactive'].includes(r.kind)&&!session.attempted){s.tries++;session.attempted=true;}
  if(r.kind==='wrong'){s.wrong++;s.wrongActive=true;wrong=i;if(examMode){exam().answered=true;session.message='本题未匹配原谱，已记录结果。';}sound('lose');}
  if(r.kind==='correct'){s.reviewed=true;if(!session.assisted&&!session.hadError){s.solved=true;s.correct++;s.wrongActive=false;if(!examMode){profile().practiceSuccess=(profile().practiceSuccess??0)+1;}}if(examMode&&!exam().answered){exam().answered=true;exam().correct++;}sound('win');}
  if(r.kind==='accepted')sound('stone');render();save();
}
function renderBoard(){
  const q=session?.q,n=q?.size??13,p=review?.position??session?.board,step=640/(n-1),start=40,points=[];
  let svg='<svg viewBox="0 0 720 720" role="group" aria-label="围棋棋盘"><defs><radialGradient id="blackStone" cx="30%" cy="25%"><stop stop-color="#596361"/><stop offset="1" stop-color="#18211f"/></radialGradient><radialGradient id="whiteStone" cx="30%" cy="25%"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#daddd0"/></radialGradient><filter id="stoneShadow" x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dx="1" dy="2" stdDeviation="1" flood-opacity=".2"/></filter></defs>';
  for(let i=0;i<n;i++){const d=start+i*step;svg+=`<path class="board-grid" d="M${d} 40V680M40 ${d}H680"/><text class="coordinate" x="${d}" y="706">${'ABCDEFGHJKLMNOPQRST'[i]}</text><text class="coordinate" x="13" y="${d}">${i+1}</text>`;}
  const stars=n===19?[3,9,15]:[3,6,9];for(const x of stars)for(const y of stars)svg+=`<circle cx="${start+x*step}" cy="${start+y*step}" r="2.8" fill="#705c3b"/>`;
  for(let x=0;x<n;x++)for(let y=0;y<n;y++){const i=x*19+y,c=p?.cells[i]??0,cx=start+x*step,cy=start+y*step,r=step*.455;points.push(i);
    if(c)svg+=`<circle class="stone" cx="${cx}" cy="${cy}" r="${r}" fill="url(#${c===1?'blackStone':'whiteStone'})" stroke="${c===1?'#25332b':'#c0c5b4'}" stroke-width=".7" filter="url(#stoneShadow)"/>`;
    if(p?.last===i&&c)svg+=`<text class="stone-last" x="${cx}" y="${cy}" fill="${c===1?'#fff':'#273a2b'}" style="font-size:${Math.max(12,step*.3)}px">${review?review.step:session.moves.length}</text>`;
    if(hints.includes(i))svg+=`<circle class="hint-point" cx="${cx}" cy="${cy}" r="${step*.22}"/>`;
    if(wrong===i)svg+=`<circle class="wrong-point" cx="${cx}" cy="${cy}" r="${step*.25}"/>`;
    if(selected===i)svg+=`<circle class="selection" cx="${cx}" cy="${cy}" r="${r}"/>`;
    svg+=`<circle class="hit" cx="${cx}" cy="${cy}" r="${step*.49}" role="button" tabindex="${canPlay()?'0':'-1'}" aria-label="${coord(i)} ${c===1?'黑棋':c===2?'白棋':'空点'}" aria-disabled="${!canPlay()}" data-point="${i}"/>`;
  }
  $('board').innerHTML=svg+'</svg>';
}
function renderPlacement(){const ok=selected!==null&&canPlay();$('selectedPoint').textContent=ok?'已选 '+coord(selected)+' · 黑棋':state.confirm?'轻点交叉点选择落点':'直接点击交叉点落子';$('confirmPlace').disabled=!ok;$('cancelPlace').disabled=!ok;$('placement').hidden=!!review;}
function renderList(){
  const before=$('questionList').scrollTop;
  $('questionList').innerHTML=list.length?list.map(q=>{const r=profile().results[q.id];return `<button role="option" aria-selected="${session?.q.id===q.id}" data-q="${q.id}" class="${session?.q.id===q.id?'active ':''}${r?.solved?'solved':r?.wrongActive?'wrong':''}"><span class="dot"></span><span>${String(q.number).padStart(4,'0')}</span><span>${typeOf(q)}</span>${r?.favorite?'<span class="q-star">★</span>':''}</button>`;}).join(''):'<p class="muted">这一档暂时没有'+(mode==='wrong'?'待复习错题':mode==='favorite'?'收藏':'题目')+'。</p>';
  $('questionList').scrollTop=before;$('listCount').textContent=list.length+' 题';
}
function render(){
  const q=session?.q,e=exam(),locked=examMode&&!e?.finished,rs=q?(profile().results[q.id]??blankResult()):null;
  $('book').value=state.book;$('bookEmoji').textContent=EMOJI[state.book];$('level').value=level;$('level').disabled=locked;$('category').disabled=locked;
  document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',!examMode&&b.dataset.mode===mode));
  const mastered=bank.filter(x=>x.level===level&&profile().results[x.id]?.solved).length,total=bank.filter(x=>x.level===level).length;
  $('mastered').textContent=mastered;$('total').textContent=' / '+total.toLocaleString();$('progressBar').style.width=mastered/total*100+'%';
  $('modeBadge').textContent=examMode?'级位考核 '+(e.index+1)+' / 10':mode==='wrong'?'错题回顾':mode==='favorite'?'我的收藏':'题库练习';
  $('questionTitle').textContent=q?q.title:'这一档暂时没有题目';$('questionMeta').textContent=q?LEVELS[q.level]+' · 第 '+q.number+' 题 · '+(q.number>1000?'拓展题 · ':'')+'黑先':'换一个档位或分类继续练习';
  $('favorite').textContent=rs?.favorite?'★':'☆';$('favorite').disabled=!q||locked;$('favorite').setAttribute('aria-label',rs?.favorite?'取消收藏':'收藏本题');
  $('message').textContent=review?'正在查看原谱，可逐手播放或切换变化。':examMode&&e.finished?'本轮答对 '+e.correct+' / 10 题，评定为 '+(e.gradeLabel??rankLabel(e.rank))+'。':session?.message??'换一个档位，继续探索棋盘。';
  $('turnLabel').textContent=review?'原谱复盘':examMode&&e.finished?'考核完成':session?.done?'这一题完成了':'轮到黑棋';
  $('questionStatus').textContent=q?'原谱 '+q.answers.length+' 条变化 · 已行 '+session.moves.length+' 手\n'+(rs?.solved?'已独立完成':rs?.reviewed?'已学习，试试独立重做':'答案与应手来自原题库')+(profile().legacyProgress?' · 旧版累计答对 '+profile().legacyProgress.success+' 题':''):'';
  const idx=list.findIndex(x=>x.id===q?.id);
  $('reset').disabled=!q||examMode;$('undo').disabled=!q||examMode||!!review||!session.moves.length;$('hint').disabled=!canPlay()||examMode;$('answer').disabled=!q||locked;
  const stageEnd=q?.number===1000&&mode==='all'&&!category;
  $('previous').disabled=!q||examMode||idx<1;$('next').disabled=!q||(examMode?e.finished:idx<0||idx===list.length-1);$('next').textContent=locked?(e.answered?'下一题 →':'跳过此题'):stageEnd?(q.level<5?'下一档 →':'完成原版练习'):'下一题 →';
  $('examStart').hidden=locked;$('examStart').textContent=e&&!e.finished?'继续上次考核':'开始本档考核';$('examPause').hidden=!examMode;
  $('examDescription').textContent=locked?'已答对 '+e.correct+' 题。考核中不提供提示、悔棋和答案。':'本档随机10题，按原版分数表换算级位。银、金证书按累计达标次数授予。';
  $('review').hidden=!review;if(review){$('reviewStep').textContent='第 '+review.step+' / '+q.answers[review.branch].length+' 手 · '+(q.title.includes('劫')?'劫材按原谱省略':'黑白交替落子');}
  renderList();renderBoard();renderPlacement();
}
function navigate(delta){if(!session)return;if(delta===1&&session.q.number===1000&&mode==='all'&&!category){if(level===5){profile().originalPracticeComplete=true;save();toast('原版六档练习已到终点，额外124题可按题号选择。');return;}level++;$('level').value=level;list=filtered();loadQuestion(list[0]);toast('进入 '+LEVELS[level]+' 练习');return;}const index=list.findIndex(q=>q.id===session.q.id);const next=list[index+delta];if(next)loadQuestion(next);}
function startExam(){remember();try{const name=(!exam()?.finished&&exam()?.name)||state.recipient.trim()||'棋友';ensurePerson(state,name);state.recipient=name;}catch(e){toast(e.message);fillSettings();$('settings').showModal();return;}if(!profile().exam||exam().finished){profile().exam=makeExam(bank,level);exam().name=state.recipient;}exam().name??=state.recipient;examMode=true;level=exam().level;category='';$('category').value='';selected=null;list=filtered();const q=bank[exam().queue[exam().index]];loadQuestion(q,exam().current?.id===q.id?exam().current:null);if(exam().answered){session.message='本题已作答，继续下一题。';render();}musicTrack();}
function nextExam(){const e=exam();if(e.finished)return;if(!e.answered){const r=stats(session.q);if(!session.attempted)r.tries++;r.wrong++;r.wrongActive=true;e.answered=true;}
  if(e.index===9){e.finished=true;e.rank=gradeFor(e.level,e.correct);e.gradeLabel=gradeLabel(e.level,e.correct);e.name??=state.recipient.trim()||'棋友';e.completedAt=new Date().toISOString();const cert=awardExam(state,e.name,e.rank);e.certificate=cert;profile().history.push(clone(e));if(cert)profile().certificates.push(cert);review=null;render();save();toast('考核完成：'+e.gradeLabel);return;}
  e.index++;e.answered=false;e.current=null;loadQuestion(bank[e.queue[e.index]]);
}
function reviewTo(step){if(!review||!session)return;const path=session.q.answers[review.branch];review.step=Math.max(0,Math.min(path.length,step));review.position=new Position(session.q.board,session.q.size);for(let i=0;i<review.step;i++)if(!review.position.play(path[i],1+i%2,true).ok)throw Error('原谱重放失败');render();}
function showAnswer(){if(!session)return;session.assisted=true;selected=null;hints=[];wrong=null;stopPlayback();review={branch:0,step:0,position:new Position(session.q.board,session.q.size)};$('variation').innerHTML=session.q.answers.map((path,i)=>`<option value="${i}">变化 ${i+1} · ${path.length} 手</option>`).join('');reviewTo(0);save();}
const effects=Object.fromEntries(['stone','win','lose'].map(k=>[k,new Audio(new URL('./audio/'+k+'.wav',import.meta.url))]));
const bgm=new Audio();bgm.loop=true;bgm.volume=.22;let bgmKey='';
function sound(key){if(!state.sound)return;const a=effects[key];a.currentTime=0;a.play().catch(()=>{});}
function musicTrack(){if(!state.music){bgm.pause();return;}const key=examMode?'exam':'practice';if(bgmKey!==key){bgm.src=new URL('./audio/'+key+'.wav',import.meta.url);bgmKey=key;}bgm.play().catch(()=>{toast('请再次轻点音乐开关以启用播放。');});}
function download(name,text,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function exportState(){remember();download('围棋进度-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(state,null,2));}
async function replaceState(next){await store.set('backup',clone(state));state=validateState(next);syncMeta.pending=!!syncMeta.token;restorePractice();fillSettings();await save();}
function certificateMarkup(c){return `<div class="certificate"><h3>${c.award==='gold'?'金质':'银质'}级位证书</h3><strong>${esc(c.name)}</strong><p>完成本软件的围棋级位检定<br>学习成绩达到 <b>${rankLabel(c.rank)}</b><br>本级累计达标 ${c.count} 次</p><p>${esc(new Date(c.date).toLocaleDateString('zh-CN'))}</p><small>一手围棋 · 原版评定规则训练记录<br>非棋协正式认证</small></div>`;}
function certificateSvg(c){return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="850"><rect width="1200" height="850" fill="#fcf8ea"/><rect x="30" y="30" width="1140" height="790" fill="none" stroke="#b58a49" stroke-width="4"/><rect x="44" y="44" width="1112" height="762" fill="none" stroke="#c7ac79"/><g text-anchor="middle" fill="#67502b" font-family="sans-serif"><text x="600" y="160" font-size="54">${c.award==='gold'?'金质':'银质'}级位证书</text><text x="600" y="300" font-size="48">${esc(c.name)}</text><text x="600" y="400" font-size="32">围棋级位训练成绩达到 ${rankLabel(c.rank)}</text><text x="600" y="470" font-size="28">本级累计达标 ${c.count} 次</text><text x="600" y="610" font-size="24">${esc(new Date(c.date).toLocaleDateString('zh-CN'))}</text><text x="600" y="730" font-size="18">一手围棋 · 软件训练记录，非棋协正式认证</text></g></svg>`;}
function historyDialog(){
  const p=profile();$('historyBody').innerHTML=p.history.length||p.certificates.length?p.history.slice().reverse().map(e=>typeof e==='string'?`<article class="history-entry"><p>${esc(e).replace(/\n/g,'<br>')}</p></article>`:`<article class="history-entry"><h3>${esc(e.gradeLabel??rankLabel(e.rank))} · ${e.correct} / 10 题</h3><p>${esc(e.name)} · ${LEVELS[e.level]}<br>${esc(new Date(e.completedAt).toLocaleString('zh-CN'))}</p></article>`).join('')+p.certificates.slice().reverse().map((c,i)=>certificateMarkup(c)+`<button data-cert="${p.certificates.length-1-i}">下载这张证书</button>`).join('')+'<div class="button-row"><button id="exportHistory">导出成绩记录</button><button id="printCertificate">打印成绩与证书</button></div>':'<p class="muted">完成一次考核后，这里会保留成绩。某级累计达到5次获得银质证书，10次获得金质证书。</p>';
  $('history').showModal();
}
function fillSettings(){$('confirmSetting').checked=state.confirm;$('soundSetting').checked=state.sound;$('musicSetting').checked=state.music;$('recipient').value=state.recipient;$('studentSelect').innerHTML='<option value="">选择已保存的学员</option>'+Object.keys(state.people??{}).map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');$('studentSelect').value=Object.hasOwn(state.people??{},state.recipient)?state.recipient:'';renderStudent();$('syncCode').value=syncMeta.token;$('syncStatus').textContent=syncMeta.token?(syncMeta.pending?'已连接，等待上传本机更新。':'已连接到服务器进度。'):'尚未连接同步码，本机自动保存照常可用。';}
function renderStudent(){const p=state.people?.[$('studentSelect').value];$('studentCounts').textContent=p?p.counts.map((n,rank)=>n?rankLabel(rank)+' '+n+'次':'').filter(Boolean).join(' · ')||'还没有级位达标记录':'最多保存5位学员。学员的级位次数独立于动物练习书签。';}
async function api(operation,extra={}){const r=await fetch('/api/go-training/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,token:syncMeta.token,...extra})});const data=await r.json();if(r.status===409){conflict=data;$('conflict').showModal();throw Error('两台设备都有更新，请选择要保留的进度。');}if(!r.ok)throw Error(data.error||'同步暂时失败');return data;}
async function synchronize(){if(!syncMeta.token||syncBusy||conflict)return;syncBusy=true;const tick=dirty,token=syncMeta.token;try{
    if(syncMeta.pending){const data=await api('save',{version:syncMeta.version,state:clone(state)});if(token!==syncMeta.token)return;syncMeta.version=data.version;syncMeta.pending=dirty!==tick;await store.set('sync',syncMeta);status(syncMeta.pending?'本机有新进度，继续同步中':'本机与服务器已保存');}
    else{const data=await api('load');if(dirty!==tick||token!==syncMeta.token)return;if(data.version!==syncMeta.version){await store.set('backup',clone(state));state=validateState(data.state);lastLogical=JSON.stringify(state);syncMeta.version=data.version;await store.set('state',state);await store.set('sync',syncMeta);restorePractice(false);}status('本机与服务器已保存');}
    $('syncStatus').textContent='同步完成 · '+new Date().toLocaleTimeString('zh-CN');
  }catch(error){$('syncStatus').textContent=error.message;status('已保留本机，服务器同步待完成');}finally{syncBusy=false;if(syncMeta.pending&&!conflict){clearTimeout(syncTimer);syncTimer=setTimeout(()=>synchronize(),15000);}}
}
async function initialize(){
  store=await new Storage().open();const cached=await store.get('state');if(cached)try{state=validateState(cached);}catch{await store.set('invalid-backup',cached);toast('旧进度格式异常，已保留备份。');}lastLogical=JSON.stringify(state);
  syncMeta=await store.get('sync')??syncMeta;bank=await(await fetch('./questions.v1.json')).json();if(bank.length!==6124)throw Error('题库未加载完整，请刷新重试。');
  $('book').innerHTML=ANIMALS.map((x,i)=>`<option value="${i}">${x}书签</option>`).join('');$('level').innerHTML=LEVELS.map((x,i)=>`<option value="${i}">${x}</option>`).join('');$('legacyRules').textContent=RULES_TEXT;
  $('level').onchange=()=>{remember();examMode=false;level=+$('level').value;rebuild(true);musicTrack();};$('category').onchange=()=>{category=$('category').value;rebuild(true);};
  $('book').onchange=()=>{remember();state.book=+$('book').value;restorePractice();};document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>switchMode(b.dataset.mode));
  $('questionList').onclick=e=>{const b=e.target.closest('[data-q]');if(b&&!examMode){loadQuestion(bank[+b.dataset.q]);document.querySelector('.library').classList.remove('open-list');}};
  document.querySelector('.list-head').setAttribute('role','button');document.querySelector('.list-head').tabIndex=0;document.querySelector('.list-head').onclick=()=>document.querySelector('.library').classList.toggle('open-list');document.querySelector('.list-head').onkeydown=e=>{if(e.key==='Enter'||e.key===' ')document.querySelector('.library').classList.toggle('open-list');};
  $('jumpBtn').onclick=()=>{if(examMode)return;const q=bank.find(q=>q.level===level&&q.number===+$('jump').value);if(q){mode='all';category='';$('category').value='';list=filtered();loadQuestion(q);}else toast('这一档没有这个题号。');};$('jump').onkeydown=e=>{if(e.key==='Enter')$('jumpBtn').click();};
  $('board').onclick=e=>{const p=e.target.closest('[data-point]');if(p)pick(+p.dataset.point);};$('board').onkeydown=e=>{const p=e.target.closest('[data-point]');if(!p)return;const i=+p.dataset.point;let target;if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(i);return;}const d={ArrowLeft:-19,ArrowRight:19,ArrowUp:-1,ArrowDown:1}[e.key];if(d){e.preventDefault();target=i+d;if(target>=0&&Math.floor(target/19)<session.q.size&&target%19<session.q.size)$('board').querySelector(`[data-point="${target}"]`)?.focus();}};
  $('confirmPlace').onclick=()=>{if(selected!==null)play(selected);};$('cancelPlace').onclick=()=>{selected=null;renderBoard();renderPlacement();};
  $('favorite').onclick=()=>{const r=stats(session.q);r.favorite=!r.favorite;render();save();};$('reset').onclick=()=>loadQuestion(session.q);$('undo').onclick=()=>{session.undo();selected=null;hints=[];wrong=null;render();save();};$('hint').onclick=()=>{session.assisted=true;hints=[...session.node.next.keys()];session.message='已圈出本手可选的原谱落点。';render();save();};$('answer').onclick=showAnswer;$('previous').onclick=()=>navigate(-1);$('next').onclick=()=>examMode?nextExam():navigate(1);
  $('variation').onchange=()=>{stopPlayback();review.branch=+$('variation').value;reviewTo(0);};$('reviewBack').onclick=()=>{stopPlayback();reviewTo(review.step-1);};$('reviewNext').onclick=()=>{stopPlayback();reviewTo(review.step+1);};$('reviewPlay').onclick=()=>{if(playTimer){stopPlayback();return;}if(review.step===session.q.answers[review.branch].length)reviewTo(0);$('reviewPlay').textContent='暂停';playTimer=setInterval(()=>{if(review.step===session.q.answers[review.branch].length)stopPlayback();else reviewTo(review.step+1);},650);};
  $('examStart').onclick=startExam;$('examPause').onclick=()=>{remember();restorePractice();};$('historyBtn').onclick=historyDialog;$('historyBody').onclick=e=>{const cert=e.target.closest('[data-cert]');if(cert){const c=profile().certificates[+cert.dataset.cert];download('围棋级位证书.svg',certificateSvg(c),'image/svg+xml');}if(e.target.id==='exportHistory')download('围棋成绩记录.txt',profile().history.map(e=>typeof e==='string'?e:`${e.name} ${LEVELS[e.level]} ${e.correct}/10 ${e.gradeLabel??rankLabel(e.rank)} ${new Date(e.completedAt).toLocaleString('zh-CN')}`).join('\n'),'text/plain;charset=utf-8');if(e.target.id==='printCertificate')window.print();};
  $('settingsBtn').onclick=()=>{fillSettings();$('settings').showModal();};$('helpBtn').onclick=()=>$('help').showModal();
  $('confirmSetting').onchange=()=>{state.confirm=$('confirmSetting').checked;selected=null;renderPlacement();save();};$('soundSetting').onchange=()=>{state.sound=$('soundSetting').checked;save();sound('stone');};$('musicSetting').onchange=()=>{state.music=$('musicSetting').checked;musicTrack();save();};$('recipient').onchange=()=>{state.recipient=$('recipient').value.trim();save();};
  $('studentSelect').onchange=()=>{if($('studentSelect').value){state.recipient=$('studentSelect').value;$('recipient').value=state.recipient;save();}renderStudent();};
  $('addStudent').onclick=()=>{const name=$('recipient').value.trim();if(!name)return toast('请先填写学员姓名或昵称。');try{ensurePerson(state,name);state.recipient=name;save();fillSettings();toast('学员已保存。');}catch(e){toast(e.message);}};
  $('resetStudent').onclick=async()=>{const name=$('studentSelect').value;if(!name)return toast('请先选择一位学员。');await store.set('backup',clone(state));state.people[name].counts=Array(31).fill(0);save();renderStudent();toast('已重置该学员级位次数，可恢复上份备份撤销。');};
  $('deleteStudent').onclick=async()=>{const name=$('studentSelect').value;if(!name)return toast('请先选择一位学员。');if(state.profiles.some(p=>p.exam&&!p.exam.finished&&p.exam.name===name))return toast('这位学员有未完成的考核，请完成后再移出名单。');await store.set('backup',clone(state));delete state.people[name];if(state.recipient===name)state.recipient='';save();fillSettings();toast('已移出名单，可恢复上份备份撤销。');};
  $('export').onclick=exportState;$('importBtn').onclick=()=>$('importFile').click();$('importFile').onchange=async()=>{const f=$('importFile').files[0];if(!f)return;try{if(f.size>8*1024*1024)throw Error('文件超过8MiB');const next=f.name.toLowerCase().endsWith('.dat')?importLegacy(await f.arrayBuffer(),bank):importDesktop(JSON.parse(await f.text()));await replaceState(next);toast('已导入进度，原本机进度已备份。');}catch(error){toast('导入未成功：'+error.message);}finally{$('importFile').value='';}};
  $('restoreBackup').onclick=async()=>{const backup=await store.get('backup');if(!backup)return toast('暂时没有上一份本机备份。');await replaceState(backup);toast('已恢复备份，刚才的进度仍可再恢复。');};
  $('createSync').onclick=async()=>{if(syncBusy)return;syncBusy=true;try{await saveChain;await store.set('backup',clone(state));const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);const old=syncMeta;syncMeta={token:[...bytes].map(v=>v.toString(16).padStart(2,'0')).join(''),version:0,pending:false};try{const data=await api('create',{state:clone(state)});syncMeta.version=data.version;await store.set('sync',syncMeta);fillSettings();toast('同步码已创建，请在另一台设备输入。');}catch(e){syncMeta=old;throw e;}}catch(e){toast(e.message);}finally{syncBusy=false;}};
  $('connectSync').onclick=async()=>{if(syncBusy)return toast('正在同步，请稍后再连接。');const token=$('syncCode').value.replace(/\s/g,'').toLowerCase();if(!/^[a-f0-9]{48}$/.test(token))return toast('请输入完整的48位同步码。');const old=syncMeta;try{syncMeta={token,version:0,pending:false};const data=await api('load');await store.set('backup',clone(state));state=validateState(data.state);syncMeta.version=data.version;await store.set('state',state);await store.set('sync',syncMeta);restorePractice(false);fillSettings();toast('已连接，原本机进度已备份。');}catch(e){syncMeta=old;toast(e.message);}};
  $('syncNow').onclick=()=>synchronize();$('disconnectSync').onclick=async()=>{clearTimeout(syncTimer);syncMeta={token:'',version:0,pending:false};await store.set('sync',syncMeta);fillSettings();status('已自动保存到本机');toast('仅断开本机，服务器进度仍保留。');};
  $('conflictExport').onclick=exportState;$('useRemote').onclick=async()=>{if(!conflict)return;await store.set('backup',clone(state));state=validateState(conflict.state);syncMeta.version=conflict.version;syncMeta.pending=false;conflict=null;$('conflict').close();await store.set('state',state);await store.set('sync',syncMeta);restorePractice(false);fillSettings();};$('useLocal').onclick=async()=>{if(!conflict)return;await store.set('conflict-remote',conflict.state);syncMeta.version=conflict.version;syncMeta.pending=true;conflict=null;$('conflict').close();await store.set('sync',syncMeta);synchronize();};
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){save();bgm.pause();}else{if(state.music)musicTrack();if(syncMeta.token&&!syncMeta.pending)synchronize();}});
  document.addEventListener('click',e=>{const d=e.target.closest('dialog');if(d&&e.target===d)d.close();});restorePractice(false);if(!cached)save({cloud:false});if(syncMeta.token){clearTimeout(syncTimer);syncTimer=setTimeout(()=>synchronize(),1000);}
}
initialize().catch(error=>{$('questionTitle').textContent='加载未完成';$('questionMeta').textContent='请刷新页面重试';$('message').textContent=error.message;status('尚未加载，请保留现有备份');console.error(error);});
