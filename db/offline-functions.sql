-- ============================================================
-- ⛔ 基线 / 回滚目标 —— 正常情况不要执行
-- ============================================================
--
-- 这是最初的 baseline。线上这三个函数已被后续补丁替换：
--
--   move_pot        → 生效版本在 fix-settle-trigger.sql
--   offline_settle  → 生效版本在 fix-total-games.sql
--   room_snapshot   → 生效版本在 room-snapshot-updatedat.sql
--
-- 重跑本文件会让线上函数【退化】，前端立刻报错：
--   p_guest 参数不存在 / round_status 字段消失 /
--   收款人归零检测失效 / 结算按旧口径记账
--
-- 只在「确定要回到最初那版」时使用。正常情况下请看 db/README.md。
--
-- ── 以下是原始说明（保留备查）────────────────────────────────
--
-- 线下联机 — PG 函数（不依赖云函数）
--
-- 三个核心函数，前端通过 db.rpc() 调用：
--   move_pot         出瓜子/收瓜子（单事务改公共池和我的瓜子）
--   offline_settle   结算：金瓜子转账 + 写历史 + 重置瓜子
--   room_snapshot    获取房间 + 座位 + 我的状态
--
-- 全部 SECURITY DEFINER + 函数体内校验身份，
-- 因为 PostgREST 网关不检查 GRANT EXECUTE，任何角色都能调 RPC。
--
-- 用法：数据编辑器逐条执行
-- ============================================================

-- ------------------------------------------------------------
-- 1. move_pot — 公共池变动
--    p_amount > 0 = 出瓜子（我的 → 公共池）
--    p_amount < 0 = 收瓜子（公共池 → 我的）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_pot(
  p_room_id varchar,
  p_amount  integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      varchar;
  v_pot      integer;
  v_seeds    integer;
  v_new_pot  integer;
  v_new_seeds integer;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  IF p_amount = 0 THEN
    RAISE EXCEPTION '数量不能为 0';
  END IF;

  -- 锁房间行，防止并发改动公共池
  SELECT pot INTO v_pot FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;

  -- 锁我的座位行
  SELECT seeds INTO v_seeds FROM public.room_members
  WHERE room_id = p_room_id AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '你不在这个房间';
  END IF;

  v_new_pot   := v_pot + p_amount;
  v_new_seeds := v_seeds - p_amount;

  -- 校验：公共池和我的瓜子都不能为负
  IF v_new_pot < 0 THEN
    RAISE EXCEPTION '公共池没有这么多瓜子';
  END IF;
  IF v_new_seeds < 0 THEN
    RAISE EXCEPTION '我的瓜子不足';
  END IF;

  UPDATE public.rooms        SET pot = v_new_pot   WHERE id = p_room_id;
  UPDATE public.room_members SET seeds = v_new_seeds
  WHERE room_id = p_room_id AND user_id = v_uid;

  RETURN json_build_object(
    'pot', v_new_pot,
    'mySeeds', v_new_seeds,
    'delta', p_amount
  );
END;
$$;

-- ------------------------------------------------------------
-- 2. offline_settle — 线下结算
--
--    参数：
--      p_room_id    房间号
--      p_transfers  金瓜子转账 [{fromUid, toUid, amount}]
--      p_save_history 是否写历史记录
--
--    做三件事（单事务）：
--      1. 按 transfers 转金瓜子（复用 transfer_seeds 逻辑）
--      2. 全员重置瓜子为初始值，局数 +1，公共池清零
--      3. 可选：写 history 表
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offline_settle(
  p_room_id      varchar,
  p_transfers    jsonb DEFAULT '[]'::jsonb,
  p_save_history boolean DEFAULT true
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid         varchar;
  v_room        public.rooms%ROWTYPE;
  v_initial     integer;
  v_t           jsonb;
  v_from        varchar;
  v_to          varchar;
  v_amount      integer;
  v_history_id  bigint;
  v_members     jsonb;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  -- 只有房主能结算
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  IF v_room.host_uid <> v_uid THEN
    RAISE EXCEPTION '只有房主能结算';
  END IF;

  v_initial := v_room.initial_seeds;

  -- 1. 金瓜子转账（双向记账）
  FOR v_t IN SELECT * FROM jsonb_array_elements(p_transfers) LOOP
    v_from   := v_t->>'fromUid';
    v_to     := v_t->>'toUid';
    v_amount := COALESCE((v_t->>'amount')::integer, 1);

    IF v_from IS NULL OR v_to IS NULL OR v_from = v_to THEN
      CONTINUE;
    END IF;

    -- 确保双方档案存在
    INSERT INTO public.users (id, nickname, avatar)
    VALUES (v_from, '玩家', 1) ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.users (id, nickname, avatar)
    VALUES (v_to, '玩家', 1) ON CONFLICT (id) DO NOTHING;

    -- 付款方
    UPDATE public.users SET golden_seeds = golden_seeds - v_amount WHERE id = v_from;
    INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
    SELECT v_from, v_to, u.nickname, u.avatar, -v_amount
    FROM public.users u WHERE u.id = v_to
    ON CONFLICT (user_id, peer_uid)
    DO UPDATE SET count = public.seed_ledger.count + (-v_amount);

    -- 收款方
    UPDATE public.users SET golden_seeds = golden_seeds + v_amount WHERE id = v_to;
    INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
    SELECT v_to, v_from, u.nickname, u.avatar, v_amount
    FROM public.users u WHERE u.id = v_from
    ON CONFLICT (user_id, peer_uid)
    DO UPDATE SET count = public.seed_ledger.count + v_amount;
  END LOOP;

  DELETE FROM public.seed_ledger WHERE count = 0;

  -- 2. 快照当前局面（写历史用）
  SELECT jsonb_agg(jsonb_build_object(
    'uid', m.user_id,
    'nickname', m.nickname,
    'avatar', m.avatar,
    'seeds', m.seeds,
    'delta', m.seeds - v_initial
  ) ORDER BY m.seat_no) INTO v_members
  FROM public.room_members m WHERE m.room_id = p_room_id;

  -- 3. 写历史
  IF p_save_history THEN
    INSERT INTO public.history (
      room_no, mode, round_no, initial_seeds,
      small_blind, big_blind, players, seeds_moves, created_by
    ) VALUES (
      p_room_id, v_room.mode, v_room.round_no, v_initial,
      v_room.small_blind, v_room.big_blind,
      COALESCE(v_members, '[]'::jsonb),
      p_transfers,
      v_uid
    ) RETURNING id INTO v_history_id;
  END IF;

  -- 4. 重置：全员发初始瓜子，局数 +1，公共池清零
  UPDATE public.room_members
  SET seeds = v_initial, bet = 0, total_bet = 0,
      folded = false, all_in = false, is_turn = false
  WHERE room_id = p_room_id;

  UPDATE public.rooms
  SET pot = 0, round_no = round_no + 1, status = 'waiting'
  WHERE id = p_room_id;

  RETURN json_build_object(
    'ok', true,
    'roundNo', v_room.round_no + 1,
    'historyId', v_history_id
  );
END;
$$;

-- ------------------------------------------------------------
-- 3. room_snapshot — 获取房间 + 座位 + 公共池
--    比前端分别查 rooms / room_members 少一次往返，
--    且用 SECURITY DEFINER 统一做成员校验。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.room_snapshot(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  varchar;
  v_room public.rooms%ROWTYPE;
  v_seats jsonb;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;

  -- 必须是房主或成员
  IF v_room.host_uid <> v_uid
     AND NOT public.is_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION '你不在这个房间';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'uid', m.user_id,
    'nickname', m.nickname,
    'avatar', m.avatar,
    'seatNo', m.seat_no,
    'seeds', m.seeds,
    'bet', m.bet,
    'folded', m.folded,
    'allIn', m.all_in,
    'isTurn', m.is_turn,
    'isMe', m.user_id = v_uid,
    'isHost', m.user_id = v_room.host_uid
  ) ORDER BY m.seat_no) INTO v_seats
  FROM public.room_members m WHERE m.room_id = p_room_id;

  RETURN json_build_object(
    'id', v_room.id,
    'mode', v_room.mode,
    'status', v_room.status,
    'hostUid', v_room.host_uid,
    'initialSeeds', v_room.initial_seeds,
    'smallBlind', v_room.small_blind,
    'bigBlind', v_room.big_blind,
    'roundNo', v_room.round_no,
    'pot', v_room.pot,
    'myUid', v_uid,
    'isHost', v_room.host_uid = v_uid,
    'seats', COALESCE(v_seats, '[]'::jsonb)
  );
END;
$$;

-- ------------------------------------------------------------
-- 4. 授权：anon 要能调这三个函数
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.move_pot(varchar, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offline_settle(varchar, jsonb, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_snapshot(varchar) TO anon, authenticated;
