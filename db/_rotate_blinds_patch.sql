-- ============================================================
-- 补丁：rotate_blinds 放开了调用者身份
--
-- 原来写死「只有房主可以调整麦位」，导致非房主点收款后
-- 轮转被拒（RAISE EXCEPTION），下一轮大小麦不会自动下注。
--
-- 现在改为：任何房间成员都能触发轮转。
-- 敏感操作仍只放行房主 —— set_blinds / reset_blinds 未改动。
--
-- 本文件只覆盖 rotate_blinds 一个函数，可单独执行。
-- ============================================================

CREATE OR REPLACE FUNCTION public.rotate_blinds(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    varchar;
  v_old_sb varchar;
  v_old_bb varchar;
  v_new_sb varchar;
  v_new_bb varchar;
  v_first  varchar;
  v_sb_amt integer;
  v_bb_amt integer;
  v_posted integer;
  v_refund integer;
  v_room   public.rooms%ROWTYPE;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;

  -- 任何房间成员都能触发轮转：收款的人不一定是房主。
  -- 设麦位/改规则仍是房主特权，见 set_blinds / reset_blinds。
  IF NOT public.is_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION '你不在这个房间';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = p_room_id) THEN
    RAISE EXCEPTION '房间里还没有玩家';
  END IF;

  v_sb_amt := COALESCE(v_room.small_blind, 0);
  v_bb_amt := COALESCE(v_room.big_blind, 0);

  -- 收款（move_pot）已把全场 bet 归零，正常情况下这里没有旧注可退。
  -- 兜底：路径异常残留 bet 时全额退还，但 pot 绝不允许写成负数。
  SELECT COALESCE(sum(bet), 0) INTO v_refund
  FROM public.room_members
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  IF v_refund > 0 THEN
    UPDATE public.room_members
    SET seeds = seeds + bet, bet = 0
    WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

    UPDATE public.rooms
    SET pot = GREATEST(pot - LEAST(v_refund, pot), 0)
    WHERE id = p_room_id;
  END IF;

  -- ── 轮转麦位 ──
  SELECT max(seat_no)::text INTO v_old_sb
  FROM public.room_members WHERE room_id = p_room_id AND blind = 'sb';
  SELECT max(seat_no)::text INTO v_old_bb
  FROM public.room_members WHERE room_id = p_room_id AND blind = 'bb';
  SELECT min(seat_no)::text INTO v_first
  FROM public.room_members WHERE room_id = p_room_id;

  UPDATE public.room_members SET blind = NULL WHERE room_id = p_room_id;

  v_new_sb := COALESCE(v_old_bb, v_old_sb, v_first);
  SELECT COALESCE(
    (SELECT min(seat_no)::text FROM public.room_members
      WHERE room_id = p_room_id AND seat_no > v_new_sb::smallint),
    v_first
  ) INTO v_new_bb;

  UPDATE public.room_members SET blind = 'sb'
  WHERE room_id = p_room_id AND seat_no = v_new_sb::smallint;
  UPDATE public.room_members SET blind = 'bb'
  WHERE room_id = p_room_id AND seat_no = v_new_bb::smallint;

  -- ── 小麦自动下注 + 流水 ──
  SELECT LEAST(seeds, v_sb_amt) INTO v_posted
  FROM public.room_members
  WHERE room_id = p_room_id AND blind = 'sb';

  IF v_posted IS NOT NULL AND v_posted > 0 THEN
    UPDATE public.room_members
    SET seeds = seeds - v_posted, bet = bet + v_posted
    WHERE room_id = p_room_id AND blind = 'sb';

    UPDATE public.rooms SET pot = pot + v_posted WHERE id = p_room_id;

    INSERT INTO public.pot_log (room_id, uid, nickname, delta, kind)
    SELECT p_room_id, user_id, nickname, v_posted, 'sb'
    FROM public.room_members
    WHERE room_id = p_room_id AND blind = 'sb';
  END IF;

  -- ── 大麦自动下注 + 流水 ──
  SELECT LEAST(seeds, v_bb_amt) INTO v_posted
  FROM public.room_members
  WHERE room_id = p_room_id AND blind = 'bb';

  IF v_posted IS NOT NULL AND v_posted > 0 THEN
    UPDATE public.room_members
    SET seeds = seeds - v_posted, bet = bet + v_posted
    WHERE room_id = p_room_id AND blind = 'bb';

    UPDATE public.rooms SET pot = pot + v_posted WHERE id = p_room_id;

    INSERT INTO public.pot_log (room_id, uid, nickname, delta, kind)
    SELECT p_room_id, user_id, nickname, v_posted, 'bb'
    FROM public.room_members
    WHERE room_id = p_room_id AND blind = 'bb';
  END IF;

  RETURN json_build_object(
    'ok', true,
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_blinds(varchar) TO anon, authenticated;
