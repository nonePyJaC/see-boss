-- ============================================================
-- 彻底清理：账号上线前的数据归零
--
-- 用户已确认：以前没有攒金瓜子，不需要迁移。
-- 目标：让上线时的数据是干净的空库。
--
-- 删除：
--   1. accounts            所有账号（含测试号 仓鼠老张）
--   2. rooms               所有房间（级联清 room_members / pot_log / hands / decks）
--   3. users               所有匿名身份
--   4. seed_ledger         金瓜子账本（全 0 也无所谓，一并清）
--   5. history             对局历史
--
-- 保留：
--   * 表结构、函数、RLS 策略、索引 —— 一行不动
--
-- 用法：整份粘贴执行。最后会打印各表剩余行数供核对。
-- ============================================================

-- 1. 账号（测试号 + 你刚才注册的都在这里）
DELETE FROM public.accounts;

-- 2. 房间及其级联数据
DELETE FROM public.rooms;

-- 3. 匿名身份
DELETE FROM public.users;

-- 4. 金瓜子账本
DELETE FROM public.seed_ledger;

-- 5. 对局历史
DELETE FROM public.history;

-- ── 核对：各表应全部为 0 ──
SELECT 'accounts'      AS tbl, count(*) AS rows FROM public.accounts
UNION ALL SELECT 'rooms',        count(*) FROM public.rooms
UNION ALL SELECT 'room_members', count(*) FROM public.room_members
UNION ALL SELECT 'pot_log',      count(*) FROM public.pot_log
UNION ALL SELECT 'users',        count(*) FROM public.users
UNION ALL SELECT 'seed_ledger',  count(*) FROM public.seed_ledger
UNION ALL SELECT 'history',      count(*) FROM public.history
UNION ALL SELECT 'hands',        count(*) FROM public.hands
UNION ALL SELECT 'decks',        count(*) FROM public.decks
ORDER BY tbl;
