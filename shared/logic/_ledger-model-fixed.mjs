// 修复后的行为（对应 db/fix-ledger-accounting.sql）
// 与上一个文件的旧版模型对照，看差异落在哪。

// ── 修复版 account_seed_transfer：只清本次两方的归零行 ──
function transferFixed(rows, seedMap, from, to, amount) {
  const add = (owner, peer, count) => {
    const r = rows.find((x) => x.owner === owner && x.peer === peer)
    if (r) r.count += count
    else rows.push({ owner, peer, count })
  }
  add(from, to, -amount)
  add(to, from, +amount)
  seedMap[from] -= amount
  seedMap[to] += amount
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.count === 0 && (r.owner === from || r.owner === to)) rows.splice(i, 1)
  }
}

// ── 修复版 clear_account_ledger_row：双方同时冲销 ──
function clearFixed(rows, seedMap, owner, peer) {
  const mine = rows.find((r) => r.owner === owner && r.peer === peer)
  if (!mine) return 0
  const theirs = rows.find((r) => r.owner === peer && r.peer === owner)
  seedMap[owner] -= mine.count
  if (theirs) seedMap[peer] -= theirs.count
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if ((r.owner === owner && r.peer === peer) || (r.owner === peer && r.peer === owner)) rows.splice(i, 1)
  }
  return mine.count
}

export { transferFixed, clearFixed }
