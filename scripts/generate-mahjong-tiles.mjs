// 生成全套麻将 SVG 牌面（万/饼/条/风/箭/花/季 + 牌背）
// 输出:
//   client/public/mahjong/tiles/<id>.svg   单牌文件，<img> 直接使用
//   client/public/mahjong/sprite.svg       <symbol> 雪碧图，<use href> 使用
//   client/public/mahjong/index.html       手机端牌面预览 + 手牌演示
//   client/src/data/mahjong-tiles.js       牌面清单（Vue 侧引用）
// 用法: node scripts/generate-mahjong-tiles.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'client', 'public', 'mahjong')
const TILES_DIR = path.join(OUT_DIR, 'tiles')
const DATA_DIR = path.join(ROOT, 'client', 'src', 'data')

// ---------- 设计常量（viewBox 76x104，牌面 68x90 + 右/下绿色牌体厚度） ----------
const W = 76
const H = 104
const IVORY = '#f8f4e8' // 牌面象牙白，也用作牌点镂空色
const INK = '#17355f' // 藏青：风牌 / 万子上字
const RED = '#c02a30'
const RED_D = '#8f1f24'
const GREEN = '#23713d'
const GREEN_D = '#17522b'
const BLUE = '#1e4f9c'
const BLUE_D = '#123a75'
const BROWN = '#7a5230'
const PINK = '#e77aa2'
const GOLD = '#e0a52e'
const ORANGE = '#e08a2e'
const SKY = '#3a7ec2'
const PURPLE = '#7a5aa8'
const DIM = '#9a8f6d' // 花牌角标

// 小尺寸优先使用笔画清楚的系统字体；SVG 不依赖下载字体。
const KAI = `'PingFang SC','Microsoft YaHei','Noto Sans CJK SC','Hiragino Sans GB',sans-serif`

const CJK_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九']

// ---------- 基础图元 ----------
const txt = (s, x, y, size, fill, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="middle" dominant-baseline="central" font-family="${KAI}" font-weight="700"${extra}>${s}</text>`

// 饼子点：色环 + 镂空 + 芯 + 镂空
const pip = (x, y, r, c) =>
  `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>` +
  `<circle cx="${x}" cy="${y}" r="${(r * 0.56).toFixed(2)}" fill="${IVORY}"/>` +
  `<circle cx="${x}" cy="${y}" r="${(r * 0.27).toFixed(2)}" fill="${c}"/></g>`

// 条子：竹节棍，两节线 + 三个钱孔点
const stick = (x, y, color, edge, { ang = 0, h = 24, w = 10 } = {}) =>
  `<g transform="translate(${x} ${y})${ang ? ` rotate(${ang})` : ''}">` +
  `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="${color}" stroke="${edge}" stroke-width=".9"/>` +
  `<path d="M${-w / 2 + 1} ${-h / 6}h${w - 2}M${-w / 2 + 1} ${h / 6}h${w - 2}" stroke="${edge}" stroke-width="1" opacity=".5" fill="none"/>` +
  [-1, 0, 1].map(k => `<circle cy="${(k * h) / 3}" r="1.1" fill="${IVORY}"/>`).join('') +
  `</g>`

const sGreen = (x, y, o) => stick(x, y, GREEN, GREEN_D, o)
const sBlue = (x, y, o) => stick(x, y, BLUE, BLUE_D, o)
const sRed = (x, y, o) => stick(x, y, RED, RED_D, o)

// ---------- 牌壳 ----------
const DEFS = `<defs>` +
  `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfbf4"/><stop offset="1" stop-color="#f0e8d2"/></linearGradient>` +
  `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a8a5f"/><stop offset="1" stop-color="#1b6444"/></linearGradient>` +
  `<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f7d57"/><stop offset="1" stop-color="#17452d"/></linearGradient>` +
  `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".38"/><stop offset=".2" stop-color="#ffffff" stop-opacity="0"/><stop offset=".82" stop-color="#8a6c30" stop-opacity="0"/><stop offset="1" stop-color="#8a6c30" stop-opacity=".12"/></linearGradient>` +
  `</defs>`

const shell = inner =>
  `<rect x="6" y="6" width="68" height="96" rx="10" fill="url(#s)"/>` +
  `<rect x="2" y="2" width="68" height="90" rx="10" fill="url(#f)" stroke="#cfc5a6"/>` +
  `<rect x="2" y="2" width="68" height="90" rx="10" fill="url(#v)"/>` +
  `<rect x="7.5" y="7.5" width="57" height="79" rx="6" fill="none" stroke="#e4dcc0"/>` +
  `<path d="M13 5.6h38" stroke="#fff" stroke-width="1.2" opacity=".55" stroke-linecap="round"/>` +
  `<path d="M70.8 14v72" stroke="#0f3a26" stroke-width="1" opacity=".5"/>` +
  `<path d="M16 92.8h40" stroke="#0f3a26" stroke-width="1" opacity=".45"/>` +
  `<g>${inner}</g>`

const svgDoc = inner =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${DEFS}${shell(inner)}</svg>\n`

// ---------- 万子 ----------
const wanFace = n =>
  txt(CJK_NUM[n - 1], 36, 32, 30, INK) + txt('万', 36, 69, 38, RED)

// ---------- 饼子 ----------
const TONG_LAYOUTS = {
  1: null, // 单独花饼
  2: [[24, 27, 'B'], [48, 65, 'G']],
  3: [[23, 25, 'B'], [36, 46, 'R'], [49, 67, 'G']],
  4: [[24, 27, 'B'], [48, 27, 'G'], [24, 65, 'G'], [48, 65, 'B']],
  5: [[24, 27, 'B'], [48, 27, 'B'], [36, 46, 'R'], [24, 65, 'B'], [48, 65, 'B']],
  6: [[24, 21, 'B'], [48, 21, 'B'], [24, 46, 'G'], [48, 46, 'G'], [24, 71, 'G'], [48, 71, 'G']],
  7: [[20, 17, 'B'], [33, 27, 'B'], [47, 37, 'B'], [24, 59, 'R'], [48, 59, 'R'], [24, 78, 'R'], [48, 78, 'R']],
  8: [[24, 17, 'B'], [48, 17, 'B'], [24, 36, 'B'], [48, 36, 'B'], [24, 56, 'B'], [48, 56, 'B'], [24, 76, 'B'], [48, 76, 'B']],
  9: [[19, 23, 'B'], [36, 23, 'B'], [53, 23, 'B'], [19, 46, 'R'], [36, 46, 'R'], [53, 46, 'R'], [19, 69, 'G'], [36, 69, 'G'], [53, 69, 'G']],
}
const TONG_COLOR = { B: BLUE, G: GREEN, R: RED }

const tongFace = n => {
  if (n === 1) {
    // 大饼：同心花环
    const rings = [[GREEN, 25], [IVORY, 19.5], [RED, 15], [IVORY, 10.5], [BLUE, 6.6], [IVORY, 2.6]]
    return `<g>${rings.map(([c, r]) => `<circle cx="36" cy="46" r="${r}" fill="${c}"/>`).join('')}</g>`
  }
  const r = n === 9 ? 7.2 : n >= 7 ? 7.6 : 8.6
  return TONG_LAYOUTS[n].map(([x, y, c]) => pip(x, y, r, TONG_COLOR[c])).join('')
}

// ---------- 条子 ----------
const tiaoFace = n => {
  switch (n) {
    case 1: return sparrow()
    case 2: return sBlue(36, 26) + sGreen(36, 64)
    case 3: return sBlue(36, 20, { h: 21 }) + sGreen(24, 63) + sGreen(48, 63)
    case 4: return sBlue(24, 27) + sBlue(48, 27) + sGreen(24, 65) + sGreen(48, 65)
    case 5: return sGreen(24, 26) + sGreen(48, 26) + sRed(36, 46, { h: 22 }) + sGreen(24, 66) + sGreen(48, 66)
    case 6:
      return sBlue(24, 19, { h: 20 }) + sBlue(48, 19, { h: 20 }) +
        sGreen(24, 45, { h: 20 }) + sGreen(48, 45, { h: 20 }) +
        sGreen(24, 71, { h: 20 }) + sGreen(48, 71, { h: 20 })
    case 7:
      return sRed(36, 15, { h: 17, w: 8 }) +
        sGreen(24, 34, { h: 20 }) + sGreen(48, 34, { h: 20 }) +
        sGreen(24, 56, { h: 20 }) + sGreen(48, 56, { h: 20 }) +
        sGreen(24, 78, { h: 20 }) + sGreen(48, 78, { h: 20 })
    case 8: // 上下两组 M 形镜像
      return sGreen(15, 26) + sGreen(57, 26) +
        sGreen(30.5, 31, { ang: -21 }) + sGreen(41.5, 31, { ang: 21 }) +
        sGreen(15, 74) + sGreen(57, 74) +
        sGreen(30.5, 69, { ang: 21 }) + sGreen(41.5, 69, { ang: -21 })
    case 9: {
      const xs = [19, 36, 53]
      const ys = [21, 46, 71]
      return ys.map(y => xs.map(x => (x === 36 ? sRed(x, y, { h: 22, w: 7.6 }) : sGreen(x, y, { h: 22, w: 7.6 }))).join('')).join('')
    }
  }
}

// 幺鸡：枝头孔雀/麻雀
function sparrow() {
  const feather = (ang, len, ex, ey) =>
    `<g transform="translate(30 62) rotate(${ang})"><ellipse cx="0" cy="${-len / 2}" rx="3.1" ry="${len / 2}" fill="${GREEN}" stroke="${GREEN_D}" stroke-width=".7"/>` +
    `<circle cy="${-len + 3.5}" r="2.6" fill="${GOLD}"/><circle cy="${-len + 3.5}" r="1.3" fill="${BLUE}"/></g>`
  return (
    `<path d="M14 77Q36 71 58 77" stroke="${BROWN}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` +
    `<path d="M22 75q-3 -5 2 -8" stroke="${GREEN_D}" stroke-width="1.4" fill="none"/>` +
    feather(-32, 26, 0, 0) + feather(-12, 30, 0, 0) + feather(10, 30, 0, 0) + feather(30, 25, 0, 0) +
    `<path d="M33 66l-3 8M39 66l1 8" stroke="${BROWN}" stroke-width="1.6" stroke-linecap="round"/>` +
    `<ellipse cx="36" cy="54" rx="9.5" ry="13" transform="rotate(-14 36 54)" fill="${GREEN}" stroke="${GREEN_D}" stroke-width=".9"/>` +
    `<ellipse cx="33" cy="55" rx="5" ry="8.5" transform="rotate(-22 33 55)" fill="${GREEN_D}"/>` +
    `<path d="M29 51q4 3 8 0M28.5 56q4.5 3 9 0" stroke="${GREEN}" stroke-width="1" fill="none" opacity=".8"/>` +
    `<circle cx="44" cy="37" r="7" fill="${GREEN}" stroke="${GREEN_D}" stroke-width=".9"/>` +
    `<path d="M41 30q-1 -3 -3 -4M44 30q0 -3 -1 -5M47 30q1 -3 2 -4" stroke="${GREEN_D}" stroke-width="1.3" fill="none" stroke-linecap="round"/>` +
    `<circle cx="46" cy="35.5" r="1.7" fill="#fff"/><circle cx="46.4" cy="35.5" r=".9" fill="#1a1a1a"/>` +
    `<path d="M50.5 34.5L55 36.5l-4.5 2.2z" fill="${ORANGE}"/>` +
    `<path d="M42.5 40.5q-3 1.5 -5 4" stroke="${GOLD}" stroke-width="1.2" fill="none" opacity=".85"/>`
  )
}

// ---------- 字牌 ----------
const windFace = ch => txt(ch, 36, 48, 50, INK)
const zhongFace = () => txt('中', 36, 48, 52, RED)
const faFace = () => txt('發', 36, 48, 50, GREEN)
const baiFace = () =>
  `<rect x="17" y="24" width="38" height="48" rx="4" fill="none" stroke="${BLUE}" stroke-width="5"/>` +
  `<rect x="23.5" y="30.5" width="25" height="35" rx="2" fill="none" stroke="${BLUE}" stroke-width="1.6"/>`

// ---------- 花 / 季 牌 ----------
const blossom = (cx, cy, pr, pc, cc) =>
  `<g>${[0, 72, 144, 216, 288].map(a => {
    const r = (a * Math.PI) / 180
    return `<circle cx="${(cx + pr * Math.cos(r)).toFixed(2)}" cy="${(cy + pr * Math.sin(r)).toFixed(2)}" r="2.5" fill="${pc}"/>`
  }).join('')}<circle cx="${cx}" cy="${cy}" r="1.7" fill="${cc}"/></g>`

const flowerIndex = n => `<text x="57.5" y="14" font-size="9" fill="${DIM}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif">${n}</text>`

const meiArt = () =>
  `<path d="M19 76C27 68 33 61 45 52M30 68l8 9" stroke="${BROWN}" stroke-width="2.2" fill="none" stroke-linecap="round"/>` +
  blossom(24, 63, 4, PINK, GOLD) + blossom(37, 55, 4, PINK, GOLD) + blossom(47, 68, 4, '#e89ab8', GOLD) +
  `<circle cx="30" cy="48" r="2" fill="${PINK}"/><circle cx="51" cy="57" r="1.8" fill="${PINK}"/>`

const lanArt = () =>
  `<g stroke="${GREEN_D}" stroke-width="1.8" fill="none" stroke-linecap="round">` +
  `<path d="M36 79C30 67 25 58 20 49"/><path d="M36 79C38 66 41 55 48 47"/><path d="M36 79C35 68 35 58 33 50"/></g>` +
  `<ellipse cx="40" cy="56" rx="4.6" ry="2.4" transform="rotate(-28 40 56)" fill="${PURPLE}"/>` +
  `<ellipse cx="33" cy="59" rx="4.2" ry="2.2" transform="rotate(24 33 59)" fill="${PURPLE}"/>` +
  `<circle cx="36.5" cy="58" r="1.5" fill="${GOLD}"/>` +
  `<path d="M44 70q5 -4 10 -2" stroke="${GREEN_D}" stroke-width="1.5" fill="none"/>`

const zhuArt = () =>
  `<rect x="32" y="50" width="7" height="28" rx="3.5" fill="${GREEN}" stroke="${GREEN_D}"/>` +
  `<path d="M32.9 62h5.2M32.9 70h5.2" stroke="${GREEN_D}" stroke-width="1.1"/>` +
  `<path d="M38 54q8 -7 15 -6 -6 6 -15 6zM38 58q9 -1 13 4 -8 1 -13 -4zM35 51q-7 -5 -13 -4 5 5 13 4zM34 58q-8 0 -12 5 7 1 12 -5z" fill="${GREEN}" stroke="${GREEN_D}" stroke-width=".6"/>`

const juArt = () => {
  const petals = Array.from({ length: 12 }, (_, i) =>
    `<ellipse cx="36" cy="53.5" rx="2.1" ry="7" transform="rotate(${i * 30} 36 62)" fill="${ORANGE}" stroke="#c0701f" stroke-width=".5"/>`
  ).join('')
  return `<g>${petals}<circle cx="36" cy="62" r="3.6" fill="#b5551d"/></g>` +
    `<path d="M27 78q4 -6 9 -3M45 78q-4 -6 -9 -3" stroke="${GREEN_D}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
}

const chunArt = () =>
  `<circle cx="27" cy="57" r="6" fill="#e8543f"/>` +
  Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const x1 = 27 + 7.5 * Math.cos(a), y1 = 57 + 7.5 * Math.sin(a)
    const x2 = 27 + 10.5 * Math.cos(a), y2 = 57 + 10.5 * Math.sin(a)
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#e8543f" stroke-width="1.6" stroke-linecap="round"/>`
  }).join('') +
  `<path d="M44 79V64" stroke="${GREEN_D}" stroke-width="2" stroke-linecap="round"/>` +
  `<ellipse cx="40" cy="63" rx="4.5" ry="2.2" transform="rotate(-30 40 63)" fill="${GREEN}"/>` +
  `<ellipse cx="48" cy="63" rx="4.5" ry="2.2" transform="rotate(30 48 63)" fill="${GREEN}"/>` +
  `<path d="M20 79h32" stroke="${GREEN_D}" stroke-width="1.5" opacity=".6"/>`

const xiaArt = () =>
  `<circle cx="36" cy="54" r="8" fill="#e8543f"/>` +
  Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const x1 = 36 + 9.5 * Math.cos(a), y1 = 54 + 9.5 * Math.sin(a)
    const x2 = 36 + 12.5 * Math.cos(a), y2 = 54 + 12.5 * Math.sin(a)
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#e8543f" stroke-width="1.7" stroke-linecap="round"/>`
  }).join('') +
  `<path d="M17 73q5 -4.5 10 0t10 0t10 0t10 0" stroke="${SKY}" stroke-width="2" fill="none" stroke-linecap="round"/>` +
  `<ellipse cx="48" cy="66" rx="5" ry="2.4" transform="rotate(-24 48 66)" fill="${GREEN}"/>`

const qiuArt = () =>
  `<path d="M36 50l3.5 8 8.5 -2.5 -4.5 7.5 6 6 -8.5 -0.5 -2 8.5 -3 -7 -7.5 3 3.5 -8 -6 -4.5 7.5 -0.5z" fill="${ORANGE}" stroke="#b56a1c" stroke-width=".8" stroke-linejoin="round"/>` +
  `<path d="M36 58L38.5 77" stroke="${BROWN}" stroke-width="2" stroke-linecap="round"/>` +
  `<path d="M36 60l-6 4M36 64l7 4" stroke="#b56a1c" stroke-width="1.1"/>` +
  `<path d="M24 76q-3 -4 1 -7" stroke="${ORANGE}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`

const dongArt = () => {
  const spokes = Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3
    const x2 = 36 + 14 * Math.cos(a), y2 = 62 + 14 * Math.sin(a)
    const bx = 36 + 8 * Math.cos(a), by = 62 + 8 * Math.sin(a)
    const t1 = a + Math.PI / 6, t2 = a - Math.PI / 6
    const b1x = bx + 4 * Math.cos(t1), b1y = by + 4 * Math.sin(t1)
    const b2x = bx + 4 * Math.cos(t2), b2y = by + 4 * Math.sin(t2)
    return `<path d="M36 62L${x2.toFixed(1)} ${y2.toFixed(1)}M${bx.toFixed(1)} ${by.toFixed(1)}L${b1x.toFixed(1)} ${b1y.toFixed(1)}M${bx.toFixed(1)} ${by.toFixed(1)}L${b2x.toFixed(1)} ${b2y.toFixed(1)}" stroke="${SKY}" stroke-width="1.9" stroke-linecap="round" fill="none"/>`
  }).join('')
  return `<g>${spokes}<circle cx="36" cy="62" r="2" fill="${SKY}"/></g>`
}

const huaFace = (char, art) => txt(char, 36, 30, 32, RED) + art()
const jiFace = (char, art) => txt(char, 36, 30, 32, INK) + art()

// ---------- 牌背 ----------
const backBody = () =>
  `<rect x="6" y="6" width="68" height="96" rx="10" fill="#0f3a26"/>` +
  `<rect x="2" y="2" width="68" height="90" rx="10" fill="url(#b)" stroke="#14563b"/>` +
  `<rect x="2" y="2" width="68" height="90" rx="10" fill="url(#v)"/>` +
  `<rect x="7.5" y="7.5" width="57" height="79" rx="6" fill="none" stroke="#3f9a6e" stroke-width="1.2"/>` +
  `<rect x="10.5" y="10.5" width="51" height="73" rx="5" fill="none" stroke="#0f4a31" stroke-width=".8" opacity=".7"/>` +
  `<path d="M13 5.6h38" stroke="#fff" stroke-width="1.2" opacity=".35" stroke-linecap="round"/>` +
  `<g opacity=".28">${blossom(36, 46, 7, '#eaf5ee', '#eaf5ee')}</g>`

const backSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${DEFS}${backBody()}</svg>\n`

// ---------- 牌面清单 ----------
// kind: suit | honor | bonus ; notation: 日麻式简写便于程序侧使用
const TILES = []
const push = (id, file, name, suit, rank, kind, notation, unicode, inner) =>
  TILES.push({ id, file, name, suit, rank, kind, notation, unicode, inner, svg: svgDoc(inner) })

for (let n = 1; n <= 9; n++) {
  push(`wan-${n}`, `wan-${n}.svg`, `${CJK_NUM[n - 1]}万`, 'wan', n, 'suit', `${n}m`, String.fromCodePoint(0x1f006 + n), wanFace(n))
}
for (let n = 1; n <= 9; n++) {
  push(`tong-${n}`, `tong-${n}.svg`, `${CJK_NUM[n - 1]}饼`, 'tong', n, 'suit', `${n}p`, String.fromCodePoint(0x1f018 + n), tongFace(n))
}
for (let n = 1; n <= 9; n++) {
  push(`tiao-${n}`, `tiao-${n}.svg`, n === 1 ? '幺鸡' : `${CJK_NUM[n - 1]}条`, 'tiao', n, 'suit', `${n}s`, String.fromCodePoint(0x1f00f + n), tiaoFace(n))
}
const WINDS = [['dong', '东', '1z', 0x1f000], ['nan', '南', '2z', 0x1f001], ['xi', '西', '3z', 0x1f002], ['bei', '北', '4z', 0x1f003]]
for (const [id, ch, mj, cp] of WINDS) push(`feng-${id}`, `feng-${id}.svg`, `${ch}风`, 'feng', null, 'honor', mj, String.fromCodePoint(cp), windFace(ch))
push('jian-zhong', 'jian-zhong.svg', '红中', 'jian', null, 'honor', '5z', String.fromCodePoint(0x1f004), zhongFace())
push('jian-fa', 'jian-fa.svg', '发财', 'jian', null, 'honor', '6z', String.fromCodePoint(0x1f005), faFace())
push('jian-bai', 'jian-bai.svg', '白板', 'jian', null, 'honor', '7z', String.fromCodePoint(0x1f006), baiFace())
const HUA = [['mei', '梅', meiArt], ['lan', '兰', lanArt], ['zhu', '竹', zhuArt], ['ju', '菊', juArt]]
HUA.forEach(([id, ch, art], i) =>
  push(`hua-${id}`, `hua-${id}.svg`, `${ch}花`, 'hua', i + 1, 'bonus', `f${i + 1}`, String.fromCodePoint(0x1f022 + i), huaFace(ch, art) + flowerIndex(i + 1)))
const JI = [['chun', '春', chunArt], ['xia', '夏', xiaArt], ['qiu', '秋', qiuArt], ['dong', '冬', dongArt]]
JI.forEach(([id, ch, art], i) =>
  push(`ji-${id}`, `ji-${id}.svg`, ch, 'ji', i + 1, 'bonus', `f${i + 5}`, String.fromCodePoint(0x1f026 + i), jiFace(ch, art) + flowerIndex(i + 1)))

// ---------- 雪碧图 ----------
const sprite = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${DEFS}` +
  TILES.map(t => `<symbol id="${t.id}" viewBox="0 0 ${W} ${H}">${shell(t.inner)}</symbol>`).join('') +
  `<symbol id="back" viewBox="0 0 ${W} ${H}">${backBody()}</symbol>` +
  `</svg>\n`

// ---------- 数据清单 ----------
const manifestJs = () => {
  const rows = TILES.map(({ id, file, name, suit, rank, kind, notation, unicode }) =>
    `  { id: '${id}', file: '${file}', name: '${name}', suit: '${suit}', rank: ${rank === null ? 'null' : rank}, kind: '${kind}', notation: '${notation}', unicode: '${unicode}' },`
  ).join('\n')
  return `// 由 scripts/generate-mahjong-tiles.mjs 生成，请勿手改
// 牌面 SVG 位于 client/public/mahjong/tiles/，构建后随 dist 输出
export const MAHJONG_TILE_DIR = 'mahjong/tiles/'
export const MAHJONG_TILE_BACK = 'back.svg'

/** 全部牌面（42 种：万/饼/条 各9，四风+三箭，四花+四季） */
export const MAHJONG_TILES = [
${rows}
]

const _base = () =>
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './'

/** 依 id 或文件名取牌面 URL；base 默认站点 BASE_URL，可传 './' 之类覆盖 */
export function mahjongTileUrl(idOrFile, base = _base()) {
  const file = idOrFile.endsWith('.svg')
    ? idOrFile
    : (MAHJONG_TILES.find(t => t.id === idOrFile) || {}).file || MAHJONG_TILE_BACK
  return base + MAHJONG_TILE_DIR + file
}
`
}

// ---------- 预览页 ----------
const demoHtml = () => {
  const list = TILES.map(({ id, file, name }) => ({ id, file, name }))
  const groups = [
    ['万子', list.filter(t => t.id.startsWith('wan-'))],
    ['饼子', list.filter(t => t.id.startsWith('tong-'))],
    ['条子', list.filter(t => t.id.startsWith('tiao-'))],
    ['字牌', list.filter(t => t.id.startsWith('feng-') || t.id.startsWith('jian-'))],
    ['花牌', list.filter(t => t.id.startsWith('hua-') || t.id.startsWith('ji-'))],
  ]
  const hand = ['wan-2', 'wan-3', 'wan-4', 'tong-3', 'tong-4', 'tong-5', 'tiao-6', 'tiao-7', 'tiao-8', 'feng-dong', 'feng-dong', 'jian-zhong', 'hua-mei']
  const handHtml = hand
    .map(id => `<img class="tile" src="tiles/${id}.svg" alt="${id}" draggable="false">`)
    .join('\n      ')
  const drawn = `<img class="tile drawn" src="tiles/tiao-5.svg" alt="摸牌" draggable="false">`

  const section = ([title, tiles]) => `
    <h2>${title}</h2>
    <div class="grid">
      ${tiles.map(t => `<figure><img src="tiles/${t.file}" alt="${t.name}" draggable="false"><figcaption>${t.name}</figcaption></figure>`).join('\n      ')}
    </div>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>麻将牌面 SVG · 手机适配预览</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: #14352a; color: #e8e4d8; min-height: 100vh;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    user-select: none; -webkit-user-select: none;
  }
  header { padding: 14px 16px 6px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header p { font-size: 12px; opacity: .7; margin-top: 4px; }
  h2 { font-size: 14px; font-weight: 600; padding: 14px 16px 8px; color: #cfe0d4; }
  .grid { display: flex; flex-wrap: wrap; gap: 8px 6px; padding: 0 14px; }
  figure { width: clamp(40px, 12vw, 56px); text-align: center; }
  figure img { width: 100%; display: block; filter: drop-shadow(0 2px 2px rgba(0,0,0,.35)); }
  figcaption { font-size: 10px; opacity: .65; margin-top: 3px; }

  /* ---- 牌桌演示 ---- */
  .table { margin: 16px 10px 24px; border-radius: 16px; overflow: hidden;
    background: radial-gradient(ellipse at 50% 35%, #2b6b4f 0%, #1c4a37 70%, #173e2f 100%);
    border: 1px solid #0f2c20; padding: 14px 0 18px; }
  .table .label { text-align: center; font-size: 11px; color: #b8d4c2; padding: 2px 0 10px; }
  .opponents { display: flex; justify-content: center; gap: 4px; }
  .opponents img { width: 26px; filter: drop-shadow(0 1px 1px rgba(0,0,0,.4)); }
  .river { display: grid; grid-template-columns: repeat(6, 26px); gap: 3px; justify-content: center; margin: 12px 0; min-height: 40px; }
  .river img { width: 26px; }
  .river .slot { width: 26px; height: 36px; border-radius: 4px; background: rgba(0,0,0,.12); }
  .hand { display: flex; gap: 2px; overflow-x: auto; padding: 26px 10px 4px; scrollbar-width: none; }
  .hand::-webkit-scrollbar { display: none; }
  .hand .tile { flex: 0 0 auto; width: clamp(42px, 12.5vw, 58px); cursor: pointer;
    transition: transform .12s ease, filter .12s ease;
    filter: drop-shadow(0 3px 3px rgba(0,0,0,.4)); touch-action: manipulation; }
  .hand .tile.drawn { margin-left: 10px; }
  .hand .tile.up { transform: translateY(-16px); filter: drop-shadow(0 8px 6px rgba(0,0,0,.5)); }
  .actions { display: flex; justify-content: center; gap: 10px; margin-top: 10px; }
  .actions button { font-size: 14px; padding: 8px 22px; border-radius: 999px; border: 0;
    background: #e8b64c; color: #3a2a08; font-weight: 600; touch-action: manipulation; }
  .actions button:disabled { opacity: .4; }
  footer { font-size: 11px; color: #9db8a8; padding: 0 16px 24px; line-height: 1.7; }
  footer code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>麻将牌面 · SVG 全套</h1>
  <p>万饼条 1-9 · 东南西北 · 中发白 · 梅兰竹菊 · 春夏秋冬 · 牌背，共 43 个文件</p>
</header>

<div class="table">
  <div class="label">对家</div>
  <div class="opponents">${'<img src="tiles/back.svg" alt="牌背">'.repeat(13)}</div>
  <div class="river" id="river">
    ${'<div class="slot"></div>'.repeat(6)}
  </div>
  <div class="hand" id="hand">
      ${handHtml}
      ${drawn}
  </div>
  <div class="actions"><button id="discardBtn" disabled>打出</button></div>
</div>
${groups.map(section).join('\n')}
<footer>
  文件：<code>public/mahjong/tiles/&lt;id&gt;.svg</code>（id 见 <code>src/data/mahjong-tiles.js</code>）<br>
  雪碧图：<code>public/mahjong/sprite.svg</code>，用法 <code>&lt;use href="mahjong/sprite.svg#wan-1"&gt;</code><br>
  字体：牌面汉字走系统楷体回退链，Android 无楷体时退化为衬线/黑体，仍可读。<br>
  触控：手牌 width ≥42px，点按抬牌，按钮打出；横竖屏自适应。
</footer>
<script>
const hand = document.getElementById('hand')
const river = document.getElementById('river')
const btn = document.getElementById('discardBtn')
let selected = null
hand.addEventListener('click', e => {
  const t = e.target.closest('.tile')
  if (!t) return
  if (selected === t) { t.classList.remove('up'); selected = null }
  else { selected && selected.classList.remove('up'); selected = t; t.classList.add('up') }
  btn.disabled = !selected
})
btn.addEventListener('click', () => {
  if (!selected) return
  const img = selected.cloneNode()
  img.className = ''; img.style.width = '26px'
  const slot = river.querySelector('.slot')
  slot ? slot.replaceWith(img) : river.appendChild(img)
  selected.remove(); selected = null; btn.disabled = true
})
</script>
</body>
</html>
`
}

// ---------- 写出 ----------
mkdirSync(TILES_DIR, { recursive: true })
mkdirSync(DATA_DIR, { recursive: true })
for (const t of TILES) writeFileSync(path.join(TILES_DIR, t.file), t.svg)
writeFileSync(path.join(TILES_DIR, 'back.svg'), backSvg())
writeFileSync(path.join(OUT_DIR, 'sprite.svg'), sprite())
writeFileSync(path.join(OUT_DIR, 'index.html'), demoHtml())
writeFileSync(path.join(DATA_DIR, 'mahjong-tiles.js'), manifestJs())

console.log(`已生成 ${TILES.length} 张牌面 + 牌背`)
console.log(`  tiles/      ${TILES_DIR}`)
console.log(`  sprite.svg  ${path.join(OUT_DIR, 'sprite.svg')}`)
console.log(`  index.html  ${path.join(OUT_DIR, 'index.html')}`)
console.log(`  manifest    ${path.join(DATA_DIR, 'mahjong-tiles.js')}`)
