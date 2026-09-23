-- ============================================================
-- rooms 表的 DELETE 授权
--
-- 问题：房主点「退出」解散房间报
--       permission denied for table rooms
--
-- 根因：表级 GRANT 缺失。schema.sql 第 202 行只授了
--       GRANT SELECT, INSERT ON public.rooms
--       —— 没有 DELETE。RLS 策略只负责行过滤，
--       表级权限没给，一样是 permission denied。
--
-- 本文件补 DELETE。行级安全仍由 rooms_delete_host 策略保证
-- （只能删 host_uid = 自己的房间）。
-- ============================================================

GRANT DELETE ON public.rooms TO anon, authenticated;

-- room_members 的 CRUD 补齐（幂等）。房主解散靠 rooms 的级联删除，
-- 成员自己退房靠 members_delete_self 策略 + 这里的 DELETE 授权。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.room_members TO anon, authenticated;

-- 注意：pot_log 故意不授权。
-- 它只能由 move_pot / rotate_blinds 等 SECURITY DEFINER 函数写入，
-- 客户端直连 PostgREST 碰不到，防止伪造流水。
-- 读取统一走 room_snapshot 函数，所以也不需要 SELECT 授权。

-- 核对当前授权
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE grantee IN ('anon', 'authenticated')
  AND table_schema = 'public'
  AND table_name IN ('rooms', 'room_members', 'pot_log', 'users', 'accounts')
GROUP BY table_name
ORDER BY table_name;
