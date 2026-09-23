-- ============================================================
-- 补丁：修「收完公共池但没进入 settling」
--
-- 问题：把瓜子全出完的人自己收款，round_status 不变成 settling。
--
-- 原因：我在 move_pot 里先 UPDATE room_members SET seeds = v_new_seeds，
--       之后才检查 seeds <= 0。而收款会让收款人 seeds 增加，
--       如果归零者正是收款人本人，UPDATE 后他已不再归零 → 漏判。
--
-- 真实场景（A 输光、B 收池）其实能正确触发，
--       但「输光者自己收池」这个常见操作会漏。
--
-- 修法：检查挪到 UPDATE 之前，用收款前的快照判断。
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
    -- 收款 = 本轮结束：流水归零，重新计数
    DELETE FROM public.pot_log WHERE room_id = p_room_id;
    UPDATE public.room_members SET bet = 0 WHERE room_id = p_room_id;

    -- 公共池收干净了，才判断本局是否该结束。
    -- v_zeroed 用「收款前是否已有人归零」+「收款后是否还有人归零」综合判断：
    --   收款前归零者（通常是输光的人）在 UPDATE 里不受影响，仍在库里为 0；
    --   唯一漏判的场景是「归零者恰好是收款人本人」——
    --   此时他 UPDATE 后 seeds 变正，需要单独看他收款前是不是 0。
    IF v_new_pot = 0 THEN
      SELECT count(*) INTO v_zeroed
      FROM public.room_members
      WHERE room_id = p_room_id AND seeds <= 0;

      -- 兜底：收款人自己就是归零者（v_seeds = 0）也要算
      IF v_zeroed = 0 AND v_seeds <= 0 THEN
        v_zeroed := 1;
      END IF;

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
