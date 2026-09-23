-- ============================================================
-- room_snapshot 返回 updatedAt
--
-- 用途：前端退避轮询要用「版本号」判断房间有没有变。
--       已经有一套 rooms_touch BEFORE UPDATE 触发器在推
--       rooms.updated_at，所以这个字段是可靠的单调节拍器：
--         move_pot / rotate_blinds / set_blinds /
--         offline_settle / set_auto_blind 全都 UPDATE rooms
--       → updated_at 一定跟着动。
--
-- 不改任何业务逻辑，只加一个输出字段。
-- （guest 分支也加：前端在加入前会用它探活。）
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
      'roundStatus', COALESCE(v_room.round_status, 'playing'),
      'seats', '[]'::jsonb, 'log', '[]'::jsonb,
      'updatedAt', v_room.updated_at
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
  FROM public.room_members m WHERE room_id = p_room_id;

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
    'maxSeats', v_room.max_seats, 'roundNo', v_room.round_no,
    'pot', v_room.pot, 'myUid', v_uid, 'isHost', v_room.host_uid = v_uid,
    'isGuest', false, 'seatCount', v_seat_count,
    'autoBlind', COALESCE(v_room.auto_blind, false),
    'roundStatus', COALESCE(v_room.round_status, 'playing'),
    'seats', COALESCE(v_seats, '[]'::jsonb),
    'log', v_log,
    'updatedAt', v_room.updated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_snapshot(varchar, boolean) TO anon, authenticated;
