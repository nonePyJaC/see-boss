import {newState} from './engine.mjs';
export const RULES_TEXT='原版考级每轮10题、每题10分，六档分别使用原版分数表换算级位（最高档满分为有段）。各学员相应级位累计达标5次银质、10次金质；最多5名学员，独立于8个动物练习书签。原版顺序练习每档1000题，其余124题保留为拓展题。';
export function gradeFor(level,correct){if(!Number.isInteger(level)||level<0||level>5||!Number.isInteger(correct)||correct<0||correct>10)throw Error('考级分数无效');return GRADE_TABLES[level][correct].rank;}
export function gradeLabel(level,correct){return GRADE_TABLES[level][correct].label.replace(/級/g,'级').replace(/\.$/,'');}
export const rankLabel=rank=>rank<0?'低于本档范围':rank===0?'有段':rank+'级';
export function ensurePerson(state,name){
  state.people??={};if(!Object.hasOwn(state.people,name)){if(Object.keys(state.people).length>=5)throw Error('原版支持最多5位学员，请先选择已有学员或管理名单。');Object.defineProperty(state.people,name,{value:{counts:Array(31).fill(0)},enumerable:true,writable:true,configurable:true});}
  return state.people[name];
}
export function awardExam(state,name,rank){
  const person=ensurePerson(state,name);if(rank<0)return null;const count=++person.counts[rank];if(count<5)return null;
  return {name,rank,count,award:count>=10?'gold':'silver',date:new Date().toISOString()};
}
export function importLegacy(buffer,bank){
  if(buffer.byteLength<132)throw Error('旧版存档长度不足');const v=new DataView(buffer),count=v.getInt32(128,true);
  if(count<0||count>5||buffer.byteLength!==132+144*count)throw Error('不是完整的旧版 gosave.dat 存档。');
  const s=newState();s.people={};
  for(let book=0;book<8;book++){
    const off=book*16,l=v.getInt32(off,true),index=v.getInt32(off+4,true),success=v.getInt32(off+8,true),reward=v.getInt32(off+12,true);
    if(l<0||l>6||index<0||index>1000||success<0||reward<0)throw Error('旧版书签数据异常。');
    const completed=l===6||(l===5&&index===1000),p=s.profiles[book],actual=completed?5:index===1000?l+1:l,q=bank.find(q=>q.level===actual&&q.number===(completed?1000:index===1000?1:index+1));
    if(!q)throw Error('书签题号未找到');p.lastId=q.id;p.legacyProgress={level:l,resumeIndex:index,success,reward,complete:l===6};
  }
  const bytes=new Uint8Array(buffer),decode=new TextDecoder('gbk');
  for(let i=0;i<count;i++){
    const raw=bytes.slice(132+i*20,152+i*20),end=raw.indexOf(0),name=decode.decode(end<0?raw:raw.slice(0,end)).trim();
    if(!name||name.includes('\ufffd')||Object.hasOwn(s.people,name))throw Error('旧版学员姓名无法识别或重复。');
    const counts=[];for(let rank=0;rank<31;rank++){const n=v.getInt32(132+20*count+i*124+rank*4,true);if(n<0)throw Error('旧版级位计数异常');counts.push(n);}
    Object.defineProperty(s.people,name,{value:{counts,imported:true},enumerable:true,writable:true,configurable:true});
  }
  s.recipient=Object.keys(s.people)[0]??'';s.legacyImported=true;return s;
}
export const GRADE_TABLES=[[{"correct":0,"score":0,"rank":-1,"label":"30級以下"},{"correct":1,"score":10,"rank":30,"label":"30級"},{"correct":2,"score":20,"rank":28,"label":"28級"},{"correct":3,"score":30,"rank":27,"label":"27級"},{"correct":4,"score":40,"rank":26,"label":"26級"},{"correct":5,"score":50,"rank":25,"label":"25級"},{"correct":6,"score":60,"rank":24,"label":"24級"},{"correct":7,"score":70,"rank":23,"label":"23級"},{"correct":8,"score":80,"rank":22,"label":"22級"},{"correct":9,"score":90,"rank":21,"label":"21級"},{"correct":10,"score":100,"rank":20,"label":"20級以上"}],[{"correct":0,"score":0,"rank":-1,"label":"20級以下"},{"correct":1,"score":10,"rank":-1,"label":"20級以下"},{"correct":2,"score":20,"rank":-1,"label":"20級以下"},{"correct":3,"score":30,"rank":20,"label":"20級"},{"correct":4,"score":40,"rank":19,"label":"19級"},{"correct":5,"score":50,"rank":18,"label":"18級"},{"correct":6,"score":60,"rank":17,"label":"17級"},{"correct":7,"score":70,"rank":16,"label":"16級"},{"correct":8,"score":80,"rank":15,"label":"15級"},{"correct":9,"score":90,"rank":14,"label":"14級"},{"correct":10,"score":100,"rank":13,"label":"14級以上"}],[{"correct":0,"score":0,"rank":-1,"label":"13級以下"},{"correct":1,"score":10,"rank":-1,"label":"13級以下"},{"correct":2,"score":20,"rank":-1,"label":"13級以下"},{"correct":3,"score":30,"rank":-1,"label":"13級以下"},{"correct":4,"score":40,"rank":-1,"label":"13級以下"},{"correct":5,"score":50,"rank":-1,"label":"13級以下"},{"correct":6,"score":60,"rank":13,"label":"13級"},{"correct":7,"score":70,"rank":12,"label":"12級"},{"correct":8,"score":80,"rank":11,"label":"11級"},{"correct":9,"score":90,"rank":10,"label":"10級"},{"correct":10,"score":100,"rank":9,"label":"10級以上"}],[{"correct":0,"score":0,"rank":-1,"label":"9級以下"},{"correct":1,"score":10,"rank":-1,"label":"9級以下"},{"correct":2,"score":20,"rank":-1,"label":"9級以下"},{"correct":3,"score":30,"rank":-1,"label":"9級以下"},{"correct":4,"score":40,"rank":-1,"label":"9級以下"},{"correct":5,"score":50,"rank":-1,"label":"9級以下"},{"correct":6,"score":60,"rank":9,"label":"9級"},{"correct":7,"score":70,"rank":9,"label":"9級"},{"correct":8,"score":80,"rank":8,"label":"8級"},{"correct":9,"score":90,"rank":7,"label":"7級"},{"correct":10,"score":100,"rank":6,"label":"7級以上"}],[{"correct":0,"score":0,"rank":-1,"label":"6級以下"},{"correct":1,"score":10,"rank":-1,"label":"6級以下"},{"correct":2,"score":20,"rank":-1,"label":"6級以下"},{"correct":3,"score":30,"rank":-1,"label":"6級以下"},{"correct":4,"score":40,"rank":-1,"label":"6級以下"},{"correct":5,"score":50,"rank":-1,"label":"6級以下"},{"correct":6,"score":60,"rank":-1,"label":"6級以下"},{"correct":7,"score":70,"rank":6,"label":"6級"},{"correct":8,"score":80,"rank":5,"label":"5級"},{"correct":9,"score":90,"rank":4,"label":"4級"},{"correct":10,"score":100,"rank":3,"label":"3級以上"}],[{"correct":0,"score":0,"rank":-1,"label":"3級以下"},{"correct":1,"score":10,"rank":-1,"label":"3級以下"},{"correct":2,"score":20,"rank":-1,"label":"3級以下"},{"correct":3,"score":30,"rank":-1,"label":"3級以下"},{"correct":4,"score":40,"rank":-1,"label":"3級以下"},{"correct":5,"score":50,"rank":-1,"label":"3級以下"},{"correct":6,"score":60,"rank":3,"label":"3級"},{"correct":7,"score":70,"rank":3,"label":"3級"},{"correct":8,"score":80,"rank":2,"label":"2級"},{"correct":9,"score":90,"rank":1,"label":"1級."},{"correct":10,"score":100,"rank":0,"label":"有段"}]];
