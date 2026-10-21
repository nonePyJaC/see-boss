import fs from 'node:fs'

export function assertProductionLayout({ projectDir, staticDir, env = process.env, realpath = fs.realpathSync }) {
  if (env.NODE_ENV !== 'production') return
  const release = realpath(projectDir)
  if (!/^\/opt\/cangshu-releases\/[a-f0-9]{40}$/.test(release) || realpath('/opt/cangshu') !== release) {
    throw new Error('生产入口不是当前 release；请使用项目统一部署命令')
  }
  if (env.HAMSTER_DATA_DIR !== '/var/lib/cangshu' || env.HAMSTER_DB !== 'hamster.db') {
    throw new Error('生产数据库必须固定为 /var/lib/cangshu/hamster.db')
  }
  if (realpath(staticDir) !== `${release}/client/dist` || env.HAMSTER_RELEASE_SHA !== release.split('/').at(-1)) {
    throw new Error('生产前端、后端和 release SHA 不一致')
  }
  if (env.PORT !== '80' || env.LISTEN !== '1') throw new Error('生产监听配置不符合统一入口')
}
