<script setup>
/**
 * 注册 / 登录页
 *
 * 账号名即身份，无密码（熟人朋友玩法）：
 *   · 注册：账号名查重 → 未占用则建档
 *   · 登录：输账号名 → 匹配到就登上原号（金瓜子、账本一起回来）
 *   · 已登录过：本机 uid 已绑账号 → 启动时自动登录，不再问
 *
 * 2026-09-24：数据层从 cloud-repo（CloudBase PG）换成 account-repo（自家 /api/account/*）。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { HAMSTERS, hamsterDataURI } from '../../../shared/assets/hamsters.mjs'
import { goldenSeedSVG, svgToDataURI } from '../../../shared/assets/visuals.mjs'
import { accountRepo } from '../data/account-repo.js'
import { writeIdentity } from '../data/identity.js'

const router = useRouter()
const route = useRoute()

/** 注册 / 登录 两个页签 */
const tab = ref('login')

const account = ref('')
const nickname = ref('')
const selected = ref(1)
const error = ref('')
const busy = ref(false)
const verifying = ref(true)

const goldURI = svgToDataURI(goldenSeedSVG(20))

/** 账号名规则：3-16 位，字母/数字/下划线/中文 */
const ACCOUNT_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,16}$/
const accountValid = computed(() => ACCOUNT_RE.test(account.value.trim()))

const canLogin = computed(() => accountValid.value && !busy.value)
const canRegister = computed(
  () => accountValid.value && nickname.value.trim().length >= 2 && !busy.value
)

/** 本机 uid 已经绑了账号 → 直接进大厅，不再问 */
onMounted(async () => {
  verifying.value = true
  try {
    const m = await accountRepo.me()
    if (m.ok && m.data?.loggedIn) {
      router.replace(String(route.query.redirect ?? '/lobby'))
      return
    }
  } catch (e) {
    console.warn('[register] 确认登录态失败', e?.message ?? e)
  } finally {
    verifying.value = false
  }
})

/** 登录：输账号名登上原号 */
async function doLogin() {
  if (!canLogin.value) return
  error.value = ''
  busy.value = true
  try {
    const r = await accountRepo.login(account.value.trim())
    if (!r.ok) { error.value = r.error || '登录失败'; return }
    writeIdentity({ nickname: r.data?.nickname || account.value.trim(), avatar: r.data?.avatar })
    router.replace(String(route.query.redirect ?? '/lobby'))
  } catch (e) {
    error.value = '登录失败：' + (e?.message ?? e)
  } finally {
    busy.value = false
  }
}

/** 注册：账号名未占用就按这个昵称建档 */
async function doRegister() {
  if (!accountValid.value) {
    error.value = '账号名需 3-16 位，可用字母、数字、下划线、中文'
    return
  }
  if (nickname.value.trim().length < 2) {
    error.value = '昵称至少 2 个字'
    return
  }
  error.value = ''
  busy.value = true
  try {
    const r = await accountRepo.login(account.value.trim(), nickname.value.trim())
    if (!r.ok) { error.value = r.error || '注册失败'; return }
    writeIdentity({ nickname: nickname.value.trim(), avatar: r.data?.avatar })
    router.replace(String(route.query.redirect ?? '/lobby'))
  } catch (e) {
    error.value = e?.message ?? String(e)
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
        @keyup.enter="submit"
      />
      <p v-if="account && !accountValid" class="error">格式不对：3-16 位，字母/数字/下划线/中文</p>

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
