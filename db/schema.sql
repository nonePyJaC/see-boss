-- ============================================================
-- ⛔ 基线 —— 正常情况不要执行
-- ============================================================
--
-- 表结构从这里建，但 is_room_member / transfer_seeds /
-- clear_seed_ledger_entry 三个函数已被后续版本替换。
-- 重跑本文件只覆盖这三个函数与表结构，不影响 move_pot /
-- offline_settle / room_snapshot（它们不在这里定义）。
--
-- 新增环境首次部署：可以执行。
-- 已在跑的环境：不要执行。请看 db/README.md。
--
-- ── 以下是原始说明（保留备查）────────────────────────────────
--
-- 仓鼠聚会 — CloudBase PostgreSQL 表结构 + 安全规则
--
-- 环境：see-boss-d2gjggfbz8808d1d4（PostgreSQL 类型）
-- 用法：控制台「SQL 型数据库 → PostgreSQL 管理 → 数据编辑器」逐条执行
--      （ExecutePGSql 每次只能执行一条 SQL，DDL 建议用 DO 块包装）
--
-- 设计原则：
--   1. 客户端只读，所有写操作走云函数（服务端身份，绕过 RLS）
--   2. 线上模式零留存：rooms 表加 TTL 语义，退出即删，不产生金瓜子
--   3. 金瓜子账本只在 users / seed_ledger，双向记账
-- ============================================================

-- ------------------------------------------------------------
-- 0. 清理（重跑时用）
-- ------------------------------------------------------------
DROP TABLE IF EXISTS public.seed_ledger CASCADE;
DROP TABLE IF EXISTS public.hands CASCADE;
DROP TABLE IF EXISTS public.decks CASCADE;
DROP TABLE IF EXISTS public.room_members CASCADE;
DROP TABLE IF EXISTS public.rooms CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP VIEW  IF EXISTS public.user_seed_stats CASCADE;
DROP TYPE  IF EXISTS public.room_mode CASCADE;
DROP TYPE  IF EXISTS public.game_type CASCADE;
DROP TYPE  IF EXISTS public.room_status CASCADE;
DROP TYPE  IF EXISTS public.game_phase CASCADE;

-- ------------------------------------------------------------
-- 1. 枚举
-- ------------------------------------------------------------
CREATE TYPE public.room_mode   AS ENUM ('online', 'offline');
CREATE TYPE public.game_type   AS ENUM ('long', 'short');
CREATE TYPE public.room_status AS ENUM ('waiting','playing','settling','finished');
CREATE TYPE public.game_phase  AS ENUM ('idle','preflop','flop','turn','river','showdown');

-- ------------------------------------------------------------
-- 2. users — 用户档案 + 金瓜子总数
--    id 用 CloudBase 匿名登录的 sub（varchar(64)，与 JWT sub 一致）
-- ------------------------------------------------------------
CREATE TABLE public.users (
  id            varchar(64) PRIMARY KEY,
  nickname      varchar(32)  NOT NULL,
  avatar        smallint     NOT NULL DEFAULT 1,
  golden_seeds  integer      NOT NULL DEFAULT 0,   -- 可为负
  total_games   integer      NOT NULL DEFAULT 0,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 3. seed_ledger — 金瓜子账本（每仓鼠一行）
--    count > 0：peer 给了我 count 颗
--    count < 0：我给了 peer |count| 颗
-- ------------------------------------------------------------
CREATE TABLE public.seed_ledger (
  id           bigserial PRIMARY KEY,
  user_id      varchar(64) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  peer_uid     varchar(64) NOT NULL,
  peer_name    varchar(32) NOT NULL,   -- 冗余存，对方改名不追溯
  peer_avatar  smallint    NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  CONSTRAINT seed_ledger_unique UNIQUE (user_id, peer_uid)
);
CREATE INDEX idx_seed_ledger_user ON public.seed_ledger(user_id);

-- ------------------------------------------------------------
-- 4. rooms — 房间公共状态
--    线上模式零留存：status='finished' 或 updated_at 超 6 小时即删
-- ------------------------------------------------------------
CREATE TABLE public.rooms (
  id              varchar(6)    PRIMARY KEY,
  mode            public.room_mode   NOT NULL,
  game_type       public.game_type   NOT NULL DEFAULT 'long',
  status          public.room_status NOT NULL DEFAULT 'waiting',
  host_uid        varchar(64)  NOT NULL,
  initial_seeds   integer      NOT NULL DEFAULT 3000,
  small_blind     integer      NOT NULL DEFAULT 10,
  big_blind       integer      NOT NULL DEFAULT 20,
  round_no        integer      NOT NULL DEFAULT 1,
  max_seats       smallint     NOT NULL DEFAULT 8,

  -- 线下模式专用：公共池
  pot             integer      NOT NULL DEFAULT 0,

  -- 线上模式牌局状态
  phase           public.game_phase NOT NULL DEFAULT 'idle',
  community_cards jsonb        NOT NULL DEFAULT '[]'::jsonb,
  current_bet     integer      NOT NULL DEFAULT 0,
  min_raise       integer      NOT NULL DEFAULT 0,
  turn_uid        varchar(64),
  last_aggressor  varchar(64),
  acted_uids      jsonb        NOT NULL DEFAULT '[]'::jsonb,
  dealer_uid      varchar(64),
  action_log      jsonb        NOT NULL DEFAULT '[]'::jsonb,

  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX idx_rooms_status ON public.rooms(status);
CREATE INDEX idx_rooms_updated ON public.rooms(updated_at);

-- ------------------------------------------------------------
-- 5. room_members — 座位（关联表，RLS 用它判断"我是否在这个房间"）
-- ------------------------------------------------------------
CREATE TABLE public.room_members (
  room_id    varchar(6)  NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id    varchar(64) NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  seat_no    smallint    NOT NULL,
  nickname   varchar(32) NOT NULL,
  avatar     smallint    NOT NULL,
  seeds      integer     NOT NULL,
  bet        integer     NOT NULL DEFAULT 0,
  total_bet  integer     NOT NULL DEFAULT 0,
  folded     boolean     NOT NULL DEFAULT false,
  all_in     boolean     NOT NULL DEFAULT false,
  is_turn    boolean     NOT NULL DEFAULT false,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX idx_room_members_room ON public.room_members(room_id);
CREATE INDEX idx_room_members_user ON public.room_members(user_id);

-- ------------------------------------------------------------
-- 6. hands — 底牌（每人只能看自己的）
-- ------------------------------------------------------------
CREATE TABLE public.hands (
  room_id    varchar(6)  NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id    varchar(64) NOT NULL,
  cards      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- ------------------------------------------------------------
-- 7. decks — 牌堆（客户端完全不可见）
--    不授予任何 GRANT，只有云函数（service_role）能读写
-- ------------------------------------------------------------
CREATE TABLE public.decks (
  room_id    varchar(6) PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  deck       jsonb       NOT NULL,
  dealt      smallint    NOT NULL DEFAULT 0,
  burned     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 8. history — 线下对局历史（线上模式不写）
-- ------------------------------------------------------------
CREATE TABLE public.history (
  id           bigserial PRIMARY KEY,
  room_no      varchar(6)  NOT NULL,
  mode         public.room_mode NOT NULL,
  round_no     integer     NOT NULL,
  initial_seeds integer     NOT NULL,
  small_blind  integer     NOT NULL,
  big_blind    integer     NOT NULL,
  players      jsonb       NOT NULL,   -- [{uid,nickname,avatar,seeds,delta}]
  seeds_moves  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_by   varchar(64) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_history_creator ON public.history(created_by, created_at DESC);

-- ============================================================
-- 9. 金瓜子统计视图
-- ============================================================
CREATE OR REPLACE VIEW public.user_seed_stats AS
SELECT u.id,
       u.nickname,
       u.avatar,
       COALESCE(SUM(l.count), 0)::integer AS golden_seeds
FROM public.users u
LEFT JOIN public.seed_ledger l ON l.user_id = u.id
GROUP BY u.id, u.nickname, u.avatar;

-- ============================================================
-- 10. updated_at 自动维护
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER rooms_touch BEFORE UPDATE ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER hands_touch BEFORE UPDATE ON public.hands
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 11. 表级 GRANT（第一层权限）
--     匿名登录的 role 是 anon，且带真实 sub
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.seed_ledger TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.seed_ledger_id_seq TO anon, authenticated;

GRANT SELECT, INSERT ON public.rooms TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.room_members TO anon, authenticated;

-- hands：只读，写入全走云函数
GRANT SELECT ON public.hands TO anon, authenticated;

-- history：仅创建者可读可写（RLS 限 created_by = auth.uid()）
GRANT SELECT, INSERT, DELETE ON public.history TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.history_id_seq TO anon, authenticated;

-- decks：不授予任何权限 → 前端连读都做不到
-- user_seed_stats：只读视图
GRANT SELECT ON public.user_seed_stats TO anon, authenticated;

-- ============================================================
-- 12. RLS 策略（第二层权限）
--     必须写 (select auth.uid()) 而不是 auth.uid()，
--     否则 PostgreSQL 会对每一行都调用一次函数
-- ============================================================
ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seed_ledger  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hands        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history      ENABLE ROW LEVEL SECURITY;

-- ---------- users：仅本人 ----------
CREATE POLICY users_select_own ON public.users
  FOR SELECT TO anon, authenticated
  USING (id = (select auth.uid()));

CREATE POLICY users_insert_own ON public.users
  FOR INSERT TO anon, authenticated
  WITH CHECK (id = (select auth.uid()));

CREATE POLICY users_update_own ON public.users
  FOR UPDATE TO anon, authenticated
  USING (id = (select auth.uid()))
  WITH CHECK (id = (select auth.uid()));

-- ---------- seed_ledger：仅本人，且 peer 归属不可改 ----------
CREATE POLICY ledger_select_own ON public.seed_ledger
  FOR SELECT TO anon, authenticated
  USING (user_id = (select auth.uid()));

CREATE POLICY ledger_insert_own ON public.seed_ledger
  FOR INSERT TO anon, authenticated
  WITH CHECK (user_id = (select auth.uid()));

-- 只允许改 count（清账），不许把记录挪到别人名下
CREATE POLICY ledger_update_own ON public.seed_ledger
  FOR UPDATE TO anon, authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()) AND peer_uid = (select auth.uid()) IS FALSE);

CREATE POLICY ledger_delete_own ON public.seed_ledger
  FOR DELETE TO anon, authenticated
  USING (user_id = (select auth.uid()));

-- ---------- rooms：仅房间成员可读；创建者才能建；禁前端改 ----------
-- 用 SECURITY DEFINER 函数判断成员身份，避免 RLS 自引用导致无限递归
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id varchar, p_uid varchar)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $
  SELECT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = p_uid
  );
$;

-- 房主或成员都能读：房主建房的瞬间还没有 member 记录，
-- 只判成员的话房主会看不到自己刚建的房间
CREATE POLICY rooms_select_member ON public.rooms
  FOR SELECT TO anon, authenticated
  USING (
    host_uid = (select auth.uid())
    OR public.is_room_member(id, (select auth.uid()))
  );

CREATE POLICY rooms_insert_host ON public.rooms
  FOR INSERT TO anon, authenticated
  WITH CHECK (host_uid = (select auth.uid()));

-- 不授 UPDATE / DELETE：房间状态全部走云函数改

-- ---------- room_members：同房间成员可读；自己只能改自己 ----------
CREATE POLICY members_select_room ON public.room_members
  FOR SELECT TO anon, authenticated
  USING (public.is_room_member(room_id, (select auth.uid())));

CREATE POLICY members_insert_self ON public.room_members
  FOR INSERT TO anon, authenticated
  WITH CHECK (user_id = (select auth.uid()));

-- seeds/bet/folded 等由云函数改，前端不能动
CREATE POLICY members_update_self ON public.room_members
  FOR UPDATE TO anon, authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()) AND bet = 0 AND folded = false AND all_in = false);

CREATE POLICY members_delete_self ON public.room_members
  FOR DELETE TO anon, authenticated
  USING (user_id = (select auth.uid()));

-- ---------- hands：仅本人 ----------
CREATE POLICY hands_select_own ON public.hands
  FOR SELECT TO anon, authenticated
  USING (user_id = (select auth.uid()));

-- ---------- history：仅创建者可读可写 ----------
CREATE POLICY history_select_own ON public.history
  FOR SELECT TO anon, authenticated
  USING (created_by = (select auth.uid()));

CREATE POLICY history_insert_own ON public.history
  FOR INSERT TO anon, authenticated
  WITH CHECK (created_by = (select auth.uid()));

CREATE POLICY history_delete_own ON public.history
  FOR DELETE TO anon, authenticated
  USING (created_by = (select auth.uid()));

-- ============================================================
-- 13. 线上模式零留存：清理已结束/过期的房间
--     RPC 函数，云函数定时调用（如每小时一次）
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_stale_rooms(max_age_hours integer DEFAULT 6)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- 只清理线上房间：线下房间是实体牌局的记账，需要保留到用户主动退出
  WITH gone AS (
    DELETE FROM public.rooms
    WHERE mode = 'online'
      AND (status = 'finished'
           OR updated_at < now() - make_interval(hours => max_age_hours))
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM gone;

  RETURN deleted_count;
END;
$$;

-- ============================================================
-- 14. 线上房间退出：删除房间及其关联数据
--     RPC，前端「退出房间」时调用（云函数转发）
-- ============================================================
CREATE OR REPLACE FUNCTION public.leave_online_room(p_room_id varchar)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- rooms 删了，room_members / hands / decks 靠 ON DELETE CASCADE 一起清
  DELETE FROM public.rooms
  WHERE id = p_room_id
    AND mode = 'online';
END;
$$;

-- ============================================================
-- 15. 金瓜子转账（双向记账，单事务）
--     RPC，云函数在结算时调用。SECURITY DEFINER + 函数体内校验，
--     因为 PostgREST 网关不检查 GRANT EXECUTE，任何角色都能调 RPC。
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_seeds(
  p_from_uid varchar,
  p_to_uid   varchar,
  p_amount   integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_from_uid = p_to_uid THEN
    RETURN;  -- 自己转自己无意义
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive';
  END IF;

  -- 确保双方档案存在（匿名登录首次写入）
  INSERT INTO public.users (id, nickname, avatar)
  VALUES (p_from_uid, '玩家', 1)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.users (id, nickname, avatar)
  VALUES (p_to_uid, '玩家', 1)
  ON CONFLICT (id) DO NOTHING;

  -- 付款方
  UPDATE public.users SET golden_seeds = golden_seeds - p_amount WHERE id = p_from_uid;
  INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
  SELECT p_from_uid, p_to_uid, u.nickname, u.avatar, -p_amount
  FROM public.users u WHERE u.id = p_to_uid
  ON CONFLICT (user_id, peer_uid)
  DO UPDATE SET count = public.seed_ledger.count + (-p_amount);

  -- 收款方
  UPDATE public.users SET golden_seeds = golden_seeds + p_amount WHERE id = p_to_uid;
  INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
  SELECT p_to_uid, p_from_uid, u.nickname, u.avatar, p_amount
  FROM public.users u WHERE u.id = p_from_uid
  ON CONFLICT (user_id, peer_uid)
  DO UPDATE SET count = public.seed_ledger.count + p_amount;

  -- 清理归零条目，不留空行
  DELETE FROM public.seed_ledger WHERE count = 0;
END;
$$;

-- ============================================================
-- 16. 清空账本某一行（双方同时清，避免坏账）
-- ============================================================
CREATE OR REPLACE FUNCTION public.clear_seed_ledger_entry(
  p_owner_uid varchar,
  p_peer_uid  varchar
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_count integer;
  v_peer_count  integer;
BEGIN
  SELECT count INTO v_owner_count FROM public.seed_ledger
  WHERE user_id = p_owner_uid AND peer_uid = p_peer_uid;

  SELECT count INTO v_peer_count FROM public.seed_ledger
  WHERE user_id = p_peer_uid AND peer_uid = p_owner_uid;

  -- 双方账面同时冲销
  IF v_owner_count IS NOT NULL AND v_owner_count <> 0 THEN
    UPDATE public.users SET golden_seeds = golden_seeds - v_owner_count
    WHERE id = p_owner_uid;
  END IF;

  IF v_peer_count IS NOT NULL AND v_peer_count <> 0 THEN
    UPDATE public.users SET golden_seeds = golden_seeds - v_peer_count
    WHERE id = p_peer_uid;
  END IF;

  DELETE FROM public.seed_ledger
  WHERE (user_id = p_owner_uid AND peer_uid = p_peer_uid)
     OR (user_id = p_peer_uid AND peer_uid = p_owner_uid);
END;
$$;

-- 补 GRANT：这几个函数原先漏了授权行。
-- PostgREST 下没有 GRANT EXECUTE 会直接 403，而线上这几条
-- 是靠后续操作手工补上的 —— 这里补齐，避免换环境重跑后踩同一个坑。
GRANT EXECUTE ON FUNCTION public.leave_online_room(varchar) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_seeds(varchar, varchar, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_seed_ledger_entry(varchar, varchar) TO anon, authenticated;
-- is_room_member 被 room_snapshot 等 SECURITY DEFINER 函数内部调用，
-- 也可能被前端直调，补 anon 授权防止 403。
GRANT EXECUTE ON FUNCTION public.is_room_member(varchar, varchar) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_rooms(integer) TO anon, authenticated;

-- ============================================================
-- 17. 实时订阅准备（若采用 Postgres CDC 方案）
--     若用 Broadcast / 轮询方案则不需要这段
--
--     ⚠️ 实测（2026-09-21）：本环境执行 GRANT ... TO
--     "cloudbase_realtime_admin" 报 SQLSTATE 42704
--     （role does not exist），说明 CDC 的 connector 角色未预置。
--     因此下面的授权全部做成条件执行，角色不存在就跳过，不阻断部署。
--
--     诊断：执行下面这句看环境里有哪些 realtime 相关角色
--       select rolname from pg_roles where rolname ilike '%realtime%'
--                                           or rolname ilike '%supabase%'
--                                           or rolname ilike '%cloudbase%';
-- ============================================================
DO $
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
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'cloudbase_realtime'
      AND schemaname = 'public' AND tablename = 'room_members'
  ) THEN
    EXECUTE 'ALTER PUBLICATION cloudbase_realtime ADD TABLE public.room_members';
  END IF;
END $;

-- connector 角色授权：角色不存在就跳过（CDC 未启用时属正常）
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudbase_realtime_admin') THEN
    EXECUTE 'GRANT SELECT ON public.rooms, public.room_members TO "cloudbase_realtime_admin"';
  ELSE
    RAISE NOTICE 'role cloudbase_realtime_admin 不存在，跳过 CDC 授权（用轮询/Broadcast 即可）';
  END IF;
END $;

ALTER TABLE public.rooms        REPLICA IDENTITY FULL;
ALTER TABLE public.room_members REPLICA IDENTITY FULL;
