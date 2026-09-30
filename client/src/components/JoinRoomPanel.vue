<script setup>
/**
 * 加入房间面板 —— 线上/线下入口页共用的「加入房间」tab。
 *
 * 三块内容：
 *   1. 我的房间：本机有凭证/在座位的房（iAmIn）→ 回到房间；我建的（isMine）→ 解散
 *   2. 房间列表：当前存在的房间（含线上），显示人数/状态；满员禁加入；可解散自己的房
 *   3. 输房间号加入（线上进入页面自动入座，线下走 join 接口）
 *
 * 「解散/退出」全部走 leave 接口：房主离开 = 销毁房间，成员离开 = 退座。
 * 线上凭证由 listSeatCredRooms 回传服务端 authSeat 认证 —— 伪造不了别人房间的标记。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { useUser } from '../stores/user.js'
import { askConfirm } from '../composables/useConfirm.js'
import {
  listRooms, joinRoom, onlineState, onlineLeave, leaveRoom,
  listSeatCredRooms, clearSeatCred,
} from '../data/room-repo.js'

const props = defineProps({
  /** 'online' | 'offline' —— 只显示对应模式的房间 */
  mode: { type: String, required: true },
})

const router = useRouter()
const { user } = useUser()

const rooms = ref([])
const listError = ref('')
const busy = ref(false)
const joinNo = ref('')
const joinError = ref('')

/** 按模式过滤后的房间列表 */
const shownRooms = computed(() => rooms.value.filter((r) => r.mode === props.mode))
/** 我在的房间（置顶显示，回到房间入口） */
const myRooms = computed(() => shownRooms.value.filter((r) => r.iAmIn))

async function refresh() {
  const r = await listRooms(undefined, listSeatCredRooms())
  if (r.ok) {
    rooms.value = r.data.rooms ?? []
    listError.value = ''
    // 本机存有凭证但房间已没了 → 清掉失效凭证，免得列表误导
    const alive = new Set(rooms.value.map((x) => x.roomNo))
    for (const roomId of Object.keys(listSeatCredRooms())) {
      if (!alive.has(roomId)) clearSeatCred(roomId)
    }
  } else {
    listError.value = r.error || '拉取失败'
  }
}

const roomPath = (roomNo) => (props.mode === 'online' ? '/room/online' : '/room/offline')

function enter(r) {
  router.push({ path: roomPath(r.roomNo), query: { room: r.roomNo } })
}

async function joinByNo() {
  const no = joinNo.value.trim()
  if (!/^\d{6}$/.test(no)) { joinError.value = '房间号是 6 位数字'; return }
  joinError.value = ''
  if (props.mode === 'online') {
    // 线上：直接进房，页面自己处理入座/旁观
    router.push({ path: roomPath(no), query: { room: no } })
    return
  }
  // 线下：先 join 再进
  busy.value = true
  try {
    const r = await joinRoom(no, {
      nickname: user.value?.nickname || user.value?.account || '匿名',
      avatar: user.value?.avatar ?? 1,
    })
    if (!r.ok) { joinError.value = r.error || '加入失败'; return }
    router.push({ path: roomPath(no), query: { room: no } })
  } finally {
    busy.value = false
  }
}

async function joinListed(r) {
  if (r.full && !r.iAmIn) return
  if (props.mode === 'online') {
    // 先探活：列表是 4s 缓存，房间可能刚解散 —— 别把人送到「房间不存在」挡屏
    const st = await onlineState(r.roomNo)
    if (!st.ok) {
      joinError.value = '房间已不存在或刚解散'
      await refresh()
      return
    }
    enter(r)
    return
  }
  busy.value = true
  try {
    const j = await joinRoom(r.roomNo, {
      nickname: user.value?.nickname || user.value?.account || '匿名',
      avatar: user.value?.avatar ?? 1,
    })
    if (j.ok) { enter(r); return }
    joinError.value = j.error || '加入失败'
  } finally {
    busy.value = false
  }
}

/** 解散（房主）/退出（成员）：清理残留房间的手动入口 */
async function closeRoom(r) {
  const mine = r.isMine
  const yes = await askConfirm({
    title: mine ? '解散房间' : '退出房间',
    msg: mine ? `解散房间 ${r.roomNo}？里面的玩家都会被请出。` : `退出房间 ${r.roomNo}？`,
    okText: mine ? '解散' : '退出',
    danger: mine,
  })
  if (!yes) return
  busy.value = true
  try {
    const cred = listSeatCredRooms()[r.roomNo]
    const res = props.mode === 'online'
      ? await onlineLeave(r.roomNo, cred ?? {})
      : await leaveRoom(r.roomNo)
    if (res.ok) { clearSeatCred(r.roomNo); await refresh(); return }
    joinError.value = res.error || '操作失败'
  } finally {
    busy.value = false
  }
}

let timer = null
onMounted(() => {
  refresh()
  timer = setInterval(refresh, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="join-panel">
    <!-- 我的房间：回到房间 / 解散入口 -->
    <template v-if="myRooms.length">
      <h3 class="sec-title">我的房间</h3>
      <div class="room-row card mine" v-for="r in myRooms" :key="'my' + r.roomNo">
        <img class="r-avatar" :src="hamsterDataURI(getHamster(r.hostAvatar), 40)" alt="" />
        <div class="r-info">
          <div class="r-top">
            <span class="r-no">{{ r.roomNo }}</span>
            <span class="badge mine-tag">我{{ r.isMine ? '建的' : '在' }}</span>
            <span class="badge" :class="r.inProgress ? 'live' : 'idle'">
              {{ r.inProgress ? '对局中' : '等待中' }}
            </span>
          </div>
          <div class="r-sub">{{ r.playerCount }}/{{ r.maxSeats }} 人 · 房主 {{ r.hostName }}</div>
        </div>
        <div class="r-actions">
          <button class="btn primary sm" @click="enter(r)">回到房间</button>
          <button class="btn ghost sm danger" :disabled="busy" @click="closeRoom(r)">
            {{ r.isMine ? '解散' : '退出' }}
          </button>
        </div>
      </div>
    </template>

    <!-- 全部房间 -->
    <h3 class="sec-title">
      房间列表
      <button class="refresh" title="刷新" @click="refresh">⟳</button>
    </h3>
    <p v-if="!shownRooms.length" class="empty">暂无房间 —— 建一个或让朋友分享房间号</p>
    <div class="room-row card" v-for="r in shownRooms.filter(x => !x.iAmIn)" :key="r.roomNo">
      <img class="r-avatar" :src="hamsterDataURI(getHamster(r.hostAvatar), 40)" alt="" />
      <div class="r-info">
        <div class="r-top">
          <span class="r-no">{{ r.roomNo }}</span>
          <span class="badge" :class="r.inProgress ? 'live' : 'idle'">
            {{ r.inProgress ? '对局中' : '等待中' }}
          </span>
          <span v-if="r.full" class="badge full">满员</span>
        </div>
        <div class="r-sub">
          {{ r.playerCount }}/{{ r.maxSeats }} 人 · 房主 {{ r.hostName }}
          <template v-if="r.aiCount"> · {{ r.aiCount }} AI</template>
        </div>
      </div>
      <div class="r-actions">
        <button class="btn primary sm" :disabled="busy || r.full" @click="joinListed(r)">加入</button>
      </div>
    </div>

    <div class="divider">或者</div>

    <!-- 输房间号加入 -->
    <div class="row">
      <input
        v-model="joinNo" class="input no" type="text" inputmode="numeric" maxlength="6"
        placeholder="000000" @keyup.enter="joinByNo"
      />
      <button class="btn primary join" :disabled="busy" @click="joinByNo">加入</button>
    </div>
    <p v-if="joinError" class="error">{{ joinError }}</p>
    <p v-if="listError" class="error">{{ listError }}</p>
  </div>
</template>

<style scoped>
.join-panel { display: flex; flex-direction: column; gap: 10px; }
.sec-title { margin: 4px 0 0; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.refresh { border: none; background: none; font-size: 15px; cursor: pointer; color: var(--c-text-light); }
.empty { margin: 6px 0; font-size: 13px; color: var(--c-text-light); text-align: center; }

.room-row {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
}
.room-row.mine { border-color: var(--c-primary); }
.r-avatar { width: 34px; height: 34px; border-radius: 50%; }
.r-info { flex: 1; min-width: 0; }
.r-top { display: flex; align-items: center; gap: 6px; }
.r-no { font-size: 16px; font-weight: 900; letter-spacing: 1px; }
.r-sub { font-size: 11px; color: var(--c-text-light); margin-top: 2px; }
.r-actions { display: flex; gap: 6px; flex-shrink: 0; }

.badge {
  font-size: 10px; padding: 1px 6px; border-radius: 6px;
  background: var(--c-bg); color: var(--c-text-light); border: 1px solid var(--c-border);
}
.badge.live { background: #e8f7ee; color: #1a7a3a; border-color: #b7e4c7; }
.badge.idle { background: #fff6e0; color: var(--c-primary-dark); }
.badge.full { background: #f3f3f3; color: #999; }
.badge.mine-tag { background: var(--c-primary); color: #fff; border-color: var(--c-primary); }

.btn.sm { height: 32px; padding: 0 12px; font-size: 13px; border-radius: 10px; }
.btn.primary { border: none; background: linear-gradient(180deg, var(--c-primary), var(--c-primary-dark)); color: #fff; font-weight: 800; }
.btn.ghost { background: var(--c-card); border: 1.5px solid var(--c-border); color: var(--c-text); font-weight: 700; }
.btn.danger { color: var(--c-danger); }
.btn:disabled { opacity: 0.5; }

.divider { text-align: center; font-size: 12px; color: var(--c-text-light); }
.row { display: flex; gap: 8px; }
.input {
  height: 44px; border: 2px solid var(--c-border); border-radius: 12px;
  background: var(--c-card); padding: 0 12px; font-size: 15px; font-weight: 700;
  color: var(--c-text); width: 100%;
}
.input.no { flex: 1; text-align: center; font-size: 20px; font-weight: 900; letter-spacing: 4px; }
.btn.join { width: 96px; }
.error { margin: 0; font-size: 13px; color: var(--c-danger); }
</style>
