<script setup>
/**
 * 注册 / 登录页
 *
 * 账号名即身份，无密码（熟人朋友玩法）：
 *   · 注册：账号名查重 → 未占用则建档
 *   · 登录：输账号名 → 匹配到就登上原号（金瓜子、账本一起回来）
 *   · 已登录过：本地记住账号名，启动时自动登录，不再问
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { HAMSTERS, hamsterDataURI } from '@shared/assets/hamsters.mjs'
import { goldenSeedSVG, svgToDataURI } from '@shared/assets/visuals.mjs'
import { useUser } from '../stores/user.js'
import { repo, usingCloud } from '../data/repo.js'

const router = useRouter()
const route = useRoute()
const { signInWithAccount, user } = useUser()

/** 注册 / 登录 两个页签 */
const tab = ref('login')

const account = ref('')
const nickname = ref('')
const selected = ref(1)
const error = ref('')
const busy = ref(false)
const checking = ref(false)
const taken = ref(false)

const goldURI = svgToDataURI(goldenSeedSVG(20))

/** 已登录：本地有账号档案就直接进大厅，不再问 */
const alreadyIn = computed(() => !!user.value?.account)

/**
 * 是否正在确认登录态。
 * 云端模式下本地缓存可能是上一次会话的旧数据（甚至没有 account 字段），
 * 必须以服务端 my_account() 为准，否则会误把已登录用户推到登录页。
 */
const verifying = ref(true)

onMounted(async () => {
  verifying.value = true
  try {
    const me = await repo.myAccount()
    if (me?.loggedIn) {
      // 服务端说已登录：把档案落到本地再进大厅
      await signInWithAccount(me)
      router.replace(String(route.query.redirect ?? '/lobby'))
      return
    }
    // 服务端说没登录：清掉可能残留的旧档案，避免 alreadyIn 误判
    if (user.value && !user.value.account) {
      // 游客档案，保留即可，不影响登录页
    }
  } catch (e) {
    console.warn('[register] 确认登录态失败', e?.message ?? e)
  } finally {
    verifying.value = false
  }

  // 本地缓存里有账号档案（离线场景）也直接进
  if (alreadyIn.value) {
    router.replace(String(route.query.redirect ?? '/lobby'))
  }
})

/** 账号名规则：3-16 位，字母/数字/下划线/中文 */
const ACCOUNT_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,16}$/
const accountValid = computed(() => ACCOUNT_RE.test(account.value.trim()))

/** 登录页签下，账号名合法就能提交 */
const canLogin = computed(() => accountValid.value && !busy.value)
/** 注册页签下还需要昵称合法 */
const canRegister = computed(() => accountValid.value && nickname.value.trim().length >= 2 && !taken.value && !busy.value)

/** 输完账号名离开焦点时查重（云端才有意义，本地模式同规则） */
async function checkAccount() {
  const a = account.value.trim()
  if (!accountValid.value) return
  checking.value = true
  try {
    taken = !(await repo.accountAvailable(a))
  } catch {
    taken = false   // 查不到就当作可用，提交时再拦
  } finally {
    checking.value = false
  }
}

/** 用账号档案落地：写 userStore + 兜底记忆，然后进大厅 */
async function adopt(profile) {
  await signInWithAccount(profile)
  router.replace(String(route.query.redirect ?? '/lobby'))
}

/** 登录：输账号名登上原号 */
async function doLogin() {
  if (!canLogin.value) return
  error.value = ''
  busy.value = true
  try {
    const profile = await repo.loginAccount(account.value.trim())
    await adopt(profile)
  } catch (e) {
    error.value = '登录失败：' + (e?.message ?? e)
  } finally {
    busy.value = false
  }
}

/** 注册：查重 + 建档 */
async function doRegister() {
  if (!accountValid.value) {
    error.value = '账号名需 3-16 位，可用字母、数字、下划线、中文'
    return
  }
  if (taken.value) {
    error.value = '账号名已被占用'
    return
  }
  if (nickname.value.trim().length < 2) {
    error.value = '昵称至少 2 个字'
    return
  }
  error.value = ''
  busy.value = true
  try {
    const profile = await repo.registerAccount(
      account.value.trim(),
      nickname.value.trim(),
      selected.value
    )
    await adopt(profile)
  } catch (e) {
    const msg = e?.message ?? String(e)
    // 特殊case：上一次注册其实成功了，只是后续步骤报错（如组件未挂载）。
    // 这时账号已存在，再注册会报「已被占用」——直接帮用户登上，别让他卡住。
    if (msg.includes('已被占用')) {
      try {
        const existing = await repo.loginAccount(account.value.trim())
        await adopt(existing)
        return
      } catch {
        error.value = '该账号名已被占用，请换一个'
        return
      }
    }
    error.value = msg
  } finally {
    busy.value = false
  }
}

function submit() {
  if (tab.value === 'login') doLogin()
  else doRegister()
}
</script>

<template>
  <div v-if="verifying" class="page register">
    <header class="reg-head">
      <h1 class="title">仓鼠聚会</h1>
      <p class="subtitle">瓜子一响，黄金万两</p>
    </header>
    <p class="hint" style="text-align: center">正在确认登录状态…</p>
  </div>

  <div v-else class="page register">
    <header class="reg-head">
      <h1 class="title">仓鼠聚会</h1>
      <p class="subtitle">瓜子一响，黄金万两</p>
    </header>

    <div class="tabs">
      <button :class="{ on: tab === 'login' }" @click="tab = 'login'; error = ''">登录</button>
      <button :class="{ on: tab === 'register' }" @click="tab = 'register'; error = ''">注册</button>
    </div>

    <div class="card reg-card">
      <label class="field-label">账号名</label>
      <input
        v-model="account"
        class="input"
        type="text"
        maxlength="16"
        placeholder="3-16 位字母/数字/下划线/中文"
        @blur="checkAccount"
        @keyup.enter="submit"
      />
      <p v-if="account && !accountValid" class="error">格式不对：3-16 位，字母/数字/下划线/中文</p>
      <p v-else-if="checking" class="hint">正在查询账号…</p>
      <p v-else-if="taken && tab === 'register'" class="error">该账号名已被占用</p>
      <p v-else-if="taken && tab === 'login'" class="hint ok">账号存在，可直接登录</p>
      <p v-else-if="accountValid && tab === 'register'" class="hint ok">账号名可用</p>

      <template v-if="tab === 'register'">
        <label class="field-label">昵称</label>
        <input
          v-model="nickname"
          class="input"
          type="text"
          maxlength="8"
          placeholder="牌桌上显示的名字"
          @keyup.enter="submit"
        />

        <label class="field-label">选一只仓鼠</label>
        <div class="hamster-grid">
          <button
            v-for="h in HAMSTERS"
            :key="h.id"
            class="avatar"
            :class="{ 'avatar--selected': selected === h.id }"
            @click="selected = h.id"
          >
            <img :src="hamsterDataURI(h, 96)" :alt="h.name" />
            <span class="hamster-name">{{ h.name }}</span>
          </button>
        </div>
      </template>

      <p v-else class="hint">
        无需密码，输入账号名即可登录。没有账号先去「注册」页签创建一个。
      </p>

      <p v-if="error" class="error">{{ error }}</p>
    </div>

    <button
      class="btn reg-btn"
      :disabled="tab === 'login' ? !canLogin : !canRegister"
      @click="submit"
    >
      {{ busy ? '处理中…' : tab === 'login' ? '登 录' : '注 册 并 进 入' }}
    </button>

    <p class="tip">
      <img :src="goldURI" class="inline-gold" alt="" />
      账号名就是你的身份，金瓜子存在账号上
    </p>
  </div>
</template>

<style scoped>
.register {
  padding: 24px 20px calc(24px + var(--sab));
  gap: 14px;
}

.reg-head {
  text-align: center;
  padding-top: calc(12px + var(--sat));
}

.title {
  font-size: 34px;
  margin: 0;
  color: var(--c-primary-dark);
  letter-spacing: 2px;
  text-shadow: 0 2px 0 #fff, 0 4px 8px rgba(216, 167, 104, 0.3);
}

.subtitle {
  margin: 6px 0 0;
  color: var(--c-text-light);
  font-size: 14px;
}

.tabs {
  display: flex;
  gap: 8px;
  background: #fff;
  padding: 4px;
  border-radius: 16px;
  border: 2px solid var(--c-border);
}

.tabs button {
  flex: 1;
  height: 40px;
  border: none;
  border-radius: 12px;
  background: transparent;
  font-size: 15px;
  font-weight: 800;
  color: var(--c-text-light);
  cursor: pointer;
}

.tabs button.on {
  background: var(--c-primary);
  color: #fff;
}

.reg-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--c-text-light);
  margin-top: 4px;
}

.error {
  color: var(--c-danger);
  font-size: 13px;
  margin: 0;
}

.hint {
  font-size: 12px;
  color: var(--c-text-light);
  margin: 0;
}

.hint.ok {
  color: #2b8a3e;
  font-weight: 700;
}

.hamster-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.hamster-grid .avatar {
  width: 100%;
  aspect-ratio: 1;
  flex-direction: column;
  border-radius: 18px;
  padding: 4px;
  background: var(--c-bg);
  border-width: 3px;
  cursor: pointer;
}

.hamster-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--c-text-light);
}

.avatar--selected .hamster-name {
  color: var(--c-primary-dark);
}

.reg-btn {
  margin-top: auto;
}

.tip {
  text-align: center;
  font-size: 12px;
  color: var(--c-text-light);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin: 0;
}

.inline-gold {
  width: 16px;
  height: 16px;
  vertical-align: -3px;
}
</style>
