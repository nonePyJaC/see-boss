-- ============================================================
-- 房间删除权限
--
-- 问题：房主点「退出」解散房间时报 permission denied for table rooms。
-- 原因：rooms 表只授予了 SELECT / INSERT / UPDATE，
--       没有 DELETE 策略，anon 角色删不动。
--
-- 本文件补两条 DELETE 策略 + 级联删除策略：
--   rooms        房主可删自己的房间（onDeleteCascade 会带走
--               room_members / pot_log / hands / decks）
--   room_members 成员可删自己的座位（「退出房间」用）
--
-- 安全边界：
--   rooms        仅 host_uid = 当前 uid
--   room_members 仅 user_id = 当前 uid
--   → 别人不能替你退房，也不能解散别人的房间
-- ============================================================

-- 1. rooms：房主可删
DROP POLICY IF EXISTS rooms_delete_host ON public.rooms;
CREATE POLICY rooms_delete_host ON public.rooms
  FOR DELETE TO anon, authenticated
  USING (host_uid = (select auth.uid()));

-- 2. room_members：成员可删自己的座位
DROP POLICY IF EXISTS members_delete_self ON public.room_members;
CREATE POLICY members_delete_self ON public.room_members
  FOR DELETE TO anon, authenticated
  USING (user_id = (select auth.uid()));

-- 3. 核对：现在 rooms / room_members 上应有全部 CRUD 策略
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('rooms', 'room_members')
ORDER BY tablename, cmd, policyname;
