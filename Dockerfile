# 仓鼠聚会 — 线上对局服务（云托管）
#
# 全内存态：不连数据库、不写盘、退出即焚。
# 云托管会注入 PORT（默认 80），代码已读 process.env.PORT。

FROM node:20-alpine

WORKDIR /app

# 先拷依赖清单，利用 Docker 层缓存
COPY server/package.json ./server/package.json
COPY package.json ./package.json

# 服务端零运行时依赖（只用 node 内置 http/crypto + shared/logic），
# 所以没有 npm install 步骤。保留 package.json 仅为云托管识别 Node 项目。

# 应用代码
COPY server/ ./server/
COPY shared/ ./shared/

# shared/logic 是 ESM，server 也是 ESM，直接跑
EXPOSE 80

CMD ["node", "server/index.js"]
