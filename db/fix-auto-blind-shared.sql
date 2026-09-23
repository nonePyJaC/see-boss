-- ============================================================
-- 自动大小麦：房间级开关落库
--
-- 问题：非房主点收款后不触发小麦大麦轮转和自动下注。
--
-- 根因：autoBlind 只存在于房主浏览器的 ref 里。
--       房主点了锁，他自己手机上是 true；
--       其他人的手机上还是 false，于是他们收款时
--       if (autoBlind.value) 不成立，轮转根本不被调用。
--
-- 修法：把开关变成房间级状态。
--       rooms.auto_blind 一列，房主切锁时写库，
--       所有人从 room_snapshot 读，行为一致。
--
-- 同时提供 set_auto_blind / get_auto_blind 两个函数：
--       set   仅房主可调
--       get   任何成员可读（其实 room_snapshot 已带，留给调试用）
-- ============================================================

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS auto_blind boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.rooms.auto_blind IS '自动大小麦开关：true=自动下注+收款轮转，false=手动设置';


-- ---- 1. 房主设置自动大小麦开关 ----
CREATE OR REPLACE FUNCTION public.set_auto_blind(
  p_room_id varchar,
  p_on      boolean
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  varchar;
  v_room public.rooms%ROWTYPE;
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
    RAISE EXCEPTION '只有房主可以设置自动大小麦';
  END IF;

  UPDATE public.rooms SET auto_blind = p_on WHERE id = p_room_id;

  RETURN json_build_object(
    'ok', true,
    'autoBlind', p_on,
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_auto_blind(varchar, boolean) TO anon, authenticated;


-- ---- 2. room_snapshot 增加 autoBlind 字段 ----
-- 只重建这一个函数，避免动到其他部分。
CREATE OR REPLACE FUNCTION public.room_snapshot(
  p_room_id varchar,
  p_guest   boolean DEFAULT false
)
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
  v_seat_count integer;
  v_log jsonb;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;

  SELECT count(*) INTO v_seat_count FROM public.room_members WHERE room_id = p_room_id;

  IF p_guest THEN
    RETURN json_build_object(
      'id', v_room.id, 'mode', v_room.mode, 'status', v_room.status,
      'hostUid', v_room.host_uid, 'initialSeeds', v_room.initial_seeds,
      'smallBlind', v_room.small_blind, 'bigBlind', v_room.big_blind,
      'maxSeats', v_room.max_seats, 'roundNo', v_room.round_no,
      'pot', v_room.pot, 'myUid', v_uid,
      'isHost', v_room.host_uid = v_uid,
      'isGuest', true, 'seatCount', v_seat_count,
      'isFull', v_seat_count >= v_room.max_seats,
      'autoBlind', COALESCE(v_room.auto_blind, false),
      'seats', '[]'::jsonb, 'log', '[]'::jsonb
    );
  END IF;

  IF v_room.host_uid <> v_uid
     AND NOT public.is_room_member(p_room_id, v_uid) THEN
    RAISE EXCEPTION '你不在这个房间';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'uid', m.user_id, 'nickname', m.nickname, 'avatar', m.avatar,
    'seatNo', m.seat_no, 'seeds', m.seeds, 'bet', m.bet,
    'folded', m.folded, 'allIn', m.all_in, 'isTurn', m.is_turn,
    'isMe', m.user_id = v_uid, 'isHost', m.user_id = v_room.host_uid,
    'blind', m.blind
  ) ORDER BY m.seat_no) INTO v_seats
  FROM public.room_members m WHERE m.room_id = p_room_id;

  -- 最近 50 条流水（前端默认只显示 5 条，点「查看全部」才展开）
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'uid', l.uid, 'name', l.nickname, 'delta', l.delta, 'kind', l.kind
  ) ORDER BY l.seq DESC), '[]'::jsonb) INTO v_log
  FROM (
    SELECT * FROM public.pot_log
    WHERE room_id = p_room_id
    ORDER BY seq DESC LIMIT 50
  ) l;

  RETURN json_build_object(
    'id', v_room.id, 'mode', v_room.mode, 'status', v_room.status,
    'hostUid', v_room.host_uid, 'initialSeeds', v_room.initial_seeds,
    'smallBlind', v_room.small_blind, 'bigBlind', v_room.big_blind,
    'roundNo', v_room.round_no, 'pot', v_room.pot,
    'myUid', v_uid, 'isHost', v_room.host_uid = v_uid,
    'isGuest', false, 'seatCount', v_seat_count,
    'autoBlind', COALESCE(v_room.auto_blind, false),
    'seats', COALESCE(v_seats, '[]'::jsonb),
    'log', v_log
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_snapshot(varchar, boolean) TO anon, authenticated;
