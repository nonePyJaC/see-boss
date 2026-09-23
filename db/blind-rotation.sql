-- ============================================================
-- 小麦 / 大麦 轮转 + 房主指定
--
-- 规则（用户定义）：
--   1. 房主拖拽调整座位顺序（room_members.seat_no）
--   2. 房主手动指定初始大小麦
--   3. 每次「收款」（收回公共池）后轮转一格：
--        旧小麦 → 无
--        旧大麦 → 小麦
--        沿座位顺序，原小麦的下一位 → 新大麦（到末尾则回到首位）
--   4. 若收款前无人设麦 → 从最靠前的一位设小麦，下一位设大麦
--
-- 函数都返回轮转后的完整座位表，前端据此刷新。
-- ============================================================

-- ---- 1. 收款后轮转 ----
CREATE OR REPLACE FUNCTION public.rotate_blinds(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    varchar;
  v_host   varchar;
  v_old_sb varchar;   -- 原小麦座位号
  v_old_bb varchar;   -- 原大麦座位号
  v_new_sb varchar;   -- 新小麦
  v_new_bb varchar;   -- 新大麦
  v_first  varchar;   -- 最小座位号
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  -- 锁房间行，保证并发的轮转不会交叉写入
  SELECT host_uid INTO v_host FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_host IS NULL THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  IF v_host <> v_uid THEN
    RAISE EXCEPTION '只有房主可以调整麦位';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = p_room_id) THEN
    RAISE EXCEPTION '房间里还没有玩家';
  END IF;

  -- 第一步：记下旧麦位（座位号存成文本，避免 smallint 运算的空值麻烦）
  SELECT max(seat_no)::text INTO v_old_sb
  FROM public.room_members WHERE room_id = p_room_id AND blind = 'sb';
  SELECT max(seat_no)::text INTO v_old_bb
  FROM public.room_members WHERE room_id = p_room_id AND blind = 'bb';

  SELECT min(seat_no)::text INTO v_first
  FROM public.room_members WHERE room_id = p_room_id;

  -- 第二步：全部清空
  UPDATE public.room_members SET blind = NULL WHERE room_id = p_room_id;

  -- 第三步：推算
  --   有人设过大麦（正常轮转中）：新小麦 = 原大麦
  --   只设过小麦             ：新小麦 = 原小麦
  --   从没设过               ：新小麦 = 最小座位
  v_new_sb := COALESCE(v_old_bb, v_old_sb, v_first);

  -- 新大麦 = 新小麦的下一个座位；没有更大的就回卷到最小座位
  SELECT COALESCE(
    (SELECT min(seat_no)::text FROM public.room_members
      WHERE room_id = p_room_id AND seat_no > v_new_sb::smallint),
    v_first
  ) INTO v_new_bb;

  -- 第四步：写入
  UPDATE public.room_members SET blind = 'sb'
  WHERE room_id = p_room_id AND seat_no = v_new_sb::smallint;
  UPDATE public.room_members SET blind = 'bb'
  WHERE room_id = p_room_id AND seat_no = v_new_bb::smallint;

  RETURN json_build_object(
    'ok', true,
    'seats', (
      SELECT jsonb_agg(jsonb_build_object(
        'uid', m.user_id, 'seatNo', m.seat_no, 'blind', m.blind
      ) ORDER BY m.seat_no)
      FROM public.room_members m WHERE m.room_id = p_room_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_blinds(varchar) TO anon, authenticated;


-- ---- 2. 房主手动指定小麦 / 大麦 ----
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
  v_uid  varchar;
  v_host varchar;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT host_uid INTO v_host FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_host IS NULL THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  IF v_host <> v_uid THEN
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

  -- 重置后写入（用用户精确匹配，不会误伤他人）
  UPDATE public.room_members SET blind = NULL WHERE room_id = p_room_id;

  IF p_sb_uid IS NOT NULL THEN
    UPDATE public.room_members SET blind = 'sb'
    WHERE room_id = p_room_id AND user_id = p_sb_uid;
  END IF;

  IF p_bb_uid IS NOT NULL THEN
    UPDATE public.room_members SET blind = 'bb'
    WHERE room_id = p_room_id AND user_id = p_bb_uid;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'seats', (
      SELECT jsonb_agg(jsonb_build_object(
        'uid', m.user_id, 'seatNo', m.seat_no, 'blind', m.blind
      ) ORDER BY m.seat_no)
      FROM public.room_members m WHERE m.room_id = p_room_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_blinds(varchar, varchar, varchar) TO anon, authenticated;


-- ---- 3. 房主拖拽调整座位顺序 ----
CREATE OR REPLACE FUNCTION public.reorder_seats(
  p_room_id varchar,
  p_uids    varchar[]   -- 按新顺序排列的用户 id
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    varchar;
  v_host   varchar;
  i        integer;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT host_uid INTO v_host FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_host IS NULL THEN
    RAISE EXCEPTION '房间不存在';
  END IF;
  IF v_host <> v_uid THEN
    RAISE EXCEPTION '只有房主可以调整座位';
  END IF;

  -- 传入的 uid 必须正好是房间里的全部成员，不多不少
  IF (SELECT count(*) FROM public.room_members WHERE room_id = p_room_id)
     <> COALESCE(array_length(p_uids, 1), 0) THEN
    RAISE EXCEPTION '座位数量不匹配';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_uids) u
    WHERE NOT EXISTS (
      SELECT 1 FROM public.room_members
      WHERE room_id = p_room_id AND user_id = u
    )
  ) THEN
    RAISE EXCEPTION '传入了非本房间的成员';
  END IF;

  -- 先全部挪到 100+ 避开唯一约束冲突，再按新顺序写 1..n
  UPDATE public.room_members SET seat_no = seat_no + 100 WHERE room_id = p_room_id;

  FOR i IN 1..COALESCE(array_length(p_uids, 1), 0) LOOP
    UPDATE public.room_members
    SET seat_no = i
    WHERE room_id = p_room_id AND user_id = p_uids[i];
  END LOOP;

  RETURN json_build_object(
    'ok', true,
    'seats', (
      SELECT jsonb_agg(jsonb_build_object(
        'uid', m.user_id, 'seatNo', m.seat_no, 'blind', m.blind
      ) ORDER BY m.seat_no)
      FROM public.room_members m WHERE m.room_id = p_room_id
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reorder_seats(varchar, varchar[]) TO anon, authenticated;
