-- ============================================================
-- 修正历史脏数据 + 补充一条「和解」入口的兜底
--
-- 背景：clear_account_ledger_row 以前是单向冲销 ——
--       发起方放弃一笔往来、明细双方都删，但对方的
--       golden_seeds 原样留下。表现为：
--         · 我方显示 -2，明细一条都没有
--         · 对方显示 +2，明细同样为空
--       windows 上线前的这个坑已经由 fix-ledger-accounting.sql 修好，
--       但**已经产生的 -2 / +2 不会自己消失**。
--
-- 本脚本做两件事：
--   1. 找出并列出所有「有金瓜子但明细为空」或「明细与总数矛盾」的账号
--   2. 给出一条按明细重新对账的 UPDATE，把数字拉回与明细一致
--
-- ⚠️ 第 2 步会改数据，请先跑第 1 步的 SELECT 看清楚再决定是否执行。
-- ============================================================

-- ---- 1. 体检：谁的数字和明细对不上（只读，随便跑）----
SELECT
  a.account,
  a.golden_seeds,
  COALESCE(SUM(l.count), 0) AS ledger_sum,
  COUNT(l.owner)            AS ledger_rows
FROM public.accounts a
LEFT JOIN public.account_ledger l ON l.owner = a.account
GROUP BY a.account, a.golden_seeds
HAVING a.golden_seeds <> COALESCE(SUM(l.count), 0)
ORDER BY a.golden_seeds;

-- 说明：
--   golden_seeds 与 ledger_sum 不等的行，就是被单向冲销污染过的账号。
--   （注意：清零过的行会被 DELETE，所以「已和解」的历史痕迹会丢失，
--     对账只能从现在这一刻开始，回不到和解前。这是已知代价。）


-- ---- 2. 修正：把 golden_seeds 拉回与当前明细一致 ----
-- 只在确认上面 SELECT 的结果符合预期后再执行这一段。
--
-- UPDATE public.accounts a
-- SET golden_seeds = COALESCE((
--       SELECT SUM(l.count) FROM public.account_ledger l WHERE l.owner = a.account
--     ), 0);


-- ---- 3. 兜底：想彻底清零、两人从零开始 ----
-- 「我的」页面点「清空全部数据」只清本地显示。
-- 要连服务端一起清，用下面两条（慎用，金瓜子归零且不可恢复）：
--
-- DELETE FROM public.account_ledger;
-- UPDATE public.accounts SET golden_seeds = 0, total_games = 0;
