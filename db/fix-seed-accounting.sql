-- ============================================================
-- 结算金瓜子写入 accounts（而不是 users）
--
-- 问题：账目体系上线后，前端金瓜子读 accounts.golden_seeds，
--       但 offline_settle 的转账仍在写 users.golden_seeds。
--       两张表脱节 → 结算成功但界面金瓜子永远 0。
--
-- 修法：新增 account_seed_transfer()，按账号记账。
--       offline_settle 改调它。
--
-- 记账规则沿用 users 时代的语义：
--   * 归零者 golden_seeds -1
--   * 最多者 golden_seeds +1
--   * 可为负
--   * seed_ledger 双向记账（owner 视角一行、peer 视角一行）
--
--   seed_ledger.user_id / peer_uid 存账号名而非 uid，
--   这样换设备后账本还在。
-- ============================================================

-- ---- 1. seed_ledger 允许存账号名 ----
-- 原列是 varchar(64) 且外键指向 users(id)，
-- 账号名最长 16，放宽长度 + 去掉外键（账号名不是 users.id）。
ALTER TABLE public.seed_ledger
  ALTER COLUMN user_id TYPE varchar(64),
  ALTER COLUMN peer_uid TYPE varchar(64);

-- 去掉指向 users 的外键（如果存在）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name LIKE '%seed_ledger%user_id%'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE public.seed_ledger DROP CONSTRAINT '
             || constraint_name
      FROM information_schema.table_constraints
      WHERE constraint_name LIKE '%seed_ledger%user_id%'
        AND constraint_type = 'FOREIGN KEY'
      LIMIT 1
    );
  END IF;
END $$;


-- ---- 2. 按账号记账的金瓜子转账 ----
CREATE OR REPLACE FUNCTION public.account_seed_transfer(
  p_from_uid varchar,     -- 付款方匿名 uid
  p_to_uid   varchar,     -- 收款方匿名 uid
  p_amount   integer DEFAULT 1
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_from_acct varchar;
  v_to_acct   varchar;
  v_from_nick varchar;
  v_to_nick   varchar;
  v_from_ava  smallint;
  v_to_ava    smallint;
BEGIN
  IF p_amount = 0 THEN
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  -- 把 uid 解析成账号名。没绑账号的（纯游客）不记账——
  -- 没有账号就没有可归属的金瓜子。
  SELECT account, nickname, avatar INTO v_from_acct, v_from_nick, v_from_ava
  FROM public.accounts WHERE uid = p_from_uid;

  SELECT account, nickname, avatar INTO v_to_acct, v_to_nick, v_to_ava
  FROM public.accounts WHERE uid = p_to_uid;

  IF v_from_acct IS NULL OR v_to_acct IS NULL OR v_from_acct = v_to_acct THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', '任一方未绑定账号');
  END IF;

  -- 付款方
  UPDATE public.accounts
  SET golden_seeds = golden_seeds - p_amount
  WHERE account = v_from_acct;

  INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
  VALUES (v_from_acct, v_to_acct,
          COALESCE(v_to_nick, v_to_acct), COALESCE(v_to_ava, 1), -p_amount)
  ON CONFLICT (user_id, peer_uid)
  DO UPDATE SET count = public.seed_ledger.count + (-p_amount);

  -- 收款方
  UPDATE public.accounts
  SET golden_seeds = golden_seeds + p_amount
  WHERE account = v_to_acct;

  INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
  VALUES (v_to_acct, v_from_acct,
          COALESCE(v_from_nick, v_from_acct), COALESCE(v_from_ava, 1), p_amount)
  ON CONFLICT (user_id, peer_uid)
  DO UPDATE SET count = public.seed_ledger.count + p_amount;

  -- 归零的账本行清掉，不留噪音
  DELETE FROM public.seed_ledger WHERE count = 0;

  RETURN json_build_object('ok', true, 'skipped', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_seed_transfer(varchar, varchar, integer) TO anon, authenticated;


-- ---- 3. offline_settle 改调账号记账 ----
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

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  IF v_room.host_uid <> v_uid THEN
    RAISE EXCEPTION '只有房主能结算';
  END IF;

  v_initial := COALESCE(v_room.initial_seeds, 3000);

  -- 幂等：同一局只结算一次，防房主连点导致金瓜子 ×2
  IF v_room.round_status <> 'settling' THEN
    RETURN json_build_object(
      'ok', true, 'skipped', true,
      'reason', '本局不在待结算状态',
      'roundNo', v_room.round_no
    );
  END IF;

  -- 1. 金瓜子转账（按账号记账）
  FOR v_t IN SELECT * FROM jsonb_array_elements(p_transfers) LOOP
    v_from   := v_t->>'fromUid';
    v_to     := v_t->>'toUid';
    v_amount := COALESCE((v_t->>'amount')::integer, 1);

    IF v_from IS NULL OR v_to IS NULL OR v_from = v_to THEN
      CONTINUE;
    END IF;

    PERFORM public.account_seed_transfer(v_from, v_to, v_amount);
  END LOOP;

  -- 2. 写历史
  IF p_save_history THEN
    SELECT jsonb_agg(jsonb_build_object(
      'uid', user_id, 'nickname', nickname, 'avatar', avatar,
      'seeds', seeds, 'delta', seeds - v_initial
    )) INTO v_members
    FROM public.room_members WHERE room_id = p_room_id;

    INSERT INTO public.history (
      room_no, mode, round_no, initial_seeds, small_blind, big_blind,
      players, seeds_moves, created_by
    ) VALUES (
      p_room_id, v_room.mode, v_room.round_no, v_initial,
      v_room.small_blind, v_room.big_blind,
      COALESCE(v_members, '[]'::jsonb),
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', nickname, 'delta', delta
      )) FROM public.pot_log WHERE room_id = p_room_id), '[]'::jsonb),
      v_uid
    ) RETURNING id INTO v_history_id;
  END IF;

  -- 3. 全员重置、局数+1、状态回 playing
  UPDATE public.room_members
  SET seeds = v_initial, bet = 0, total_bet = 0,
      folded = false, all_in = false, is_turn = false, blind = NULL
  WHERE room_id = p_room_id;

  UPDATE public.rooms
  SET pot = 0, round_no = round_no + 1, round_status = 'playing'
  WHERE id = p_room_id;

  DELETE FROM public.pot_log WHERE room_id = p_room_id;

  RETURN json_build_object(
    'ok', true, 'skipped', false,
    'roundNo', v_room.round_no + 1,
    'historyId', v_history_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.offline_settle(varchar, jsonb, boolean) TO anon, authenticated;
