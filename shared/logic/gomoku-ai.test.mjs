import { test } from 'node:test'
import assert from 'node:assert/strict'
import {SIZE,newGame,play} from './gomoku.mjs'
import {chooseMove} from './gomoku-ai.mjs'
const i=(x,y)=>y*SIZE+x
function position(stones,turn=1,rules={}){const s=newGame(rules);for(const [x,y,c] of stones)s.board[i(x,y)]=c;s.turn=turn;return s}
for(const level of ['easy','normal','hard']){
 test(`${level} 能完成必胜、阻止一手成五并保持原局面`,()=>{
  let s=position([[3,7,1],[4,7,1],[5,7,1],[6,7,1],[2,7,2]],1)
  let before=s.board.slice(), move=chooseMove(s,level,{random:()=>0,milliseconds:2000})
  assert.equal(play(s,move).state.winner,1);assert.deepEqual(s.board,before)
  s=position([[3,7,2],[4,7,2],[5,7,2],[6,7,2],[2,7,1]],1)
  move=chooseMove(s,level,{random:()=>0,milliseconds:2000});assert.equal(move,i(7,7))
 })
 test(`${level} 执黑时不主动落禁手`,()=>{
  const s=position([[6,7,1],[8,7,1],[7,6,1],[7,8,1]],1,{doubleThree:true,doubleFour:true,overline:true})
  const move=chooseMove(s,level,{random:()=>0,milliseconds:2000});assert.notEqual(move,i(7,7));assert.notEqual(play(s,move).state.winner,2)
 })
}
test('无合法安全落点时仍可落子并按禁手判负',()=>{
 const s=newGame({overline:true});s.board.fill(2);for(let x=0;x<5;x++)s.board[i(x,7)]=1;s.board[i(5,7)]=0;s.turn=1
 const move=chooseMove(s,'hard');assert.equal(move,i(5,7));assert.equal(play(s,move).state.winner,2)
})
test('棋局结束后不行动，空棋盘从中央开局',()=>{
 const s=newGame();assert.equal(chooseMove(s,'normal'),i(7,7));s.phase='finished';assert.equal(chooseMove(s,'hard'),null)
})

test('困难档提早防范对手形成无法同时封堵的活四', () => {
 const s=position([[7,7,1],[7,6,2],[6,6,1],[8,8,2],[6,7,1],[8,7,2],[6,5,1],[6,8,2],[5,7,1],[7,8,2],[4,7,1],[3,7,2]],1,{doubleThree:true,doubleFour:true,overline:true})
 assert.ok([i(5,8),i(9,8)].includes(chooseMove(s,'hard',{milliseconds:5000})))
})
