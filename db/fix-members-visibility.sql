-- ============================================================
-- 1. 房间成员互见金瓜子
--
-- 问题：users 表的 SELECT 策略只允许读自己，
--       所以房间卡片上除自己以外的人金瓜子都显示 0。
--
-- 解法：加一条策略 —— 只要和对方在同一个房间里，就能读
--       对方的用户行（金瓜子/昵称/头像/总场次）。
--       只开 SELECT，不开 UPDATE，别人改不了你的资料。
-- ============================================================

DROP POLICY IF EXISTS users_select_own ON public.users;

CREATE POLICY users_select_own ON public.users
  FOR SELECT TO anon, authenticated
  USING (
    id = (select auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.room_members mine
      JOIN public.room_members theirs
        ON theirs.room_id = mine.room_id
       AND theirs.user_id = public.users.id
      WHERE mine.user_id = (select auth.uid())
    )
  );

-- ============================================================
-- 2. 小麦 / 大麦 落库 + 房主拖拽排序
--
-- room_members 新增 seat 排序与麦位字段。
-- blind 枚举：null（默认）| 'sb'（小麦）| 'bb'（大麦）
-- ============================================================

ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS blind varchar(2);

-- 座位排序号由房主拖拽决定，前端 update 该列
COMMENT ON COLUMN public.room_members.seat_no IS '座位序号，房主可拖拽调整';
COMMENT ON COLUMN public.room_members.blind  IS '麦位：null | sb（小麦）| bb（大麦）';
