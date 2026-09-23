-- ============================================================
-- 分批修复 SQL — 在数据编辑器逐条执行
--
-- 修三件事：
--   1. history 表权限（permission denied for table history）
--   2. rooms 读权限（房主建房后看不到自己的房间）
--   3. 清理上一轮自检造的测试房间
-- ============================================================

-- 1. history 权限：允许创建者自己写
GRANT SELECT, INSERT, DELETE ON public.history TO anon, authenticated;

DROP POLICY IF EXISTS history_select_own ON public.history;

CREATE POLICY history_select_own ON public.history
  FOR SELECT TO anon, authenticated
  USING (created_by = (select auth.uid()));

CREATE POLICY history_insert_own ON public.history
  FOR INSERT TO anon, authenticated
  WITH CHECK (created_by = (select auth.uid()));

CREATE POLICY history_delete_own ON public.history
  FOR DELETE TO anon, authenticated
  USING (created_by = (select auth.uid()));

-- 2. rooms 读权限：房主也能读（建房瞬间还没有 member 记录）
DROP POLICY IF EXISTS rooms_select_member ON public.rooms;

CREATE POLICY rooms_select_member ON public.rooms
  FOR SELECT TO anon, authenticated
  USING (
    host_uid = (select auth.uid())
    OR public.is_room_member(id, (select auth.uid()))
  );

-- 3. 清理自检造的测试房间（可跳过）
DELETE FROM public.rooms WHERE id = '999001';
DELETE FROM public.rooms WHERE id = '000000';
