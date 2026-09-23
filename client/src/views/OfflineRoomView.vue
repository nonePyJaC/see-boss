<script setup>
/**
 * 线下计分模式 — 手机当筹码计分器（云端联机版）
 *
 * 数据流：
 *   创建/加入房间 → repo.createRoom / repo.joinRoom
 *   公共池变动   → repo.movePot（PG 单事务，FOR UPDATE 锁行）
 *   结算         → repo.offlineSettle（金瓜子转账 + 历史 + 重置）
 *   实时同步     → repo.subscribeRoom（轮询，2s）
 *
 * 核心概念：
 *   公共池（pot）  桌面上大家共有的瓜子
 *   出瓜子 = 我的 → 公共池
 *   收瓜子 = 公共池 → 我的（点一次全收）
 */
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { hamsterDataURI, getHamster } from '@shared/assets/hamsters.mjs'
import { goldenSeedSVG, svgToDataURI, seedSVG } from '@shared/assets/visuals.mjs'
import SeedChips from '../components/SeedChips.vue'
import { useUser } from '../stores/user.js'
import { useHistory } from '../stores/history.js'
import { repo, usingCloud, createRoomSync } from '../data/repo.js'
import { buildSettlement, transfersAfterTiePick } from '@shared/logic/settlement.mjs'

const router = useRouter()
const route = useRoute()
const { user, recordSeed, update, refreshMyProfile } = useUser()
const { addGame } = useHistory()
// 未登录/未注册：带 redirect 去注册页，注册完自动回到本页
// （JoinView 已带 redirect，但用户直接开 /room/offline?join=xxx 时兜底）
if (!user.value) {
  const no = String(route.query.join ?? '').trim()
  router.replace({
    path: '/register',
    query: /^\d{6}$/.test(no) ? { redirect: '/room/offline?join=' + no } : {},
  })
}

// 扫码落地：/?join=<房间号> 时自动入座，跳过「创建/加入」选择页
// 用户没注册时先把完整路径存进 redirect，注册完再回到这里
const pendingJoin = ref('')

// ── 房间配置 ──
const CREATING = ref(true)
const roomNo = ref('')
const joinInput = ref('')
const initialSeeds = ref(3000)
const customSeeds = ref('')
const smallBlind = ref(10)
const bigBlind = ref(20)
const roundNo = ref(1)

// ── 房间状态 ──
const started = ref(false)
const busy = ref(false)

/** 座位（来自云端快照） */
const players = reactive([])

/**
 * 麦位锁开关状态（true = 🔒 自动下注，false = 🔓 手动设置）
 */
const autoBlind = ref(false)

/** 离开房间二次确认 */
const leaveConfirm = ref(false)

/**
 * 座位排序模式（仅房主 + 手动模式下可用）。
 * 用 Pointer Events 而不是 HTML5 drag&drop：后者在 iOS Safari /
 * 微信 WebView 上根本不触发，Pointer Events 一套 API 同时覆盖
 * 鼠标、手指、触控笔。
 */
const sorting = ref(false)

/** 拖拽中间状态 */
const drag = reactive({
  uid: '',        // 正被拖的玩家
  active: false,  // 是否已超过阈值算"真拖拽"（否则视为点击）
  target: '',     // 手指/指针下方的玩家
  x: 0,
  y: 0,
})

const DRAG_THRESHOLD = 8   // px，超过才算拖，否则算点击

function enterSort() {
  if (!isHost.value) return showToast('只有房主可以调整座位')
  if (autoBlind.value) return showToast('自动下注中不能排序，请先解锁')
  sorting.value = true
}

function exitSort() {
  sorting.value = false
  resetDrag()
}

function resetDrag() {
  drag.uid = ''
  drag.active = false
  drag.target = ''
}

/** 交换 uidA 与 uidB 的座位顺序 */
async function doSwap(uidA, uidB) {
  if (!uidA || !uidB || uidA === uidB) return
  const order = sortedPlayers.value.map((p) => p.uid)
  const i = order.indexOf(uidA)
  const j = order.indexOf(uidB)
  if (i < 0 || j < 0) return
  order[i] = uidB
  order[j] = uidA
  try {
    await repo.reorderSeats(roomNo.value, order)
    await pullSnapshot()
  } catch (e) {
    showToast('调整座位失败：' + (e?.message ?? e))
  }
}

/** pointerdown：登记起点，捕获指针确保移出卡片也收得到事件 */
function onPointerDown(e, uid) {
  if (!sorting.value || !isHost.value) return
  drag.uid = uid
  drag.x = e.clientX
  drag.y = e.clientY
  drag.active = false
  drag.target = ''
  // setPointerCapture 让后续 move/up 都发到这张卡上，不会因手指移出而丢失
  e.currentTarget?.setPointerCapture?.(e.pointerId)
}

/** pointermove：超过阈值后开始找落点 */
function onPointerMove(e) {
  if (!drag.uid) return
  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y

  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    drag.active = true
  }

  // 手指在哪个卡片上。被拖的卡片自己也可能命中，排除掉。
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const card = el?.closest?.('.pcard')
  const over = card?.dataset?.uid
  drag.target = over && over !== drag.uid ? over : ''
}

/**
 * pointerup：拖拽就交换，没超过阈值就当作点击选中
 * （两种交互并存：手机上拖不准时还能用点的）
 */
async function onPointerUp(e) {
  const { uid, active, target } = drag
  e.currentTarget?.releasePointerCapture?.(e.pointerId)
  resetDrag()
  if (!uid) return
  if (active && target) await doSwap(uid, target)
  else if (!active) await tapSwap(uid)
}

/** 点击选中交换：第一次点 A，第二次点 B → 交换 */
const swapFrom = ref('')

async function tapSwap(uid) {
  if (!sorting.value) return
  if (!swapFrom.value) {
    swapFrom.value = uid
    return
  }
  if (swapFrom.value === uid) {
    swapFrom.value = ''
    return
  }
  const a = swapFrom.value
  swapFrom.value = ''
  await doSwap(a, uid)
}

/** 公共池 */
const pot = ref(0)

/** 我是否是房主 */
const isHost = ref(false)

/** 最近一次变动，用于弹跳动效 */
const lastChange = ref(null)

const goldURI = svgToDataURI(goldenSeedSVG(24))

const QUICK_AMOUNTS = [5, 10, 20, 50, 100, 500]
const MAX_SEATS = 8

const me = computed(() => players.find((p) => p.isMe))
const mySeeds = computed(() => me.value?.seeds ?? 0)
const others = computed(() => players.filter((p) => !p.isMe))

/** 按座位号排序展示 */
const sortedPlayers = computed(() =>
  [...players].sort((a, b) => Number(a.seatNo ?? 99) - Number(b.seatNo ?? 99))
)

/** 存活房间列表 */
const liveRooms = ref([])
const roomsLoading = ref(false)
const roomsError = ref('')

/** 切到加入页签：首次自动拉一次存活房间列表 */
function switchToJoin() {
  CREATING.value = false
  if (!liveRooms.value.length && !roomsLoading.value) loadRooms()
}

async function loadRooms() {
  roomsLoading.value = true
  roomsError.value = ''
  try {
    liveRooms.value = await repo.listJoinableRooms(20)
  } catch (e) {
    roomsError.value = '加载失败：' + (e?.message ?? e)
    liveRooms.value = []
  } finally {
    roomsLoading.value = false
  }
}

/** 从列表点进去：已加入的直接进，没加入的走 joinRoom */
/** 房间列表头像（模板里不能用 ?? 与函数默认参数，放这里算） */
function roomAvatarURI(r) {
  const idx = Number(r.hostAvatar)
  return hamsterDataURI(getHamster(Number.isFinite(idx) && idx >= 0 ? idx : 1), 64)
}

async function joinFromList(r) {
  if (!r?.roomNo) return
  joinInput.value = r.roomNo
  await joinRoom()
  // 进房后刷新列表，让自己从"可加入"变成"已加入"
  if (started.value) loadRooms()
}

/** 快捷档位弹窗 */
const quickOpen = ref(false)
const customAmount = ref('')

/**
 * 已选中待打出的瓜子数（两段式交互：先点选，再点「打出」）
 * 0 表示未选中
 */
const picked = ref(0)

/**
 * busy 超时释放。
 * 页面里多个按钮绑了 :disabled="busy"，一旦某个 await 永不 settle，
 * finally 不执行，busy 就永久卡在 true，整页按钮失灵
 * （症状：点创建/退出/收款都没反应，也不报错）。
 * 这里加 15 秒硬超时，保证用户永不被锁死。
 */
let busyTimer = null
watch(busy, (v) => {
  if (busyTimer) {
    clearTimeout(busyTimer)
    busyTimer = null
  }
  if (v) {
    busyTimer = setTimeout(() => {
      console.warn('[offline] busy 超时 15s，强制释放')
      busy.value = false
    }, 15000)
  }
})

/**
 * 最近 5 条公共池流水。
 * 权威来源是服务端 pot_log 表（pullSnapshot 覆盖），
 * 本地只在乐观更新时插入，避免两个手机看到不同记录。
 */
const betLog = ref([])
/** 是否展开全部流水（默认只显示最近 LOG_LIMIT 条） */
const logExpanded = ref(false)
const LOG_LIMIT = 5

/** 默认只展示最近 5 条；展开后全显示 */
const visibleLog = computed(() =>
  logExpanded.value ? betLog.value : betLog.value.slice(0, LOG_LIMIT)
)

let betSeq = 0

/** 本地乐观插入一条，让 UI 立即有反馈（随后会被快照覆盖） */
function pushBetLog(name, delta, kind = 'pay') {
  betLog.value.unshift({ id: ++betSeq, name, delta, kind })
  if (betLog.value.length > 5) betLog.value.pop()
}

/** 用服务端返回的流水覆盖本地（全员同步的关键） */
function replaceBetLog(list) {
  // 最多留 50 条，够了——展开视图也不会无限长
  betLog.value = (list ?? []).slice(0, 50).map((l, i) => ({
    id: (l.uid ?? 'x') + '-' + (l.delta ?? 0) + '-' + i,
    name: l.name ?? '玩家',
    delta: l.delta ?? 0,
    kind: l.kind ?? 'pay',
  }))
}

/** 切换展开/收起 */
function toggleLog() {
  logExpanded.value = !logExpanded.value
}

/** 动效状态 */
const flying = ref(false)
const flyDir = ref('out')   // out=投入公共池  in=收回
const potBumping = ref(false)
const mySeedsBump = ref(false)
let bumpTimer = null

function flashPot() {
  potBumping.value = true
  if (bumpTimer) clearTimeout(bumpTimer)
  bumpTimer = setTimeout(() => (potBumping.value = false), 380)
}

function flashMySeeds() {
  mySeedsBump.value = true
  setTimeout(() => (mySeedsBump.value = false), 380)
}

/** 播放飞籽动效 */
function playFly(dir) {
  flyDir.value = dir
  flying.value = true
  setTimeout(() => (flying.value = false), 520)
}

const toast = ref('')
let toastTimer = null
function showToast(msg) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1800)
}

function avatarURI(id) {
  return hamsterDataURI(getHamster(id), 64)
}

/** 房间二维码 dataURI（动态 import qrcode，避免 SFC 拆分问题） */
const qrURI = ref('')
const qrExpanded = ref(false)
const qrZoom = ref(false)

/** 瓜子图标 dataURI（收/出款按钮用） */
const seedIconURI = svgToDataURI(seedSVG({ size: 48 }))
/** 房主皇冠图标 */
const hostIconURI = svgToDataURI(`
<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
  <path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-2 10H5L3 8z" fill="#FFC107" stroke="#F57F17" stroke-width="1.2" stroke-linejoin="round"/>
  <circle cx="3" cy="7" r="2" fill="#FFD54F"/>
  <circle cx="21" cy="7" r="2" fill="#FFD54F"/>
  <circle cx="12" cy="4" r="2" fill="#FFD54F"/>
</svg>`)

/** 复制房间号到剪贴板 */
function copyRoomNo() {
  const no = roomNo.value
  if (!no) return
  const cb = navigator.clipboard
  if (cb?.writeText) {
    cb.writeText(no).then(
      () => showToast('房间号已复制'),
      () => showToast('复制失败，房间号：' + no)
    )
  } else {
    showToast('房间号：' + no)
  }
}

async function genRoomQR() {
  if (!roomNo.value) return
  try {
    const mod = await import('qrcode')
    const QRCode = mod.default ?? mod
    const url = location.origin + location.pathname + '#/join/' + roomNo.value + '?mode=offline'
    qrURI.value = await QRCode.toDataURL(url, {
      width: 72,
      margin: 1,
      color: { dark: '#5D4037', light: '#FFFFFFFF' },
      errorCorrectionLevel: 'M',
    })
  } catch (e) {
    console.error('[offline] 二维码生成失败', e)
  }
}

// ── 实时同步 ──
let stopSync = null

/**
 * 退避轮询：空闲时降频，省 CloudBase 调用。
 *
 * 全量 roomSnapshot 带 50 行流水；getRoomRevision 只取一个时间戳。
 * 策略：先用轻量探针看版本有没有动，
 *         没动 → 什么都不做（省掉全量请求），
 *         动了 → 才拉全量，并把退避等级归零。
 *       版本连续 N 次没动，把探针本身的间隔拉长（2s→15s）。
 */
const pollBackoff = { level: 0, lastRev: 0, lastOk: 0 }
/** 上一次成功拿到的快照：版本没变时直接复用，省掉全量请求 */
const lastSnap = ref(null)
const BACKOFF_STEPS = [2000, 3000, 5000, 8000, 15000]

function backoffMs() {
  return BACKOFF_STEPS[Math.min(pollBackoff.level, BACKOFF_STEPS.length - 1)]
}

async function pullSnapshot() {
  if (!roomNo.value) return null
  try {
    // 已经退避到较慢档位时，先探一下指纹有没有动
    if (pollBackoff.level > 0) {
      try {
        const fp = await repo.getRoomFingerprint(roomNo.value)
        if (fp && fp === pollBackoff.lastRev) {
          // 没动静，直接返回上次的数据（省掉全量请求）
          return lastSnap.value
        }
      } catch {
        // 探针失败不阻塞，继续拉全量
      }
    }

    const snap = await repo.roomSnapshot(roomNo.value)
    if (!snap) return null
    applySnapshot(snap)
    return snap
  } catch (e) {
    // 房间被房主解散时，成员端会一直拿到「房间不存在」。
    // 这时自动退出回大厅，并把原因讲清楚，别让用户盯着一个死房间。
    const msg = e?.message ?? String(e)
    console.error('[offline] 拉取房间失败', msg)
    if (msg.includes('房间不存在')) {
      stopSync?.stop?.()
      started.value = false
      roomNo.value = ''
      players.length = 0
      pot.value = 0
      showToast('房主已解散房间')
      router.replace('/lobby')
      return null
    }
    return null
  }
}

/** 把云端快照映射到本地响应式状态 */
/**
 * 新旧快照是否有实质差别。
 * 只比用户看得见的字段 —— 房间配置在开局前就定了，不会变。
 */
function snapChanged(a, b) {
  if (!a || !b) return true
  if (a.pot !== b.pot || a.roundNo !== b.roundNo) return true
  if (a.status !== b.status) return true
  if ((a.log?.length ?? 0) !== (b.log?.length ?? 0)) return true
  const sa = a.seats ?? []
  const sb = b.seats ?? []
  if (sa.length !== sb.length) return true
  for (let i = 0; i < sa.length; i++) {
    if (sa[i].seeds !== sb[i].seeds) return true
    if (sa[i].blind !== sb[i].blind) return true
    if ((sa[i].bet ?? 0) !== (sb[i].bet ?? 0)) return true
    if (sa[i].nickname !== sb[i].nickname) return true
  }
  return false
}

/**
 * 检测到「本局已结算」（roundStatus: settling → playing）时调用。
 *
 * 结算由房主的 offline_settle 触发，服务端在那一个事务里做了三件事：
 *   account_seed_transfer 转金瓜子 / accounts.total_games +1 /
 *   重写 history / 重置座位 / 清空流水。
 *
 * 只有发起请求的那台设备会顺带更新本地档案。其他成员（包括输家的手机）
 * 的 goldenSeeds / totalGames 还停在进入 App 时读过的那份，
 * 必须在这里自己重拉一次，否则「我的」页面的数字永远是旧的。
 */
async function onSettledAnywhere() {
  // 自己的档案：金瓜子 + 局数都在这里
  await refreshMyProfile()
  syncMyGoldenSeeds()
}

/**
 * 从全量快照本地算出指纹 —— 必须和
 * public.get_room_fingerprint 的 concat_ws 顺序逐一对应，
 * 否则探针会把「其实变了」判成「没变」，界面就冻结。
 *
 * 顺序：updatedAt | 成员数 | sum(seeds) | sum(bet) | round_status | pot
 */
function fingerprintOfSnap(snap) {
  const seats = snap?.seats ?? []
  const sumSeeds = seats.reduce((a, x) => a + (x.seeds ?? 0), 0)
  const sumBet = seats.reduce((a, x) => a + (x.bet ?? 0), 0)
  const t = snap?.updatedAt ? new Date(snap.updatedAt).getTime() : 0
  // 服务端用 to_char(..., 'YYYYMMDDHH24MISSMS')，这里用毫秒数即可
  const ver = Number.isFinite(t) ? String(t) : '0'
  return [
    ver,
    String(seats.length),
    String(sumSeeds),
    String(sumBet),
    snap?.roundStatus ?? 'playing',
    String(snap?.pot ?? 0),
  ].join('|')
}

function applySnapshot(snap) {
  // 有实质变化 → 立刻退出退避，回到 2 秒高频
  if (snapChanged(lastSnap.value, snap)) {
    pollBackoff.level = 0
  } else if (pollBackoff.level < BACKOFF_STEPS.length - 1) {
    pollBackoff.level += 1
  }
  lastSnap.value = snap

  pot.value = snap.pot ?? 0
  roundNo.value = snap.roundNo ?? 1
  initialSeeds.value = snap.initialSeeds ?? initialSeeds.value
  smallBlind.value = snap.smallBlind ?? smallBlind.value
  bigBlind.value = snap.bigBlind ?? bigBlind.value
  isHost.value = !!snap.isHost
  // 自动大小麦是房间级状态，必须从快照读——
  // 只存在房主本地的话，其他成员收款时不会触发轮转。
  autoBlind.value = !!snap.autoBlind

  players.length = 0
  for (const s of snap.seats ?? []) {
    players.push({
      uid: s.uid,
      nickname: s.nickname,
      avatar: s.avatar,
      seatNo: s.seatNo ?? null,
      seeds: s.seeds,
      goldSeeds: 0,
      blind: s.blind ?? null,
      isMe: !!s.isMe,
      isHost: !!s.isHost,
    })
  }

  // 流水以服务端为准：收款已在服务端清空，这里自然同步
  replaceBetLog(snap.log)

  // 本地算出本次快照的指纹，与服务端 get_room_fingerprint 同一格式。
  // 全量快照里字段齐全，所以这一步不额外发请求。
  // 必须每次全量拉取后都刷新 —— 否则基线一直是旧值，
  // 退避判断会失准（要么永远拉全量，要么永远跳过）。
  pollBackoff.lastRev = fingerprintOfSnap(snap)

  // 结算状态以服务端为准。move_pot 只会在
  // 「公共池已收干净 + 有人归零」时把它置成 settling，
  // 所以自动下注把某人扣到 0 不会误触发。
  //
  // bug 2 修复：结算完成后，非房主也要刷新自己的档案。
  // 金瓜子是服务端 offline_settle 调的 account_seed_transfer，
  // 只改发起方（房主）的本地数字，别的人的 goldenSeeds 还停在旧值，
  // 因为他们只在 App 启动时跑过一次 initFromCloud。
  // 这里盯 roundStatus 的 settling → playing 跳变：
  // 它是「本局已经结算完」的唯一权威信号，所有成员都能收到。
  const prevRoundStatus = roundStatus.value
  roundStatus.value = snap.roundStatus ?? 'playing'
  if (prevRoundStatus === 'settling' && roundStatus.value !== 'settling') {
    onSettledAnywhere()
  }
  refreshSettlementPreview()

  // 金瓜子：只填自己那一格。
  //
  // 以前这里按 uid 批量拉 users.golden_seeds，导致两个 bug：
  //   1. 结算写的是 accounts.golden_seeds（账号体系），两张表脱节，
  //      每次轮询都把自己的 1 覆盖回 0 —— 界面上的金豆就在 0/1 之间闪。
  //   2. RLS 下 users 只允许读自己，别人本来就恒为 0，白跑一次查询。
  //
  // 自己的金瓜子以 userStore 为准（它读 accounts 表），
  // 其他人的保持 0，不再为看不见的数据发请求。
  syncMyGoldenSeeds()
}

/** 把 userStore 里的我的金瓜子填进座位卡片 */
function syncMyGoldenSeeds() {
  const me = players.find((p) => p.isMe)
  if (me) me.goldSeeds = user.value?.goldenSeeds ?? 0
}

// ── 创建 / 加入 ──
async function startRoom() {
  const seeds = customSeeds.value ? Number(customSeeds.value) : initialSeeds.value
  if (!Number.isFinite(seeds) || seeds <= 0) return showToast('请输入有效的初始瓜子数')
  if (bigBlind.value <= smallBlind.value) return showToast('大麦必须大于小麦')

  busy.value = true
  try {
    const { roomNo: no } = await repo.createRoom({
      mode: 'offline',
      initialSeeds: seeds,
      smallBlind: smallBlind.value,
      bigBlind: bigBlind.value,
      me: { nickname: user.value.nickname, avatar: user.value.avatar },
    })
    roomNo.value = no
    started.value = true
    await pullSnapshot()
    startSync()
    genRoomQR()
  } catch (e) {
    showToast('创建房间失败：' + (e?.message ?? e))
  } finally {
    busy.value = false
  }
}

async function joinRoom() {
  const no = joinInput.value.trim()
  if (!/^\d{6}$/.test(no)) return showToast('请输入 6 位数字房间号')

  busy.value = true
  try {
    await repo.joinRoom(no, {
      nickname: user.value.nickname,
      avatar: user.value.avatar,
    })
    roomNo.value = no
    started.value = true
    await pullSnapshot()
    startSync()
    genRoomQR()
  } catch (e) {
    showToast('加入失败：' + (e?.message ?? e))
  } finally {
    busy.value = false
  }
}

function startSync() {
  stopSync?.stop?.()
  // 传入 backoffMs 让轮询按房间动静自动降频：
  // 一直在打牌 → 2s；一局结束大家聊会儿天 → 自动拉到 15s
  stopSync = createRoomSync(roomNo.value, applySnapshot, pullSnapshot, backoffMs)
}

/** 演示用：本地模式下加 bot（云端模式由真人扫码加入） */
function addBot() {
  showToast('让好友扫码或输入房间号加入')
}

// ── 出瓜子 / 收瓜子 ──
function flash(delta) {
  lastChange.value = { uid: user.value.uid, delta, at: Date.now() }
  setTimeout(() => {
    if (lastChange.value?.uid === user.value.uid) lastChange.value = null
  }, 320)
}

/**
 * 出瓜子：我的 → 公共池
 * @param {number|'all'} amount 数量；'all' 表示全出
 */
async function payOut(amount) {
  if (!roomNo.value) return
  const n = amount === 'all' ? mySeeds.value : Number(amount)
  if (!Number.isFinite(n) || n <= 0) return
  if (n > mySeeds.value) return showToast('我的瓜子不足')

  // 乐观更新，让 UI 立即响应
  const before = { pot: pot.value, seeds: mySeeds.value }
  pot.value += n
  if (me.value) me.value.seeds -= n
  pushBetLog(user.value.nickname, n, 'pay')
  flashPot()
  flashMySeeds()
  playFly('out')

  try {
    await repo.movePot(roomNo.value, n)
    // 不再主动补拉快照。
    //
    // 操作成功时服务端已经写好 pot/流水/座位，
    // 2 秒轮询一定会带上这次变更，再补一次等于
    // 为同一份数据发两次请求（CloudBase 按调用计费）。
    //
    // 乐观值已经在本地改好了，用户马上看到反馈；
    // 轮询差异比对负责把不一致的地方对回来。
  } catch (e) {
    // 失败回滚
    pot.value = before.pot
    if (me.value) me.value.seeds = before.seeds
    betLog.value = betLog.value.filter((b) => b.id !== betLog.value[0]?.id || b.delta !== n)
    showToast('操作失败：' + (e?.message ?? e))
  }
}

/**
 * 收瓜子：公共池 → 我的（点一次全收）
 * 收款后清空下注记录，重新开始计
 */
async function payIn() {
  if (!roomNo.value) return
  // 用服务端的 pot 作为权威值，不能用本地 pot.value——
  // 本地可能因为轮询/乐观更新还没追上，导致收款金额算错，
  // 极端情况下会把 pot 收成负数。
  let n = 0
  try {
    const snap = await repo.roomSnapshot(roomNo.value)
    n = snap?.pot ?? 0
  } catch {
    n = pot.value
  }
  if (n <= 0) return showToast('公共池是空的')

  const before = { pot: pot.value, seeds: mySeeds.value }
  pot.value = 0
  if (me.value) me.value.seeds += n
  // 服务端在 move_pot 里已清空流水，这里本地也清，保持观感一致
  pushBetLog(user.value.nickname, -n, 'get')
  flash(-n)
  flashPot()
  flashMySeeds()
  playFly('in')

  try {
    await repo.movePot(roomNo.value, -n)

    // 收款后自动轮转小麦大麦。
    // 条件只看 autoBlind（是否上锁），不看是否房主——收款的人不一定是房主。
    if (autoBlind.value) {
      try {
        await repo.rotateBlinds(roomNo.value)
      } catch (e) {
        console.warn('[blind] 轮转失败（不影响收款）', e?.message ?? e)
      }
    }
    // 不补拉：rotateBlinds 的结果由 2 秒轮询带上
  } catch (e) {
    pot.value = before.pot
    if (me.value) me.value.seeds = before.seeds
    showToast('操作失败：' + (e?.message ?? e))
  }
}

/** 打开出瓜子弹窗（第一步：选数量，不立即打出） */
function openQuick() {
  customAmount.value = ''
  quickOpen.value = true
}

/** 第一步：点数量档位 → 选中（不立即打出） */
function pickAmount(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return
  if (n > mySeeds.value) return showToast('我的瓜子不足')
  // 再次点击同一个档位 = 取消选中
  picked.value = picked.value === n ? 0 : n
}

/** 第二步：点「打出」→ 真正投入公共池 */
function firePicked() {
  const n = picked.value
  if (!n) return
  picked.value = 0
  quickOpen.value = false
  payOut(n)
}

/** 全部出完 */
function fireAll() {
  quickOpen.value = false
  picked.value = 0
  payOut('all')
}

/** 自定义数量确定 */
function fireCustom() {
  const n = Number(customAmount.value)
  if (!Number.isFinite(n) || n <= 0) return showToast('请输入有效数量')
  quickOpen.value = false
  picked.value = 0
  payOut(n)
}

/** 快捷档位里可用的金额（不能超过我的瓜子） */
const availableAmounts = computed(() => QUICK_AMOUNTS.filter((v) => v <= mySeeds.value))

/**
 * 设置某玩家的麦位（房主专属，走 RPC 落库）
 * 自动大小麦开启时，RPC 会同时扣 small_blind / big_blind 投入公共池。
 * @param {object} p 玩家
 * @param {'sb'|'bb'|null} val 目标位置
 */
async function setBlind(p, val) {
  if (!isHost.value) return showToast('只有房主可以设置大小麦')
  if (!roomNo.value) return

  // 算出设置后的完整 sb/bb 分配
  const next = players.map((x) => ({ ...x, blind: x.uid === p.uid ? val : x.blind }))
  const sbUid = next.find((x) => x.blind === 'sb')?.uid ?? null
  const bbUid = next.find((x) => x.blind === 'bb')?.uid ?? null

  try {
    await repo.setBlinds(roomNo.value, sbUid, bbUid)
    p.blind = val
    // 本地已更新（房主即时反馈），轮询负责与服务端对齐
  } catch (e) {
    showToast('设置失败：' + (e?.message ?? e))
  }
}

/** 点击麦位按钮：无 → 小麦 → 大麦 → 无 */
function cycleBlind(p) {
  if (!isHost.value) return showToast('只有房主可以设置大小麦')
  const next = p.blind === null ? 'sb' : p.blind === 'sb' ? 'bb' : null
  setBlind(p, next)
}

/**
 * 切换麦位模式。
 *
 *   → 自动模式（上锁）：立刻按当前小麦/大麦下注，之后收款自动轮转
 *   → 手动模式（开锁）：退还所有自动下注的筹码并清空麦位，
 *     此时房主可自由拖拽排序、手动指定谁小麦谁大麦
 *
 * 负数防御：退还前先算出应退总额，若超过当前 pot 就不退全部，
 * 只退 pot 能覆盖的部分，绝不把 pot 写成负数。
 */
async function toggleAutoBlind() {
  if (!isHost.value) return showToast('只有房主可以设置大小麦')
  if (!roomNo.value) return

  const next = !autoBlind.value
  try {
    // 先写库。这是房间级开关，所有成员都会从快照读到同一状态——
    // 只改本地 ref 的话，其他人收款时仍认为没开自动下注。
    await repo.setAutoBlind(roomNo.value, next)
    autoBlind.value = next

    if (!next) {
      // 切回手动：退还所有自动下注的筹码并清空麦位
      await repo.resetBlinds(roomNo.value)
      showToast('已切到手动设置：可拖拽排序、手动设大小麦')
    } else {
      // 进入自动模式：若当前已有人设了麦位，立即补一次自动下注
      const has = players.some((p) => p.blind === 'sb' || p.blind === 'bb')
      if (has) {
        await repo.rotateBlinds(roomNo.value)
        showToast('自动下注已开启')
      } else {
        showToast('自动下注已开启，先手动指定位次或点收款开始')
      }
    }
    // 本地 autoBlind 已置位，轮询同步
  } catch (e) {
    showToast('操作失败：' + (e?.message ?? e))
  }
}

// ── 房主拖拽排序 ──
// 用 Pointer Events：一套 API 覆盖鼠标 / 手指 / 触控笔。
// HTML5 drag&drop（dragstart/drop）在 iOS Safari 和微信 WebView
// 上不触发，所以不用它。
// （onPointerDown / onPointerMove / onPointerUp / tapSwap 见上方）

// ── 结算 ──
/** { zeroed, tieUids, transfers } */
const settlement = ref(null)
const tiePicking = ref(false)
/**
 * 服务端裁决的局状态：'playing' | 'settling'
 * 由 move_pot 在「公共池收干净且有人归零」时置 settling，
 * offline_settle 结算后置回 playing。
 * 前端不再自己判断——以前本地判断会导致：
 *   · 自动下注把某人扣到 0 就误触发结算（牌还没打完）
 *   · 每次轮询重算，金瓜子转重复
 *   · 房主重开后其他人的 settling 卡住，弹窗按钮点不动
 */
const roundStatus = ref('playing')
const settling = computed(() => roundStatus.value === 'settling')

/** 本地算一份转账方案供房主预览（真正的转账由 offline_settle 幂等执行） */
function refreshSettlementPreview() {
  if (roundStatus.value !== 'settling') {
    settlement.value = null
    tiePicking.value = false
    return
  }
  const st = buildSettlement(players)
  settlement.value = st
  tiePicking.value = st.tieUids.length > 0
}

/** 房主点选并列者中的赢家 */
function pickTieWinner(uid) {
  if (!settlement.value || !tiePicking.value) return
  const st = settlement.value
  settlement.value = { ...st, transfers: transfersAfterTiePick(st.zeroed, uid) }
  tiePicking.value = false
}

async function settleAndRestart() {
  if (busy.value) return
  busy.value = true
  try {
    // 金瓜子转账由 offline_settle 在服务端完成（account_seed_transfer），
    // 前端不要再调 recordSeed —— 那会写旧 users 账本，构成双写。
    // 我把 settlement.value?.transfers 传给服务端，是为了让它拿到
    // 「并列时房主点选的赢家」这一信息；其它情况服务端自己重算。
    await repo.offlineSettle(roomNo.value, settlement.value?.transfers ?? [], true)

    // 2.1 笔误：函数名是 refreshSettlementPreview。
    // refreshSettlement 从不存在，调用即 ReferenceError → catch 弹「结算失败」，
    // 且下面两行被跳过，弹窗不消、用户反复点。
    refreshSettlementPreview()

    // 这里必须立刻拉一次：结算后要马上关掉结算弹窗、
    // 重置座位筹码、推进局数 —— 等轮询会让弹窗挂 2 秒。
    await pullSnapshot()

    // 2.9：服务端已把本局在座成员的 accounts.total_games +1，
    // 这里重读一次把最新金瓜子/局数带回来（Lobby 的「已玩 N 局」要用）。
    await refreshMyProfile()
    syncMyGoldenSeeds()
  } catch (e) {
    showToast('结算失败：' + (e?.message ?? e))
  } finally {
    busy.value = false
  }
}

async function settleAndExit() {
  if (busy.value) return
  busy.value = true
  try {
    // 2.2：删掉 payGoldenSeeds —— offline_settle 已在服务端记账。
    // 不补拉快照：这一步马上退房，拉了也没人看。
    await repo.offlineSettle(roomNo.value, settlement.value?.transfers ?? [], true)

    // 2.9：局数由 offline_settle 在服务端给 accounts.total_games +1。
    // 这里不再本地 update —— readonly(ref) 会写失败并刷 Vue 警告。
    await refreshMyProfile()
    router.push('/lobby')
  } catch (e) {
    showToast('结算失败：' + (e?.message ?? e))
  } finally {
    busy.value = false
  }
}

/**
 * 离开房间。
 *   房主：销毁整个房间，避免留下没人用的空房间占数据
 *   成员：只删自己的座位
 */
async function leaveRoom() {
  if (!roomNo.value) return
  // 房主解散影响所有人，必须先确认
  leaveConfirm.value = isHost.value ? true : false
  if (!leaveConfirm.value) await doLeave()
}

async function doLeave() {
  if (!roomNo.value) return
  leaveConfirm.value = false
  busy.value = true
  try {
    if (isHost.value) {
      await repo.deleteRoom(roomNo.value)
      showToast('房间已解散')
    } else {
      await repo.leaveSeat(roomNo.value)
      showToast('已离开房间')
    }
  } catch (e) {
    // 房间删除失败不阻塞退出流程——本地先脱离，
    // 否则用户会卡在一个已经不存在的房间里。
    console.warn('[leave] 服务端清理失败', e?.message ?? e)
    showToast('已退出（房间清理失败：' + (e?.message ?? e) + '）')
  } finally {
    // 清理本地状态与轮询，然后直接回大厅。
    // 用 finally 保证无论服务端成功与否都会脱离房间。
    stopSync?.stop?.()
    started.value = false
    roomNo.value = ''
    players.length = 0
    pot.value = 0
    busy.value = false
    router.replace('/lobby')
  }
}

onMounted(() => {
  // 扫码落地：自动入座，并把房间号从 URL 清掉避免刷新重复加入
  const no = String(route.query.join ?? '').trim()
  if (/^\d{6}$/.test(no)) {
    joinInput.value = no
    router.replace({ path: '/room/offline' })
    joinRoom()
  }
})

// 离开本页时清理状态。afterEach 返回注销函数，卸载时调用。
// 不注销的话每次进出本页都会新注册一个，越积越多，
// 且旧回调持有已卸载实例的闭包，会和实例互相覆盖状态
// ——症状是「点了退出但页面像没跳转」。
const removeAfterEach = router.afterEach((to) => {
  if (to.name !== 'offline-room') {
    stopSync?.stop?.()
    started.value = false
    players.length = 0
    pot.value = 0
    settling.value = false
    settlement.value = null
  }
})

onUnmounted(() => {
  stopSync?.stop?.()
  removeAfterEach?.()
})
</script>

<template>
  <div class="page offline" v-if="user">
    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>

    <template v-if="!started">
      <header class="head">
        <button class="back-btn" @click="router.back()">‹</button>
        <h1>线下计分</h1>
        <div class="head-space"></div>
      </header>

      <div class="tabs">
        <button :class="{ on: CREATING }" @click="CREATING = true">创建房间</button>
        <button :class="{ on: !CREATING }" @click="switchToJoin">加入房间</button>
      </div>

      <div class="card config">
        <template v-if="CREATING">
          <label class="field-label">初始瓜子数量</label>
          <div class="chip-row">
            <button
              v-for="v in [3000, 5000]"
              :key="v"
              :class="{ on: initialSeeds === v && !customSeeds }"
              @click="initialSeeds = v; customSeeds = ''"
            >
              {{ v }}
            </button>
          </div>
          <input v-model="customSeeds" class="input" type="number" placeholder="自定义初始瓜子" />

          <label class="field-label">麦位设置</label>
          <div class="blind-row">
            <div class="blind-item">
              <span>小麦</span>
              <input v-model.number="smallBlind" class="input" type="number" />
            </div>
            <div class="blind-item">
              <span>大麦</span>
              <input v-model.number="bigBlind" class="input" type="number" />
            </div>
          </div>

          <button class="btn" :disabled="busy" @click="startRoom">
            {{ busy ? '创建中…' : '创建并进入' }}
          </button>
        </template>

        <template v-else>
          <label class="field-label">输入 6 位房间号</label>
          <input
            v-model="joinInput"
            class="input input--roomno"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="000000"
          />
          <button class="btn" :disabled="busy" @click="joinRoom">
            {{ busy ? '加入中…' : '加入房间' }}
          </button>

          <!-- 存活房间列表：除了扫码和输房号，也可以直接点进去 -->
          <div class="room-list-head">
            <span class="field-label">正在进行的房间</span>
            <button class="room-list-refresh" :disabled="roomsLoading" @click="loadRooms">
              {{ roomsLoading ? '刷新中' : '刷新' }}
            </button>
          </div>

          <p v-if="roomsLoading" class="room-list-empty">正在查找房间…</p>
          <p v-else-if="roomsError" class="room-list-empty err">{{ roomsError }}</p>
          <p v-else-if="!liveRooms.length" class="room-list-empty">
            暂时没有可加入的房间，让房主先创建一个吧
          </p>

          <div v-else class="room-list">
            <button
              v-for="r in liveRooms"
              :key="r.roomNo"
              class="room-item"
              :class="{ mine: r.isMine, joined: r.iAmIn }"
              :disabled="busy"
              @click="joinFromList(r)"
            >
              <div class="room-item-avatar">
                <img :src="roomAvatarURI(r)" alt="" />
              </div>
              <div class="room-item-info">
                <div class="room-item-top">
                  <span class="room-item-no">{{ r.roomNo }}</span>
                  <span v-if="r.isMine" class="room-item-tag mine">我的</span>
                  <span v-else-if="r.iAmIn" class="room-item-tag in">已加入</span>
                </div>
                <div class="room-item-sub">
                  {{ r.hostName || '房主' }} · {{ r.playerCount }}/{{ r.maxSeats }} 人 ·
                  小麦 {{ r.smallBlind }} / 大麦 {{ r.bigBlind }}
                </div>
              </div>
              <span class="room-item-go">›</span>
            </button>
          </div>
        </template>
      </div>
    </template>

    <template v-else>
      <!-- 顶部：退出 + 房间信息 + 锁 + 二维码 -->
      <header class="room-head card">
        <div class="row">
          <button class="leave-btn" @click="leaveRoom" aria-label="离开房间">✕</button>
          <div class="room-meta">
            <div class="room-no">
              房间 {{ roomNo }}
              <span v-if="isHost" class="host-tag">房主</span>
            </div>
            <div class="room-sub">第 {{ roundNo }} 局 · 小麦 {{ smallBlind }} / 大麦 {{ bigBlind }}</div>
          </div>

          <!-- 麦位锁：🔒 自动下注（不可排序）/ 🔓 手动设置（可排序设麦） -->
          <button
            v-if="isHost"
            class="lock-btn"
            :class="{ on: autoBlind }"
            :title="autoBlind ? '自动下注中 · 点击切到手动设置' : '手动设置 · 点击开启自动下注'"
            @click="toggleAutoBlind"
          >
            {{ autoBlind ? '🔒' : '🔓' }}
          </button>

          <!-- 排序按钮：手动模式下才可用（拖拽在手机上不可靠，用点选交换） -->
          <button
            v-if="isHost && !autoBlind && players.length > 1"
            class="sort-btn"
            :class="{ on: sorting }"
            @click="sorting ? exitSort() : enterSort()"
          >
            {{ sorting ? '完成' : '排序' }}
          </button>

          <button class="qr-entry" @click="qrExpanded = true" aria-label="房间二维码">
            <img v-if="qrURI" :src="qrURI" width="44" height="44" alt="房间二维码" />
            <span v-else class="qr-entry-no">{{ roomNo }}</span>
          </button>
        </div>

        <!-- 确认离开弹窗（房主会解散房间，需要二次确认） -->
        <transition name="fade">
          <div v-if="leaveConfirm" class="mask" @click.self="leaveConfirm = false">
            <div class="dialog">
              <h3 class="dlg-title">{{ isHost ? '解散房间？' : '离开房间？' }}</h3>
              <p class="text-sm text-light" style="margin: 0 0 14px">
                <template v-if="isHost">
                  解散后所有人都会退出，本局计分将结束且无法恢复。
                </template>
                <template v-else>离开后你的座位会被移除，公共池不受影响。</template>
              </p>
              <div class="col">
                <button class="btn" @click="doLeave">确认离开</button>
                <button class="btn btn--ghost" @click="leaveConfirm = false">取消</button>
              </div>
            </div>
          </div>
        </transition>

        <!-- 公共池：居中、醒目、带最近下注记录 -->
        <div class="pot-hero">
          <div class="pot-hero-label">公共池</div>
          <div class="pot-hero-value" :class="{ bump: potBumping }">
            <img class="pot-hero-icon" :src="seedIconURI" alt="" />
            <span class="pot-hero-num">{{ pot }}</span>
          </div>
          <transition-group name="betlog" tag="ul" class="pot-log" v-if="betLog.length">
            <li v-for="b in visibleLog" :key="b.id" class="pot-log-item">
              <span class="pot-log-name">
                {{ b.name }}
                <em v-if="b.kind === 'sb'" class="pot-log-tag sb">小麦</em>
                <em v-else-if="b.kind === 'bb'" class="pot-log-tag bb">大麦</em>
              </span>
              <span class="pot-log-amt" :class="b.delta > 0 ? 'up' : 'down'">
                {{ b.delta > 0 ? '+' + b.delta : b.delta }}
              </span>
            </li>
          </transition-group>
          <button v-if="betLog.length > LOG_LIMIT" class="pot-log-toggle" @click="toggleLog">
            {{ logExpanded ? '收起 ▲' : '查看全部 ' + betLog.length + ' 条 ▼' }}
          </button>
          <p v-else class="pot-log-empty">还没有下注</p>
        </div>
      </header>

      <!-- 二维码弹层：大图 + 房间号 -->
      <transition name="fade">
        <div v-if="qrExpanded" class="mask" @click.self="qrExpanded = false">
          <div class="dialog qr-dialog">
            <img v-if="qrURI" :src="qrURI" width="240" height="240" alt="房间二维码" />
            <div v-else class="qr-no-mini qr-no-mini--big">{{ roomNo }}</div>
            <div class="qr-roomno-row">
              <span class="qr-roomno-label">房间号</span>
              <span class="qr-roomno-val">{{ roomNo }}</span>
              <button class="btn btn--sm" @click="copyRoomNo">复制</button>
            </div>
            <p class="text-sm text-light" style="margin: 0">好友扫码直接进房间</p>
            <button class="btn btn--ghost btn--sm" @click="qrExpanded = false">关闭</button>
          </div>
        </div>
      </transition>

      <div class="players-grid" :class="{ sorting }">
        <p v-if="sorting" class="sort-hint">依次点两位玩家即可交换座位，点「完成」结束</p>
        <div
          v-for="p in sortedPlayers"
          :key="p.uid"
          class="pcard"
          :class="{
            me: p.isMe,
            out: p.seeds <= 0,
            'pcard--dragging': sorting && drag.uid === p.uid && drag.active,
            'pcard--over': sorting && drag.target === p.uid,
            'pcard--pick': sorting && swapFrom === p.uid,
          }"
          :data-uid="p.uid"
          @pointerdown="onPointerDown($event, p.uid)"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="resetDrag"
        >
          <div class="pcard-avatar">
            <img :src="avatarURI(p.avatar)" :alt="p.nickname" />
            <img v-if="p.isHost" class="pcard-crown" :src="hostIconURI" alt="房主" />
            <span v-if="p.isMe" class="pcard-me">我</span>
          </div>

          <div class="pcard-name">{{ p.nickname }}</div>

          <div class="pcard-gold">
            <img class="pcard-gold-icon" :src="goldURI" alt="" />
            <span>{{ p.goldSeeds ?? 0 }}</span>
          </div>

          <div class="pcard-seeds">
            <img class="pcard-seed-icon" :src="seedIconURI" alt="" />
            <span>{{ p.seeds }}</span>
          </div>

          <button
            class="pcard-blind"
            :class="p.blind"
            :disabled="!isHost || autoBlind"
            @click.stop="cycleBlind(p)"
          >
            {{ p.blind === 'sb' ? '小麦' : p.blind === 'bb' ? '大麦' : '设麦' }}
          </button>        </div>

        <button v-if="players.length < MAX_SEATS" class="pcard pcard--add" @click="addBot">
          <span class="pcard-add-icon">+</span>
          <span class="pcard-add-text">邀请好友</span>
        </button>
      </div>

      <p v-if="players.length === 1" class="empty text-light">等待其他玩家扫码加入…</p>

      <!-- 底部操作栏：收圆钮 | 我的瓜子 | 出圆钮 -->
      <div class="action-bar">
        <button
          class="act-dot act-in"
          :class="{ 'act-dot--fly': flyDir === 'in' }"
          :disabled="pot <= 0 || !!picked"
          :title="'收瓜子 全收 ' + pot"
          @click="payIn"
        >
          <img class="act-dot-icon" :src="seedIconURI" alt="收瓜子" />
          <span class="act-dot-text">收</span>
        </button>

        <div class="act-mid">
          <template v-if="!picked">
            <div class="my-seeds" :title="'我有 ' + mySeeds + ' 瓜子'">
              <span class="my-seeds-num" :class="{ bump: mySeedsBump }">{{ mySeeds }}</span>
              <img class="my-seeds-icon" :src="seedIconURI" alt="" />
            </div>
            <button
              class="act-dot act-out"
              :disabled="mySeeds <= 0"
              title="出瓜子"
              @click="openQuick"
            >
              <img class="act-dot-icon" :src="seedIconURI" alt="出瓜子" />
              <span class="act-dot-text">出</span>
            </button>
          </template>

          <div v-else class="picked-bar">
            <span class="picked-num">× {{ picked }}</span>
            <button class="picked-fire" @click="firePicked">打出</button>
            <button class="picked-cancel" @click="picked = 0">取消</button>
          </div>
        </div>
      </div>

      <!-- 飞行动效的瓜子 -->
      <transition name="fly">
        <img v-if="flying" class="fly-chip" :src="seedIconURI" :class="'fly-' + flyDir" alt="" />
      </transition>

      <div v-if="quickOpen" class="mask" @click.self="quickOpen = false">
        <div class="dialog">
          <h3 class="dlg-title">出瓜子</h3>
          <p class="text-sm text-light" style="margin: 0 0 12px">
            从我的瓜子投入公共池（我有 {{ mySeeds }}）
          </p>
          <div class="quick-grid">
            <button
              v-for="v in availableAmounts"
              :key="v"
              class="btn btn--sm"
              :class="{ on: picked === v }"
              @click="pickAmount(v)"
            >
              {{ v }}
            </button>
          </div>
          <div class="row" style="margin-top: 12px">
            <input v-model="customAmount" class="input grow" type="number" placeholder="自定义数量" />
            <button class="btn btn--sm" @click="fireCustom">确定</button>
          </div>
          <div class="row" style="margin-top: 8px">
            <button class="btn btn--ghost btn--sm grow" @click="fireAll">全部出完</button>
            <button v-if="picked" class="btn btn--sm" @click="firePicked">
              打出 ×{{ picked }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="settling && tiePicking" class="mask">
        <div class="dialog settle-dlg">
          <img :src="goldURI" class="settle-gold" alt="" />
          <h3 class="dlg-title">瓜子数并列</h3>
          <p class="text-sm text-light">
            {{ settlement.zeroed.length }} 人瓜子归零，请房主选择金瓜子给谁
          </p>
          <div class="tie-list">
            <button
              v-for="uid in settlement.tieUids"
              :key="uid"
              class="tie-item"
              @click="pickTieWinner(uid)"
            >
              <div class="avatar avatar--sm">
                <img :src="avatarURI(players.find(p => p.uid === uid)?.avatar ?? 1)" alt="" />
              </div>
              <span class="tie-name">{{ players.find(p => p.uid === uid)?.nickname }}</span>
            </button>
          </div>
        </div>
      </div>

      <div v-else-if="settling" class="mask">
        <div class="dialog settle-dlg">
          <img :src="goldURI" class="settle-gold" alt="" />
          <h3 class="dlg-title">本局结束</h3>
          <p class="text-sm">{{ settlement?.zeroed?.length ?? 0 }} 人瓜子归零</p>
          <p class="text-sm text-light" v-if="!isHost">等待房主结算…</p>
          <div class="col" style="margin-top: 16px">
            <button class="btn" :disabled="busy || !isHost" @click="settleAndRestart">结算并重开</button>
            <button class="btn btn--ghost" :disabled="busy || !isHost" @click="settleAndExit">结算并退出</button>
            <!-- 非房主至少能离开，不能把人锁在弹窗里 -->
            <button class="btn btn--ghost btn--sm" @click="doLeave">离开房间</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
<style scoped>
/* ── 存活房间列表 ── */
.room-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
}

.room-list-refresh {
  border: none;
  background: transparent;
  color: var(--c-primary-dark);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 4px 6px;
}

.room-list-refresh:disabled {
  color: var(--c-text-light);
}

.room-list-empty {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--c-text-light);
  text-align: center;
  padding: 14px 0;
}

.room-list-empty.err {
  color: var(--c-danger);
}

.room-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.room-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 2px solid var(--c-border);
  border-radius: 14px;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.room-item:active {
  background: #fffdf7;
}

.room-item.mine {
  border-color: var(--c-primary);
  background: #fffdf7;
}

.room-item.joined {
  border-color: #37b24d;
  background: #f4fbf6;
}

.room-item-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  border: 2px solid var(--c-border);
}

.room-item-avatar img {
  width: 100%;
  height: 100%;
  display: block;
}

.room-item-info {
  flex: 1;
  min-width: 0;
}

.room-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.room-item-no {
  font-size: 15px;
  font-weight: 900;
  letter-spacing: 1px;
  color: var(--c-text);
}

.room-item-tag {
  font-size: 9px;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 5px;
  color: #fff;
}

.room-item-tag.mine { background: var(--c-primary-dark); }
.room-item-tag.in { background: #37b24d; }

.room-item-sub {
  font-size: 11px;
  color: var(--c-text-light);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-item-go {
  font-size: 18px;
  color: var(--c-text-light);
  flex-shrink: 0;
}

.offline {
  padding: calc(10px + var(--sat)) 12px calc(12px + var(--sab));
  gap: 10px;
}

.head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.head h1 {
  font-size: 19px;
  margin: 0;
  flex: 1;
}

.head-space {
  width: 36px;
}

.back-btn {
  width: 36px;
  height: 36px;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: #fff;
  font-size: 22px;
  line-height: 1;
  color: var(--c-text-light);
  cursor: pointer;
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
  font-weight: 700;
  color: var(--c-text-light);
  cursor: pointer;
}

.tabs button.on {
  background: var(--c-primary);
  color: #fff;
}

.config {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  height: 44px;
  border: 2px solid var(--c-border);
  border-radius: 12px;
  background: #fff;
  font-size: 15px;
  font-weight: 700;
  color: var(--c-text-light);
  cursor: pointer;
}

.chip-row button.on {
  border-color: var(--c-primary);
  background: #fff3e0;
  color: var(--c-primary-dark);
}

.blind-row {
  display: flex;
  gap: 10px;
}

.blind-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.blind-item span {
  font-size: 13px;
  color: var(--c-text-light);
  white-space: nowrap;
}

.input--roomno {
  text-align: center;
  font-size: 28px;
  letter-spacing: 8px;
  font-weight: 800;
}

/* 房间信息 + 公共池 */
.room-head {
  padding: 12px 14px;
}

.room-no {
  font-size: 16px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 6px;
}

.room-sub {
  font-size: 11px;
  color: var(--c-text-light);
  margin-top: 2px;
}

.host-tag {
  font-size: 10px;
  background: var(--c-secondary);
  color: #fff;
  padding: 1px 6px;
  border-radius: 6px;
}

/* 退出按钮 */
.leave-btn {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: var(--c-bg);
  color: var(--c-text-light);
  font-size: 14px;
  font-weight: 900;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
}

.leave-btn:active {
  background: #ffe3e3;
  border-color: #ffa8a8;
  color: #c92a2a;
}

.room-meta {
  min-width: 0;
  flex: 1;
}

/* ========== 自动大小麦锁（仅 icon） ========== */
.lock-btn {
  width: 32px;
  height: 32px;
  border: 2px solid var(--c-border);
  border-radius: 50%;
  background: var(--c-bg);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  padding: 0;
  transition: background 0.2s, border-color 0.2s;
}

.lock-btn.on {
  border-color: #37b24d;
  background: #ebfbee;
}

/* 排序按钮（手机上替代拖拽） */
.sort-btn {
  height: 28px;
  padding: 0 12px;
  border: 2px solid #ffd591;
  border-radius: 999px;
  background: #fff7e6;
  color: #b76e00;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  flex-shrink: 0;
}

.sort-btn.on {
  border-color: #37b24d;
  background: #ebfbee;
  color: #2b8a3e;
}

/* 排序模式下的提示条 */
.sort-hint {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: #b76e00;
  background: #fff7e6;
  border: 1px dashed #ffd591;
  border-radius: 10px;
  padding: 6px;
}

/* 排序模式：可拖动的手感 */
.sorting .pcard {
  cursor: grab;
  touch-action: none;   /* 关掉浏览器手势，交给 pointermove 处理 */
}

/* 正被拖的卡片：抬起 + 半透明 */
.pcard--dragging {
  opacity: 0.55;
  transform: scale(1.06);
  cursor: grabbing;
  z-index: 5;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
}

/* 拖拽落点：绿色高亮 */
.pcard--over {
  border-color: #37b24d;
  box-shadow: 0 0 0 3px rgba(55, 178, 77, 0.28);
}

/* 点击选中的卡片 */
.pcard--pick {
  border-color: #f6a623;
  box-shadow: 0 0 0 3px rgba(246, 166, 35, 0.3);
}

/* ========== 顶部：房间信息 + 二维码入口 ========== */
.qr-entry {
  width: 48px;
  height: 48px;
  border: 2px solid var(--c-border);
  border-radius: 12px;
  background: #fff;
  padding: 0;
  cursor: pointer;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  line-height: 0;
}

.qr-entry:active {
  transform: scale(0.94);
}

.qr-entry img {
  display: block;
}

.qr-entry-no {
  font-size: 13px;
  font-weight: 800;
  color: var(--c-primary-dark);
  line-height: 1.2;
}

/* ========== 公共池：居中醒目 + 下注流水 ========== */
.pot-hero {
  margin-top: 12px;
  padding: 14px 12px 12px;
  border-radius: 18px;
  background: linear-gradient(180deg, #fff7e6 0%, #ffefc9 100%);
  border: 2px solid #ffd591;
  text-align: center;
  position: relative;
  overflow: hidden;
}

/* 池子高光扫过 */
.pot-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 30%, rgba(255, 255, 255, 0.55) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: sheen 3.6s ease-in-out infinite;
  pointer-events: none;
}

@keyframes sheen {
  0%, 70% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.pot-hero-label {
  font-size: 12px;
  font-weight: 700;
  color: #b76e00;
  letter-spacing: 2px;
}

.pot-hero-value {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}

.pot-hero-icon {
  width: 26px;
  height: 26px;
}

.pot-hero-num {
  font-size: 40px;
  font-weight: 900;
  color: #c2410c;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 0 rgba(255, 255, 255, 0.8);
  transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* 数字变动时弹一下 */
.pot-hero-value.bump .pot-hero-num {
  transform: scale(1.28);
  color: #ea580c;
}

.pot-log {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 20px;
}

.pot-log-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 3px 10px;
  background: rgba(255, 255, 255, 0.72);
  border-radius: 8px;
}

.pot-log-name {
  color: var(--c-text);
  font-weight: 600;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pot-log-amt {
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.pot-log-amt.up {
  color: #16a34a;
}

.pot-log-amt.down {
  color: #ea580c;
}

/* 流水里的小麦/大麦小标签 */
.pot-log-tag {
  font-style: normal;
  font-size: 9px;
  font-weight: 800;
  padding: 0 4px;
  margin-left: 3px;
  border-radius: 4px;
  vertical-align: middle;
}

.pot-log-tag.sb {
  background: #e3f2fd;
  color: #1565c0;
}

.pot-log-tag.bb {
  background: #fbe9e7;
  color: #d84315;
}

.pot-log-empty {
  margin: 8px 0 0;
  font-size: 11px;
  color: #b08968;
}

/* 展开/收起全部流水 */
.pot-log-toggle {
  margin-top: 6px;
  border: none;
  background: transparent;
  color: #b76e00;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
}

.pot-log-toggle:active {
  background: rgba(255, 213, 145, 0.4);
}

/* 展开后流水区可滚动，避免把玩家卡片挤出屏幕 */
.pot-log {
  max-height: 168px;
  overflow-y: auto;
}

/* 流水条目进出动画 */
.betlog-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.betlog-enter-active {
  transition: all 0.28s ease;
}
.betlog-leave-to {
  opacity: 0;
}
.betlog-leave-active {
  transition: opacity 0.3s ease;
  position: absolute;
}
.betlog-move {
  transition: transform 0.28s ease;
}

/* ========== 底部操作栏：收 | 我的瓜子 | 出 ========== */
.action-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: auto;
  padding: 10px 4px 0;
  position: sticky;
  bottom: 0;
  z-index: 20;
}

/* 圆形按钮 */
.act-dot {
  width: 62px;
  height: 62px;
  flex-shrink: 0;
  border: none;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  cursor: pointer;
  color: #fff;
  box-shadow: 0 3px 0 rgba(0, 0, 0, 0.16);
  transition: transform 0.1s, box-shadow 0.1s, filter 0.2s;
  padding: 0;
}

.act-dot:active {
  transform: translateY(3px);
  box-shadow: none;
}

.act-dot:disabled {
  filter: grayscale(0.75);
  opacity: 0.5;
  cursor: default;
}

.act-in {
  background: linear-gradient(180deg, #ffd666 0%, #f6a623 100%);
}

.act-out {
  background: linear-gradient(180deg, #7bd88f 0%, #37b24d 100%);
}

.act-dot--fly {
  animation: pulseDot 0.5s ease;
}

@keyframes pulseDot {
  0%, 100% { transform: scale(1); }
  45% { transform: scale(1.12); }
}

.act-dot-icon {
  width: 20px;
  height: 20px;
}

.act-dot-text {
  font-size: 12px;
  font-weight: 900;
  line-height: 1;
}

/* 中间：我的瓜子数 */
.act-mid {
  flex: 0 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.my-seeds {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.9);
  border: 2px solid var(--c-border);
  border-radius: 999px;
}

.my-seeds-num {
  font-size: 20px;
  font-weight: 900;
  color: var(--c-primary-dark);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.my-seeds-num.bump {
  transform: scale(1.3);
}

.my-seeds-icon {
  width: 17px;
  height: 17px;
}

/* 选中数量后的确认条 */
.picked-bar {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  background: #fff;
  border: 2px dashed #37b24d;
  border-radius: 999px;
}

.picked-num {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 900;
  color: #2f9e44;
  font-variant-numeric: tabular-nums;
}

.picked-fire,
.picked-cancel {
  border: none;
  border-radius: 999px;
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 900;
  cursor: pointer;
  white-space: nowrap;
}

.picked-fire {
  background: linear-gradient(180deg, #7bd88f 0%, #37b24d 100%);
  color: #fff;
  box-shadow: 0 3px 0 rgba(0, 0, 0, 0.16);
}

.picked-fire:active {
  transform: translateY(2px);
  box-shadow: none;
}

.picked-cancel {
  background: #f1f3f5;
  color: var(--c-text-light);
}


.picked-fire {
  background: linear-gradient(180deg, #7bd88f 0%, #37b24d 100%);
  color: #fff;
  box-shadow: 0 3px 0 rgba(0, 0, 0, 0.16);
}

.picked-fire:active {
  transform: translateY(2px);
  box-shadow: none;
}

.picked-cancel {
  background: #f1f3f5;
  color: var(--c-text-light);
}

/* 飞行的小瓜子 */
.fly-chip {
  position: fixed;
  left: 50%;
  width: 26px;
  height: 26px;
  z-index: 90;
  pointer-events: none;
}

.fly-out {
  bottom: 96px;
  animation: flyToPot 0.5s cubic-bezier(0.4, 0, 0.6, 1) forwards;
}

.fly-in {
  top: 30%;
  animation: flyToMe 0.5s cubic-bezier(0.4, 0, 0.6, 1) forwards;
}

@keyframes flyToPot {
  0% { transform: translate(-50%, 0) scale(1.4); opacity: 1; }
  100% { transform: translate(-50%, -46vh) scale(0.4); opacity: 0; }
}

@keyframes flyToMe {
  0% { transform: translate(-50%, 0) scale(0.5); opacity: 1; }
  100% { transform: translate(-50%, 34vh) scale(1.3); opacity: 0; }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 我的卡片 */





.me-seeds :deep(.seed-num b) {
  font-size: 18px;
  color: var(--c-primary-dark);
}

/* 收瓜子 / 出瓜子 */









/* 玩家列表 —— 圆形卡片 */
.players-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.pcard {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 12px 8px 10px;
  border: 2px solid var(--c-border);
  border-radius: 22px;
  background: #fff;
  min-width: 0;
}

.pcard.me {
  border-color: var(--c-primary);
  background: #fffdf7;
}

.pcard.out {
  opacity: 0.55;
}

/* 头像：中间偏上 */
.pcard-avatar {
  position: relative;
  width: 62px;
  height: 62px;
  flex-shrink: 0;
}

.pcard-avatar > img:first-child {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 3px solid var(--c-border);
  display: block;
  background: #fff;
}

/* 房主图标：头像右上角 */
.pcard-crown {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
}

/* 「我」角标 */
.pcard-me {
  position: absolute;
  bottom: -2px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 9px;
  font-weight: 800;
  color: #fff;
  background: var(--c-primary-dark);
  border-radius: 6px;
  padding: 1px 5px;
  line-height: 1.3;
}

/* 昵称 */
.pcard-name {
  font-size: 13px;
  font-weight: 800;
  color: var(--c-text);
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 金瓜子 */
.pcard-gold {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  font-weight: 700;
  color: #b8860b;
}

.pcard-gold-icon {
  width: 14px;
  height: 14px;
}

/* 瓜子数 */
.pcard-seeds {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 14px;
  font-weight: 800;
  color: var(--c-primary-dark);
}

.pcard-seed-icon {
  width: 16px;
  height: 16px;
}

/* 小麦 / 大麦 */
.pcard-blind {
  margin-top: 2px;
  font-size: 10px;
  font-weight: 700;
  border: 1px solid var(--c-border);
  background: var(--c-bg);
  color: var(--c-text-light);
  padding: 3px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.pcard-blind:disabled {
  cursor: default;
  opacity: 0.7;
}

.pcard-blind.sb {
  background: #e3f2fd;
  border-color: #90caf9;
  color: #1565c0;
}

.pcard-blind.bb {
  background: #fbe9e7;
  border-color: #ffab91;
  color: #d84315;
}

/* 邀请好友（虚线圆） */
.pcard--add {
  border-style: dashed;
  justify-content: center;
  min-height: 150px;
  color: var(--c-text-light);
  cursor: pointer;
}

/* 房主拖拽排序 */
.pcard[draggable='true'] {
  cursor: grab;
}

.pcard--drag {
  opacity: 0.4;
}

.pcard--over {
  border-color: var(--c-primary);
  transform: scale(1.04);
}

.pcard-add-icon {
  font-size: 26px;
  font-weight: 800;
  line-height: 1;
}

.pcard-add-text {
  font-size: 11px;
  font-weight: 700;
}

.empty {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 13px;
  padding: 20px 0;
}

/* 弹窗 */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(93, 64, 55, 0.5);
  display: grid;
  place-items: center;
  z-index: 100;
  padding: 24px;
}

.dialog {
  background: #fff;
  border-radius: 24px;
  padding: 24px;
  width: 100%;
  max-width: 340px;
  border: 3px solid var(--c-border);
}

.dlg-title {
  margin: 0 0 8px;
  font-size: 18px;
  text-align: center;
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}


/* 结算 */
.settle-dlg {
  text-align: center;
}

.settle-gold {
  width: 56px;
  height: 56px;
  animation: spin-in 0.6s ease-out;
}

@keyframes spin-in {
  from {
    transform: scale(0) rotate(-180deg);
  }
  to {
    transform: scale(1) rotate(0);
  }
}

.tie-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.tie-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 2px solid var(--c-border);
  border-radius: 14px;
  background: #fff;
  cursor: pointer;
}

.tie-item:active {
  border-color: var(--c-primary);
  background: #fff3e0;
}

.tie-name {
  font-size: 15px;
  font-weight: 800;
  color: var(--c-text);
}

/* toast */
.toast {
  position: fixed;
  left: 50%;
  top: 20%;
  transform: translateX(-50%);
  background: rgba(93, 64, 55, 0.9);
  color: #fff;
  font-size: 14px;
  font-weight: 700;
  padding: 10px 20px;
  border-radius: 20px;
  z-index: 200;
  white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}
</style>
