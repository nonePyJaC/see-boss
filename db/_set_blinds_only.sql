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
