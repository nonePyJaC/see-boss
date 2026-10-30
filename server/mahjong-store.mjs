/** 麻将快照和每手战绩在同一 SQLite 事务中保存，复用既有房间与历史表。 */
import { getDb } from './db.js'

export function saveMahjongSnapshot({ roomId, snapshot, handRecord = null, close = false }) {
  if (!/^\d{6}$/.test(String(roomId))) throw new Error('房间号无效')
  if (!snapshot || typeof snapshot !== 'object') throw new Error('快照无效')
  if (handRecord && (!handRecord.matchId || !Number.isSafeInteger(handRecord.handId) || handRecord.handId < 1)) throw new Error('战绩标识无效')
  const db = getDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    if (close) db.prepare('DELETE FROM room_snapshots WHERE room_id=?').run(String(roomId))
    else db.prepare(`INSERT INTO room_snapshots (room_id, mode, state, updated_at)
      VALUES (?, 'mahjong', ?, datetime('now')) ON CONFLICT(room_id) DO UPDATE SET
      mode=excluded.mode, state=excluded.state, updated_at=excluded.updated_at`).run(String(roomId), JSON.stringify(snapshot))
    if (handRecord) {
      const exists = db.prepare(`SELECT id FROM history WHERE mode='mahjong'
        AND json_extract(payload, '$.matchId')=? AND json_extract(payload, '$.handId')=? LIMIT 1`)
        .get(handRecord.matchId, handRecord.handId)
      if (!exists) {
        db.prepare(`INSERT INTO history (room_no, mode, round_no, payload, created_by)
          VALUES (?, 'mahjong', ?, ?, ?)`).run(String(roomId), handRecord.handId,
          JSON.stringify(handRecord), handRecord.createdBy ?? '')
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 战绩仅存公共结算和赢家手牌，座位凭证和其他人的私牌不进入历史。 */
export function makeMahjongHandRecord(session, seats) {
  if (!session?.game || session.game.phase !== 'finished') return null
  return {
    matchId: session.matchId, handId: session.handId, dealer: session.game.dealer,
    double: session.game.double, balances: session.game.balances.slice(),
    result: structuredClone(session.game.result), ledger: session.game.ledger.map((entry, eventIndex) => ({ ...structuredClone(entry),
      transfers: entry.transfers.map((transfer, transferIndex) => ({ ...structuredClone(transfer), id: `${session.matchId}:${session.handId}:${eventIndex}:${transferIndex}` })) })),
    seats: seats.map(({ nickname, kind, account }) => ({ nickname, kind, account: account ?? null })),
    createdBy: seats.find((s) => s.account)?.account ?? '',
  }
}

export function makeAbandonedMahjongHandRecord(session, seats) {
  if (!session?.game || session.game.phase === 'finished') return makeMahjongHandRecord(session, seats)
  const game = { ...session.game, phase: 'finished', result: { type: 'abandoned', winners: [], matchOver: true } }
  return makeMahjongHandRecord({ ...session, game }, seats)
}
