/**
 * 仓鼠头像 —— 程序化 SVG 生成
 *
 * 6 个造型，通过 5 个维度组合保证风格统一：
 *   body   毛色（奶油/焦糖/灰/巧克力/三花/雪球）
 *   belly  肚皮色
 *   ear    耳朵形态（圆耳/垂耳/尖耳）
 *   acc    配饰（无/围巾/帽子/花/领结/眼罩）
 *   eye    眼睛（圆眼/星星眼/笑眼）
 *
 * 输出 128x128 viewBox 的 SVG 字符串，可直接 innerHTML 或做 <img src="data:...">
 */

export const HAMSTERS = [
  {
    id: 1,
    name: '奶油',
    body: '#F5D6A8', bodyDark: '#E0B77E', belly: '#FFF3E0',
    ear: 'round', acc: 'scarf', accColor: '#FF8A80', eye: 'round',
  },
  {
    id: 2,
    name: '焦糖',
    body: '#D9A05B', bodyDark: '#B87F3E', belly: '#FBE7C6',
    ear: 'drop', acc: 'hat', accColor: '#8D6E63', eye: 'star',
  },
  {
    id: 3,
    name: '灰灰',
    body: '#B0BEC5', bodyDark: '#8A9BA5', belly: '#ECEFF1',
    ear: 'point', acc: 'flower', accColor: '#F48FB1', eye: 'round',
  },
  {
    id: 4,
    name: '可可',
    body: '#8D6E63', bodyDark: '#6D4C41', belly: '#D7CCC8',
    ear: 'round', acc: 'bowtie', accColor: '#FFB300', eye: 'happy',
  },
  {
    id: 5,
    name: '三花',
    body: '#F5D6A8', bodyDark: '#E0B77E', belly: '#FFF3E0',
    ear: 'point', acc: 'mask', accColor: '#4DD0E1', eye: 'star',
    patch: '#A1887F', // 三花斑块
  },
  {
    id: 6,
    name: '雪球',
    body: '#FAFAFA', bodyDark: '#E0E0E0', belly: '#FFFFFF',
    ear: 'drop', acc: 'scarf', accColor: '#90CAF9', eye: 'happy',
    patch: '#F5F5F5',
  },
]

/**
 * 生成单个仓鼠的 SVG
 * @param {Object} h HAMSTERS 中的一项
 * @param {number} size 输出尺寸（px）
 * @returns {string} SVG 字符串
 */
export function hamsterSVG(h, size = 128) {
  const { body, bodyDark, belly } = h

  return `<svg viewBox="0 0 128 128" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg${h.id}" cx="50%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#FFF8E7"/>
      <stop offset="100%" stop-color="#FFE0B2"/>
    </radialGradient>
    <radialGradient id="fur${h.id}" cx="40%" cy="30%" r="80%">
      <stop offset="0%" stop-color="${body}"/>
      <stop offset="100%" stop-color="${bodyDark}"/>
    </radialGradient>
  </defs>

  <!-- 圆形暖色背景 -->
  <circle cx="64" cy="64" r="62" fill="url(#bg${h.id})"/>

  <!-- 耳朵 -->
  ${renderEars(h)}

  <!-- 身体（圆滚滚） -->
  <ellipse cx="64" cy="76" rx="38" ry="34" fill="url(#fur${h.id})"/>

  <!-- 肚皮 -->
  <ellipse cx="64" cy="84" rx="24" ry="20" fill="${belly}" opacity="0.9"/>

  <!-- 三花斑块 -->
  ${h.patch ? `<ellipse cx="46" cy="66" rx="13" ry="11" fill="${h.patch}" opacity="0.5"/>
  <ellipse cx="82" cy="80" rx="9" ry="8" fill="${h.patch}" opacity="0.4"/>` : ''}

  <!-- 小爪子 -->
  <ellipse cx="48" cy="100" rx="7" ry="5" fill="${bodyDark}"/>
  <ellipse cx="80" cy="100" rx="7" ry="5" fill="${bodyDark}"/>

  <!-- 脸 -->
  <ellipse cx="64" cy="62" rx="34" ry="30" fill="url(#fur${h.id})"/>

  <!-- 眼睛 -->
  ${renderEyes(h)}

  <!-- 鼻子 + 嘴 -->
  <ellipse cx="64" cy="74" rx="4" ry="3" fill="#5D4037"/>
  <path d="M 58 80 Q 64 85 70 80" stroke="#5D4037" stroke-width="2" fill="none" stroke-linecap="round"/>
  <path d="M 64 77 L 64 80" stroke="#5D4037" stroke-width="1.5" stroke-linecap="round"/>

  <!-- 腮红 -->
  <ellipse cx="40" cy="70" rx="6" ry="4" fill="#FFAB91" opacity="0.6"/>
  <ellipse cx="88" cy="70" rx="6" ry="4" fill="#FFAB91" opacity="0.6"/>

  <!-- 胡须 -->
  <g stroke="#8D6E63" stroke-width="1" stroke-linecap="round" opacity="0.5">
    <line x1="30" y1="72" x2="42" y2="74"/>
    <line x1="30" y1="78" x2="42" y2="77"/>
    <line x1="98" y1="72" x2="86" y2="74"/>
    <line x1="98" y1="78" x2="86" y2="77"/>
  </g>

  <!-- 配饰 -->
  ${renderAccessory(h)}
</svg>`
}

/** 耳朵 */
function renderEars(h) {
  const { body, bodyDark } = h
  const inner = '#FFCDD2'
  if (h.ear === 'round') {
    return `
  <circle cx="38" cy="38" r="14" fill="${body}"/>
  <circle cx="38" cy="38" r="8" fill="${inner}"/>
  <circle cx="90" cy="38" r="14" fill="${body}"/>
  <circle cx="90" cy="38" r="8" fill="${inner}"/>`
  }
  if (h.ear === 'drop') {
    return `
  <ellipse cx="36" cy="42" rx="11" ry="15" fill="${bodyDark}"/>
  <ellipse cx="36" cy="42" rx="6" ry="9" fill="${inner}"/>
  <ellipse cx="92" cy="42" rx="11" ry="15" fill="${bodyDark}"/>
  <ellipse cx="92" cy="42" rx="6" ry="9" fill="${inner}"/>`
  }
  // point 尖耳
  return `
  <path d="M 30 50 L 36 26 L 52 40 Z" fill="${body}"/>
  <path d="M 36 44 L 38 33 L 47 41 Z" fill="${inner}"/>
  <path d="M 98 50 L 92 26 L 76 40 Z" fill="${body}"/>
  <path d="M 92 44 L 90 33 L 81 41 Z" fill="${inner}"/>`
}

/** 眼睛 */
function renderEyes(h) {
  const cx = [54, 74]
  const cy = 60
  if (h.eye === 'star') {
    return cx.map((x) => `<path d="${starPath(x, cy, 7)}" fill="#37474F"/>`).join('\n  ')
  }
  if (h.eye === 'happy') {
    return cx
      .map(
        (x) =>
          `<path d="M ${x - 6} ${cy + 3} Q ${x} ${cy - 5} ${x + 6} ${cy + 3}" stroke="#37474F" stroke-width="3" fill="none" stroke-linecap="round"/>`
      )
      .join('\n  ')
  }
  // round
  return cx
    .map(
      (x) => `
  <circle cx="${x}" cy="${cy}" r="6" fill="#37474F"/>
  <circle cx="${x + 2}" cy="${cy - 2}" r="2" fill="#fff"/>`
    )
    .join('')
}

/** 五角星路径 */
function starPath(cx, cy, r) {
  const pts = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45
    const a = (Math.PI / 5) * i - Math.PI / 2
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`)
  }
  return `M ${pts.join(' L ')} Z`
}

/** 配饰 */
function renderAccessory(h) {
  switch (h.acc) {
    case 'scarf':
      return `
  <path d="M 40 92 Q 64 102 88 92 L 88 98 Q 64 108 40 98 Z" fill="${h.accColor}"/>
  <rect x="82" y="94" width="10" height="18" rx="3" fill="${h.accColor}"/>`
    case 'hat':
      return `
  <ellipse cx="64" cy="36" rx="30" ry="7" fill="${h.accColor}"/>
  <path d="M 44 36 Q 46 16 64 16 Q 82 16 84 36 Z" fill="${h.accColor}"/>
  <rect x="44" y="30" width="40" height="6" fill="#5D4037" opacity="0.35"/>`
    case 'flower':
      return `
  <g transform="translate(90,44)">
    ${[0, 72, 144, 216, 288]
      .map((a) => `<ellipse cx="0" cy="-6" rx="4" ry="6" fill="${h.accColor}" transform="rotate(${a})"/>`)
      .join('')}
    <circle r="3.5" fill="#FFF59D"/>
  </g>`
    case 'bowtie':
      return `
  <g transform="translate(64,94)">
    <path d="M -12 -6 L -2 0 L -12 6 Z" fill="${h.accColor}"/>
    <path d="M 12 -6 L 2 0 L 12 6 Z" fill="${h.accColor}"/>
    <circle r="3" fill="#FFF59D"/>
  </g>`
    case 'mask':
      return `
  <rect x="36" y="54" width="56" height="14" rx="6" fill="${h.accColor}" opacity="0.85"/>
  <rect x="36" y="54" width="56" height="5" rx="2" fill="#fff" opacity="0.4"/>`
    default:
      return ''
  }
}

/**
 * 把 SVG 转成 data URI，可直接用于 <img src>
 */
export function hamsterDataURI(h, size = 128) {
  const svg = hamsterSVG(h, size)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 根据 id 取仓鼠配置 */
export function getHamster(id) {
  return HAMSTERS.find((h) => h.id === Number(id)) ?? HAMSTERS[0]
}
