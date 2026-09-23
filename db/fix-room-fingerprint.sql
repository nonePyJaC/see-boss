-- ============================================================
-- get_room_fingerprint — 一个查询拿到房间所有权威状态
--
-- 修复 bug 1（房东看不到人加入）：
--   最初的探针 getRoomRevision 只读 rooms.updated_at。
--   但 joinRoom 只往 room_members 插行，不碰 rooms 表，
--   updated_at 纹丝不动 → 退避轮询判定「没动静」→
--   不拉全量快照 → 房东屏幕上就是看不到新人。
--   探针的覆盖面必须 >= 权威状态。
--
-- 指纹一次查六样，覆盖全部权威状态：
--   rooms.updated_at     pot / 大小麦 / round_status / 局数
--   room_members 行数     加入、退出、解散
--   sum(seeds) / sum(bet) 出款、收款、结算重置
--
-- ⚠️ 两个必须注意的点：
--
-- 1. 必须 RETURNS json，不能 RETURNS text（实测踩过）：
--    PostgREST 对返回 text 的 RPC 按纯文本响应，不加 JSON 引号，
--    SDK 的 db.rpc() 里 JSON.parse 直接抛
--      "Unexpected non-whitespace character after JSON at position 17"
--
-- 2. 必须先 DROP 再 CREATE：
--    上一版已经以 RETURNS text 存在于库里，
--    CREATE OR REPLACE 不允许改返回类型，会报
--      ERROR: cannot change return type of existing function (42P13)
-- ============================================================

DROP FUNCTION IF EXISTS public.get_room_fingerprint(varchar);

CREATE OR REPLACE FUNCTION public.get_room_fingerprint(p_room_id varchar)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     varchar;
  v_room    public.rooms%ROWTYPE;
  v_members integer;
  v_seeds   bigint;
  v_bets    bigint;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '房间不存在';
  END IF;

  -- 不做成员校验：房东面前的探测只需要房间级指纹，
  -- 加校验会让「还没加入的人」无法探活。
  SELECT count(*), COALESCE(sum(seeds), 0), COALESCE(sum(bet), 0)
  INTO v_members, v_seeds, v_bets
  FROM public.room_members WHERE room_id = p_room_id;

  RETURN to_json(concat_ws('|',
    -- 房间级：出款/收款/指麦/自动麦/结算都会 UPDATE rooms
    to_char(COALESCE(v_room.updated_at, 'epoch'::timestamptz), 'YYYYMMDDHH24MISSMS'),
    -- 座位级：加入/退出会改行数
    v_members::text,
    -- 注码级：sum 比逐行便宜，且能兜住子表无触发器的场景
    v_seeds::text,
    v_bets::text,
    -- 局状态：结算触发 settling、结算完回 playing
    COALESCE(v_room.round_status, 'playing'),
    to_char(v_room.pot, 'FM999999999999999')
  ));
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_room_fingerprint(varchar) TO anon, authenticated;
