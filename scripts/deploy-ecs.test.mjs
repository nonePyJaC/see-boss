import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import config from './lib/ecs-config.cjs'
import { remoteCommand } from './deploy-ecs.mjs'
import { releaseTransaction } from './lib/release-transaction.mjs'
import { assertProductionLayout } from '../server/production-layout.mjs'

const sha = 'a'.repeat(40)
const release = `/opt/cangshu-releases/${sha}`
const settings = { HAMSTER_ONLINE_CREATE_CODE: 'test-only', DEEPSEEK_API_KEY: 'test-secret' }

test('实际 CLI 对无效版本返回非零，防止入口未执行却假报成功', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./deploy-ecs.mjs', import.meta.url)), 'invalid'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /40 位/)
})

test('发布入口拒绝短 SHA、分支名和 shell 注入，状态查询不拉取代码', () => {
  for (const value of ['main', 'abc1234', 'a'.repeat(39), `${sha};echo unsafe`, `../${sha}`]) {
    assert.throws(() => remoteCommand([value]))
  }
  assert.throws(() => remoteCommand([sha, '--force']))
  const command = remoteCommand([sha])
  const bash = Buffer.from(command.split("'")[1], 'base64').toString()
  assert.match(bash, /flock -n -E 75 9/)
  assert.match(bash, new RegExp(`/opt/cangshu-releases/${sha}`))
  const status = Buffer.from(remoteCommand(['--status']).split("'")[1], 'base64').toString()
  assert.doesNotMatch(status, /git clone|bootstrap-reset/)
})

test('PM2 固定一个实例、同版本前后端、独立数据；运行参数不能改数据路径', () => {
  const app = config.makeConfig(release, settings).apps[0]
  assert.equal(app.instances, 1)
  assert.equal(app.cwd, release)
  assert.equal(app.script, `${release}/server/index.js`)
  assert.equal(app.env.HAMSTER_STATIC_DIR, `${release}/client/dist`)
  assert.equal(app.env.HAMSTER_DATA_DIR, '/var/lib/cangshu')
  assert.equal(app.env.HAMSTER_DB, 'hamster.db')
  assert.equal(app.env.DEEPSEEK_API_KEY, 'test-secret')
  assert.throws(() => config.makeConfig(release, { ...settings, HAMSTER_DATA_DIR: '/tmp/other-db' }))
  assert.throws(() => config.makeConfig('/opt/cangshu', settings))
  assert.throws(() => config.makeConfig(release, {}))
})

test('迁移只提取模型及建房配置，不继承旧代码或数据库路径', () => {
  const migrated = config.settingsFromEnvironment({ ...settings, HAMSTER_STATIC_DIR: '/old/dist', HAMSTER_DATA_DIR: '/old/data', PORT: '9999' })
  assert.equal(migrated.DEEPSEEK_API_KEY, settings.DEEPSEEK_API_KEY)
  assert.equal(migrated.HAMSTER_ONLINE_CREATE_CODE, settings.HAMSTER_ONLINE_CREATE_CODE)
  assert.equal('HAMSTER_DATA_DIR' in migrated, false)
  assert.equal('HAMSTER_STATIC_DIR' in migrated, false)
})

test('生产进程拒绝旧版本、另一个数据库和前后端混版；本地开发可用', () => {
  const env = config.makeConfig(release, settings).apps[0].env
  const realpath = p => p === '/opt/cangshu' ? release : p
  const good = { projectDir: release, staticDir: `${release}/client/dist`, env, realpath }
  assert.doesNotThrow(() => assertProductionLayout(good))
  assert.throws(() => assertProductionLayout({ ...good, env: { ...env, HAMSTER_DATA_DIR: '/opt/cangshu/server/data' } }))
  assert.throws(() => assertProductionLayout({ ...good, staticDir: '/old/client/dist' }))
  assert.throws(() => assertProductionLayout({ ...good, projectDir: `/opt/cangshu-releases/${'b'.repeat(40)}` }))
  assert.doesNotThrow(() => assertProductionLayout({ projectDir: '/local', staticDir: '/local/dist', env: {} }))
})

test('新服务验证失败时恢复旧版、验证旧版、持久化后才报告失败', async () => {
  const calls = []
  await assert.rejects(releaseTransaction({
    activate: async () => calls.push('new'),
    verifyNew: async () => { throw new Error('HTTP health failed') },
    restore: async () => calls.push('old'),
    verifyOld: async () => calls.push('old verified'),
    persist: async () => calls.push('saved'),
  }), /已恢复并验证旧服务/)
  assert.deepEqual(calls, ['new', 'old', 'old verified', 'saved'])
})

test('PM2 保存失败也回滚；回滚失败不能报告成功', async () => {
  let saved = 0, restored = 0
  await assert.rejects(releaseTransaction({ activate: async () => {}, verifyNew: async () => {},
    restore: async () => restored++, verifyOld: async () => {},
    persist: async () => { if (++saved === 1) throw new Error('disk full') },
  }), /已恢复并验证旧服务/)
  assert.equal(restored, 1)
  assert.equal(saved, 2)
  await assert.rejects(releaseTransaction({ activate: async () => { throw new Error('new failed') },
    verifyNew: async () => {}, restore: async () => { throw new Error('old failed') },
    verifyOld: async () => {}, persist: async () => {},
  }), /回滚未完成/)
})
