/**
 * 探测 rooms 表实际有哪些列。
 * 用 insert + select * 的方式反推，比猜可靠。
 * 用法：浏览器 Console 粘贴运行（在 localhost:5173 页面下）
 */
;(async () => {
  const out = {}
  try {
    const mod = await import('/src/data/cloud-repo-internal.js')
    const db = mod.getApp().rdb()
    const me = await mod.currentUid()

    const ins = await db.from('rooms').insert({
      id: '600001', mode: 'offline', game_type: 'long', host_uid: me,
      initial_seeds: 100, small_blind: 10, big_blind: 20, max_seats: 8, status: 'waiting',
    })
    out.insert = ins.error ? 'ERR: ' + ins.error.message.slice(0, 120) : 'ok'

    if (!ins.error) {
      const sel = await db.from('rooms').select('*').eq('id', '600001')
      out.row = sel.error ? 'ERR: ' + sel.error.message : sel.data
      if (sel.data?.[0]) {
        out.columns = Object.keys(sel.data[0])
        out.hasRoundStatus = 'round_status' in sel.data[0]
        out.hasAutoBlind = 'auto_blind' in sel.data[0]
      }
      await db.from('rooms').delete().eq('id', '600001')
    }
  } catch (e) {
    out.fatal = String(e?.message || e)
  }
  console.log(JSON.stringify(out, null, 1))
  return out
})()
