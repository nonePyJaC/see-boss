/**
 * 实时同步策略 — 可切换
 *
 * 三种方案，按 VITE_REALTIME_MODE 选择：
 *
 *   cdc        Postgres CDC（app.realtime() 订阅表变更）
 *              优点：语义清晰，任何写入都会推送
 *              缺点：poller 持续产生数据库处理，可能每个 5 分钟窗口都计费
 *
 *   broadcast  内存消息通道（app.realtime().channel().send()）
 *              优点：不产生数据库调用，不消耗资源点
 *              缺点：需要服务端配合发送；消息可能丢失（无 ack）
 *
 *   poll       轮询（默认，最稳）
 *              优点：一定能用，无前置要求
 *              缺点：有延迟；但 CPU 计费按 5 分钟窗口，频率不影响
 *
 * 实测优先级：broadcast > cdc > poll
 */

export const REALTIME_MODE = import.meta.env.VITE_REALTIME_MODE ?? 'poll'

/** 轮询间隔（ms）。CPU 计费按 5 分钟窗口，2s 和 10s 成本相同 */
export const POLL_INTERVAL = 2000

/**
 * 创建房间订阅器
 *
 * @param {string} roomNo
 * @param {(snapshot:any) => void} onChange
 * @param {() => Promise<any>} fetchSnapshot  拉取房间全量状态
 * @returns {{ stop: () => void, mode: string }}
 */
export function createRoomSync(roomNo, onChange, fetchSnapshot) {
  if (REALTIME_MODE === 'cdc') return createCDCSync(roomNo, onChange, fetchSnapshot)
  if (REALTIME_MODE === 'broadcast') return createBroadcastSync(roomNo, onChange, fetchSnapshot)
  return createPollSync(roomNo, onChange, fetchSnapshot)
}

/**
 * 自适应轮询（兜底，一定能用）。
 *
 * intervalMs 可以是函数：由调用方按房间动静给出下一次间隔，
 * 空闲时自动降到 15s，有变化时立刻回到 2s —— 省 CloudBase 调用。
 */
function createPollSync(roomNo, onChange, fetchSnapshot, intervalMs) {
  const next = () =>
    typeof intervalMs === 'function' ? intervalMs() : (intervalMs ?? POLL_INTERVAL)
  let stopped = false
  let timer = null

  async function tick() {
    if (stopped) return
    try {
      const snap = await fetchSnapshot()
      if (snap && !stopped) onChange(snap)
    } catch {
      // 忽略单次失败，下一轮重试
    }
  }

  // 每轮结束后自己排下一轮，间隔由 next() 动态决定。
  // 关键：必须是「上一轮跑完才排下一轮」，
  // 否则退避等级刚变、下一轮就已经在跑，省不掉调用。
  function schedule() {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      tick().then(schedule)
    }, next())
  }

  schedule()

  return {
    mode: 'poll',
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/** Postgres CDC：订阅表变更 */
function createCDCSync(roomNo, onChange, fetchSnapshot) {
  let stopped = false
  let pollFallback = null
  let channel = null

  ;(async () => {
    try {
      const { getApp } = await import('./cloud-repo-internal.js')
      const app = getApp()
      const realtime = app.realtime()

      channel = realtime.channel(`room-${roomNo}`, {
        config: { postgres_changes_options: { wait: true, timeout: 10000 } },
      })

      const onAnyChange = async () => {
        if (stopped) return
        const snap = await fetchSnapshot()
        if (snap && !stopped) onChange(snap)
      }

      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomNo}` },
        onAnyChange)
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomNo}` },
        onAnyChange)

      channel.subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // CDC 不可用 → 降级轮询
          pollFallback = createPollSync(roomNo, onChange, fetchSnapshot)
        }
      })
    } catch {
      pollFallback = createPollSync(roomNo, onChange, fetchSnapshot)
    }
  })()

  return {
    mode: 'cdc',
    stop() {
      stopped = true
      pollFallback?.stop()
      channel?.unsubscribe?.()
    },
  }
}

/** Broadcast：内存消息通道，不消耗数据库资源点 */
function createBroadcastSync(roomNo, onChange, fetchSnapshot) {
  let stopped = false
  let pollFallback = null
  let channel = null

  ;(async () => {
    try {
      const { getApp } = await import('./cloud-repo-internal.js')
      const app = getApp()
      const realtime = app.realtime()

      channel = realtime.channel(`room:${roomNo}`, {
        config: { broadcast: { ack: false, self: false } },
      })

      channel.on('broadcast', { event: 'room-state' }, async () => {
        if (stopped) return
        const snap = await fetchSnapshot()
        if (snap && !stopped) onChange(snap)
      })

      channel.subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          pollFallback = createPollSync(roomNo, onChange, fetchSnapshot)
        }
      })
    } catch {
      pollFallback = createPollSync(roomNo, onChange, fetchSnapshot)
    }
  })()

  return {
    mode: 'broadcast',
    stop() {
      stopped = true
      pollFallback?.stop()
      channel?.unsubscribe?.()
    },
  }
}
