import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// Single-user deployment policy: discard transient rooms, preserve identities and keys.
// Called only after stopping the app and backing up the database.
export function clearDeploymentRoomData(file) {
  if (!fs.existsSync(file)) return { history: 0, rooms: 0 }
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE')
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    const removed = {}
    for (const table of ['history', 'room_snapshots']) {
      removed[table === 'history' ? 'history' : 'rooms'] = exists.get(table)
        ? db.prepare(`DELETE FROM ${table}`).run().changes : 0
    }
    db.exec('COMMIT')
    return removed
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* Keep the original cleanup error. */ }
    throw error
  } finally { db.close() }
}
