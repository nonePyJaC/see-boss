-- ============================================================
-- 清理测试数据
--
-- 删除内容：
--   1. 所有房间及其关联数据（room_members / hands / decks /
--      pot_log / boards 等靠 ON DELETE CASCADE 一起清）
--   2. 孤儿用户行：users 表里没有被任何房间引用的匿名身份
--   3. 测试账号：accounts 表里你点名不要的
--
-- 保留内容：
--   * accounts 表**默认全部保留**（真实账号，含金瓜子）
--   * history 表**默认全部保留**（线下对局历史）
--   * seed_ledger 表**默认全部保留**（金瓜子账本）
--
-- 用法：在「SQL 型数据库」查询编辑器整份粘贴执行。
--      执行前先看第 3 段，按需修改/注释。
-- ============================================================

-- ── 1. 删除所有房间（级联清掉房间相关的一切） ──
-- 如果想保留某些房间，把条件改成 WHERE id IN ('123456', ...)
DELETE FROM public.rooms;

-- ── 2. 清理孤儿匿名用户 ──
-- users 行在匿名登录时自动创建，房间删完后大量残留。
-- 只删「不在任何房间成员列表里」的。
DELETE FROM public.users
WHERE id NOT IN (SELECT user_id FROM public.room_members);

-- ── 3. 测试账号（按需修改） ──
-- 默认注释掉：真实账号不删。要删测试号就取消注释并改账号名。
-- DELETE FROM public.accounts WHERE account IN ('test', '测试', 'aaa');

-- ── 4. 孤儿金瓜子账本 ──
-- 上一步删掉的 users 会在 seed_ledger 留下孤立行
DELETE FROM public.seed_ledger
WHERE user_id NOT IN (SELECT id FROM public.users)
   OR peer_uid NOT IN (SELECT id FROM public.users);

-- ── 5. 孤儿流水（房间已删，pot_log 应由级联清掉，这里是兜底） ──
DELETE FROM public.pot_log
WHERE room_id NOT IN (SELECT id FROM public.rooms);

-- ── 6. 报告：清理后各表还剩多少行 ──
SELECT 'rooms'        AS tbl, count(*) FROM public.rooms
UNION ALL SELECT 'room_members',  count(*) FROM public.room_members
UNION ALL SELECT 'pot_log',       count(*) FROM public.pot_log
UNION ALL SELECT 'users',         count(*) FROM public.users
UNION ALL SELECT 'accounts',      count(*) FROM public.accounts
UNION ALL SELECT 'seed_ledger',   count(*) FROM public.seed_ledger
UNION ALL SELECT 'history',       count(*) FROM public.history
ORDER BY tbl;
