# 仓鼠聚会 — 单容器部署（阿里云服务器）
#
# 一个进程全包：静态站点（client/dist）+ 房间 API + SQLite（node:sqlite）。
# node:sqlite 需要 Node ≥22.13；这里直接用 24（用户服务器已装 24，本地也是 v24.19）。
# 数据落盘在 server/data/hamster.db —— 部署时挂个卷或留在容器层都行
# （朋友局丢一次 db 最坏是重建账号，但建议挂卷）。

# ── 阶段 1：构建前端 ────────────────────────────────
FROM node:22-alpine AS client-build
WORKDIR /app

# 先拷依赖清单吃层缓存（client/package-lock.json 必须存在）
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci

COPY client/ ./client/
RUN cd client && npm run build

# ── 阶段 2：运行时 ──────────────────────────────────
FROM node:24-alpine
WORKDIR /app

# 服务端零 npm 依赖（node 内置 http/crypto/sqlite + shared/logic）
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=client-build /app/client/dist ./client/dist

ENV PORT=80
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/index.js"]
