// pm2 配置。用 ecosystem 文件而不是命令行 start，
// 因为命令行 `PORT=8080 pm2 start ...` 的前缀赋值在部分 shell 下不会传进 pm2 子进程
// （踩过：pm2 显示 online、进程也在跑，但 8080 从没监听，日志里连 listening 都没有）。
module.exports = {
  apps: [
    {
      name: 'cangshu',
      script: 'server/index.js',
      cwd: '/opt/cangshu',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
        LISTEN: '1',
        HAMSTER_STATIC_DIR: '/opt/cangshu/client/dist',
      },
      // 1C1G 小机器：内存超过 300MB 自动重启，防止把机器拖死
      max_memory_restart: '300M',
      // 崩了别疯狂重启，朋友局可接受几秒间隔
      restart_delay: 2000,
    },
  ],
}
