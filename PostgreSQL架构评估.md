# PostgreSQL 架构可行性评估（应对环境选错数据库类型）

> 2026-09-20 ｜ 环境 `see-boss-d2gjggfbz8808d1d4` 创建时选了 PostgreSQL 数据库类型
> 本文件替代 [数据库设计与安全规则.md](数据库设计与安全规则.md) 的集合设计，改为关系表设计

---

## 0. 三个决定性结论

### ✅ 结论 1：PostgreSQL 完全可行，前端能直连，不需要自建后端

CloudBase 把这套叫「PG 模式」，基于 **PostgREST** 自动把 `public` schema 的表暴露成 REST API。前端用 `app.rdb().from('table')` 链式调用（**Supabase 风格，官方明确对齐 API 名**）。

关键点：
- **必须 `await auth.signInAnonymously()`** —— 否则所有玩家共享 `sub="anon"`，RLS 无法按用户隔离数据
- **浏览器不建数据库连接**，每个 HTTP 请求走完即释放，不存在前端打爆连接数的风险
- 权限是**表级 GRANT + 行级 RLS 双层校验**，请求自带 JWT 由数据库判定

### ✅ 结论 2：免费版能用，但有一个必须盯住的额度红线

PostgreSQL 共享实例计费模型（官方原文）：

> 「以 **5 分钟**为一个计量时间单位，每个共享实例按 **0.5 核**计算。在任一 5 分钟内存在数据库访问，或数据库内的定时任务、函数、事务等处理时，该时间段计为有使用，计算用量为 `0.5 * 5 / 60 = 0.04167 CU`；没有连接、读写、定时任务、函数或事务处理时，此 5 分钟产生的是 0 CU。」

**这是二值判活，不是按 CPU 利用率**：这 5 分钟内有 1 次查询和跑满 5 分钟，计费完全相同。

| 地域 | 单价 | 3000 点可支撑 | 折合活跃时长 |
|---|---|---|---|
| 新加坡 | 587 点/核·小时 | ≈ 5.11 核·小时/月 | ≈ 10.2 小时/月（20 分钟/天） |
| **上海** | **342 点/核·小时** | **≈ 8.77 核·小时/月** | **≈ 17.5 小时/月（35 分钟/天）** |

> ⚠️ **必须先确认你的环境在哪个地域**。上海便宜 1.7 倍，且**新加坡地域不支持云托管**。控制台「概览」页能看到地域。

**判断**：35 分钟/天对 3-5 个好友偶尔玩一局**够用**，但前提是：
- 不在服务器上跑任何定时任务/cron（会持续判活）
- 不开启实时推送 CDC（poller 会持续产生数据库处理）

### ⚠️ 结论 3：实时订阅（PG CDC）官方文档自相矛盾，必须实测

| 证据 | 时间 | 内容 |
|---|---|---|
| [Supabase 迁移页](https://docs.cloudbase.net/quick-start/migration/supabase) | 2026-07-27 | 「**PG 模式暂不支持 Realtime**。可选方案：客户端定时拉取 / 云函数起 WebSocket 服务 / 等待上线」 |
| `api-reference/webv3-pg/realtime/*` 全套 23 页 | **2026-09-16~18** | 明确有 `postgres-cdc`、broadcast、presence |

新文档晚 2 个月，判断是**迁移页未更新的残留**，倾向已支持。但这是架构关键点，**必须先实测**。

**实测方法**（5 分钟）：
```sql
CREATE PUBLICATION cloudbase_realtime FOR TABLE public.rooms;
GRANT SELECT ON public.rooms TO "cloudbase_realtime_admin";
ALTER TABLE public.rooms REPLICA IDENTITY FULL;
```
然后前端订阅 `postgres_changes`，从控制台 SQL 编辑器插入一行，看是否收到事件。

**如果实测不通，退路**：`Broadcast`（`app.realtime().channel('room-1').send(...)`）**不依赖数据库**，是纯消息通道。对游戏来说这可能反而更好——它走的是内存消息，不产生数据库调用，**不消耗资源点**。见 §3。

---

## 1. 表设计（替代原 4 个集合）

### 1.1 `public.users` — 用户档案 + 金瓜子账本

```sql
create table public.users (
  id            varchar(64) primary key,        -- 匿名登录的 sub
  nickname      varchar(32)  not null,
  avatar        smallint     not null default 1,
  golden_seeds  integer      not null default 0, -- 可为负
  total_games   integer      not null default 0,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);

create table public.seed_ledger (
  id          bigserial primary key,
  user_id     varchar(64) not null references public.users(id) on delete cascade,
  peer_uid    varchar(64) not null,             -- 对方 uid
  peer_name   varchar(32) not null,             -- 对方昵称（冗余存，改名不追溯）
  peer_avatar smallint    not null,
  count       integer     not null default 0,   -- >0 他给你；<0 你给他
  constraint seed_ledger_unique unique (user_id, peer_uid)
);

create index idx_seed_ledger_user on public.seed_ledger(user_id);
```

**账本规则**
- `count > 0`：该仓鼠给了你 `count` 颗
- `count < 0`：你给了该仓鼠 `|count|` 颗
- `golden_seeds` = `SUM(count)`，用视图或触发器自动维护
- `count` 归零的条目直接删除，不留空行

**用数据库算金瓜子总数（PG 的优势）**
```sql
create or replace view public.user_seed_stats as
select u.id,
       u.nickname,
       u.avatar,
       coalesce(sum(l.count), 0)::integer as golden_seeds
from public.users u
left join public.seed_ledger l on l.user_id = u.id
group by u.id, u.nickname, u.avatar;
```

---

### 1.2 `public.rooms` — 房间公共状态

```sql
create type public.room_mode   as enum ('online', 'offline');
create type public.game_type   as enum ('long', 'short');
create type public.room_status as enum ('waiting','playing','settling','playoff','finished');
create type public.game_phase  as enum ('idle','preflop','flop','turn','river','showdown');

create table public.rooms (
  id             varchar(6)    primary key,     -- 6 位房间号
  mode           public.room_mode   not null,
  game_type      public.game_type   not null default 'long',
  status         public.room_status not null default 'waiting',
  host_uid       varchar(64)  not null,
  initial_seeds  integer      not null default 3000,
  small_blind    integer      not null default 10,
  big_blind      integer      not null default 20,
  round_no       integer      not null default 1,
  dealer_uid     varchar(64),
  max_seats      smallint     not null default 5,

  -- 牌局状态
  pot            integer      not null default 0,
  community_cards jsonb       not null default '[]'::jsonb,
  phase          public.game_phase not null default 'idle',
  current_bet    integer      not null default 0,
  min_raise      integer      not null default 0,
  turn_uid       varchar(64),
  last_aggressor varchar(64),
  acted_uids     jsonb        not null default '[]'::jsonb,

  -- 结算 / 加赛
  settlement     jsonb,
  playoff        jsonb,

  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now()
);

create index idx_rooms_status on public.rooms(status);

create table public.room_members (
  room_id    varchar(6)  not null references public.rooms(id) on delete cascade,
  user_id    varchar(64) not null references public.users(id) on delete cascade,
  seat_no    smallint    not null,
  seeds      integer     not null,
  bet        integer     not null default 0,
  total_bet  integer     not null default 0,
  folded     boolean     not null default false,
  all_in     boolean     not null default false,
  is_turn    boolean     not null default false,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index idx_room_members_room on public.room_members(room_id);
create index idx_room_members_user on public.room_members(user_id);
```

**为什么拆两张表**：`room_members` 作为关联表，让「我参与了哪些房间」的查询和 RLS 判断都能用简单的 `EXISTS` 子查询，比在 `rooms` 里塞 JSON 数组更干净，也符合关系型设计。

---

### 1.3 `public.hands` — 底牌

```sql
create table public.hands (
  room_id    varchar(6)  not null references public.rooms(id) on delete cascade,
  user_id    varchar(64) not null,
  cards      jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
```

---

### 1.4 `public.decks` — 牌堆（客户端完全不可见）

```sql
create table public.decks (
  room_id    varchar(6) primary key references public.rooms(id) on delete cascade,
  deck       jsonb       not null,             -- 洗好的整副
  dealt      smallint    not null default 0,   -- 已发到第几张
  burned     jsonb       not null default '[]'::jsonb,
  updated_at timestamptz  not null default now()
);
```

**隐私实现**：不对 `anon` / `authenticated` 授予任何 `GRANT`，且**不启用 RLS 也不需要**——因为表级 GRANT 就是拒绝。前端连读的权限都没有。

---

## 2. 安全规则（GRANT + RLS 双层）

### 2.1 核心原则

官方四层「双重锁定」原则：**表级 GRANT 与 RLS Policy 都通过，操作才会成功。任一层拒绝均返回权限错误。**

**标准执行顺序**：
```
建表 → 启用 RLS → 授权 GRANT → 创建策略
```

### 2.2 完整 SQL（可直接在控制台 SQL 编辑器执行）

```sql
-- ============================================================
-- 0. 清理（重跑时用）
-- ============================================================
drop table if exists public.seed_ledger cascade;
drop table if exists public.room_members cascade;
drop table if exists public.hands cascade;
drop table if exists public.decks cascade;
drop table if exists public.rooms cascade;
drop view  if exists public.user_seed_stats cascade;
drop table if exists public.users cascade;
drop type  if exists public.room_mode cascade;
drop type  if exists public.game_type cascade;
drop type  if exists public.room_status cascade;
drop type  if exists public.game_phase cascade;

-- ============================================================
-- 1. 建表
-- ============================================================
create table public.users (
  id            varchar(64) primary key,
  nickname      varchar(32)  not null,
  avatar        smallint     not null default 1,
  golden_seeds  integer      not null default 0,
  total_games   integer      not null default 0,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);

create table public.seed_ledger (
  id          bigserial primary key,
  user_id     varchar(64) not null references public.users(id) on delete cascade,
  peer_uid    varchar(64) not null,
  peer_name   varchar(32) not null,
  peer_avatar smallint    not null,
  count       integer     not null default 0,
  constraint seed_ledger_unique unique (user_id, peer_uid)
);
create index idx_seed_ledger_user on public.seed_ledger(user_id);

create type public.room_mode   as enum ('online', 'offline');
create type public.game_type   as enum ('long', 'short');
create type public.room_status as enum ('waiting','playing','settling','playoff','finished');
create type public.game_phase  as enum ('idle','preflop','flop','turn','river','showdown');

create table public.rooms (
  id              varchar(6)    primary key,
  mode            public.room_mode   not null,
  game_type       public.game_type   not null default 'long',
  status          public.room_status not null default 'waiting',
  host_uid        varchar(64)  not null,
  initial_seeds   integer      not null default 3000,
  small_blind     integer      not null default 10,
  big_blind       integer      not null default 20,
  round_no        integer      not null default 1,
  dealer_uid      varchar(64),
  max_seats       smallint     not null default 5,
  pot             integer      not null default 0,
  community_cards jsonb        not null default '[]'::jsonb,
  phase           public.game_phase not null default 'idle',
  current_bet     integer      not null default 0,
  min_raise       integer      not null default 0,
  turn_uid        varchar(64),
  last_aggressor  varchar(64),
  acted_uids      jsonb        not null default '[]'::jsonb,
  settlement      jsonb,
  playoff         jsonb,
  created_at      timestamptz  not null default now(),
  updated_at      timestamptz  not null default now()
);
create index idx_rooms_status on public.rooms(status);

create table public.room_members (
  room_id    varchar(6)  not null references public.rooms(id) on delete cascade,
  user_id    varchar(64) not null references public.users(id) on delete cascade,
  seat_no    smallint    not null,
  seeds      integer     not null,
  bet        integer     not null default 0,
  total_bet  integer     not null default 0,
  folded     boolean     not null default false,
  all_in     boolean     not null default false,
  is_turn    boolean     not null default false,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index idx_room_members_room on public.room_members(room_id);
create index idx_room_members_user on public.room_members(user_id);

create table public.hands (
  room_id    varchar(6)  not null references public.rooms(id) on delete cascade,
  user_id    varchar(64) not null,
  cards      jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.decks (
  room_id    varchar(6) primary key references public.rooms(id) on delete cascade,
  deck       jsonb       not null,
  dealt      smallint    not null default 0,
  burned     jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 2. 金瓜子统计视图
-- ============================================================
create or replace view public.user_seed_stats as
select u.id,
       u.nickname,
       u.avatar,
       coalesce(sum(l.count), 0)::integer as golden_seeds
from public.users u
left join public.seed_ledger l on l.user_id = u.id
group by u.id, u.nickname, u.avatar;

-- ============================================================
-- 3. 表级 GRANT（第一层）
-- ============================================================
grant select, insert, update, delete on public.users, public.seed_ledger,
     public.rooms, public.room_members, public.hands to anon, authenticated;

grant usage, select on sequence public.seed_ledger_id_seq to anon, authenticated;

-- decks 不授予任何权限 → 前端连读都做不到
-- 需要管理操作时，云函数用 service_role（API Key）访问

grant select on public.user_seed_stats to anon, authenticated;

-- ============================================================
-- 4. 启用 RLS + 创建策略（第二层）
-- ============================================================
alter table public.users        enable row level security;
alter table public.seed_ledger  enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.hands        enable row level security;

-- ---------- users：仅本人 ----------
create policy users_select_own on public.users
  for select to anon, authenticated
  using (id = (select auth.uid()));

create policy users_insert_own on public.users
  for insert to anon, authenticated
  with check (id = (select auth.uid()));

create policy users_update_own on public.users
  for update to anon, authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 不授 delete：注销走云函数

-- ---------- seed_ledger：仅本人，且 peer 不可改 ----------
create policy ledger_select_own on public.seed_ledger
  for select to anon, authenticated
  using (user_id = (select auth.uid()));

create policy ledger_insert_own on public.seed_ledger
  for insert to anon, authenticated
  with check (user_id = (select auth.uid()));

-- 只允许改 count（清账），不许改 peer_uid
create policy ledger_update_own on public.seed_ledger
  for update to anon, authenticated
  using (user_id = (select auth.uid()) and peer_uid = (select auth.uid()) is false)
  with check (user_id = (select auth.uid()));

create policy ledger_delete_own on public.seed_ledger
  for delete to anon, authenticated
  using (user_id = (select auth.uid()));

-- ---------- rooms：仅房间成员可读，不可写 ----------
create policy rooms_select_member on public.rooms
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.room_members m
      where m.room_id = public.rooms.id
        and m.user_id = (select auth.uid())
    )
  );

create policy rooms_insert_host on public.rooms
  for insert to anon, authenticated
  with check (host_uid = (select auth.uid()));

-- 不授 update / delete：房间状态全部走云函数改

-- ---------- room_members：仅本房间成员可读；自己只能改 seat_no ----------
create policy members_select_room on public.room_members
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.room_members me
      where me.room_id = public.room_members.room_id
        and me.user_id = (select auth.uid())
    )
  );

create policy members_insert_self on public.room_members
  for insert to anon, authenticated
  with check (user_id = (select auth.uid()));

-- seeds/bet/folded 等由云函数改，前端不能动
create policy members_update_self on public.room_members
  for update to anon, authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and folded = false and bet = 0);

-- ---------- hands：仅本人 ----------
create policy hands_select_own on public.hands
  for select to anon, authenticated
  using (user_id = (select auth.uid()));

-- 不授 insert/update/delete：发牌走云函数

-- ============================================================
-- 5. updated_at 自动维护
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger rooms_touch before update on public.rooms
  for each row execute function public.touch_updated_at();
```

### 2.3 六个必须记住的坑（官方明确列出）

| # | 坑 | 后果 |
|---|---|---|
| 1 | 启用了 RLS 但没写 Policy | 所有非 `service_role` 请求全被拒绝 |
| 2 | 写了 Policy 但忘记 GRANT | 表级权限不通过 |
| 3 | UPDATE 只写 `USING` 没写 `WITH CHECK` | 用户可把 `owner_id` 改成别人，窃取数据 |
| 4 | 前端代码用 API Key | `service_role` 有 BYPASSRLS，**等于数据全裸** |
| 5 | `serial` 主键忘授 SEQUENCE 权限 | INSERT 报权限错误 |
| 6 | 直接写 `auth.uid()` 而非 `(select auth.uid())` | PostgreSQL 对**每一行**都调用一次函数，大表性能差数个数量级 |

### 2.4 RPC 的后门风险（重要）

官方原文：

> Cloudbase PostgREST **当前不强制检查 `GRANT EXECUTE` 权限**——所有角色（包括 `anon`）在网关层面都可以调用任何 `/rpc/{函数名}` 端点。

**含义**：不要指望 `REVOKE EXECUTE` 保护函数。`SECURITY DEFINER` 函数**必须在函数体内自行校验角色**：

```sql
create or replace function public.admin_only_action()
returns json language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if current_setting('request.jwt.claims', true)::json->>'role' <> 'service_role' then
    raise exception 'Permission denied';
  end if;
  return json_build_object('ok', true);
end;
$$;
```

**对本项目的含义**：所有涉及发牌、改筹码、转账金瓜子的函数，都必须写成 `SECURITY DEFINER` + 函数体内校验，且用 `FOR UPDATE` 锁行防并发。

---

## 3. 实时同步：两条路，优先 Broadcast

### 3.1 路线 A：Postgres CDC（依赖数据库，消耗资源点）

```ts
import { postgresChangesFilter } from "@cloudbase/js-sdk/realtime-js";

const channel = app.realtime().channel("db-changes", {
  config: { postgres_changes_options: { wait: true, timeout: 15000 } },
});

channel.on(
  "postgres_changes",
  { event: "*", schema: "public", table: "rooms", filter: postgresChangesFilter().eq("id", roomId) },
  (payload) => {
    // payload.eventType: INSERT | UPDATE | DELETE
    // payload.new / payload.old
    applyRoomState(payload.new);
  }
);

channel.subscribe((status) => {
  if (status === "SUBSCRIBED") console.log("已订阅");
});
```

**前置准备（数据库侧，必做否则订阅成功但收不到事件）**
```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'cloudbase_realtime') THEN
    CREATE PUBLICATION cloudbase_realtime;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'cloudbase_realtime'
      AND schemaname = 'public' AND tablename = 'rooms'
  ) THEN
    EXECUTE 'ALTER PUBLICATION cloudbase_realtime ADD TABLE public.rooms';
  END IF;
END $$;

GRANT SELECT ON public.rooms TO "cloudbase_realtime_admin";
ALTER TABLE public.rooms REPLICA IDENTITY FULL;
```

> ⚠️ **加表后约 10 秒才生效**（poller 周期性感知，无需重启）
> ⚠️ CDC 的 poller 会持续产生数据库处理 → **每 5 分钟都判为"有使用" → 持续消耗资源点**

### 3.2 路线 B：Broadcast（不依赖数据库，不消耗资源点）

**这是我更推荐给本项目的方案。**

```ts
const ch = app.realtime().channel(`room:${roomId}`, {
  config: { broadcast: { ack: false, self: false } },
});

ch.on("broadcast", { event: "room-state" }, (payload) => {
  applyRoomState(payload.state);
});

ch.subscribe(async (status) => {
  if (status !== "SUBSCRIBED") return;
  // 新加入者先拉一次全量
  const { data } = await app.rdb().from("rooms").select("*").eq("id", roomId).maybeSingle();
  applyRoomState(data);
});
```

**工作方式**：客户端调云函数 → 云函数改数据库 + 通过 Broadcast 广播新状态 → 其他客户端收到推送直接渲染。

**优势**：
- Broadcast 是内存消息通道，**不产生数据库调用，不消耗资源点**
- 没有 publication / REPLICA IDENTITY 的前置要求
- 没有「加表 10 秒生效」的坑
- 不触发 PG 共享实例的"5 分钟判活"

**代价**：广播消息需要自己从云函数侧发出（云函数用 `@cloudbase/node-sdk` 的 realtime 能力，或让云函数写一个 `broadcast` 触发动作）。

> ⚠️ **待实测**：云函数侧如何发 Broadcast。如果 node-sdk 不支持服务端广播，则改用 CDC。这是必须先验证的点。

### 3.3 路线 C：轮询（兜底）

`setInterval` 每 1-2 秒 `select` 一次房间状态。简单可靠，但每次查询都消耗资源点，且 3-5 人同时轮询会频繁判活。

**费用对比**（以 5 人局、一局 5 分钟、每 2 秒轮询一次）：
- 轮询：5 人 × 150 次 = 750 次查询 ≈ 15 资源点/局。一局 5 分钟 = 1 个"有使用"窗口 = 0.04167 CU ≈ **14 资源点（上海）/ 24（新加坡）**
- 所以**每次开局的 5 分钟窗口是固定成本 14-24 点**，与轮询频率无关（因为 5 分钟窗口内只要有一次访问就算全额）

**这个发现很重要**：既然一个 5 分钟窗口的计费是固定的，**轮询频率不影响 CPU 计费**（只影响"数据库调用次数"计费，200 点/万次，极便宜）。所以轮询其实是经济上可接受的兜底方案。

---

## 4. 需要实测的四件事（按优先级）

| # | 事项 | 为什么关键 | 怎么测 |
|---|---|---|---|
| 1 | **环境地域** | 上海 342 点/核·小时，新加坡 587 点；且新加坡不支持云托管 | 控制台「概览」页 |
| 2 | **云函数能否连通 PostgreSQL** | 免费版云函数**不支持 VPC**，而文档说云函数"优先使用内网访问" | 部署一个测试函数，`select 1` |
| 3 | **Broadcast 能否从服务端发** | 决定实时方案选 B 还是 A | 云函数里调 realtime 发一条，前端订阅看能否收到 |
| 4 | **PG CDC 是否真的可用** | 文档自相矛盾 | 按 §3.1 的 SQL + 代码实测 |

> **如果 #2 不通**（云函数连不上 PG），整个架构要改成**前端直连 + 数据库函数（RPC）承载全部游戏逻辑**。这个方案甚至更省——不需要云函数，逻辑写在 `SECURITY DEFINER` 的 PG 函数里，用 `FOR UPDATE` 锁行保证并发安全。代价是德州逻辑要用 PL/pgSQL 写，调试比 JS 麻烦。

---

## 5. 我的建议

**先做 #1（看地域），再按这个顺序推进：**

1. 前端直连 PG 的部分（注册、大厅、房间列表、金瓜子统计）**现在就能写**，不依赖任何待验证项
2. 游戏逻辑（牌型判定、下注状态机、边池、结算）**现在就能写**，纯计算
3. 数据访问层和实时方案等 #2 #3 #4 实测结果

**如果四项实测全部通过** → 云函数跑逻辑 + Broadcast 推送，架构最干净
**如果 #2 不通但 #3 #4 通** → 逻辑前移到 RPC 函数，前端直连
**如果 #3 #4 都不通** → 轮询兜底，经济上可接受（见 §3.3）

---

## 6. 一句话

**PostgreSQL 方案可行，前端能直连（`app.rdb()`，Supabase 风格），免费版能用（上海地域约 35 分钟活跃/天）。但有四个点必须先实测，其中「云函数能否连上 PG」是架构分岔点。**
