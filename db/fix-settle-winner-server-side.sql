-- ============================================================
-- 结算收款方改由服务端裁定
--
-- 背景：offline_settle 的 p_transfers 由前端 buildSettlement 算出。
--       前端用的是本地 players（可能是上一次轮询的快照），
--       存在「按旧状态转账」的风险——尤其全员 all in、
--       只有一人收底池这种筹码剧烈变化的场景。
--
-- 修法：忽略客户端传来的收款方，服务端按当前 room_members 重算：
--        归零者 = seeds <= 0
--        收款方 = 非归零者中 seeds 最多者（并列则跳过，交给房主点选）
--        全员归零 = 无人可收，跳过
--
-- 同时响应需求：「所有人都 all in 的情况下，只有 1 个人收底池后的结算」
--   A all in 输光, B all in 输光, C 收底池 3000
--   → zeroed=[A,B], winner=C, transfers=[A→C 1, B→C 1]
--   这个场景由本函数保证正确，不依赖前端算对。
-- ============================================================

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
  v_zeroed_cnt  integer;
  v_total_cnt   integer;
  v_winner      varchar;
  v_max_seeds   integer;
  v_tie_cnt     integer;
  v_paid        integer := 0;
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

  -- 幂等：同一局只结算一次
  IF v_room.round_status <> 'settling' THEN
    RETURN json_build_object(
      'ok', true, 'skipped', true,
      'reason', '本局不在待结算状态',
      'roundNo', v_room.round_no
    );
  END IF;

  -- ── 服务端自己裁定谁该收金瓜子 ──
  SELECT count(*) INTO v_total_cnt FROM public.room_members WHERE room_id = p_room_id;
  SELECT count(*) INTO v_zeroed_cnt
  FROM public.room_members WHERE room_id = p_room_id AND seeds <= 0;

  -- 全员归零（含全员 all in 后无人剩筹码）→ 无人可收
  IF v_zeroed_cnt = 0 OR v_zeroed_cnt >= v_total_cnt THEN
    v_winner := NULL;
  ELSE
    -- 非归零者中的最高筹码
    SELECT max(seeds) INTO v_max_seeds
    FROM public.room_members WHERE room_id = p_room_id AND seeds > 0;

    -- 并列检查：多个非归零者同为最高 → 不能自动判定
    SELECT count(*) INTO v_tie_cnt
    FROM public.room_members
    WHERE room_id = p_room_id AND seeds > 0 AND seeds = v_max_seeds;

    IF v_tie_cnt > 1 THEN
      -- 并列时尊重客户端传来的收款方（房主已点选），
      -- 但只在前端确实传了的时候
      SELECT (p_transfers->0->>'toUid') INTO v_winner;
    ELSE
      SELECT user_id INTO v_winner
      FROM public.room_members
      WHERE room_id = p_room_id AND seeds > 0 AND seeds = v_max_seeds
      LIMIT 1;
    END IF;
  END IF;

  -- ── 执行转账：归零者各付 1 粒给 v_winner ──
  IF v_winner IS NOT NULL THEN
    FOR v_from IN
      SELECT user_id FROM public.room_members
      WHERE room_id = p_room_id AND seeds <= 0 AND user_id <> v_winner
    LOOP
      PERFORM public.account_seed_transfer(v_from, v_winner, 1);
      v_paid := v_paid + 1;
    END LOOP;
  END IF;

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
    'ok', true,
    'skipped', false,
    'winner', v_winner,
    'paid', v_paid,
    'roundNo', v_room.round_no + 1,
    'historyId', v_history_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.offline_settle(varchar, jsonb, boolean) TO anon, authenticated;
