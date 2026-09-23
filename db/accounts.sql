-- ============================================================
-- 账号体系：账号名即身份（无密码）
--
-- 设计目标（用户明确要求）：
--   * 熟人朋友玩，不要密码
--   * 知道账号名就能登上，登录态由账号名决定
--   * 金瓜子绑账号名而不是匿名 uid
--     → 微信清掉 localStorage 导致 uid 变了，金瓜子照样在
--
-- 与现有结构的关系：
--   users       保留，仍是匿名身份（uid ← JWT sub），
--               RLS 的房间隔离/麦位权限都以它为准
--   accounts    新增，账号 ←→ uid 的绑定关系 + 业务档案
--               （金瓜子、昵称、头像、总场次）
--   一次登录后，accounts.uid 指向当前匿名 uid，
--   后续所有读写都通过这个 uid 走，RLS 无需改动。
--
-- 安全边界：
--   accounts 表只允许「已登录到自己账号」的 uid 读写自己的行。
--   登录动作本身由 SECURITY DEFINER 函数完成，函数内做查重。
--   → 别人拿到你的账号名可以登上（这是产品设定），
--     但登上来后只能操作这一个账号，看不到其他人。
-- ============================================================

-- ---- 1. accounts 表 ----
CREATE TABLE IF NOT EXISTS public.accounts (
  account      varchar(16) PRIMARY KEY,
  uid          varchar(64) NOT NULL UNIQUE,
  nickname     varchar(32) NOT NULL,
  avatar       smallint    NOT NULL DEFAULT 1,
  golden_seeds integer     NOT NULL DEFAULT 0,
  total_games  integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_login   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_uid ON public.accounts(uid);

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

-- 只能读/写自己的那一行（uid 匹配当前 JWT sub）
DROP POLICY IF EXISTS accounts_self_select ON public.accounts;
CREATE POLICY accounts_self_select ON public.accounts
  FOR SELECT TO anon, authenticated
  USING (uid = (select auth.uid()));

DROP POLICY IF EXISTS accounts_self_update ON public.accounts;
CREATE POLICY accounts_self_update ON public.accounts
  FOR UPDATE TO anon, authenticated
  USING (uid = (select auth.uid()))
  WITH CHECK (uid = (select auth.uid()));

-- 写权限只给登录函数用，客户端不能直接 INSERT（否则能抢注别人的账号名）
-- 所以这里不授予 INSERT 策略，插入只发生在 SECURITY DEFINER 函数内。


-- ---- 2. 注册账号 ----
-- 账号名规则：3-16 位，字母/数字/下划线/中文
-- 冲突时抛错，由前端提示「账号名已被占用」
CREATE OR REPLACE FUNCTION public.register_account(
  p_account  varchar,
  p_nickname varchar,
  p_avatar   smallint DEFAULT 1
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid varchar;
  v_row public.accounts;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  IF p_account !~ '^[A-Za-z0-9_一-龥]{3,16}$' THEN
    RAISE EXCEPTION '账号名需 3-16 位，可用字母、数字、下划线、中文';
  END IF;

  IF p_nickname IS NULL OR length(trim(p_nickname)) = 0 THEN
    RAISE EXCEPTION '昵称不能为空';
  END IF;

  -- 该账号名是否已被占用
  IF EXISTS (SELECT 1 FROM public.accounts WHERE account = p_account) THEN
    RAISE EXCEPTION '账号名已被占用';
  END IF;

  -- 当前匿名 uid 是否已绑过别的账号（一台设备一个匿名身份只绑一个号）
  IF EXISTS (SELECT 1 FROM public.accounts WHERE uid = v_uid) THEN
    RAISE EXCEPTION '当前设备已绑定账号，请先退出登录';
  END IF;

  INSERT INTO public.accounts (account, uid, nickname, avatar)
  VALUES (p_account, v_uid, coalesce(nullif(trim(p_nickname), ''), p_account), COALESCE(p_avatar, 1))
  RETURNING * INTO v_row;

  RETURN json_build_object(
    'ok', true,
    'account', v_row.account,
    'nickname', v_row.nickname,
    'avatar', v_row.avatar,
    'goldenSeeds', v_row.golden_seeds,
    'totalGames', v_row.total_games
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.register_account(varchar, varchar, smallint) TO anon, authenticated;


-- ---- 3. 登录账号 ----
-- 用账号名取得档案，并把该账号重新绑定到当前匿名 uid。
-- 这样换设备/清缓存后，用同一个账号名就能把金瓜子找回来。
CREATE OR REPLACE FUNCTION public.login_account(p_account varchar)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid varchar;
  v_row public.accounts;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT * INTO v_row FROM public.accounts WHERE account = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在，请先注册';
  END IF;

  -- 换设备登录：uid 换了，把账号指向新 uid
  IF v_row.uid <> v_uid THEN
    UPDATE public.accounts
    SET uid = v_uid, last_login = now()
    WHERE account = p_account
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.accounts SET last_login = now()
    WHERE account = p_account
    RETURNING * INTO v_row;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'account', v_row.account,
    'nickname', v_row.nickname,
    'avatar', v_row.avatar,
    'goldenSeeds', v_row.golden_seeds,
    'totalGames', v_row.total_games
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.login_account(varchar) TO anon, authenticated;


-- ---- 4. 查询账号名是否可用（注册前预检，避免提交才报错） ----
CREATE OR REPLACE FUNCTION public.account_available(p_account varchar)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_account !~ '^[A-Za-z0-9_一-龥]{3,16}$' THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM public.accounts WHERE account = p_account);
END;
$$;

GRANT EXECUTE ON FUNCTION public.account_available(varchar) TO anon, authenticated;


-- ---- 5. 读取当前登录态 ----
-- 前端启动时调一次：当前匿名 uid 绑了哪个账号
CREATE OR REPLACE FUNCTION public.my_account()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid varchar;
  v_row public.accounts;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  SELECT * INTO v_row FROM public.accounts WHERE uid = v_uid;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', true, 'loggedIn', false);
  END IF;

  RETURN json_build_object(
    'ok', true,
    'loggedIn', true,
    'account', v_row.account,
    'nickname', v_row.nickname,
    'avatar', v_row.avatar,
    'goldenSeeds', v_row.golden_seeds,
    'totalGames', v_row.total_games
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.my_account() TO anon, authenticated;


-- ---- 6. 更新我的档案（昵称/头像） ----
CREATE OR REPLACE FUNCTION public.update_my_account(
  p_nickname varchar DEFAULT NULL,
  p_avatar   smallint DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid varchar;
  v_row public.accounts;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  UPDATE public.accounts
  SET nickname = COALESCE(nullif(trim(p_nickname), ''), nickname),
      avatar   = COALESCE(p_avatar, avatar)
  WHERE uid = v_uid
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION '尚未登录账号';
  END IF;

  RETURN json_build_object(
    'ok', true,
    'account', v_row.account,
    'nickname', v_row.nickname,
    'avatar', v_row.avatar,
    'goldenSeeds', v_row.golden_seeds,
    'totalGames', v_row.total_games
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_my_account(varchar, smallint) TO anon, authenticated;


-- ---- 7. 退出登录 ----
-- 解绑当前匿名 uid，让别人可以用这个账号名在这台设备上登录。
-- 不删账号，金瓜子保留。
CREATE OR REPLACE FUNCTION public.logout_account()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid varchar;
BEGIN
  v_uid := current_setting('request.jwt.claims', true)::json->>'sub';
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录';
  END IF;

  -- 把 uid 改成一个不可能再出现的值，等于解绑
  UPDATE public.accounts
  SET uid = 'unbound-' || account || '-' || floor(extract(epoch from now()))::bigint
  WHERE uid = v_uid;

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.logout_account() TO anon, authenticated;
