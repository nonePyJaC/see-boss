-- ============================================================
-- 结算金瓜子写入 accounts（v2 —— 不动 seed_ledger 列类型）
--
-- 问题：账号体系上线后，前端金瓜子读 accounts.golden_seeds，
--       但 offline_settle 的转账写在 users.golden_seeds，
--       两张表脱节 → 结算成功但界面金瓜子永远 0。
--
-- v1 失败原因：seed_ledger.user_id 被视图 user_seed_stats 引用，
--       ALTER COLUMN TYPE 报 "cannot alter type of a column used by a view"。
--
-- v2 做法：完全不碰 seed_ledger / users / user_seed_stats。
--       新建 account_ledger 表按账号记账，前端账本改读它。
--       accounts.golden_seeds 由函数维护，仍是唯一真源。
-- ============================================================

-- ---- 1. 账号账本表 ----
CREATE TABLE IF NOT EXISTS public.account_ledger (
  owner       varchar(16) NOT NULL,   -- 账目归属账号名
  peer        varchar(16) NOT NULL,   -- 对方账号名
  peer_name   varchar(32) NOT NULL DEFAULT '',
  peer_avatar smallint    NOT NULL DEFAULT 1,
  count       integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, peer)
);

CREATE INDEX IF NOT EXISTS idx_account_ledger_owner ON public.account_ledger(owner);

ALTER TABLE public.account_ledger ENABLE ROW LEVEL SECURITY;

-- 只能读自己的行
DROP POLICY IF EXISTS account_ledger_self ON public.account_ledger;
CREATE POLICY account_ledger_self ON public.account_ledger
  FOR SELECT TO anon, authenticated
  USING (owner = (
    SELECT a.account FROM public.accounts a WHERE a.uid = (select auth.uid())
  ));

-- 写只走函数（SECURITY DEFINER），不授 INSERT/UPDATE/DELETE 给 anon


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

  -- uid → 账号名。没绑账号（纯游客）不记账。
  SELECT account, nickname, avatar INTO v_from_acct, v_from_nick, v_from_ava
  FROM public.accounts WHERE uid = p_from_uid;

  SELECT account, nickname, avatar INTO v_to_acct, v_to_nick, v_to_ava
  FROM public.accounts WHERE uid = p_to_uid;

  IF v_from_acct IS NULL OR v_to_acct IS NULL OR v_from_acct = v_to_acct THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', '任一方未绑定账号');
  END IF;

  -- 付款方：金瓜子减少，账本记负
  UPDATE public.accounts
  SET golden_seeds = golden_seeds - p_amount
  WHERE account = v_from_acct;

  INSERT INTO public.account_ledger (owner, peer, peer_name, peer_avatar, count)
  VALUES (v_from_acct, v_to_acct,
          COALESCE(v_to_nick, v_to_acct), COALESCE(v_to_ava, 1), -p_amount)
  ON CONFLICT (owner, peer)
  DO UPDATE SET count = public.account_ledger.count + (-p_amount),
                peer_name = EXCLUDED.peer_name,
                peer_avatar = EXCLUDED.peer_avatar,
                updated_at = now();

  -- 收款方：金瓜子增加，账本记正
  UPDATE public.accounts
  SET golden_seeds = golden_seeds + p_amount
  WHERE account = v_to_acct;

  INSERT INTO public.account_ledger (owner, peer, peer_name, peer_avatar, count)
  VALUES (v_to_acct, v_from_acct,
          COALESCE(v_from_nick, v_from_acct), COALESCE(v_from_ava, 1), p_amount)
  ON CONFLICT (owner, peer)
  DO UPDATE SET count = public.account_ledger.count + p_amount,
                peer_name = EXCLUDED.peer_name,
                peer_avatar = EXCLUDED.peer_avatar,
                updated_at = now();

  -- 归零的行清掉，不留噪音
  DELETE FROM public.account_ledger WHERE count = 0;

  RETURN json_build_object('ok', true, 'skipped', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_seed_transfer(varchar, varchar, integer) TO anon, authenticated;


-- ---- 3. 读取我的账号账本 ----
CREATE OR REPLACE FUNCTION public.account_ledger_rows()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   varchar;
  v_acct  varchar;
  v_rows  jsonb;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT account INTO v_acct FROM public.accounts WHERE uid = v_uid;
  IF v_acct IS NULL THEN
    RETURN json_build_object('ok', true, 'rows', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'peerUid', peer,
    'peerName', peer_name,
    'peerAvatar', peer_avatar,
    'count', count
  ) ORDER BY abs(count) DESC), '[]'::jsonb) INTO v_rows
  FROM public.account_ledger WHERE owner = v_acct;

  RETURN json_build_object('ok', true, 'rows', v_rows);
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_ledger_rows() TO anon, authenticated;


-- ---- 4. 清掉与某人的账本（和解） ----
CREATE OR REPLACE FUNCTION public.clear_account_ledger_row(p_peer varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  varchar;
  v_acct varchar;
  v_delta integer;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT account INTO v_acct FROM public.accounts WHERE uid = v_uid;
  IF v_acct IS NULL THEN
    RAISE EXCEPTION '尚未登录账号';
  END IF;

  -- 把这个 peer 在我账上欠的数目从金瓜子里扣掉/加回来，
  -- 实现「和解」：双方结清，账本行删除。
  SELECT count INTO v_delta
  FROM public.account_ledger
  WHERE owner = v_acct AND peer = p_peer;

  IF v_delta IS NULL THEN
    RETURN json_build_object('ok', true, 'cleared', 0);
  END IF;

  -- v_delta > 0 表示对方欠我，和解后我放弃这笔债权
  UPDATE public.accounts
  SET golden_seeds = golden_seeds - v_delta
  WHERE account = v_acct;

  DELETE FROM public.account_ledger
  WHERE (owner = v_acct AND peer = p_peer)
     OR (owner = p_peer AND peer = v_acct);

  RETURN json_build_object('ok', true, 'cleared', v_delta);
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_account_ledger_row(varchar) TO anon, authenticated;


-- ---- 5. offline_settle 改调账号记账 ----
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
