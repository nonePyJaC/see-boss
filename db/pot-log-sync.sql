-- ============================================================
-- 公共池流水落库 + 修自动盲注重复扣注
--
-- 修三个实测问题：
--   1) 下注记录只存在于发起端本地 → 建 pot_log 表，move_pot 同事务写入
--   2) 自动盲注不显示谁下了 → rotate/set_blinds 也写流水
--   3) 自动盲注只生效一次 → rotate_blinds 先归还上一轮 bet 再下新注
--
-- 安全：pot_log 不开 anon 的 INSERT/UPDATE/DELETE，
--       只能由 SECURITY DEFINER 函数写，防止客户端伪造流水。
-- ============================================================

-- ---- 1. 流水表 ----
CREATE TABLE IF NOT EXISTS public.pot_log (
  room_id varchar(6)  NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  seq     bigserial,
  uid     varchar(64) NOT NULL,
  nickname varchar(32) NOT NULL,
  delta   integer     NOT NULL,          -- >0 出款，<0 收款
  kind    varchar(4)  NOT NULL DEFAULT 'pay',  -- pay 出 / get 收 / sb 小麦 / bb 大麦
  at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_pot_log_room ON public.pot_log(room_id, seq DESC);

ALTER TABLE public.pot_log ENABLE ROW LEVEL SECURITY;

-- 同房间成员可读；不授予写权限（写只能走函数）
DROP POLICY IF EXISTS pot_log_select_room ON public.pot_log;
CREATE POLICY pot_log_select_room ON public.pot_log
  FOR SELECT TO anon, authenticated
  USING (public.is_room_member(room_id, (select auth.uid())));


-- ---- 2. move_pot 同事务写流水 + 收款时清空并重置下注 ----
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
  v_nick     varchar;
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

  -- 收款：先清空流水，让下一轮从零开始记
  IF p_amount < 0 THEN
    DELETE FROM public.pot_log WHERE room_id = p_room_id;
    -- 池子已分掉，所有人本轮下注额归零
    UPDATE public.room_members SET bet = 0 WHERE room_id = p_room_id;
  END IF;

  -- 写流水（同一事务，所有客户端都能看到）
  INSERT INTO public.pot_log (room_id, uid, nickname, delta, kind)
  VALUES (p_room_id, v_uid, v_nick, p_amount,
          CASE WHEN p_amount > 0 THEN 'pay' ELSE 'get' END);

  RETURN json_build_object(
    'pot', v_new_pot,
    'mySeeds', v_new_seeds,
    'delta', p_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.move_pot(varchar, integer) TO anon, authenticated;


-- ---- 3. rotate_blinds：先归还上一轮，再轮转下注 ----
CREATE OR REPLACE FUNCTION public.rotate_blinds(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    varchar;
  v_host   varchar;
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
  -- 任何房间成员都能触发轮转：收款往往不是房主点的。
  -- 敏感操作（设麦位、改房间规则）仍只放行房主，见 set_blinds / reset_blinds。
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

  -- 轮转麦位
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

  -- 小麦自动下注 + 流水
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

  -- 大麦自动下注 + 流水
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


-- ---- 4. set_blinds：同样先归还再下注，并写流水 ----
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

  -- 归还旧自动注
  SELECT COALESCE(sum(bet), 0) INTO v_refund
  FROM public.room_members
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.room_members
  SET seeds = seeds + bet, bet = 0
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.rooms SET pot = GREATEST(pot - v_refund, 0) WHERE id = p_room_id;

  UPDATE public.room_members SET blind = NULL WHERE room_id = p_room_id;

  IF p_sb_uid IS NOT NULL THEN
    UPDATE public.room_members SET blind = 'sb'
    WHERE room_id = p_room_id AND user_id = p_sb_uid;
  END IF;
  IF p_bb_uid IS NOT NULL THEN
    UPDATE public.room_members SET blind = 'bb'
    WHERE room_id = p_room_id AND user_id = p_bb_uid;
  END IF;

  -- 只指定麦位，不自动下注。
  -- 下注由 rotate_blinds 触发：房主上锁或每次收款后轮转时才扣。
  -- 上面已归还旧的自动注，这里保持 bet 为 0。

  RETURN json_build_object(
    'ok', true,
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_blinds(varchar, varchar, varchar) TO anon, authenticated;


-- ---- 5. reset_blinds：关锁退还 ----
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

  SELECT COALESCE(sum(bet), 0) INTO v_refund
  FROM public.room_members
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.room_members
  SET seeds = seeds + bet, bet = 0
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb') AND bet > 0;

  UPDATE public.rooms SET pot = GREATEST(pot - v_refund, 0) WHERE id = p_room_id;

  UPDATE public.room_members SET blind = NULL
  WHERE room_id = p_room_id AND blind IN ('sb', 'bb');

  RETURN json_build_object(
    'ok', true,
    'pot', (SELECT pot FROM public.rooms WHERE id = p_room_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_blinds(varchar) TO anon, authenticated;


-- ---- 6. room_snapshot 返回最近 5 条流水 ----
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

  -- 最近 5 条流水（新的在前）
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
    'seats', COALESCE(v_seats, '[]'::jsonb),
    'log', v_log
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.room_snapshot(varchar, boolean) TO anon, authenticated;
