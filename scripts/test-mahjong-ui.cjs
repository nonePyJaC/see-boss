// 页面回归：需本机安装 Playwright 和 Chromium；可通过 NODE_PATH、CHROME_PATH 指定。
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtempSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

async function main() {
  const { scoreHand } = await import('../shared/logic/mahjong/score.mjs')
  const socket = net.createServer()
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.resolve(__dirname, '..'), windowsHide: true,
    env: { ...process.env, PORT: String(port), HAMSTER_DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'mahjong-ui-review-')),
      HAMSTER_ONLINE_CREATE_CODE: 'ui-test-code', NODE_ENV: 'test' }, stdio: 'ignore' })
  let browser
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error('测试服务启动失败')
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* 等待服务 */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined)
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 568, height: 320 } })
    const errors = []; page.on('pageerror', (e) => errors.push(e.message))
    const uid = `review-${Date.now()}`
    const registered = await page.request.post(`${base}/api/account/register`, { data: { uid, account: `ui${Date.now()}`, nickname: '页面测试' } })
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
    const stateResponse = await page.request.post(`${base}/api/room/state`, { data: { uid, roomId, ...cred } })
    const state = (await stateResponse.json()).data
    const pong = (tile, from) => ({ type: 'pong', from, tiles: [tile, tile, tile] })
    const kong = (tile, type, from) => ({ type, from, tiles: [tile, tile, tile, tile] })
    const first = { concealed: ['E', 'E'], winTile: 'E', melds: [pong('1m', 1), pong('2s', 2), kong('3p', 'ankong'), pong('4m', 3), kong('Z', 'huagang')], flowers: ['F'] }
    const second = { concealed: ['7p','1m','4s','6p','1m','2m','2m','3m','3m','4s','5s','5s','6p','7p'], winTile: '3m', melds: [], flowers: [] }
    let response = { ok: true, data: { ...state, rev: state.rev + 10000, phase: 'finished', myActions: [], double: true,
      revealedHands: [first.concealed, ['1s'], second.concealed, ['2s']],
      result: { type: 'win', matchOver: false, winners: [{ seat: 0, hand: first, score: scoreHand(first) }, { seat: 2, hand: second, score: scoreHand(second) }] },
      ledger: [{ event: '胡牌', transfers: [{ id: 'test', from: 1, to: 0, amount: 20, paid: 9, reason: '点炮' }] }] } }
    await page.route('**/api/room/state', (route) => route.fulfill({ json: response }))
    await page.locator('.reveal-message').waitFor()
    const revealStart = Date.now()
    await page.locator('.result-card').waitFor()
    assert.ok(Date.now() - revealStart < 2000, '摊牌未在约 1 秒后进入结算')
    const winners = page.locator('.result-card .winner')
    assert.equal(await winners.count(), 1)
    assert.equal(await winners.locator('.winner-tiles .tile').count(), 2)
    assert.equal(await winners.locator('.meld').count(), 5)
    assert.equal(await winners.locator('.flowers .tile').count(), 1)
    assert.equal(await winners.locator('.result-tile--win').count(), 1)
    assert.match(await winners.innerText(), /全球独钓/)
    assert.match(await winners.innerText(), /硬花 5 张/)
    assert.match(await winners.innerText(), /×2 · 每份/)
    for (const [width, height] of [[568, 320], [667, 375], [844, 390]]) {
      await page.setViewportSize({ width, height })
      const visible = await page.evaluate(() => {
        const within = (child, parent) => { const a = child.getBoundingClientRect(), b = parent.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1 }
        return { flowers: within(document.querySelector('.winner-groups .flowers'), document.querySelector('.winner-tiles-panel')),
          total: within(document.querySelector('.score-summary'), document.querySelector('.result-card')),
          actions: [...document.querySelectorAll('.result-actions button')].every((e) => within(e, document.querySelector('.result-card'))) }
      })
      assert.deepEqual(visible, { flowers: true, total: true, actions: true }, `${width}x${height} 首屏内容`)
    }
    await page.locator('.winner-tabs button').nth(1).click()
    assert.match(await winners.innerText(), /硬花 0 张/)
    assert.match(await winners.innerText(), /软花小计\s*0 花/)
    assert.equal(await winners.locator('.result-tile--win').getAttribute('aria-label'), '三万，胡牌张')
    assert.equal(await winners.locator('.result-tile').last().getAttribute('aria-label'), '三万，胡牌张')
    await page.getByRole('button', { name: '流水', exact: true }).click()
    assert.match(await page.locator('.result-card').innerText(), /实付 9（应付 20）/)
    if (process.env.MAHJONG_UI_SCREENSHOT) await page.screenshot({ path: process.env.MAHJONG_UI_SCREENSHOT })
    await page.getByRole('button', { name: '返回牌桌' }).click()
    assert.ok(await page.locator('.opponent .back-row img[alt="背面"]').count() > 0)
    response = { ok: true, data: { ...response.data, rev: response.data.rev + 1, result: { type: 'draw', matchOver: false, winners: [] } } }
    await page.waitForFunction(() => document.querySelector('.board')?.dataset.resultType === 'draw')
    await page.getByRole('button', { name: '本手结果', exact: true }).click()
    assert.equal(await page.locator('.result-empty').innerText(), '本手流局')
    assert.equal(await page.locator('.result-card .winner').count(), 0)
    response = { ok: false, code: 'ROOM_NOT_FOUND', error: '房间不存在' }
    await page.getByText('房间不存在或已结束').waitFor()
    assert.equal(await page.locator('.board').count(), 0)
    assert.equal(await page.locator('.hand-button').count(), 0)
    assert.equal(await page.evaluate((id) => localStorage.getItem('hamster-poker:seat:' + id), roomId), null)
    assert.equal(await page.getByRole('button', { name: '返回大厅' }).isVisible(), true)
    assert.deepEqual(errors, [])
    console.log('麻将页面回归通过：双胡结算、碰杠花、零花数、实际流水、摊牌时长及房间失效。')
  } finally {
    if (browser) await browser.close()
    child.kill()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
