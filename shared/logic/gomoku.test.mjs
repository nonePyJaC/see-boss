import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIZE, newGame, play } from './gomoku.mjs'
const i = (x,y) => y*SIZE+x
function position(stones, rules={}) { const s=newGame(rules); for (const [x,y,c=1] of stones) s.board[i(x,y)]=c; return s }
test('先后手、落点、横竖斜胜负和满盘', () => {
  let s=newGame(); s=play(s,i(0,0)).state; assert.equal(s.turn,2); assert.ok(play(s,i(0,0)).error)
  for (const dir of [[1,0],[0,1],[1,1],[1,-1]]) {
    const [dx,dy]=dir, stones=Array.from({length:4},(_,n)=>[5+n*dx,7+n*dy]); const p=position(stones)
    const result=play(p,i(5+4*dx,7+4*dy)).state; assert.equal(result.winner,1); assert.equal(result.phase,'finished')
  }
})
test('三三、四四、长连可独立开启，成五优先', () => {
 const cross=[[6,7],[8,7],[7,6],[7,8]]
 assert.equal(play(position(cross,{doubleThree:true}),i(7,7)).error,'三三禁手')
 assert.ok(play(position(cross),i(7,7)).state)
 const four=[[5,7],[6,7],[8,7],[7,5],[7,6],[7,8]]
 assert.equal(play(position(four,{doubleFour:true}),i(7,7)).error,'四四禁手')
 const over=[[3,7],[4,7],[5,7],[6,7],[8,7]]
 assert.equal(play(position(over,{overline:true}),i(7,7)).error,'长连禁手')
 assert.equal(play(position(over),i(7,7)).state.winner,1)
 const exact=[[3,7],[4,7],[5,7],[6,7],[7,5],[7,6],[7,8],[6,6],[8,8]]
 assert.equal(play(position(exact,{doubleThree:true,doubleFour:true,overline:true}),i(7,7)).state.winner,1)
})
test('被边界或白子堵住的假活三不算三三；白棋不受禁手约束', () => {
 let p=position([[0,1],[2,1],[1,0],[1,2]],{doubleThree:true}); assert.ok(play(p,i(1,1)).state)
 p=position([[6,7],[8,7],[7,6],[7,8],[5,7,2]],{doubleThree:true}); assert.ok(play(p,i(7,7)).state)
 p=position([[6,7,2],[8,7,2],[7,6,2],[7,8,2]],{doubleThree:true,doubleFour:true,overline:true}); p.turn=2; assert.ok(play(p,i(7,7)).state)
})


test('假三：延伸点形成禁手长连时不计活三', () => {
 const stones=[[6,7],[8,7],[7,6],[7,8],...([2,3,4,5,6].flatMap(y=>[[5,y],[9,y]]))]
 const strict=position(stones,{doubleThree:true,overline:true})
 assert.ok(play(strict,i(7,7)).state)
})
test('满盘且无五连判平', () => {
 const s=newGame(); for(let y=0;y<SIZE;y++) for(let x=0;x<SIZE;x++) s.board[i(x,y)]=(x+2*y)%4<2?1:2
 s.board[i(0,0)]=0; s.turn=1
 const result=play(s,i(0,0)).state; assert.equal(result.phase,'finished'); assert.equal(result.winner,0)
})


test('允许长连时六连获胜优先于其他禁手', () => {
 const stones=[[3,7],[4,7],[5,7],[6,7],[8,7],[7,6],[7,8],[6,6],[8,8]]
 const r=play(position(stones,{doubleThree:true,doubleFour:true,overline:false}),i(7,7))
 assert.equal(r.state?.winner,1)
})
