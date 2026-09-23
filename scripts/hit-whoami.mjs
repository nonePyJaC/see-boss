/**
 * 直接打 HTTP 网关验证 whoami
 * 不带 Sec-Fetch-Mode: navigate，避开 CloudBase 中间页
 */
const URL_ = 'https://see-boss-d2gjggfbz8808d1d4-1492320391.ap-shanghai.app.tcloudbase.com/whoami'

async function hit(body, label) {
  try {
    const r = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        Origin: 'http://localhost:5173',
      },
      body: JSON.stringify(body),
    })
    const t = await r.text()
    console.log(`\n[${label}] status=${r.status} ct=${r.headers.get('content-type')}`)
    console.log('  body:', t.slice(0, 900))
  } catch (e) {
    console.log(`\n[${label}] EXCEPTION:`, e?.message ?? e)
  }
}

await hit({ probe: 'anonymous' }, 'anon')
await hit({ probe: 'empty' }, 'empty-body')
