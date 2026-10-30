import { DRAGON_FLOWERS, NUMBER_TILES, SEASON_FLOWERS, isFlower } from './tiles.mjs'

/** 构造 144 张南京牌。数组的开头为墙头，末尾为墙尾。 */
function secureRandom() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('缺少安全随机源')
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000
}
/** 开墙信息只记录物理位置和数量，不包含任何牌面。 */
export function createWallLayout(dealer, rng = secureRandom) {
  if (!Number.isInteger(dealer) || dealer < 0 || dealer > 3 || typeof rng !== 'function') throw new Error('开墙参数无效')
  const roll = () => {
    const value = rng()
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源必须返回 [0,1)')
    return Math.floor(value * 6) + 1
  }
  const dice = [roll(), roll()], sum = dice[0] + dice[1]
  const breakSeat = (dealer + sum - 1) % 4
  const breakStack = 17 - Math.min(...dice)
  return { version: 2, dice, breakSeat, breakStack, headTaken: 0, tailTaken: 0 }
}

/** 按开口和两端取牌次数重建四面牌墙，每墩为 0、1、2 张。 */
export function wallLayoutStacks(layout) {
  const { breakSeat, breakStack, headTaken, tailTaken } = layout
  const stacks = Array(72).fill(2), start = breakSeat * 18 + breakStack
  const direction = layout.version === 2 ? -1 : 1
  for (let i = 0; i < headTaken; i++) stacks[(start + direction * Math.floor(i / 2) + 144) % 72]--
  for (let i = 0; i < tailTaken; i++) stacks[(start - direction * (1 + Math.floor(i / 2)) + 144) % 72]--
  return Array.from({ length: 4 }, (_, seat) => stacks.slice(seat * 18, seat * 18 + 18))
}

/** 洗好的物理牌墙从掷骰开口切开，转换为墙头到墙尾的取牌顺序。 */
export function openWall(wall, layout) {
  if (!Array.isArray(wall) || wall.length !== 144) throw new Error('牌墙无效')
  const start = layout.breakSeat * 18 + layout.breakStack
  const result = []
  for (let i = 0; i < 72; i++) {
    const stack = (start - i + 72) % 72
    result.push(wall[stack * 2], wall[stack * 2 + 1])
  }
  return result
}
export function createWall(rng = secureRandom) {
  if (typeof rng !== 'function') throw new Error('随机源无效')
  const wall = [...NUMBER_TILES.flatMap((tile) => Array(4).fill(tile)),
    ...DRAGON_FLOWERS.flatMap((tile) => Array(4).fill(tile)), ...SEASON_FLOWERS]
  for (let i = wall.length - 1; i > 0; i--) {
    const value = rng()
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源必须返回 [0,1)')
    const j = Math.floor(value * (i + 1))
    ;[wall[i], wall[j]] = [wall[j], wall[i]]
  }
  return wall
}

/** 从指定方向摸一张；不会修改传入牌墙。 */
export function takeTile(wall, end = 'head') {
  if (!Array.isArray(wall)) throw new Error('牌墙无效')
  if (end !== 'head' && end !== 'tail') throw new Error('摸牌方向无效')
  if (!wall.length) return { tile: null, wall: [] }
  return end === 'head'
    ? { tile: wall[0], wall: wall.slice(1) }
    : { tile: wall[wall.length - 1], wall: wall.slice(0, -1) }
}

/** 自动补花：第一张从指定方向取得，遇花持续从墙尾补，空墙时返回已取得的花。 */
export function drawWithFlowers(wall, end = 'head') {
  let current = wall.slice()
  const flowers = []
  let direction = end
  while (true) {
    const result = takeTile(current, direction)
    current = result.wall
    if (result.tile === null || !isFlower(result.tile)) return { tile: result.tile, flowers, wall: current }
    flowers.push(result.tile)
    direction = 'tail'
  }
}
