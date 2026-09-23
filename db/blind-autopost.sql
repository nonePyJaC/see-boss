-- ============================================================
-- 自动大小麦：轮转时自动下注
--
-- 背景：原 rotate_blinds 只改 blind 标签，不动筹码，
--       需要玩家手动「出瓜子」。本文件让它真正自动下注。
--
-- 规则：
--   1. 轮转后，新小麦从自己瓜子扣 small_blind 投入公共池
--      新大麦从自己瓜子扣 big_blind 投入公共池
--   2. 下注写进 room_members.bet / total_bet，摊牌时用来算边池
--   3. 余额不足时有多少扣多少
--   4. 仍然只有房主能调
--
-- 注意：SET 右边的表达式全部基于该行旧值求值，
--       所以必须先把「实际下注额」算出来再一次性写入，不能级联引用。
-- ============================================================

CREATE OR REPLACE FUNCTION public.rotate_blinds(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     varchar;
  v_host    varchar;
  v_old_sb  varchar;
  v_old_bb  varchar;
  v_new_sb  varchar;
  v_new_bb  varchar;
  v_first   varchar;
  v_sb_amt  integer;
  v_bb_amt  integer;
  v_posted  integer;
  v_room    public.rooms%ROWTYPE;
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
    RAISE EXCEPTION '只有房主可以调整麦位';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = p_room_id) THEN
    RAISE EXCEPTION '房间里还没有玩家';
  END IF;

  v_sb_amt := COALESCE(v_room.small_blind, 0);
  v_bb_amt := COALESCE(v_room.big_blind, 0);

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

  -- ── 自动下注：小麦 ──
  -- 先算出这一个人实际能下多少，再一次写入，避免 SET 内自我引用
  SELECT LEAST(seeds, v_sb_amt) INTO v_posted
  FROM public.room_members
  WHERE room_id = p_room_id AND blind = 'sb';

  IF v_posted IS NOT NULL AND v_posted > 0 THEN
    UPDATE public.room_members
    SET seeds     = seeds - v_posted,
        bet       = bet + v_posted,
        total_bet = total_bet + v_posted
    WHERE room_id = p_room_id AND blind = 'sb';

    UPDATE public.rooms
    SET pot = pot + v_posted
    WHERE id = p_room_id;
  END IF;

  -- ── 自动下注：大麦 ──
  SELECT LEAST(seeds, v_bb_amt) INTO v_posted
  FROM public.room_members
  WHERE room_id = p_room_id AND blind = 'bb';

  IF v_posted IS NOT NULL AND v_posted > 0 THEN
    UPDATE public.room_members
    SET seeds     = seeds - v_posted,
        bet       = bet + v_posted,
        total_bet = total_bet + v_posted
    WHERE room_id = p_room_id AND blind = 'bb';

    UPDATE public.rooms
    SET pot = pot + v_posted
    WHERE id = p_room_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'seats', (
      SELECT jsonb_agg(jsonb_build_object(
        'uid', m.user_id, 'seatNo', m.seat_no, 'blind', m.blind,
        'seeds', m.seeds, 'bet', m.bet
      ) ORDER BY m.seat_no)
      FROM public.room_members m WHERE m.room_id = p_room_id
    ),
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_blinds(varchar) TO anon, authenticated;


-- ============================================================
-- set_blinds：房主手动指定时也自动下注
-- 语义与 rotate_blinds 保持一致：指定谁小麦谁大麦，同时扣注
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_blinds(
  p_room_id varchar,
  p_sb_uid  varchar,
  p_bb_uid  varchar
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    varchar;
  v_host   varchar;
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
  IF v_room.host_uid <> v_uid THEN
    RAISE EXCEPTION '只有房主可以调整麦位';
  END IF;

  IF p_sb_uid IS NOT NULL AND p_sb_uid = p_bb_uid THEN
    RAISE EXCEPTION '小麦和大麦不能是同一个人';
  END IF;

  IF p_sb_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = p_sb_uid
  ) THEN
    RAISE EXCEPTION '小麦玩家不在这个房间';
  END IF;

  IF p_bb_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = p_bb_uid
  ) THEN
    RAISE EXCEPTION '大麦玩家不在这个房间';
  END IF;

  v_sb_amt := COALESCE(v_room.small_blind, 0);
  v_bb_amt := COALESCE(v_room.big_blind, 0);

  -- 把当前小麦/大麦自动下注的筹码退回来，且清空 bet
  -- 用一个语句先汇总，再两步写：先算总额，再退还，避免级联引用混乱
  SELECT COALESCE(sum(bet), 0) INTO v_refund
  FROM public.room_members
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.room_members
  SET seeds     = seeds + bet,
      total_bet = total_bet - bet,
      bet       = 0
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.rooms
  SET pot = pot - v_refund
  WHERE id = p_room_id;

  UPDATE public.room_members SET blind = NULL WHERE room_id = p_room_id;

  IF p_sb_uid IS NOT NULL THEN
    UPDATE public.room_members SET blind = 'sb'
    WHERE room_id = p_room_id AND user_id = p_sb_uid;
  END IF;

  IF p_bb_uid IS NOT NULL THEN
    UPDATE public.room_members SET blind = 'bb'
    WHERE room_id = p_room_id AND user_id = p_bb_uid;
  END IF;

  -- 小麦下注
  SELECT LEAST(seeds, v_sb_amt) INTO v_posted
  FROM public.room_members
  WHERE room_id = p_room_id AND blind = 'sb';

  IF v_posted IS NOT NULL AND v_posted > 0 THEN
    UPDATE public.room_members
    SET seeds = seeds - v_posted, bet = bet + v_posted, total_bet = total_bet + v_posted
    WHERE room_id = p_room_id AND blind = 'sb';
    UPDATE public.rooms SET pot = pot + v_posted WHERE id = p_room_id;
  END IF;

  -- 大麦下注
  SELECT LEAST(seeds, v_bb_amt) INTO v_posted
  FROM public.room_members
  WHERE room_id = p_room_id AND blind = 'bb';

  IF v_posted IS NOT NULL AND v_posted > 0 THEN
    UPDATE public.room_members
    SET seeds = seeds - v_posted, bet = bet + v_posted, total_bet = total_bet + v_posted
    WHERE room_id = p_room_id AND blind = 'bb';
    UPDATE public.rooms SET pot = pot + v_posted WHERE id = p_room_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'seats', (
      SELECT jsonb_agg(jsonb_build_object(
        'uid', m.user_id, 'seatNo', m.seat_no, 'blind', m.blind,
        'seeds', m.seeds, 'bet', m.bet
      ) ORDER BY m.seat_no)
      FROM public.room_members m WHERE m.room_id = p_room_id
    ),
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_blinds(varchar, varchar, varchar) TO anon, authenticated;


-- ============================================================
-- reset_blinds：清空所有麦位并把自动下注的筹码退回各座位
-- 供「关闭自动大小麦」时调用
-- ============================================================

CREATE OR REPLACE FUNCTION public.reset_blinds(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    varchar;
  v_host   varchar;
  v_refund integer;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT host_uid INTO v_host FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  IF v_host <> v_uid THEN
    RAISE EXCEPTION '只有房主可以调整麦位';
  END IF;

  -- 退还自动下注的筹码（先算总额再写，避免语句内自引用）
  SELECT COALESCE(sum(bet), 0) INTO v_refund
  FROM public.room_members
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.room_members
  SET seeds     = seeds + bet,
      total_bet = total_bet - bet,
      bet       = 0
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.rooms
  SET pot = pot - v_refund
  WHERE id = p_room_id;

  -- 清空麦位
  UPDATE public.room_members
  SET blind = NULL
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb');

  RETURN json_build_object(
    'ok', true,
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_blinds(varchar) TO anon, authenticated;
