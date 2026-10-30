// 仅处理 click：触摸产生的合成 click 与鼠标使用同一通道，避免 touchend 与 click 重复触发。
export const DOUBLE_TAP_MS = 450
export const AFTER_DISCARD_GUARD_MS = 650
export const DISCARD_RECHECK_MS = 80
export function createTileTapTracker() {
  let last = null, blockedUntil = 0
  return {
    reset() { last = null },
    tap({ index, code, scope, now, canDiscard }) {
      if (now < blockedUntil) return 'ignore'
      if (!canDiscard) { last = null; return 'select' }
      if (last && last.scope === scope && last.index === index && last.code === code && now >= last.time && now - last.time <= DOUBLE_TAP_MS) {
        last = null; blockedUntil = now + AFTER_DISCARD_GUARD_MS
        return 'discard'
      }
      last = { index, code, scope, time: now }
      return 'select'
    },
  }
}
