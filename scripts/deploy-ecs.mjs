import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import config from './lib/ecs-config.cjs'

export function remoteCommand(args) {
  const status = args.length === 1 && args[0] === '--status'
  const bootstrap = args.length === 2 && args[1] === '--bootstrap-reset'
  if (!status && (args.length !== (bootstrap ? 2 : 1))) throw new Error('用法：npm run deploy:ecs -- <完整SHA> [--bootstrap-reset]，或 --status')
  const sha = status ? null : config.validateSha(args[0])
  const script = `set -euo pipefail
exec 9>${config.PATHS.lock}
flock -n -E 75 9 || { echo '已有发布操作正在运行'; exit 75; }
${status ? `node ${config.PATHS.current}/scripts/deploy-release.mjs --status` : `release=${config.PATHS.releases}/${sha}
if [ ! -e "$release" ]; then
  git clone --no-checkout --single-branch --branch feature/room-repo https://github.com/nonePyJaC/see-boss.git "$release"
  git -C "$release" checkout --detach ${sha}
fi
test "$(git -C "$release" rev-parse HEAD)" = ${sha}
test -z "$(git -C "$release" status --porcelain)"
node "$release/scripts/deploy-release.mjs" ${sha}${bootstrap ? ' --bootstrap-reset' : ''}`}
`
  return `printf %s '${Buffer.from(script).toString('base64')}' | base64 -d | bash`
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const command = remoteCommand(process.argv.slice(2))
    const exe = process.env.WORKBENCH_CLI || (process.platform === 'win32'
      ? 'C:/Users/Administrator/AppData/Local/Programs/workbench/workbench.exe' : 'workbench')
    const result = spawnSync(exe, ['exec', '--instance-id', 'i-uf6aw6q8inn2ymy0hw6d', '--region', 'cn-shanghai', '--timeout', '600', '--command', command], { stdio: 'inherit' })
    if (result.error) throw new Error(`Workbench 启动失败：${result.error.code || result.error.name}`)
    process.exitCode = result.status ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
