// ECS-only implementation. Always invoke through deploy-ecs.mjs, which owns flock fd 9.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import config from './lib/ecs-config.cjs'
import { releaseTransaction } from './lib/release-transaction.mjs'

const { PATHS, DEFAULTS, validateSha, settingsFromEnvironment, validateSettings } = config
const args = process.argv.slice(2)
const bootstrap = args.length === 2 && args[1] === '--bootstrap-reset'
const statusOnly = args.length === 1 && args[0] === '--status'

function run(program, argv, options = {}) {
  try { return execFileSync(program, argv, { encoding: 'utf8', timeout: 120000, ...options }) }
  catch (error) { throw new Error(`${path.basename(program)} ${argv[0] || ''} 失败（exit ${error.status ?? error.code ?? 'unknown'}）`) }
}
function json(text, name) {
  try { return JSON.parse(text) } catch { throw new Error(`${name} 不是有效 JSON`) }
}
function processes() { return json(run('pm2', ['jlist']), 'PM2 状态') }
function app() {
  const all = processes()
  if (all.length !== 1 || all[0].name !== 'cangshu') throw new Error('PM2 必须只有一个 cangshu 应用；请先人工检查，禁止覆盖其他应用')
  return all[0]
}
function environment(proc) {
  const e = proc.pm2_env
  const keys = [...Object.keys(DEFAULTS), 'PORT', 'LISTEN', 'NODE_ENV', 'HAMSTER_STATIC_DIR', 'HAMSTER_DATA_DIR', 'HAMSTER_DB', 'HAMSTER_RELEASE_SHA']
  const source = { ...e.env, ...e }
  return Object.fromEntries(keys.filter(k => typeof source[k] === 'string').map(k => [k, source[k]]))
}
function privateDirectory(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700) }
function privateJson(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' }) }
function shaOf(dir) { return run('git', ['-C', dir, 'rev-parse', 'HEAD']).trim() }
async function get(url) { return fetch(url, { signal: AbortSignal.timeout(4000) }) }
async function inspectHealth() {
  const response = await get('http://127.0.0.1/health')
  if (!response.ok) throw new Error('现有服务健康检查失败')
  const result = await response.json()
  if (!result.ok || !Number.isInteger(result.rooms)) throw new Error('健康状态无效')
  return result
}
async function checkRooms(allowWaiting) {
  const health = await inspectHealth()
  if (!health.rooms) return
  if (!allowWaiting) throw new Error(`仍有 ${health.rooms} 个房间，当前不允许发布`)
  const response = await fetch('http://127.0.0.1/api/room/list', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'deployment-preflight' }), signal: AbortSignal.timeout(4000),
  })
  const result = await response.json()
  const rooms = result.data?.rooms
  if (!response.ok || !result.ok || !Array.isArray(rooms) || rooms.some(r => r.inProgress)) {
    throw new Error('仍有进行中的牌局或房间状态无法确认，当前不允许发布')
  }
}
function pointCurrent(release) {
  if (path.dirname(release) !== PATHS.releases) throw new Error('release 超出固定发布目录')
  validateSha(path.basename(release))
  if (fs.existsSync(PATHS.current) && !fs.lstatSync(PATHS.current).isSymbolicLink()) throw new Error('当前入口必须是符号链接')
  const temp = `${PATHS.current}.next-${process.pid}`
  fs.symlinkSync(release, temp)
  try { fs.renameSync(temp, PATHS.current) } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
function stopApp() { if (processes().some(p => p.name === 'cangshu')) run('pm2', ['delete', 'cangshu'], { stdio: 'pipe' }) }
function startRelease(release) { run('pm2', ['start', `${release}/ecosystem.server.config.cjs`, '--only', 'cangshu'], { cwd: release, stdio: 'pipe' }) }
async function verify(release, dataDir, legacy = false) {
  let last
  for (let n = 0; n < 25; n++) {
    try {
      const p = app(), e = p.pm2_env, env = environment(p)
      if (e.status !== 'online' || e.pm_cwd !== release || e.pm_exec_path !== `${release}/server/index.js`) throw new Error('PM2 脚本/cwd 不一致')
      if (env.HAMSTER_DATA_DIR !== dataDir || env.HAMSTER_STATIC_DIR !== `${release}/client/dist` || env.PORT !== '80') throw new Error('PM2 数据或静态文件路径不一致')
      if (!legacy && env.HAMSTER_RELEASE_SHA !== path.basename(release)) throw new Error('PM2 release SHA 不一致')
      await inspectHealth()
      const page = await get('http://127.0.0.1/')
      const expected = fs.readFileSync(`${release}/client/dist/index.html`, 'utf8')
      if (!page.ok || await page.text() !== expected) throw new Error('首页不属于当前 release')
      const refs = [...expected.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1])
      if (!refs.length) throw new Error('首页缺少构建资源')
      for (const ref of refs) if (!(await get(new URL(ref, 'http://127.0.0.1/'))).ok) throw new Error('静态资源访问失败')
      if (!(await get('http://127.0.0.1:8080/')).ok) throw new Error('Wiki 健康检查失败')
      return
    } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  throw last
}
function persist() {
  run('pm2', ['save'], { stdio: 'pipe' })
  const saved = json(fs.readFileSync('/root/.pm2/dump.pm2', 'utf8'), 'PM2 保存配置')
  const live = app().pm2_env
  if (saved.length !== 1 || saved[0].pm_cwd !== live.pm_cwd || saved[0].pm_exec_path !== live.pm_exec_path) throw new Error('PM2 保存配置未同步')
}
async function databaseBackup(file, target) {
  if (!fs.existsSync(file)) return
  const db = new DatabaseSync(file, { readOnly: true })
  try { await backup(db, target); fs.chmodSync(target, 0o600) } finally { db.close() }
}
function databaseFiles(dir) { return ['hamster.db', 'hamster.db-wal', 'hamster.db-shm'].map(name => path.join(dir, name)) }
function moveDatabase(from, to) {
  privateDirectory(to)
  for (const source of databaseFiles(from)) if (fs.existsSync(source)) fs.renameSync(source, path.join(to, path.basename(source)))
}
function report() {
  const p = app(), e = p.pm2_env, env = environment(p)
  const saved = json(fs.readFileSync('/root/.pm2/dump.pm2', 'utf8'), 'PM2 保存配置')
  return { app: p.name, status: e.status, pid: p.pid, release: e.pm_cwd, sha: shaOf(e.pm_cwd),
    current: fs.realpathSync(PATHS.current), dataDir: env.HAMSTER_DATA_DIR,
    savedMatches: saved.length === 1 && saved[0].pm_cwd === e.pm_cwd && saved[0].pm_exec_path === e.pm_exec_path,
    settingsFile: PATHS.settings, globalModelKeysConfigured: { deepseek: !!env.DEEPSEEK_API_KEY, stepfun: !!env.STEPFUN_API_KEY } }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('此入口只允许在目标 ECS 上以 root 运行')
  let lock
  try { lock = fs.fstatSync(9) } catch { throw new Error('缺少发布锁；必须使用 npm run deploy:ecs') }
  if (lock.ino !== fs.statSync(PATHS.lock).ino) throw new Error('发布锁不正确')
  if (statusOnly) {
    const state = report()
    if (!fs.lstatSync(PATHS.current).isSymbolicLink() || state.current !== state.release || state.dataDir !== PATHS.data || !state.savedMatches) throw new Error('运行/保存配置不符合唯一入口，请核对路径')
    console.log(JSON.stringify({ ...state, health: await inspectHealth() }, null, 2)); return
  }
  if (args.length !== (bootstrap ? 2 : 1)) throw new Error('发布参数不合法')
  const sha = validateSha(args[0]), release = `${PATHS.releases}/${sha}`
  if (fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)) + '/..') !== release || shaOf(release) !== sha) throw new Error('发布工具与目标 Git SHA 不匹配')
  run('git', ['-C', release, 'merge-base', '--is-ancestor', '27029e1277d75b0820d99e8966fa5c4ff01502a7', sha])
  if (run('git', ['-C', release, 'status', '--porcelain']).trim()) throw new Error('release 工作区不干净')
  const old = app(), oldDir = old.pm2_env.pm_cwd, oldEnv = environment(old)
  const currentIsLink = fs.lstatSync(PATHS.current).isSymbolicLink()
  if (bootstrap === currentIsLink) throw new Error(bootstrap ? '已完成初始化，禁止再次重置账号' : '尚未统一发布布局；需经授权的一次性 --bootstrap-reset')
  if (!bootstrap && fs.realpathSync(PATHS.current) !== oldDir) throw new Error('PM2 与唯一入口不一致，禁止盲目发布')
  if (!bootstrap && oldDir === release) { await verify(release, PATHS.data); persist(); console.log(JSON.stringify({ ...report(), unchanged: true }, null, 2)); return }
  await checkRooms(bootstrap)
  run('npm', ['ci', '--prefix', `${release}/client`], { stdio: 'inherit', timeout: 240000 })
  run('npm', ['run', 'build', '--prefix', `${release}/client`], { stdio: 'inherit', timeout: 180000 })
  privateDirectory(PATHS.backups)
  const archive = `${PATHS.backups}/${bootstrap ? 'bootstrap' : 'release'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${sha.slice(0, 8)}`
  privateDirectory(archive)
  if (fs.statSync(archive).dev !== fs.statSync(PATHS.current).dev || fs.statSync(archive).dev !== fs.statSync(PATHS.releases).dev) throw new Error('备份与代码目录不在同一文件系统，请先处理归档路径')
  privateJson(`${archive}/previous-pm2.json`, old)
  if (bootstrap) {
    if (oldDir !== PATHS.current) throw new Error('初始化只支持已核验的 /opt/cangshu 布局')
    const settings = validateSettings(settingsFromEnvironment(oldEnv))
    privateDirectory(path.dirname(PATHS.settings))
    if (fs.existsSync(PATHS.settings)) {
      const previous = validateSettings(json(fs.readFileSync(PATHS.settings, 'utf8'), 'runtime.json'))
      if (Object.keys(settings).some(k => settings[k] !== previous[k])) throw new Error('已有 runtime.json 与运行配置不同，禁止覆盖')
    } else privateJson(PATHS.settings, settings)
  }
  // Fail before stopping if protected settings are missing or invalid.
  validateSettings(json(fs.readFileSync(PATHS.settings, 'utf8'), 'runtime.json'))
  if (fs.statSync(PATHS.settings).mode & 0o077) throw new Error('runtime.json 权限必须为 0600')
  // Enable the single PM2 boot owner while the previous service is still healthy.
  run('pm2', ['startup', 'systemd', '-u', 'root', '--hp', '/root'], { stdio: 'pipe' })
  run('systemctl', ['is-enabled', 'pm2-root.service'])
  await checkRooms(bootstrap)
  const legacyCheckout = `${archive}/legacy-checkout`
  const oldCanonicalFiles = `${archive}/previous-data-files`
  let stopped = false, movedCheckout = false, resetData = false, resetComplete = false, switched = false
  let emptyCounts = null
  await releaseTransaction({
    activate: async () => {
      stopApp(); stopped = true
      await databaseBackup(`${PATHS.data}/hamster.db`, `${archive}/canonical.sqlite`)
      if (bootstrap) {
        await databaseBackup(`${oldEnv.HAMSTER_DATA_DIR}/hamster.db`, `${archive}/legacy.sqlite`)
        resetData = true; moveDatabase(PATHS.data, oldCanonicalFiles); resetComplete = true
        fs.renameSync(PATHS.current, legacyCheckout); movedCheckout = true
      }
      pointCurrent(release); switched = true
      if (bootstrap) {
        privateDirectory(PATHS.data)
        const code = 'const m=await import(process.argv[1]);m.openDb();console.log(JSON.stringify(m.dataCounts()));m.closeDb()'
        emptyCounts = json(run(process.execPath, ['--input-type=module', '-e', code, pathToFileURL(`${release}/server/db.js`).href], {
          env: { ...process.env, HAMSTER_DATA_DIR: PATHS.data, HAMSTER_DB: 'hamster.db' },
        }), '空数据库计数')
        if (Object.values(emptyCounts).some(n => n !== 0)) throw new Error('初始化数据库未清空')
      }
      startRelease(release)
    },
    verifyNew: () => verify(release, PATHS.data),
    restore: async () => {
      if (!stopped) return
      stopApp()
      if (bootstrap) {
        if (switched) fs.unlinkSync(PATHS.current)
        if (movedCheckout) fs.renameSync(legacyCheckout, PATHS.current)
        if (resetData) {
          if (resetComplete) moveDatabase(PATHS.data, `${archive}/failed-new-data`)
          moveDatabase(oldCanonicalFiles, PATHS.data)
        }
        run('pm2', ['start', `${oldDir}/server/index.js`, '--name', 'cangshu', '--cwd', oldDir, '--max-memory-restart', '300M', '--restart-delay', '2000'], { env: { ...process.env, ...oldEnv }, stdio: 'pipe' })
      } else { pointCurrent(oldDir); startRelease(oldDir) }
    },
    verifyOld: () => verify(oldDir, oldEnv.HAMSTER_DATA_DIR, bootstrap),
    persist,
  })
  if (bootstrap) {
    // Legacy releases are recoverable backups, never alternate live entry points.
    const legacyReleases = `${archive}/legacy-releases`
    privateDirectory(legacyReleases)
    for (const name of fs.readdirSync(PATHS.releases)) {
      if (name === sha) continue
      const source = path.join(PATHS.releases, name)
      if (path.dirname(source) !== PATHS.releases) throw new Error('归档路径超出 release 目录')
      fs.renameSync(source, path.join(legacyReleases, name))
    }
  }
  console.log(JSON.stringify({ ...report(), backup: archive, resetAccounts: bootstrap, emptyCounts,
    health: await inspectHealth(), bootService: 'pm2-root.service', wiki: 200 }, null, 2))
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
