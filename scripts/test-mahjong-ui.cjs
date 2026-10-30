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
    const first = { concealed: ['E', 'E'], melds: [pong('1m', 1), pong('2s', 2), kong('3p', 'ankong'), pong('4m', 3), kong('Z', 'huagang')], flowers: ['F'] }
    const second = { concealed: ['1m','1m','2m','2m','3m','3m','4s','4s','5s','5s','6p','6p','7p','7p'], melds: [], flowers: [] }
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
    assert.equal(await winners.count(), 2)
    assert.equal(await winners.nth(0).locator('.winner-tiles .tile').count(), 2)
    assert.equal(await winners.nth(0).locator('.meld').count(), 5)
    assert.equal(await winners.nth(0).locator('.flowers .tile').count(), 1)
    assert.match(await winners.nth(0).innerText(), /全球独钓/)
    assert.match(await winners.nth(0).innerText(), /硬花 5 张/)
    assert.match(await winners.nth(0).innerText(), /当局倍率\s*× 2/)
    assert.match(await winners.nth(1).innerText(), /硬花 0 张/)
    assert.match(await winners.nth(1).innerText(), /软花小计\s*0 花/)
    assert.match(await page.locator('.result-card').innerText(), /实付 9（应付 20）/)
    if (process.env.MAHJONG_UI_SCREENSHOT) await page.screenshot({ path: process.env.MAHJONG_UI_SCREENSHOT })
    await page.getByRole('button', { name: '返回牌桌' }).click()
    assert.ok(await page.locator('.opponent .back-row img[alt="背面"]').count() > 0)
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
