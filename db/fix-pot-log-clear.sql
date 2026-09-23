-- ============================================================
-- 补丁：收款后流水彻底归零
--
-- 问题（用户实测）：有人归零触发结算时，公共池流水里
-- 还留着上轮的「收 -8300」， UI 看起来莫名其妙。
--
-- 原因：pot-log-sync.sql 的 move_pot 在收款分支里
--       DELETE FROM pot_log
--       ...
--       INSERT ... 'get'
-- 顺序是「先清空、再插入收这条」，于是收款后必然残留一条
-- 上一轮的收款记录，轮转下注后又叠上新的大麦/小麦。
--
-- 修法：收款时只清空，不写「收」这条流水。
--       流水只记录「本轮的投入」，收款意味着本轮结束、重新计数。
-- ============================================================

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

  -- 收款 = 本轮结束：流水全部清掉，重新开始计。
  -- 不写「收」这条——它描述的是上一轮的事，留在列表里只会让人困惑。
  IF p_amount < 0 THEN
    DELETE FROM public.pot_log WHERE room_id = p_room_id;
    UPDATE public.room_members SET bet = 0 WHERE room_id = p_room_id;
  ELSE
    -- 出款：正常记一笔
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
