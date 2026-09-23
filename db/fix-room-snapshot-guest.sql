-- ============================================================
-- 修复：room_snapshot 的「鸡生蛋」死锁
--
-- 原逻辑要求调用者必须是房主或成员才返回数据。
-- 但 joinRoom 的流程是 先取快照 -> 再插入 room_members，
-- 第二个手机扫码进来时还不是成员，第一步就报「你不在这个房间」，
-- 永远走不到插入那步。
--
-- 修复：给 room_snapshot 加 p_guest 布尔参数。
--   p_guest = false（默认）→ 原行为，成员校验，返回完整数据
--   p_guest = true         → 游客视角，只返回房间公开配置 + 已占座数
--                              不返回其他玩家的昵称/头像/瓜子，避免信息泄露
-- ============================================================

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

  -- ── 游客视角：只看这个房间是否存在、是否满员 ──
  IF p_guest THEN
    RETURN json_build_object(
      'id', v_room.id,
      'mode', v_room.mode,
      'status', v_room.status,
      'hostUid', v_room.host_uid,
      'initialSeeds', v_room.initial_seeds,
      'smallBlind', v_room.small_blind,
      'bigBlind', v_room.big_blind,
      'maxSeats', v_room.max_seats,
      'roundNo', v_room.round_no,
      'pot', v_room.pot,
      'myUid', v_uid,
      'isHost', v_room.host_uid = v_uid,
      'isGuest', true,
      'seatCount', v_seat_count,
      'isFull', v_seat_count >= v_room.max_seats,
      'seats', '[]'::jsonb
    );
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
    'isHost', m.user_id = v_room.host_uid,
    'blind', m.blind
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
    'isGuest', false,
    'seatCount', v_seat_count,
    'seats', COALESCE(v_seats, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_snapshot(varchar, boolean) TO anon, authenticated;
