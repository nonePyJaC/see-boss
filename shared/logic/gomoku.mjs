export const SIZE = 15
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]]
export const emptyBoard = () => Array(SIZE * SIZE).fill(0)
export const defaultRules = () => ({ doubleThree: false, doubleFour: false, overline: false })
const at = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE ? y * SIZE + x : -1
function line(board, index, dx, dy) {
  const x = index % SIZE, y = Math.floor(index / SIZE), points = []
  for (let n = -14; n <= 14; n++) { const i = at(x + n * dx, y + n * dy); if (i >= 0) points.push(i) }
  return points
}
function runs(board, index, color) {
  return DIRECTIONS.map(([dx, dy]) => {
    const l = line(board, index, dx, dy), p = l.indexOf(index); let a = p, b = p
    while (a > 0 && board[l[a - 1]] === color) a--
    while (b + 1 < l.length && board[l[b + 1]] === color) b++
    return l.slice(a, b + 1)
  })
}
// One four can have two winning ends; identify it by its four stones.
function fours(board, index, rules) {
  const found = new Map()
  for (const [dx, dy] of DIRECTIONS) {
    const l = line(board, index, dx, dy), pos = l.indexOf(index)
    for (let start = Math.max(0, pos - 4); start <= Math.min(pos, l.length - 5); start++) {
      const window = l.slice(start, start + 5), stones = window.filter(i => board[i] === 1), empty = window.filter(i => !board[i])
      if (stones.length !== 4 || empty.length !== 1) continue
      const copy = board.slice(); copy[empty[0]] = 1
      const lengths = runs(copy, empty[0], 1).map(r => r.length)
      if (!lengths.includes(5) && rules.overline) continue
      if (rules.overline && runs(copy, empty[0], 1).find((r, n) => DIRECTIONS[n][0] === dx && DIRECTIONS[n][1] === dy)?.length !== 5) continue
      const key = stones.slice().sort((a,b) => a-b).join(',')
      if (!found.has(key)) found.set(key, new Set())
      found.get(key).add(empty[0])
    }
  }
  return found
}
function candidateThrees(board, index, rules) {
  const found = new Map()
  for (const [dx, dy] of DIRECTIONS) {
    const l = line(board, index, dx, dy), pos = l.indexOf(index)
    for (let start = Math.max(0, pos - 4); start <= Math.min(pos - 1, l.length - 6); start++) {
      const w = l.slice(start, start + 6)
      if (board[w[0]] || board[w[5]]) continue
      const middle = w.slice(1,5), stones = middle.filter(i => board[i] === 1), spaces = middle.filter(i => !board[i])
      if (stones.length !== 3 || spaces.length !== 1 || !stones.includes(index)) continue
      // Extensions must leave both ends as exact-five wins, not overlines.
      if (rules.overline && ((start > 0 && board[l[start-1]] === 1) || (start+6 < l.length && board[l[start+6]] === 1))) continue
      const key = stones.slice().sort((a,b) => a-b).join(',')
      if (!found.has(key)) found.set(key, new Set())
      found.get(key).add(spaces[0])
    }
  }
  return found
}
function forbidden(board, index, rules, memo = new Map()) {
  const lengths = runs(board, index, 1).map(r => r.length)
  // A five takes precedence over forbidden formations.
  if (lengths.some(n => n === 5 || (!rules.overline && n > 5))) return null
  if (rules.overline && lengths.some(n => n > 5)) return '长连禁手'
  if (rules.doubleFour && fours(board, index, rules).size >= 2) return '四四禁手'
  if (!rules.doubleThree) return null
  const key = index + ':' + board.join('')
  if (memo.has(key)) return memo.get(key)
  const candidates = candidateThrees(board, index, rules)
  if (candidates.size < 2) { memo.set(key, null); return null }
  let valid = 0
  for (const extensions of candidates.values()) {
    for (const extension of extensions) {
      const next = board.slice(); next[extension] = 1
      if (runs(next, extension, 1).some(r => r.length >= 5)) continue
      if (!forbidden(next, extension, rules, memo)) { valid++; break }
    }
    if (valid >= 2) { memo.set(key, '三三禁手'); return '三三禁手' }
  }
  memo.set(key, null); return null
}
export function play(state, index) {
  if (state.phase !== 'playing') return { error: '棋局尚未开始或已结束' }
  if (!Number.isInteger(index) || index < 0 || index >= SIZE * SIZE) return { error: '落点无效' }
  if (state.board[index]) return { error: '此处已有棋子' }
  const board = state.board.slice(), color = state.turn; board[index] = color
  const rules = state.rules
  if (color === 1) {
    const reason = forbidden(board, index, rules)
    if (reason) return { state: { ...state, board, turn: color, phase: 'finished', winner: 2,
      reason: `黑棋${reason}判负`, winning: [], lastMove: index, moveNo: state.moveNo + 1 } }
  }
  const lines = runs(board, index, color)
  const winning = lines.find(r => color === 1 && rules.overline ? r.length === 5 : r.length >= 5)
  const phase = winning || board.every(Boolean) ? 'finished' : 'playing'
  return { state: { ...state, board, turn: phase === 'playing' ? 3-color : color, phase, winner: winning ? color : 0, winning: winning || [], lastMove: index, moveNo: state.moveNo + 1 } }
}
export function newGame(rules = {}) {
  return { board: emptyBoard(), turn: 1, phase: 'playing', winner: null, winning: [], lastMove: null, moveNo: 0,
    rules: { doubleThree: rules.doubleThree === true, doubleFour: rules.doubleFour === true, overline: rules.overline === true } }
}
