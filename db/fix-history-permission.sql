-- ============================================================
-- 修复 history 表权限（permission denied for table history）
--
-- 原因：schema 里 history 只授了 SELECT，写入本该走云函数。
--       但历史是用户自己的数据，RLS 已限 created_by = auth.uid()，
--       给前端 INSERT/DELETE 是安全的，也更简单。
--
-- 用法：数据编辑器逐条执行
-- ============================================================

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
