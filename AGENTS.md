# 本项目 Agent 工作约定

## 唯一生产发布流程

- 本项目是仓鼠聚会 `cangshu`。发布分支是 `feature/room-repo`，生产实例为上海 ECS `i-uf6aw6q8inn2ymy0hw6d`。
- **发布只执行 `npm run deploy:ecs -- <已推送的完整40位Git SHA>`。** 状态检查执行 `npm run deploy:ecs -- --status`。回滚也使用同一发布命令，指定此前采用本流程发布的 SHA。
- 先提交/合入并推送 Git，再发布固定 SHA；不得把未提交文件、源码压缩包或本地构建包直接覆盖到服务器。
- `/opt/cangshu` 是唯一入口符号链接，指向 `/opt/cangshu-releases/<完整SHA>`；生产只有一个 PM2 `cangshu` 应用。每个 release 前后端同源，禁止在运行目录 `git pull` 或边构建边提供服务。
- 数据只在 `/var/lib/cangshu/hamster.db`。不得改成 `server/data`，不得通过临时环境变量改变生产数据目录。密钥/建房码只保存在服务器 `/etc/cangshu/runtime.json`，权限0600；禁止读取后展示、写入Git或命令输出。
- 不得手工执行 `pm2 start/restart/reload/startOrReload`、`pm2 resurrect` 或修改 current 链接绕过发布脚本。脚本持有独占锁，检查房间、切换、验证、回滚及保存 PM2；不能从旧文档拼接另一套部署命令。
- 这是用户单人使用的服务，用户已授权每次实际版本切换自动结束全部房间，包括测试遗留、等待和进行中的房间；**房间数不得作为发布阻塞条件，也不必再次请求清房确认**。脚本先停止进程、备份数据库，再清空房间快照和房间历史，防止旧房间重启复活；正常发布保留账号、个人模型Key、账本和服务器配置。同一SHA重复发布不重启也不清理。此规则取代所有旧文档中的“等待房间为0”要求。
- 初始化参数 `--bootstrap-reset` 仍仅用于首次布局迁移和账号清空，已初始化后会拒绝再次使用；不得用它解决测试遗留房间。
- 80端口是本应用；8080是万象棋Wiki。不得重启通用Nginx、更改Wiki或安全组。只使用已有Workbench凭证，不索取或输出密钥。
- 完整操作与故障处理见 [docs/阿里云部署.md](docs/阿里云部署.md)。本约定优先于仓库其他文档中的旧部署步骤。

## 变更边界

- 保留已接入的 DeepSeek/阶跃星辰 LLM、用户模型Key管理和本地策略回退；运维任务不得回退到没有LLM的旧代码。
- 工作树可能有其他Agent的未提交内容，只暂存本任务明确文件。`sk.txt`、`.env`、SQLite数据和服务器运行配置不得入Git，不读取或打印其中密钥。
- 修改部署逻辑后运行 `node --test scripts/deploy-ecs.test.mjs`，按影响补运行相关检查；部署后核对公开站点、PM2脚本/cwd、静态目录、数据目录、完整SHA和8080Wiki。
- 旧release仅作回滚，归档在 `/var/backups/cangshu` 的旧代码和数据库不是发布入口，不得直接启动。不要删除备份或从归档覆盖当前数据库。
