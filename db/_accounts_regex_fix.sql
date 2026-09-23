-- 仅重跑两个含中文正则的函数（register_account / account_available）
-- 修复：PostgreSQL POSIX 正则不认 \x{4e00}，改用 \u4e00

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

  IF EXISTS (SELECT 1 FROM public.accounts WHERE account = p_account) THEN
    RAISE EXCEPTION '账号名已被占用';
  END IF;

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
