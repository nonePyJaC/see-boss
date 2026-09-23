-- ============================================================
-- 修复金瓜子账面两个缺陷
--
-- 线上现象（用户实测 + 单测复现）：
--   我的金瓜子显示 -2，但明细一条都没有；对方显示 +2 同样没有明细。
--
-- 缺陷 1：clear_account_ledger_row 是单向和解
--   它只把发起方（owner）的 golden_seeds 用 v_delta 冲销，
--   然后把双方账本行都 DELETE。对方那侧的 golden_seeds 原样保留，
--   明细却被删了 —— 于是对方「有数字、无明细」，且双方之和不再守恒。
--
-- 缺陷 2：account_seed_transfer 末尾的
--     DELETE FROM public.account_ledger WHERE count = 0;
--   是无条件的，清掉全表所有归零行，包括与本次转账无关的账号。
--
-- ◆ 关于「和解」到底是产品语义还是 bug —— 这里做一个决定并写下来：
--   朋友局里「长按某行清空重置」的意图是「这笔往来我们不算了」。
--   既然双方都同意不计，那么双方的金瓜子都应该被冲销，
--   否则被和解的那一笔会长久漂在两边的数字里。
--   所以本补丁把发起方与对手方一起冲销：保持守恒。
--
--   若你反而想保留「只有我能消化我的账」这种语义，
--   那就只保留本文件的缺陷 2 修复，把 clear_account_ledger_row
--   的回滚部分删掉即可 —— 但那样两账之和会漂移，是已知代价。
-- ============================================================

-- ---- 1. account_seed_transfer：只清本次两方的归零行 ----
CREATE OR REPLACE FUNCTION public.account_seed_transfer(
  p_from_uid varchar,
  p_to_uid   varchar,
  p_amount   integer DEFAULT 1
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_from_acct varchar;
  v_to_acct   varchar;
  v_from_nick varchar;
  v_to_nick   varchar;
  v_from_ava  smallint;
  v_to_ava    smallint;
BEGIN
  IF p_amount = 0 THEN
    RETURN json_build_object('ok', true, 'skipped', true);
  END IF;

  -- uid → 账号名。没绑账号（纯游客）不记账。
  SELECT account, nickname, avatar INTO v_from_acct, v_from_nick, v_from_ava
  FROM public.accounts WHERE uid = p_from_uid;

  SELECT account, nickname, avatar INTO v_to_acct, v_to_nick, v_to_ava
  FROM public.accounts WHERE uid = p_to_uid;

  IF v_from_acct IS NULL OR v_to_acct IS NULL OR v_from_acct = v_to_acct THEN
    RETURN json_build_object('ok', true, 'skipped', true, 'reason', '任一方未绑定账号');
  END IF;

  -- 付款方：金瓜子减少，账本记负
  UPDATE public.accounts
  SET golden_seeds = golden_seeds - p_amount
  WHERE account = v_from_acct;

  INSERT INTO public.account_ledger (owner, peer, peer_name, peer_avatar, count)
  VALUES (v_from_acct, v_to_acct,
          COALESCE(v_to_nick, v_to_acct), COALESCE(v_to_ava, 1), -p_amount)
  ON CONFLICT (owner, peer)
  DO UPDATE SET count = public.account_ledger.count + (-p_amount),
                peer_name = EXCLUDED.peer_name,
                peer_avatar = EXCLUDED.peer_avatar,
                updated_at = now();

  -- 收款方：金瓜子增加，账本记正
  UPDATE public.accounts
  SET golden_seeds = golden_seeds + p_amount
  WHERE account = v_to_acct;

  INSERT INTO public.account_ledger (owner, peer, peer_name, peer_avatar, count)
  VALUES (v_to_acct, v_from_acct,
          COALESCE(v_from_nick, v_from_acct), COALESCE(v_from_ava, 1), p_amount)
  ON CONFLICT (owner, peer)
  DO UPDATE SET count = public.account_ledger.count + p_amount,
                peer_name = EXCLUDED.peer_name,
                peer_avatar = EXCLUDED.peer_avatar,
                updated_at = now();

  -- 归零的行清掉，不留噪音。
  -- 只清本次两方的：以前是全表 WHERE count = 0，
  -- 会把其他账号之间刚好结清的记录一并删掉（侧边影响）。
  DELETE FROM public.account_ledger
  WHERE count = 0
    AND owner IN (v_from_acct, v_to_acct);

  RETURN json_build_object('ok', true, 'skipped', false);
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_seed_transfer(varchar, varchar, integer) TO anon, authenticated;


-- ---- 2. clear_account_ledger_row：和解时双方同时冲销 ----
CREATE OR REPLACE FUNCTION public.clear_account_ledger_row(p_peer varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     varchar;
  v_acct    varchar;
  v_delta   integer;   -- 我账上这一行：>0 我欠 peer？见下方说明
  v_peer_delta integer; -- peer 账上那一行，方向相反
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT account INTO v_acct FROM public.accounts WHERE uid = v_uid;
  IF v_acct IS NULL THEN
    RAISE EXCEPTION '尚未登录账号';
  END IF;

  IF p_peer IS NULL OR p_peer = '' OR p_peer = v_acct THEN
    RAISE EXCEPTION '对手账号不正确';
  END IF;

  -- 我账上：count > 0 表示 peer 欠我；count < 0 表示我欠 peer。
  SELECT count INTO v_delta
  FROM public.account_ledger
  WHERE owner = v_acct AND peer = p_peer;

  -- peer 账上：与 v_delta 等值反号。
  SELECT count INTO v_peer_delta
  FROM public.account_ledger
  WHERE owner = p_peer AND peer = v_acct;

  IF v_delta IS NULL THEN
    RETURN json_build_object('ok', true, 'cleared', 0);
  END IF;

  -- 我方冲销：放弃这笔往来对我方金瓜子的净影响。
  -- v_delta > 0（对方欠我 n）→ 我方账面少了这 n 粒债权。
  -- v_delta < 0（我欠对方 n）→ 我方账面回补这 n 粒。
  UPDATE public.accounts
  SET golden_seeds = golden_seeds - v_delta
  WHERE account = v_acct;

  -- ⚠️ 关键修复：对方那侧也要冲销，否则
  --    · 对方的金瓜子留着 +2，明细却被 DELETE → 「有数字没明细」
  --    · 双方金瓜子之和不再守恒，搁久了就是一笔说不清的账
  -- v_peer_delta 与 v_delta 等值反号，所以同样用减号。
  IF v_peer_delta IS NOT NULL THEN
    UPDATE public.accounts
    SET golden_seeds = golden_seeds - v_peer_delta
    WHERE account = p_peer;
  END IF;

  DELETE FROM public.account_ledger
  WHERE (owner = v_acct AND peer = p_peer)
     OR (owner = p_peer AND peer = v_acct);

  RETURN json_build_object(
    'ok', true,
    'cleared', v_delta,
    'peerCleared', COALESCE(v_peer_delta, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_account_ledger_row(varchar) TO anon, authenticated;
