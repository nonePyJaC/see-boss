import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.LISTEN='0'
process.env.HAMSTER_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'gomoku-http-'))
process.env.HAMSTER_ONLINE_CREATE_CODE='test-code'
const {server}=await import('./index.js')
const {closeDb}=await import('./db.js')
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${server.address().port}`
test.after(()=>{server.close();closeDb()})
async function api(url,body) { return (await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json() }
async function register(uid,account,nickname){assert.equal((await api('/api/account/register',{uid,account,nickname})).ok,true)}
const auth = (uid,data) => ({uid,roomId:data.id,seatId:data.seatId,seatToken:data.seatToken})
test('双人房间：创建码、入座、认证、落子顺序、禁手、重放及结束',async()=>{
 await register('host','gomokuhost','黑棋');await register('guest','gomokuguest','白棋');await register('third','gomokuthird','第三人')
 const config={mode:'online',gameType:'gomoku',rules:{doubleThree:true,doubleFour:true,overline:true}}
 assert.equal((await api('/api/room/create',{uid:'host',me:{nickname:'黑棋'},cfg:config})).code,'BAD_CREATE_CODE')
 const created=await api('/api/room/create',{uid:'host',me:{nickname:'黑棋'},cfg:config,createCode:'test-code'})
 assert.equal(created.ok,true,created.error);assert.equal(created.data.gameType,'gomoku');const host=auth('host',created.data)
 assert.equal((await api('/api/room/start',host)).code,'NOT_ENOUGH_PLAYERS')
 const joined=await api('/api/room/join',{uid:'guest',roomId:host.roomId,me:{nickname:'白棋'}});assert.equal(joined.ok,true,joined.error);const guest=auth('guest',joined.data)
 assert.equal((await api('/api/room/join',{uid:'third',roomId:host.roomId})).code,'ROOM_FULL')
 const listed=await api('/api/room/list',{uid:'host'});assert.equal(listed.data.rooms.find(r=>r.roomNo===host.roomId).maxSeats,2)
 assert.equal((await api('/api/room/start',guest)).code,'NOT_HOST')
 assert.equal((await api('/api/room/action',{...host,seatToken:'wrong'})).code,'AUTH_FAILED')
 assert.equal((await api('/api/room/add-ai',host)).code,'UNSUPPORTED')
 const start=await api('/api/room/start',host);assert.equal(start.ok,true,start.error);const game=start.data.game
 assert.equal(game.rules.doubleThree,true);assert.equal(game.turn,1)
 assert.equal((await api('/api/room/action',{...guest,matchId:game.matchId,moveNo:0,index:0})).code,'NOT_YOUR_TURN')
 let played=await api('/api/room/action',{...host,matchId:game.matchId,moveNo:0,index:0});assert.equal(played.data.game.board[0],1)
 assert.equal((await api('/api/room/action',{...host,matchId:game.matchId,moveNo:0,index:1})).code,'STALE_MOVE')
 played=await api('/api/room/action',{...guest,matchId:game.matchId,moveNo:1,index:1});assert.equal(played.data.game.board[1],2)
 assert.equal((await api('/api/room/action',{...host,matchId:game.matchId,moveNo:2,index:1})).code,'INVALID_MOVE')
 assert.equal((await api('/api/room/start',host)).code,'GAME_IN_PROGRESS')
 assert.equal((await api('/api/room/leave',guest)).ok,true)
 const state=await api('/api/room/state',host);assert.equal(state.data.game.winner,1);assert.equal(state.data.game.reason,'对手离开')
 assert.equal((await api('/api/room/leave',host)).data.roomClosed,true)
})

test('服务器拒绝黑棋三三禁手并允许继续落子', async () => {
 await register('host2','gohost2','甲方'); await register('guest2','goguest2','乙方')
 const created=await api('/api/room/create',{uid:'host2',me:{nickname:'甲'},createCode:'test-code',cfg:{mode:'online',gameType:'gomoku',rules:{doubleThree:true}}})
 assert.equal(created.ok,true,created.error);const host=auth('host2',created.data)
 const joined=await api('/api/room/join',{uid:'guest2',roomId:host.roomId});assert.equal(joined.ok,true);const guest=auth('guest2',joined.data)
 const started=await api('/api/room/start',host);let game=started.data.game
 const sequence=[[host,111],[guest,0],[host,113],[guest,1],[host,97],[guest,2],[host,127],[guest,3]]
 for(const [seat,index] of sequence){const r=await api('/api/room/action',{...seat,index,moveNo:game.moveNo,matchId:game.matchId});assert.equal(r.ok,true,r.error);game=r.data.game}
 const denied=await api('/api/room/action',{...host,index:112,moveNo:game.moveNo,matchId:game.matchId})
 assert.equal(denied.code,'INVALID_MOVE');assert.equal(denied.error,'三三禁手')
 const state=await api('/api/room/state',host);assert.equal(state.data.game.moveNo,8);assert.equal(state.data.game.board[112],0)
 const valid=await api('/api/room/action',{...host,index:114,moveNo:game.moveNo,matchId:game.matchId});assert.equal(valid.ok,true,valid.error)
 await api('/api/room/leave',host)
})

