/**
 * 仓鼠头像 —— 6 只真仓鼠，按索引循环取。
 *
 * 和 server/debug-room-page.js 里的头像逻辑保持一致：
 * 那边是 dataURI 注入，这边是 Vue 组件，但选 hamster 的规则必须一样，
 * 否则同一个 uid 在调试页和正式页会长得不一样。
 */

import { computed } from 'vue'
import { HAMSTERS, hamsterDataURI } from '../../../shared/assets/hamsters.mjs'

const URIS = HAMSTERS.map((h) => hamsterDataURI(h, 96))

/**
 * 按稳定键挑一只仓鼠。同一个 uid 永远拿到同一只。
 * @returns {(key:string, size?:number)=>string} dataURI
 */
export function useHamsters() {
  const uriFor = (key, size = 96) => {
    let h = 0
    const s = String(key ?? '')
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
    const idx = ((h % URIS.length) + URIS.length) % URIS.length
    return URIS[idx]
  }

  return {
    hamsters: computed(() => HAMSTERS),
    uriFor,
    /** 座位下标兜底：没 uid 的老数据按座位顺序排 */
    uriForIndex: (i) => URIS[((i % URIS.length) + URIS.length) % URIS.length],
  }
}
