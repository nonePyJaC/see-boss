const path = require('node:path')

const PATHS = Object.freeze({
  current: '/opt/cangshu',
  releases: '/opt/cangshu-releases',
  data: '/var/lib/cangshu',
  settings: '/etc/cangshu/runtime.json',
  backups: '/var/backups/cangshu',
  lock: '/var/lock/cangshu-deploy.lock',
})

const DEFAULTS = Object.freeze({
  HAMSTER_ONLINE_CREATE_CODE: '', HAMSTER_ADMIN_TOKEN: '',
  DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: 'deepseek-chat', DEEPSEEK_BASE: 'https://api.deepseek.com',
  STEPFUN_API_KEY: '', STEPFUN_MODEL: 'step-5-preview', STEPFUN_BASE: 'https://api.stepfun.com/v1',
  LLM_TIMEOUT_MS: '12000',
})

function validateSha(sha) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('必须提供完整的 40 位小写 Git SHA')
  return sha
}

function settingsFromEnvironment(env) {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [
    key, typeof env[key] === 'string' ? env[key] : fallback,
  ]))
}

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('runtime.json 必须是对象')
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`runtime.json 不允许配置字段 ${key}`)
    if (typeof settings[key] !== 'string') throw new Error(`runtime.json 字段 ${key} 必须是字符串`)
  }
  const result = { ...DEFAULTS, ...settings }
  if (!result.HAMSTER_ONLINE_CREATE_CODE.trim()) throw new Error('缺少生产建房码配置')
  const timeout = Number(result.LLM_TIMEOUT_MS)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('LLM_TIMEOUT_MS 超出允许范围')
  return result
}

function makeConfig(release, settings) {
  const sha = validateSha(path.posix.basename(release))
  if (release !== `${PATHS.releases}/${sha}`) throw new Error('生产代码必须来自规范 release 目录')
  return {
    apps: [{
      name: 'cangshu', script: `${release}/server/index.js`, cwd: release,
      instances: 1, exec_mode: 'fork', watch: false,
      env: {
        ...validateSettings(settings), NODE_ENV: 'production', PORT: '80', LISTEN: '1',
        HAMSTER_STATIC_DIR: `${release}/client/dist`, HAMSTER_DATA_DIR: PATHS.data,
        HAMSTER_DB: 'hamster.db', HAMSTER_RELEASE_SHA: sha,
      },
      max_memory_restart: '300M', restart_delay: 2000,
    }],
  }
}

module.exports = { PATHS, DEFAULTS, validateSha, settingsFromEnvironment, validateSettings, makeConfig }
