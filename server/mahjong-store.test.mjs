import test from 'node:test'
import assert from 'node:assert/strict'
import { openTestDb, closeDb, rawDb, loadRoomSnapshot, addHistory, deleteRoomHistory } from './db.js'
import { saveMahjongSnapshot, makeMahjongHandRecord } from './mahjong-store.mjs'

test('每手战绩与快照一起落库，重试幂等且不记录座位令牌或其他玩家暗牌', () => {
  openTestDb()
  try {
    const session = { matchId: 'match-1', handId: 1, game: { phase: 'finished', dealer: 0, double: false,
      balances: [80, 120, 100, 100], result: { type: 'win', winners: [{ seat: 1, hand: ['1m'] }] }, ledger: [] } }
    const seats = [{ nickname: 'A', kind: 'human', account: 'a', seatToken: 'secret-token' }, { nickname: 'B', kind: 'ai' }]
    const record = makeMahjongHandRecord(session, seats)
    const snapshot = { session, seats }
    saveMahjongSnapshot({ roomId: '123456', snapshot, handRecord: record })
    saveMahjongSnapshot({ roomId: '123456', snapshot, handRecord: record })
    assert.equal(loadRoomSnapshot('123456').mode, 'mahjong')
    const rows = rawDb().prepare("SELECT payload FROM history WHERE mode='mahjong'").all()
    assert.equal(rows.length, 1)
    assert.ok(!rows[0].payload.includes('secret-token'))
    assert.deepEqual(JSON.parse(rows[0].payload).result.winners[0].hand, ['1m'])
  } finally { closeDb() }
})
test('非法战绩标识不能写入快照', () => {
  openTestDb()
  try {
    assert.throws(() => saveMahjongSnapshot({ roomId: '123456', snapshot: {}, handRecord: { matchId: '', handId: 1 } }))
    assert.equal(loadRoomSnapshot('123456'), null)
  } finally { closeDb() }
})
test('房号复用后清理其他玩法历史不删除已保存的麻将战绩', () => {
  openTestDb()
  try {
    addHistory({ roomNo: '123456', mode: 'mahjong', payload: { matchId: 'old-match' } })
    addHistory({ roomNo: '123456', mode: 'offline', payload: {} })
    deleteRoomHistory('123456')
    const rows = rawDb().prepare("SELECT mode FROM history WHERE room_no='123456'").all()
    assert.deepEqual(rows.map((r) => r.mode), ['mahjong'])
  } finally { closeDb() }
})
