-- ============================================================
-- 结算流程修正（三个实测问题）
--
-- 问题 1：有人把瓜子全部打出就触发结算了。
--         正确顺序是——牌打完 → 收完公共池 → 才判断谁归零 → 结算。
--         原来前端在 applySnapshot 里看到 seeds<=0 就弹结算，
--         而自动下注（小麦/大麦）本身就可能把某人扣到 0。
--
-- 问题 2：一局结算了 2 次，金瓜子 *2。
--         前端 settling 是本地 ref，每次轮询重算；
--         且 settleAndRestart 的 payGoldenSeeds 可被重复触发。
--
-- 问题 3：房主点重开后，其他玩家卡在结算弹窗里点不动。
--         弹窗按钮绑 :disabled="!isHost"，
--         而他们的 settling 仍是 true——本地状态没被重置。
--
-- 修法：把「是否处于待结算」变成房间级服务端状态。
--   rooms.round_status   varchar(12)
--       'playing'  正常进行
--       'settling' 待结算（有人归零，等房主操作）
--   users.golden_seeds  账号化（原 users 表按 uid，账号体系下要按 account）
--   settle_once         事务内幂等：同一局只能结算一次
--
-- 触发点（服务端说了算）：
--   * move_pot 收款时检查是否有人 seeds<=0 → 有则置 settling
--   * 自动下注后不检查（牌还没打完）
--   * offline_settle 结算后置回 playing
-- ============================================================

-- ---- 1. rooms 增加结算状态列 ----
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS round_status varchar(12) NOT NULL DEFAULT 'playing';

COMMENT ON COLUMN public.rooms.round_status IS 'playing=进行中 / settling=有人归零待房主结算';

-- ---- 2. move_pot：收款后判断是否有人归零，置 settling ----
-- 同时这也是「公共池收完才算一局结束」的执行点。
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
  v_uid       varchar;
  v_nick      varchar;
  v_pot       integer;
  v_seeds     integer;
  v_new_pot   integer;
  v_new_seeds integer;
  v_zeroed    integer;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  IF p_amount = 0 THEN
    RAISE EXCEPTION '数量不能为 0';
  END IF;

  SELECT pot INTO v_pot FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;

  SELECT seeds, nickname INTO v_seeds, v_nick
  FROM public.room_members
  WHERE room_id = p_room_id AND user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '你不在这个房间';
  END IF;

  v_new_pot   := v_pot + p_amount;
  v_new_seeds := v_seeds - p_amount;

  IF v_new_pot < 0 THEN
    RAISE EXCEPTION '公共池没有这么多瓜子';
  END IF;
  IF v_new_seeds < 0 THEN
    RAISE EXCEPTION '我的瓜子不足';
  END IF;

  UPDATE public.rooms        SET pot = v_new_pot   WHERE id = p_room_id;
  UPDATE public.room_members SET seeds = v_new_seeds
  WHERE room_id = p_room_id AND user_id = v_uid;

  IF p_amount < 0 THEN
    -- 收款 = 本轮结束。流水归零，重新计数。
    DELETE FROM public.pot_log WHERE room_id = p_room_id;
    UPDATE public.room_members SET bet = 0 WHERE room_id = p_room_id;

    -- 只在「公共池已收干净」时才判断归零、进入待结算。
    -- 池子还有钱说明牌局没结束，继续打。
    IF v_new_pot = 0 THEN
      SELECT count(*) INTO v_zeroed
      FROM public.room_members
      WHERE room_id = p_room_id AND seeds <= 0;

      IF v_zeroed > 0 THEN
        UPDATE public.rooms SET round_status = 'settling' WHERE id = p_room_id;
      END IF;
    END IF;
  ELSE
    -- 出款：记一笔流水
    INSERT INTO public.pot_log (room_id, uid, nickname, delta, kind)
    VALUES (p_room_id, v_uid, v_nick, p_amount, 'pay');
  END IF;

  RETURN json_build_object(
    'pot', v_new_pot,
    'mySeeds', v_new_seeds,
    'delta', p_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_pot(varchar, integer) TO anon, authenticated;


-- ---- 3. offline_settle：只结算一次，结完回 playing ----
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
  v_paid        integer;
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

  -- 幂等：同一局只能结算一次。
  -- 原来是"调一次转一次"，房主手快点两下就转两笔，
  -- 表现就是一局金瓜子 *2。
  IF v_room.round_status <> 'settling' THEN
    RETURN json_build_object(
      'ok', true,
      'skipped', true,
      'reason', '本局不在待结算状态，跳过转账',
      'roundNo', v_room.round_no
    );
  END IF;

  -- 1. 金瓜子转账
  FOR v_t IN SELECT * FROM jsonb_array_elements(p_transfers) LOOP
    v_from   := v_t->>'fromUid';
    v_to     := v_t->>'toUid';
    v_amount := COALESCE((v_t->>'amount')::integer, 1);

    IF v_from IS NULL OR v_to IS NULL OR v_from = v_to THEN
      CONTINUE;
    END IF;

    INSERT INTO public.users (id, nickname, avatar)
    VALUES (v_from, '玩家', 1) ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.users (id, nickname, avatar)
    VALUES (v_to, '玩家', 1) ON CONFLICT (id) DO NOTHING;

    UPDATE public.users SET golden_seeds = golden_seeds - v_amount WHERE id = v_from;
    INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
    SELECT v_from, v_to, u.nickname, u.avatar, -v_amount
    FROM public.users u WHERE u.id = v_to
    ON CONFLICT (user_id, peer_uid)
    DO UPDATE SET count = public.seed_ledger.count + (-v_amount);

    UPDATE public.users SET golden_seeds = golden_seeds + v_amount WHERE id = v_to;
    INSERT INTO public.seed_ledger (user_id, peer_uid, peer_name, peer_avatar, count)
    SELECT v_to, v_from, u.nickname, u.avatar, v_amount
    FROM public.users u WHERE u.id = v_from
    ON CONFLICT (user_id, peer_uid)
    DO UPDATE SET count = public.seed_ledger.count + v_amount;
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

  -- 3. 全员重置瓜子、局数+1、公共池清零、状态回 playing
  UPDATE public.room_members
  SET seeds = v_initial, bet = 0, total_bet = 0,
      folded = false, all_in = false, is_turn = false, blind = NULL
  WHERE room_id = p_room_id;

  UPDATE public.rooms
  SET pot = 0,
      round_no = round_no + 1,
      round_status = 'playing'
  WHERE id = p_room_id;

  DELETE FROM public.pot_log WHERE room_id = p_room_id;

  RETURN json_build_object(
    'ok', true,
    'skipped', false,
    'roundNo', v_room.round_no + 1,
    'historyId', v_history_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.offline_settle(varchar, jsonb, boolean) TO anon, authenticated;


-- ---- 4. room_snapshot 返回 roundStatus + 归零者 ----
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
    'roundStatus', COALESCE(v_room.round_status, 'playing'),
    'seats', COALESCE(v_seats, '[]'::jsonb),
    'log', v_log
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_snapshot(varchar, boolean) TO anon, authenticated;
