/**
 * 瓜子筹码与扑克牌 —— 程序化 SVG 生成
 *
 * 瓜子 = 向日葵籽造型，作为筹码视觉
 * 筹码按面值区分颜色：1/5/10/20/50/100/500/1000
 */

/** 瓜子（单颗筹码） */
export function seedSVG({ size = 40, color = '#8D6E63', face = null } = {}) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="seed" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.75"/>
    </linearGradient>
  </defs>
  <!-- 瓜子外形：一端尖一端圆，带条纹 -->
  <path d="M 32 6 C 46 6 56 18 56 32 C 56 46 46 58 32 58 C 18 58 8 46 8 32 C 8 18 18 6 32 6 Z"
        fill="url(#seed)" stroke="#5D4037" stroke-width="2"/>
  <!-- 中缝 -->
  <line x1="32" y1="10" x2="32" y2="54" stroke="#5D4037" stroke-width="1.5" opacity="0.5"/>
  <!-- 高光 -->
  <ellipse cx="24" cy="20" rx="5" ry="8" fill="#fff" opacity="0.35" transform="rotate(-25 24 20)"/>
  ${face ? `<text x="32" y="40" text-anchor="middle" font-size="18" font-weight="bold" fill="#fff" stroke="#5D4037" stroke-width="0.8" paint-order="stroke">${face}</text>` : ''}
</svg>`
}

/** 筹码（一叠瓜子，带面值） */
export const CHIP_VALUES = [1, 5, 10, 20, 50, 100, 500, 1000]

export const CHIP_COLORS = {
  1: '#A1887F',
  5: '#81C784',
  10: '#64B5F6',
  20: '#FFB74D',
  50: '#BA68C8',
  100: '#E57373',
  500: '#4DB6AC',
  1000: '#FFD54F',
}

/**
 * 筹码叠 SVG
 * @param {number} value 面值
 * @param {number} size 尺寸
 */
export function chipSVG(value, size = 48) {
  const color = CHIP_COLORS[value] ?? '#A1887F'
  const label = value >= 1000 ? `${value / 1000}k` : String(value)
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="chip${value}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.6"/>
    </linearGradient>
  </defs>
  <!-- 叠起来的 3 层 -->
  <ellipse cx="32" cy="52" rx="22" ry="7" fill="#000" opacity="0.12"/>
  <ellipse cx="32" cy="46" rx="23" ry="8" fill="${color}" opacity="0.55"/>
  <ellipse cx="32" cy="40" rx="23" ry="8" fill="${color}" opacity="0.75"/>
  <ellipse cx="32" cy="32" rx="23" ry="8" fill="url(#chip${value})" stroke="#5D4037" stroke-width="1.5"/>
  <text x="32" y="36" text-anchor="middle" font-size="11" font-weight="bold" fill="#fff"
        stroke="#5D4037" stroke-width="0.6" paint-order="stroke">${label}</text>
</svg>`
}

/**
 * 扑克牌面 SVG
 *
 * @param {string} code 如 "As"；传 null 表示牌背
 * @param {number} width 牌宽
 * @param {boolean} faceDown 是否显示牌背
 */
export function cardSVG(code, width = 60, faceDown = false) {
  const h = width * 1.4

  if (faceDown || !code) {
    return `<svg viewBox="0 0 60 84" width="${width}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="back" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FF8A65"/>
      <stop offset="100%" stop-color="#F4511E"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="56" height="80" rx="7" fill="url(#back)" stroke="#BF360C" stroke-width="2"/>
  <!-- 瓜子花纹 -->
  <g opacity="0.35" fill="#FFF3E0">
    <ellipse cx="30" cy="24" rx="6" ry="9"/>
    <ellipse cx="30" cy="42" rx="6" ry="9"/>
    <ellipse cx="30" cy="60" rx="6" ry="9"/>
  </g>
  <rect x="7" y="7" width="46" height="70" rx="4" fill="none" stroke="#FFF3E0" stroke-width="1.5" opacity="0.6"/>
</svg>`
  }

  const rank = code[0]
  const suit = code[1]
  const isRed = suit === 'h' || suit === 'd'
  const color = isRed ? '#D32F2F' : '#212121'
  const glyph = { s: '♠', h: '♥', d: '♦', c: '♣' }[suit]
  const rankText = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' }[rank] ?? rank

  return `<svg viewBox="0 0 60 84" width="${width}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="56" height="80" rx="7" fill="#FFFFFF" stroke="#BDBDBD" stroke-width="1.5"/>
  <!-- 左上角 -->
  <text x="10" y="20" font-size="14" font-weight="bold" fill="${color}" text-anchor="middle">${rankText}</text>
  <text x="10" y="32" font-size="12" fill="${color}" text-anchor="middle">${glyph}</text>
  <!-- 中央大花色 -->
  <text x="30" y="56" font-size="26" fill="${color}" text-anchor="middle">${glyph}</text>
  <!-- 右下角（倒置） -->
  <g transform="rotate(180 50 64)">
    <text x="50" y="74" font-size="14" font-weight="bold" fill="${color}" text-anchor="middle">${rankText}</text>
    <text x="50" y="86" font-size="12" fill="${color}" text-anchor="middle">${glyph}</text>
  </g>
</svg>`
}

/** 牌面中文名，如 "A♠" */
export function cardName(code) {
  const r = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' }[code[0]] ?? code[0]
  const s = { s: '♠', h: '♥', d: '♦', c: '♣' }[code[1]]
  return `${r}${s}`
}

/** 金瓜子（结算特效用） */
export function goldenSeedSVG(size = 32) {
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="gold" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#FFF59D"/>
      <stop offset="50%" stop-color="#FFD54F"/>
      <stop offset="100%" stop-color="#FF8F00"/>
    </radialGradient>
  </defs>
  <path d="M 32 6 C 46 6 56 18 56 32 C 56 46 46 58 32 58 C 18 58 8 46 8 32 C 8 18 18 6 32 6 Z"
        fill="url(#gold)" stroke="#FF8F00" stroke-width="2"/>
  <line x1="32" y1="10" x2="32" y2="54" stroke="#FF8F00" stroke-width="1.5" opacity="0.5"/>
  <ellipse cx="24" cy="20" rx="5" ry="8" fill="#fff" opacity="0.5" transform="rotate(-25 24 20)"/>
  <!-- 星光 -->
  <path d="M 46 14 L 48 20 L 54 22 L 48 24 L 46 30 L 44 24 L 38 22 L 44 20 Z" fill="#FFFDE7" opacity="0.9"/>
</svg>`
}

/** 把任意 SVG 字符串转 data URI */
export function svgToDataURI(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
