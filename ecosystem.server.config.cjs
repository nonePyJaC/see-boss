// 生产配置只由 npm run deploy:ecs 调用，详见 AGENTS.md / docs/阿里云部署.md。
const fs = require('node:fs')
const { PATHS, makeConfig } = require('./scripts/lib/ecs-config.cjs')

const release = fs.realpathSync(__dirname)
if (fs.realpathSync(PATHS.current) !== release) {
  throw new Error('只能启动当前 release；请使用 npm run deploy:ecs -- <完整SHA>')
}
if (fs.statSync(PATHS.settings).mode & 0o077) {
  throw new Error('runtime.json 权限必须为 0600，禁止向其他用户开放')
}
let settings
try { settings = JSON.parse(fs.readFileSync(PATHS.settings, 'utf8')) }
catch { throw new Error('无法读取有效的 runtime.json；禁止输出该文件内容排错') }
module.exports = makeConfig(release, settings)
