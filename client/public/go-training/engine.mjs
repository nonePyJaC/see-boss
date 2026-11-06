if(!Object.hasOwn)Object.hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export const LEVELS = ['20–30级','14–19级','10–13级','7–9级','4–6级','1–3级'];
export const ANIMALS = ['老虎','大象','狒狒','飞龙','猩猩','狮子','海象','公牛'];
export const EMOJI = ['🐯','🐘','🐒','🐲','🦍','🦁','🦭','🐂'];
export const coord = i => 'ABCDEFGHJKLMNOPQRST'[Math.floor(i/19)]+(i%19+1);
export const category = q => ['对杀','手筋','死活'].find(s=>q.title.includes(s))+'题';
export const typeOf = q => q.title.includes('对杀')?'对杀题':q.title.includes('手筋')?'手筋题':q.title.includes('死活')?'死活题':'基础题';
export class Position {
  constructor(setup,size=13){this.cells=typeof setup==='string'?Uint8Array.from(setup,Number):Uint8Array.from(setup);this.size=size;this.previous=null;this.last=null;}
  copy(){const p=new Position(this.cells,this.size);p.previous=this.previous?.slice()??null;p.last=this.last;return p;}
  near(i){const x=Math.floor(i/19),y=i%19;return [x>0?i-19:-1,x+1<this.size?i+19:-1,y>0?i-1:-1,y+1<this.size?i+1:-1].filter(v=>v>=0);}
  group(cells,i){const seen=new Set([i]),todo=[i];let liberty=false;while(todo.length)for(const j of this.near(todo.pop())){if(!cells[j])liberty=true;else if(cells[j]===cells[i]&&!seen.has(j)){seen.add(j);todo.push(j);}}return {seen,liberty};}
  play(i,color,canonicalKo=false){
    if(!Number.isInteger(i)||i<0||Math.floor(i/19)>=this.size||i%19>=this.size)return {ok:false,error:'请在棋盘交叉点落子。'};
    if(this.cells[i])return {ok:false,error:'这里已经有棋子。'};
    const next=this.cells.slice();next[i]=color;let captured=0;
    for(const j of this.near(i))if(next[j]===3-color){const g=this.group(next,j);if(!g.liberty)for(const k of g.seen){next[k]=0;captured++;}}
    if(!this.group(next,i).liberty)return {ok:false,error:'这一步没有气，不能落子。'};
    if(!canonicalKo&&this.previous&&next.every((v,j)=>v===this.previous[j]))return {ok:false,ko:true,error:'不能立即回提，请先找劫材。'};
    this.previous=this.cells;this.cells=next;this.last=i;return {ok:true,captured};
  }
}
export function tree(q){const root={done:false,next:new Map()};for(const path of q.answers){let node=root;for(const point of path){if(!node.next.has(point))node.next.set(point,{done:false,next:new Map()});node=node.next.get(point);}node.done=true;}return root;}
export class Session {
  constructor(q){this.q=q;this.board=new Position(q.board,q.size);this.node=tree(q);this.moves=[];this.done=false;this.assisted=false;this.hadError=false;this.attempted=false;this.message='黑棋先行，找到关键的一手。';}
  restore(data){
    if(!data||data.id!==this.q.id||!Array.isArray(data.moves)||data.moves.length>150)return false;
    for(const i of data.moves){const next=this.node.next.get(i);if(!next||!this.board.play(i,1+this.moves.length%2,true).ok)return false;this.moves.push(i);this.node=next;}
    this.done=this.node.done;this.assisted=!!data.assisted;this.hadError=!!data.hadError;this.attempted=!!data.attempted;this.message=this.done?'这道题已完成，继续下一题吧。':this.moves.length?'已恢复上次局面，轮到黑棋。':this.message;return true;
  }
  data(){return {id:this.q.id,moves:this.moves,assisted:this.assisted,hadError:this.hadError,attempted:this.attempted};}
  try(i){
    if(this.done)return {kind:'inactive'};const candidate=this.board.copy(),legal=candidate.play(i,1);
    if(!legal.ok){this.message=legal.error;return {kind:'illegal'};}
    const next=this.node.next.get(i);if(!next){this.hadError=true;this.message='这一步不是原谱答案，再观察一下。';return {kind:'wrong'};}
    this.board=candidate;this.moves.push(i);this.node=next;
    if(this.node.done){this.done=true;this.message='回答正确，这一题完成了。';return {kind:'correct',captured:legal.captured};}
    const reply=[...this.node.next.keys()].sort((a,b)=>a-b)[0];const applied=this.board.play(reply,2);
    if(!applied.ok&&(!applied.ko||!this.board.play(reply,2,true).ok))throw Error('原谱应手无法重放');
    this.moves.push(reply);this.node=this.node.next.get(reply);this.done=this.node.done;
    this.message=applied.ko?'原谱省略了外部劫材，白棋按原谱应手。':'白棋已应手，轮到黑棋。';return {kind:this.done?'correct':'accepted',captured:legal.captured};
  }
  undo(){const keep=this.moves.slice(0,Math.max(0,this.moves.length-(this.moves.length%2?1:2)));const next=new Session(this.q);next.restore({...this.data(),moves:keep,assisted:true});Object.assign(this,next);this.message='已回到上一次黑棋落子前。';}
}
export const blankResult=()=>({tries:0,correct:0,wrong:0,solved:false,reviewed:false,favorite:false,wrongActive:false});
export const newState=()=>({schema:1,book:0,sound:false,music:false,confirm:true,recipient:'',people:{},profiles:ANIMALS.map(name=>({name,lastId:0,results:{},practice:null,exam:null,history:[],certificates:[],streaks:{}}))});
export function validateState(value){
  if(!value||value.schema!==1||!Number.isInteger(value.book)||value.book<0||value.book>7||!Array.isArray(value.profiles)||value.profiles.length!==8)throw Error('这不是有效的围棋训练进度文件。');
  value.people??={};if(typeof value.people!=='object'||Array.isArray(value.people)||Object.keys(value.people).length>5)throw Error('学员名单无效');
  for(const [name,person] of Object.entries(value.people))if(!name||name.length>30||!person||!Array.isArray(person.counts)||person.counts.length!==31||person.counts.some(n=>!Number.isSafeInteger(n)||n<0))throw Error('学员级位计数无效');
  value.recipient=String(value.recipient??'').slice(0,24);
  for(const p of value.profiles){if(!p||typeof p.name!=='string'||p.name.length>30||!p.results||Array.isArray(p.results)||typeof p.results!=='object')throw Error('书签数据不完整。');
    if(!Number.isInteger(p.lastId)||p.lastId<0||p.lastId>=6124)throw Error('题号无效。');
    if(Object.keys(p.results).length>6124)throw Error('题目记录过多。');
    for(const [id,r] of Object.entries(p.results)){if(!/^\d+$/.test(id)||+id>=6124||!r||typeof r!=='object')throw Error('答题记录无效。');for(const k of ['tries','correct','wrong'])if(!Number.isSafeInteger(r[k])||r[k]<0)throw Error('答题次数无效。');}
    p.history??=[];p.certificates??=[];p.streaks??={};if(!Array.isArray(p.history)||p.history.length>10000||!Array.isArray(p.certificates)||p.certificates.length>10000)throw Error('成绩记录格式无效。');
    if(p.exam){const e=p.exam;if(!Array.isArray(e.queue)||e.queue.length!==10||new Set(e.queue).size!==10||e.queue.some(i=>!Number.isInteger(i)||i<0||i>=6124)||!Number.isInteger(e.index)||e.index<0||e.index>=10||!Number.isInteger(e.correct)||e.correct<0||e.correct>10||!Number.isInteger(e.level)||e.level<0||e.level>5)throw Error('考级记录无效。');}
  }return value;
}
export function importDesktop(raw){
  if(raw.schema===1)return validateState(raw);
  if(raw.Version!==1||raw.Profiles?.length!==8)throw Error('暂不支持这个版本的进度文件。');
  const state=newState();state.book=raw.ActiveBook;state.sound=!!raw.Sound;state.music=!!raw.Music;
  const resume=r=>r?{id:r.QuestionId,moves:r.Moves,assisted:r.Assisted,hadError:r.HadError,attempted:r.AttemptRecorded}:null;
  state.profiles=raw.Profiles.map(p=>({...newState().profiles[0],name:p.Name,lastId:p.LastId,practice:resume(p.Practice),results:Object.fromEntries(Object.entries(p.Results).map(([id,r])=>[id,{tries:r.Tries,correct:r.Correct,wrong:r.Wrong,solved:!!r.Solved,reviewed:!!r.Reviewed,favorite:!!r.Favorite,wrongActive:!!r.WrongActive}])),history:Array.isArray(p.ExamHistory)?p.ExamHistory:[],exam:p.Exam&&!p.Exam.Finished?{level:p.Exam.Level,index:p.Exam.Index,correct:p.Exam.Correct,queue:p.Exam.Queue,answered:!!p.Exam.Answered,finished:false,current:resume(p.Exam.Current),started:p.Exam.Started,source:'desktop'}:null}));return validateState(state);
}
export function makeExam(bank,level,rng=Math.random){const ids=bank.filter(q=>q.level===level).map(q=>q.id);for(let i=ids.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[ids[i],ids[j]]=[ids[j],ids[i]];}return {level,index:0,correct:0,queue:ids.slice(0,10),answered:false,finished:false,current:null,started:new Date().toISOString()};}
