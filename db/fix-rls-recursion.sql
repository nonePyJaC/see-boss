-- ============================================================
-- 修复 RLS 无限递归（SQLSTATE 42P17? infinite recursion detected）
--
-- 原因：rooms 的策略子查询 room_members，
--       而 room_members 的策略又子查询 room_members 自己 → 死循环。
-- 解法：用 SECURITY DEFINER 函数判断成员身份，
--       绕过 RLS 递归（这是 PostgREST/Supabase 官方推荐写法）。
--
-- 用法：在数据编辑器逐条执行（ExecutePGSql 每次只能一条）
-- ============================================================

-- 1. 建判断函数（SECURITY DEFINER 绕过 RLS）
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id varchar, p_uid varchar)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = p_uid
  );
$$;

-- 2. 删掉旧的（会递归的）策略
DROP POLICY IF EXISTS rooms_select_member ON public.rooms;
DROP POLICY IF EXISTS members_select_room ON public.room_members;

-- 3. 用函数重建
CREATE POLICY rooms_select_member ON public.rooms
  FOR SELECT TO anon, authenticated
  USING (public.is_room_member(id, (select auth.uid())));

CREATE POLICY members_select_room ON public.room_members
  FOR SELECT TO anon, authenticated
  USING (public.is_room_member(room_id, (select auth.uid())));

-- 4. 授权（anon 要能调这个函数）
GRANT EXECUTE ON FUNCTION public.is_room_member(varchar, varchar) TO anon, authenticated;
