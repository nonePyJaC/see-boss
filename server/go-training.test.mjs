import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {openTestDb,closeDb} from './db.js';
import {handleGoTraining} from './go-training.mjs';
import {newState} from '../client/public/go-training/engine.mjs';
openTestDb();const server=http.createServer(handleGoTraining);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));test.after(()=>{server.close();closeDb();});const url='http://127.0.0.1:'+server.address().port;
const token='a'.repeat(48);async function api(body){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
test('cloud saves are isolated, durable and reject stale revision instead of overwriting another tablet',async()=>{
  const state=newState();let r=await api({operation:'create',token,state});assert.equal(r.status,201);assert.equal(r.data.version,1);
  r=await api({operation:'load',token});assert.equal(r.status,200);assert.equal(r.data.state.profiles.length,8);
  state.profiles[0].lastId=12;r=await api({operation:'save',token,version:1,state});assert.equal(r.status,200);assert.equal(r.data.version,2);
  r=await api({operation:'save',token,version:1,state:newState()});assert.equal(r.status,409);assert.equal(r.data.state.profiles[0].lastId,12);
  assert.equal((await api({operation:'load',token:'b'.repeat(48)})).status,404);
  assert.equal((await api({operation:'load',token:'bad'})).status,400);
  assert.equal((await api({operation:'save',token,version:2,state:{schema:1}})).status,400);
  const get=await fetch(url);assert.equal(get.status,405);assert.equal(get.headers.get('cache-control'),'no-store');
});
