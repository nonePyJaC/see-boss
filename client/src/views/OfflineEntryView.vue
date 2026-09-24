<script setup>
/**
 * 线下模式入口 —— 创建房间 / 加入房间
 *
 * 2026-09-24 修：原来大厅的「线下计分」直接 push('/room/offline')，
 * 不带房间号，房间页只能显示「房间不存在」。卡片上明明写着
 * 「创建房间 / 加入房间」，却一步都没给，是漏了一整页。
 *
 * 2026-09-24 补：重建时把「初始瓜子 / 小麦 / 大麦」的设置丢了，
 * 硬编码成 1000/100/200。旧版（7d97ba8 之前）是有的，
 * 这里按原样补回来。
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUser } from '../stores/user.js'
import { roomRepo } from '../data/room-repo.js'

const router = useRouter()
const { user, refresh } = useUser()

/**
 * 进来自行拉一次账号档案。
 * useUser() 只是本地的响应式缓存，没人 refresh 它就是空的 ——
 * 直接打开这个 URL（收藏、扫码）时建房会被服务端以「缺少昵称」拒掉。
 * 走 LobbyView 进来时通常已经有了，但别依赖那条路径。
 */
onMounted(async () => {
  if (!user.value) await refresh()
})

// ── 房间设置（旧版就有，重建时丢了，补回）──
/** 初始瓜子快捷档。默认 3000，跟服务端 newRoom 的默认值保持一致 */
const SEED_PRESETS = [3000, 5000, 10000]
const initialSeeds = ref(3000)
const customSeeds = ref('')
const smallBlind = ref(10)
const bigBlind = ref(20)

/** 自定义瓜子填了就优先用它 */
const seeds = computed(() => {
  const c = Number(customSeeds.value)
  return Number.isFinite(c) && c > 0 ? Math.floor(c) : initialSeeds.value
})

const settingError = computed(() => {
  if (!(seeds.value > 0)) return '初始瓜子要大于 0'
  if (!(smallBlind.value > 0)) return '小麦要大于 0'
  if (bigBlind.value <= smallBlind.value) return '大麦必须大于小麦'
  return ''
})

function pickSeeds(v) {
  initialSeeds.value = v
  customSeeds.value = ''
}

// ── 创建房间 ──
const creating = ref(false)
const createError = ref('')

async function create() {
  if (settingError.value) {
    createError.value = settingError.value
    return
  }
  creating.value = true
  createError.value = ''
  try {
    // cfg 和 me 是平级的两个字段，都要传。
    // 服务端 handleCreate 读 body.cfg 拿房间配置、读 body.me.nickname 拿房主昵称，
    // 少任何一个都被拒（缺 me → 「缺少昵称」；cfg 不嵌套 → 全落默认值）。
    const r = await roomRepo.createRoom({
      mode: 'offline',
      initialSeeds: seeds.value,
      smallBlind: smallBlind.value,
      bigBlind: bigBlind.value,
    }, {
      nickname: user.value?.nickname || user.value?.account || '匿名',
      avatar: user.value?.avatar ?? 1,
    })
    if (!r.ok) {
      createError.value = r.error || '建房失败'
      return
    }
    router.push({ path: '/room/offline', query: { room: r.data.id } })
  } finally {
    creating.value = false
  }
}

// ── 加入房间 ──
const joining = ref(false)
const joinNo = ref('')
const joinError = ref('')

async function join() {
  const no = joinNo.value.trim()
  if (!/^\d{6}$/.test(no)) {
    joinError.value = '房间号是 6 位数字'
    return
  }
  joining.value = true
  joinError.value = ''
  try {
    const r = await roomRepo.joinRoom(no, {
      nickname: user.value?.nickname || user.value?.account || '匿名',
      avatar: user.value?.avatar ?? 1,
    })
    if (!r.ok) {
      joinError.value = r.error || '加入失败'
      return
    }
    router.push({ path: '/room/offline', query: { room: no } })
  } finally {
    joining.value = false
  }
}
</script>

<template>
  <div class="page entry">
    <div class="topbar">
      <button class="back" @click="router.back()">←</button>
      <span class="title">线下计分</span>
    </div>

    <!-- 创建房间 -->
    <div class="card block">
      <h2>创建房间</h2>
      <p class="hint">你当房主，定小麦位，朋友扫码或输房间号进来</p>

      <label class="field-label">初始瓜子数量</label>
      <div class="chip-row">
        <button
          v-for="v in SEED_PRESETS"
          :key="v"
          :class="{ on: initialSeeds === v && !customSeeds }"
          @click="pickSeeds(v)"
        >
          {{ v }}
        </button>
      </div>
      <input
        v-model="customSeeds"
        class="input"
        type="number"
        min="1"
        placeholder="自定义初始瓜子"
      />

      <label class="field-label">盲注设置</label>
      <div class="blind-row">
        <div class="blind-item">
          <span>小麦</span>
          <input v-model.number="smallBlind" class="input" type="number" min="1" />
        </div>
        <div class="blind-item">
          <span>大麦</span>
          <input v-model.number="bigBlind" class="input" type="number" min="1" />
        </div>
      </div>

      <button class="btn primary" :disabled="creating" @click="create">
        {{ creating ? '创建中…' : '创建并进入' }}
      </button>
      <p v-if="createError" class="error">{{ createError }}</p>
    </div>

    <div class="divider">或者</div>

    <!-- 加入房间 -->
    <div class="card block">
      <h2>加入房间</h2>
      <p class="hint">输入房主给你的 6 位房间号</p>
      <div class="row">
        <input
          v-model="joinNo"
          class="input no"
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="000000"
          @keyup.enter="join"
        />
        <button class="btn primary join" :disabled="joining" @click="join">
          {{ joining ? '加入中…' : '加入' }}
        </button>
      </div>
      <p v-if="joinError" class="error">{{ joinError }}</p>
    </div>
  </div>
</template>

<style scoped>
.entry {
  padding: calc(12px + var(--sat)) 16px calc(20px + var(--sab));
  gap: 14px;
  max-width: 480px;
  margin: 0 auto;
  min-height: 100dvh;
  background: linear-gradient(160deg, var(--c-bg) 0%, var(--c-bg-deep) 100%);
}

.topbar {
  height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.back {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: var(--c-card);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 0 var(--c-border);
}

.title {
  font-size: 18px;
  font-weight: 900;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 16px;
}

.block h2 {
  margin: 0;
  font-size: 17px;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--c-text-light);
}

.field-label {
  font-size: 13px;
  font-weight: 700;
  color: var(--c-text-light);
  margin-top: 4px;
}

.chip-row {
  display: flex;
  gap: 8px;
}

.chip-row button {
  flex: 1;
  height: 42px;
  border: 2px solid var(--c-border);
  border-radius: 12px;
  background: var(--c-card);
  font-size: 15px;
  font-weight: 800;
  color: var(--c-text-light);
  cursor: pointer;
}

.chip-row button.on {
  border-color: var(--c-primary);
  background: #fff6e0;
  color: var(--c-primary-dark);
}

.blind-row {
  display: flex;
  gap: 10px;
}

.blind-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.blind-item span {
  font-size: 12px;
  font-weight: 700;
  color: var(--c-text-light);
}

.input {
  height: 46px;
  border: 2px solid var(--c-border);
  border-radius: 12px;
  background: var(--c-card);
  padding: 0 12px;
  font-size: 15px;
  font-weight: 700;
  color: var(--c-text);
  width: 100%;
}

.btn.primary {
  height: 48px;
  border: none;
  border-radius: 14px;
  background: linear-gradient(180deg, var(--c-primary) 0%, var(--c-primary-dark) 100%);
  color: #fff;
  font-size: 15px;
  font-weight: 800;
  cursor: pointer;
  box-shadow: 0 4px 0 #c77a00;
}

.btn.primary:active {
  transform: translateY(3px);
  box-shadow: none;
}

.btn.primary:disabled {
  opacity: 0.5;
}

.divider {
  text-align: center;
  font-size: 12px;
  color: var(--c-text-light);
}

.row {
  display: flex;
  gap: 8px;
}

.input.no {
  flex: 1;
  text-align: center;
  font-size: 20px;
  font-weight: 900;
  letter-spacing: 4px;
}

.btn.join {
  width: 96px;
}

.error {
  margin: 0;
  font-size: 13px;
  color: var(--c-danger);
}
</style>
