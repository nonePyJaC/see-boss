// pm2 配置。用 ecosystem 文件而不是命令行 start，
// 因为命令行 `PORT=8080 pm2 start ...` 的前缀赋值在部分 shell 下不会传进 pm2 子进程
// （踩过：pm2 显示 online、进程也在跑，但 8080 从没监听，日志里连 listening 都没有）。
const APP_DIR = process.env.HAMSTER_APP_DIR || '/opt/cangshu'

module.exports = {
  apps: [
    {
      name: 'cangshu',
      script: 'server/index.js',
      cwd: APP_DIR,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        // 80 端口：阿里云安全组默认放行 80，不用为朋友局专门开 8080
        PORT: '80',
        LISTEN: '1',
        HAMSTER_STATIC_DIR: process.env.HAMSTER_STATIC_DIR || `${APP_DIR}/client/dist`,
        HAMSTER_DATA_DIR: process.env.HAMSTER_DATA_DIR || `${APP_DIR}/server/data`,
        // 真实创建码只从服务器环境注入，不写进仓库。
        HAMSTER_ONLINE_CREATE_CODE: process.env.HAMSTER_ONLINE_CREATE_CODE || '',
        // 清理口子的口令。/api/admin/wipe 没有它就直接拒，
        // 所以不设就等于关掉清理功能（安全默认）。
        // ⚠️ 换密码时改这里 + pm2 delete/start 重启，git 里的这个值只是占位，
        //    真实口令请用 `pm2 set` 或直接在服务器上改完再 pull。
        HAMSTER_ADMIN_TOKEN: process.env.HAMSTER_ADMIN_TOKEN || '',

        // ── AI 大模型决策 ──
        // 两个模型都配上，建房页就能下拉选择。
        // 没配 key 的模型不会出现在前端列表里，选了也自动退回本地策略。
        // ⚠️ key 同样只从服务器环境注入，仓库里是空占位。
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
        DEEPSEEK_MODEL: 'deepseek-chat',
        DEEPSEEK_BASE: 'https://api.deepseek.com',

        STEPFUN_API_KEY: process.env.STEPFUN_API_KEY || '',
        STEPFUN_MODEL: 'step-5-preview',
        STEPFUN_BASE: 'https://api.stepfun.com/v1',

        // 单次决策超时（毫秒）。开深度思考时会自动 ×3。
        LLM_TIMEOUT_MS: '12000',
      },
      // 1C1G 小机器：内存超过 300MB 自动重启，防止把机器拖死
      max_memory_restart: '300M',
      // 崩了别疯狂重启，朋友局可接受几秒间隔
      restart_delay: 2000,
    },
  ],
}
