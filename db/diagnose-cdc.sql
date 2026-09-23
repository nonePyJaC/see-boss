-- ============================================================
-- CDC 可用性诊断 — 在数据编辑器逐条执行
-- ============================================================

-- 1. 环境里有哪些 realtime / cloudbase 相关角色？
--    若结果为空 → CDC connector 角色未预置，CDC 大概率不可用，改用轮询
select rolname, rolsuper, rolbypassrls
from pg_roles
where rolname ilike '%realtime%'
   or rolname ilike '%supabase%'
   or rolname ilike '%cloudbase%'
order by rolname;

-- 2. publication 是否建成功（第 17 段的 DO 块应该已建）
select pubname from pg_publication where pubname = 'cloudbase_realtime';

-- 3. publication 里有哪些表
select schemaname, tablename
from pg_publication_tables
where pubname = 'cloudbase_realtime';

-- 4. 能否改 publication 的 owner 到已存在的角色？
--    先看 rooms 表现在归谁
select c.relname, pg_get_userbyid(c.relowner) as owner
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('rooms','room_members');

-- 5. wal_level 是否支持逻辑复制
--    返回 logical 才支持 CDC；返回 replica 则不支持
show wal_level;
