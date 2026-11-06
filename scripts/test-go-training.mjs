import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Position,Session,newState,validateState,makeExam,importDesktop} from '../client/public/go-training/engine.mjs';
import {GRADE_TABLES,gradeFor,gradeLabel,awardExam,importLegacy} from '../client/public/go-training/legacy-rules.mjs';
const bank=JSON.parse(fs.readFileSync(new URL('../client/public/go-training/questions.v1.json',import.meta.url)));
test('all 6124 questions, 7356 branches, 23056 moves and every automatic reply replay correctly',()=>{
  assert.equal(bank.length,6124);let branches=0,moves=0,ko=0;
  for(const q of bank){for(const path of q.answers){const p=new Position(q.board,q.size);for(let step=0;step<path.length;step++){const a=p.play(path[step],1+step%2);if(!a.ok){assert.equal(a.ko,true,`${q.id} ${step}: ${a.error}`);assert.equal(p.play(path[step],1+step%2,true).ok,true);ko++;}moves++;}branches++;const s=new Session(q);assert.equal(s.restore({id:q.id,moves:path}),true);assert.equal(s.done,true);}
    const s=new Session(q);while(!s.done){const r=s.try([...s.node.next.keys()].sort((a,b)=>a-b)[0]);assert.ok(['accepted','correct'].includes(r.kind),q.id+':'+JSON.stringify(r));}s.undo();assert.equal(s.done,false);
  }
  assert.equal(branches,7356);assert.equal(moves,23056);assert.equal(ko,9);
});
test('illegal and noncanonical moves do not alter canonical board; simple ko is forbidden',()=>{
  const s=new Session(bank[0]),before=s.board.cells.slice();assert.equal(s.try(12*19+12).kind,'wrong');assert.deepEqual(s.board.cells,before);assert.equal(s.hadError,true);
  assert.equal(s.try(1).kind,'illegal');const p=new Position('0'.repeat(361),13);p.cells[1]=p.cells[19]=2;assert.equal(p.play(0,1).ok,false);assert.equal(p.cells[0],0);
});
test('exact original six grade tables and cumulative silver/gold thresholds',()=>{
  const ranks=[[-1,30,28,27,26,25,24,23,22,21,20],[-1,-1,-1,20,19,18,17,16,15,14,13],[-1,-1,-1,-1,-1,-1,13,12,11,10,9],[-1,-1,-1,-1,-1,-1,9,9,8,7,6],[-1,-1,-1,-1,-1,-1,-1,6,5,4,3],[-1,-1,-1,-1,-1,-1,3,3,2,1,0]];
  for(let l=0;l<6;l++)for(let n=0;n<=10;n++){assert.equal(gradeFor(l,n),ranks[l][n]);assert.equal(typeof gradeLabel(l,n),'string');}
  assert.equal(GRADE_TABLES.length,6);const state=newState();for(let i=0;i<4;i++)assert.equal(awardExam(state,'测试棋友',20),null);assert.equal(awardExam(state,'测试棋友',20).award,'silver');awardExam(state,'测试棋友',19);for(let i=0;i<4;i++)awardExam(state,'测试棋友',20);assert.equal(awardExam(state,'测试棋友',20).award,'gold');assert.equal(state.people['测试棋友'].counts[19],1);assert.equal(awardExam(state,'测试棋友',-1),null);
});
test('exam selects ten distinct questions from chosen bank; state and desktop import validate',()=>{
  for(let l=0;l<6;l++){const e=makeExam(bank,l);assert.equal(e.queue.length,10);assert.equal(new Set(e.queue).size,10);assert.ok(e.queue.every(id=>bank[id].level===l));}
  const state=newState();assert.equal(validateState(JSON.parse(JSON.stringify(state))).schema,1);state.people.bad={counts:[1]};assert.throws(()=>validateState(state));
  const old={Version:1,ActiveBook:0,Sound:false,Music:false,Profiles:Array.from({length:8},(_,i)=>({Name:'书签'+i,LastId:0,Results:{},Practice:null}))};assert.equal(importDesktop(old).profiles.length,8);
});
test('original gosave imports exact eight slots and five-person counters without inventing dates',()=>{
  const b=new ArrayBuffer(132+144),v=new DataView(b);v.setInt32(4,1,true);v.setInt32(8,23,true);v.setInt32(12,20,true);v.setInt32(16,6,true);v.setInt32(128,1,true);new Uint8Array(b).set(new TextEncoder().encode('TEST'),132);v.setInt32(132+20+20*4,5,true);
  const state=importLegacy(b,bank);assert.equal(state.profiles[0].lastId,1);assert.equal(state.profiles[0].legacyProgress.success,23);assert.equal(state.profiles[0].legacyProgress.reward,20);assert.equal(state.profiles[1].legacyProgress.complete,true);assert.equal(state.people.TEST.counts[20],5);assert.equal(state.profiles[0].history.length,0);assert.equal(state.profiles[0].certificates.length,0);assert.equal(validateState(state).schema,1);assert.throws(()=>importLegacy(new ArrayBuffer(131),bank));
});
