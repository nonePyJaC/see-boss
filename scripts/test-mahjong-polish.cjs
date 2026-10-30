// 前端实景回归；需本机 Playwright 和 Chromium，可用 NODE_PATH、CHROME_PATH 指定。
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const { scoreHand } = await import('../shared/logic/mahjong/score.mjs')
  const { sortedHand } = await import('../client/src/lib/mahjong-view.mjs')
  const socket = net.createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', HAMSTER_ONLINE_CREATE_CODE: 'ui-test-code',
      HAMSTER_DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'mahjong-polish-')) }, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode != null) throw new Error('测试服务启动失败')
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* 等待监听 */ }
      await pause(100)
    }
    const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined)
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] })
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true })
    const page = await context.newPage(), errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const uid = `polish-${Date.now()}`
    const registered = await page.request.post(`${base}/api/account/register`, { data: { uid, account: `pp${Date.now()}`, nickname: '牌桌体验' } })
    assert.equal((await registered.json()).ok, true)
    await page.goto(`${base}/#/register`)
    await page.evaluate((value) => localStorage.setItem('hamster-poker:uid', value), uid)
    await page.reload()
    await page.getByRole('button', { name: /南京麻将/ }).click()
    await page.getByPlaceholder('输入创建码').fill('ui-test-code')
    await page.getByRole('button', { name: '创建牌桌' }).click()
    await page.getByRole('heading', { name: '等朋友入座' }).waitFor()
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '添加 AI' }).first().click()
    await page.getByRole('button', { name: '准备', exact: true }).click()
    await page.getByRole('button', { name: '开始对局' }).click()
    await page.locator('.opening-message').waitFor({ state: 'hidden' })
    await page.locator('.my-hand .hand-button').first().waitFor()
    const roomId = new URL(page.url()).hash.match(/room=(\d+)/)[1]
    const cred = await page.evaluate((id) => JSON.parse(localStorage.getItem('hamster-poker:seat:' + id)), roomId)
    const realState = async () => (await (await page.request.post(`${base}/api/room/state`, { data: { uid, roomId, ...cred } })).json()).data
    let initial = await realState()
    for (let i = 0; i < 120 && !initial.myActions?.some((a) => a.type === 'discard'); i++) {
      if (initial.myActions?.some((a) => a.type === 'pass')) {
        const pass = page.getByRole('button', { name: initial.phase === 'ready' ? '不报听' : '过', exact: true })
        if (await pass.isVisible()) await pass.click()
      }
      await pause(150); initial = await realState()
    }
    const realDiscard = initial.myActions?.find((action) => action.type === 'discard')
    assert.ok(realDiscard, '实际房间未进入本人出牌回合')
    const index = sortedHand(initial.myHand, initial.myContext?.lastDraw).findIndex((tile) => tile.code === realDiscard.tile)
    const actualTile = page.locator('.my-hand .hand-button').nth(index)
    const beforeDiscards = initial.events.filter((event) => event.type === 'discard' && event.seat === 0).length
    await actualTile.click(); await actualTile.click()
    for (let i = 0; i < 40; i++) {
      await pause(100); initial = await realState()
      if (initial.events.filter((event) => event.type === 'discard' && event.seat === 0).length > beforeDiscards) break
    }
    const realDiscards = initial.events.filter((event) => event.type === 'discard' && event.seat === 0)
    assert.equal(realDiscards.length, beforeDiscards + 1, '实际服务器只接受一次出牌')
    assert.equal(realDiscards.at(-1).tile, realDiscard.tile)
    const pong = (tile, from) => ({ type: 'pong', from, tiles: [tile, tile, tile] })
    const kong = (tile, type, from) => ({ type, from, tiles: [tile, tile, tile, tile] })
    const discards = Array.from({ length: 32 }, (_, i) => ['1m','2m','3m','4m','5m','6m','7m','8m','9m','E','S','W','N','1p','2p','3p'][i % 16])
    const player = (seat) => ({ handCount: 13, flowers: ['Z','F','B','f1','f2'],
      melds: [pong('1s', (seat + 1) % 4), kong('2s', 'kong', (seat + 2) % 4), pong('3s', (seat + 3) % 4), kong('4s', 'ankong')],
      discards, ready: false, binding: null })
    const hand = ['1m','1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','E']
    const stacks = Array.from({ length: 4 }, (_, i) => Array.from({ length: 18 }, (_, j) =>
      i === 0 ? (j === 17 ? 1 : 2) : i === 1 ? (j < 9 ? 2 : j === 9 ? 1 : 0) : 0))
    let state = { ...initial, rev: initial.rev + 100000, phase: 'turn', turn: 0, dealer: 1, double: true, wallCount: 54,
      deadlineAt: Date.now() + 300000, players: [0, 1, 2, 3].map(player), myHand: hand, myContext: { lastDraw: 'E' },
      myActions: hand.map((tile) => ({ type: 'discard', tile })), events: [],
      wallLayout: { version: 2, dice: [2, 3], breakSeat: 0, breakStack: 15, headTaken: 53, tailTaken: 37, stacks } }
    let stateResult = { ok: true, data: state }, submissions = [], stateReads = 0
    await page.route('**/api/room/state', (route) => { stateReads++; return route.fulfill({ json: stateResult }) })
    await page.route('**/api/room/action', async (route) => {
      const body = route.request().postDataJSON()
      submissions.push(body)
      await pause(350)
      state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1, turn: 1, myActions: [] }
      stateResult = { ok: true, data: state }
      await route.fulfill({ json: stateResult })
    })
    await page.waitForTimeout(800)
    for (const [width, height] of [[568, 320], [667, 375], [844, 390]]) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(120) // 等待 ResizeObserver 按实际安全区更新牌面大小。
      const layout = await page.evaluate(() => {
        const rect = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } }
        const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
        const groups = [...document.querySelectorAll('.seat-flowers .tile, .seat-melds .tile')].map((e) => ({ rect: rect(e), label: e.closest('.seat-flowers, .seat-melds').className }))
        const groupAreas = [...document.querySelectorAll('.seat-flowers, .seat-melds')].map((g) => [...g.querySelectorAll('.tile')].map(rect))
        const sensitive = [...document.querySelectorAll('.river .tile, .player-badge, .my-hand .hand-button, .opponent .back-row .tile')].map((e) => ({ rect: rect(e), label: `${e.closest('.river, .player-badge, .my-hand, .opponent')?.className} ${e.closest('.opponent')?.className ?? ''}` }))
        const walls = [...document.querySelectorAll('.tile-wall')].map(rect)
        const rivers = [...document.querySelectorAll('.river')].map((river) => [...river.querySelectorAll('.tile')].map(rect))
        return { overlaps: groups.flatMap((a) => sensitive.filter((b) => overlap(a.rect, b.rect)).map((b) => `${a.label} ↔ ${b.label}`)),
          groupOverlaps: groupAreas.some((g, i) => groupAreas.some((other, j) => i < j && g.some((a) => other.some((b) => overlap(a, b))))),
          ownBadgeOverlap: [...document.querySelectorAll('.own-badge')].map(rect).some((a) => [...document.querySelectorAll('.my-hand .hand-button')].map(rect).some((b) => overlap(a, b))),
          wallOverlaps: walls.some((a, i) => walls.some((b, j) => i < j && overlap(a, b))),
          riverOverlaps: rivers.some((r, i) => rivers.some((other, j) => i < j && r.some((a) => other.some((b) => overlap(a, b))))),
          count: [...document.querySelectorAll('.wall-stack')].reduce((sum, item) => sum + Number(item.dataset.count), 0),
          layers: document.querySelectorAll('.wall-layer').length,
          wallAssets: [...document.querySelectorAll('.wall-layer')].every((item) => item.complete && item.naturalWidth > 0 && getComputedStyle(item).objectFit === 'contain'),
          status: document.querySelector('.table-center')?.innerText }
      })
      assert.deepEqual(layout.overlaps, [], `${width}x${height} 花牌/副露遮挡其他关键元素`)
      assert.equal(layout.groupOverlaps, false, `${width}x${height} 花牌或副露彼此遮挡`)
      assert.equal(layout.ownBadgeOverlap, false, `${width}x${height} 本家头像与手牌重叠`)
      assert.equal(layout.wallOverlaps, false, `${width}x${height} 牌墙角相交`)
      assert.equal(layout.riverOverlaps, false, `${width}x${height} 高密度牌河相交`)
      assert.equal(layout.count, 54); assert.equal(layout.layers, 54)
      assert.equal(layout.wallAssets, true, '牌墙素材应可加载且保持比例')
      assert.equal(await page.locator('.wall-stack[data-count="1"]').count(), 2)
      assert.equal(await page.locator('.wall-stack[data-count="1"] .wall-layer').count(), 2)
      assert.match(layout.status, /余 54 张/)
    }
    assert.equal(await page.locator('.wall-dice, .room-tag').count(), 0)
    assert.equal(await page.getByRole('button', { name: /^打出/ }).count(), 0)
    // 放大查看只展示已公开的花牌和副露，暗杠仍须遮住三张。
    await page.locator('.seat-melds--bottom').click()
    const zoom = page.getByRole('dialog', { name: '放大查看花牌和碰杠' })
    assert.equal(await zoom.isVisible(), true)
    const zoomTile = zoom.locator('.zoom-groups .tile').first()
    assert.ok((await zoomTile.boundingBox()).width >= 24, '放大后的牌应足够大')
    assert.match(await zoomTile.locator('img').getAttribute('src'), /\?v=clear-20261030$/)
    assert.equal(await zoom.locator('img[alt="背面"]').count(), 3, '暗杠不可在放大查看中泄露')
    await zoom.locator('nav button').nth(1).click()
    assert.equal(await zoom.locator('nav button.active').count(), 1)
    await zoom.getByRole('button', { name: '关闭放大查看' }).click()
    assert.equal(submissions.length, 0, '查看花牌和碰杠不能提交出牌')

    // 无副露时，手牌可使用腾出的空间；花牌仍可点击查看。
    state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1,
      players: state.players.map((p, i) => i === 0 ? { ...p, melds: [] } : p) }
    stateResult = { ok: true, data: state }
    await page.setViewportSize({ width: 568, height: 320 })
    await page.waitForFunction((id) => document.querySelector('.board')?.dataset.windowId === String(id), state.windowId)
    await page.waitForTimeout(150)
    assert.equal(await page.locator('.my-hand--wide').count(), 1)
    assert.ok((await page.locator('.my-hand .hand-button').first().boundingBox()).width >= 27, '小屏手牌应充分利用空间')
    await page.locator('.seat-flowers--bottom').click()
    assert.equal(await zoom.isVisible(), true)
    await zoom.getByRole('button', { name: '关闭放大查看' }).click()
    assert.equal(submissions.length, 0)
    state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1, players: [0, 1, 2, 3].map(player) }
    stateResult = { ok: true, data: state }
    await page.setViewportSize({ width: 844, height: 390 })
    await page.waitForFunction((id) => document.querySelector('.board')?.dataset.windowId === String(id), state.windowId)
    await page.waitForTimeout(150)
    const expectedWindow = state.windowId
    const tiles = page.locator('.my-hand .hand-button')
    await tiles.nth(0).click()
    await tiles.nth(0).evaluate((button) => getComputedStyle(button.querySelector('.tile')).transform)
    await page.waitForFunction(() => { const b = document.querySelector('.hand-button--selected'); return b && b.getBoundingClientRect().top - b.querySelector('.tile').getBoundingClientRect().top >= 8 })
    const raised = await tiles.nth(0).evaluate((button) => ({ delta: button.getBoundingClientRect().top - button.querySelector('.tile').getBoundingClientRect().top,
      transform: getComputedStyle(button.querySelector('.tile')).transform }))
    assert.ok(raised.delta >= 8, `单击应上浮，原按钮命中区保持原位（${JSON.stringify(raised)}，${await tiles.nth(0).getAttribute('class')}）`)
    assert.equal(await page.locator('.river .tile--highlight').count(), 8, '同牌弃牌应同步高亮')
    await tiles.nth(1).click()
    assert.equal(submissions.length, 0, '同牌值的不同实体不是双点')
    await pause(500)
    await tiles.nth(1).click()
    assert.equal(submissions.length, 0, '超过双点时间需要重新点击')
    await tiles.nth(1).click()
    await pause(600)
    assert.equal(submissions.length, 1)
    assert.equal(submissions[0].action.tile, '1m')
    assert.equal(submissions[0].windowId, expectedWindow)

    // 返回本人回合；触屏 tap 会生成真实的 touch/pointer/click 合成事件。
    state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1, turn: 0, myHand: hand,
      myActions: hand.map((tile) => ({ type: 'discard', tile })) }
    stateResult = { ok: true, data: state }
    await page.waitForFunction((id) => document.querySelector('.board')?.dataset.windowId === String(id), state.windowId)
    await pause(700)
    const target = await tiles.nth(0).boundingBox()
    // 靠近牌底部点按：牌上浮后原触点仍应落在同一张牌的命中区。
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height - 2)
    if (process.env.MAHJONG_POLISH_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.MAHJONG_POLISH_EVIDENCE_DIR, 'touch-selected.png') })
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height - 2)
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height - 2)
    await pause(650)
    assert.equal(submissions.length, 2, '手机双点只发送一次，额外合成事件不重复提交')

    state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1, turn: 0, myHand: hand,
      myActions: hand.map((tile) => ({ type: 'discard', tile })) }
    stateResult = { ok: true, data: state }
    await page.waitForFunction((id) => document.querySelector('.board')?.dataset.windowId === String(id), state.windowId)
    await pause(700)
    const beforePoll = stateReads
    while (stateReads === beforePoll) await pause(10)
    await pause(330)
    await tiles.nth(0).click()
    const clickedAt = Date.now()
    state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1 }
    stateResult = { ok: true, data: state }
    await page.waitForFunction((id) => document.querySelector('.board')?.dataset.windowId === String(id), state.windowId)
    await tiles.nth(0).click()
    assert.ok(Date.now() - clickedAt < 450, '测试必须在双点时间内跨窗口')
    await pause(160)
    assert.equal(submissions.length, 2, '窗口变化后旧点击不可构成双点')
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.locator('.rotate-cover').isVisible(), true)
    await page.setViewportSize({ width: 844, height: 390 })
    assert.equal(await page.locator('.rotate-cover').isVisible(), false)
    await tiles.nth(0).click()
    await pause(160)
    assert.equal(submissions.length, 2, '竖屏往返必须清除未完成点击')
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await tiles.nth(0).click(); await tiles.nth(0).click()
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await pause(160)
    assert.equal(submissions.length, 2, '双点后的窗口变化须取消待复核出牌')
    state = { ...state, rev: state.rev + 1, windowId: state.windowId + 1, phase: 'response', turn: null,
      response: { kind: 'discard', source: 1, sourceInGarden: true }, myActions: [{ type: 'win' }, { type: 'pass' }] }
    stateResult = { ok: true, data: state }
    await page.waitForFunction((id) => document.querySelector('.board')?.dataset.windowId === String(id), state.windowId)
    assert.match(await page.locator('.risk-note').innerText(), /胡牌需向点炮者支付一份/)
    await tiles.nth(0).click(); await tiles.nth(0).click()
    assert.equal(submissions.length, 2, '响应阶段不能通过双点出牌')
    assert.deepEqual(errors, [])
    if (process.env.MAHJONG_POLISH_EVIDENCE_DIR) writeFileSync(path.join(process.env.MAHJONG_POLISH_EVIDENCE_DIR, 'touch-evidence.txt'),
      '模拟 Chromium 触屏（hasTouch / isMobile），非真实手机。\n实际本地房间：鼠标双击仅产生一次服务端弃牌。\n触屏：牌底部两次 tap 及额外 tap 合计只发送一次请求。\n不同实体、超时、窗口变化、竖屏往返和响应阶段均未错误提交。\n568×320、667×375、844×390：牌墙数、单层牌、区域与密集牌河断言通过。\n')
    console.log('麻将牌桌回归通过：三种横屏布局、真实牌墙张数、鼠标/触屏双点、窗口变化及竖屏往返。')
  } finally {
    if (browser) await browser.close()
    server.kill()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
