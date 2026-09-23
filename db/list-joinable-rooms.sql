-- ============================================================
-- 可加入的存活房间列表（v2）
--
-- v1 的 bug：把 jsonb_build_object(...) AS t 当成表格别名，
--            然后 ORDER BY t.updated_at，报
--            missing FROM-clause entry for table "t"。
--
-- v2 直接把排序去掉，改用 jsonb_agg 后在前端排序，
--            或者用 ORDER BY 在子查询的顶层列上。
--            这里用后者更干净：子查询的 ste 是一行一行算好再聚。
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_joinable_rooms(p_limit integer DEFAULT 20)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid  varchar;
  v_rows jsonb;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT COALESCE(jsonb_agg(s.obj ORDER BY s.updated_at DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      r.updated_at,
      jsonb_build_object(
        'roomNo',       r.id,
        'mode',         r.mode,
        'status',       r.status,
        'hostName',     h.nickname,
        'hostAvatar',   h.avatar,
        'playerCount', (SELECT count(*) FROM public.room_members m WHERE m.room_id = r.id),
        'maxSeats',     r.max_seats,
        'smallBlind',   r.small_blind,
        'bigBlind',     r.big_blind,
        'initialSeeds', r.initial_seeds,
        'roundNo',      r.round_no,
        'isMine',       r.host_uid = v_uid,
        'iAmIn',        EXISTS (SELECT 1 FROM public.room_members m
                                WHERE m.room_id = r.id AND m.user_id = v_uid),
        'updatedAt',    r.updated_at
      ) AS obj
    FROM public.rooms r
    LEFT JOIN public.room_members h
           ON h.room_id = r.id AND h.user_id = r.host_uid
    WHERE r.mode = 'offline'
      AND r.updated_at > now() - interval '30 minutes'
      AND (SELECT count(*) FROM public.room_members m WHERE m.room_id = r.id) < r.max_seats
    LIMIT GREATEST(p_limit, 1)
  ) s;

  RETURN json_build_object('ok', true, 'rooms', v_rows);
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_joinable_rooms(integer) TO anon, authenticated;
