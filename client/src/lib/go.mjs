export const SIZE = 19
export const emptyBoard = () => Array(SIZE * SIZE).fill(0)
const neighbors = i => [i % SIZE ? i - 1 : -1, i % SIZE < SIZE - 1 ? i + 1 : -1, i >= SIZE ? i - SIZE : -1, i < SIZE * (SIZE - 1) ? i + SIZE : -1].filter(n => n >= 0)
export function group(board, start) {
  const color = board[start], stones = new Set([start]), liberties = new Set(), stack = [start]
  while (stack.length) for (const n of neighbors(stack.pop())) {
    if (!board[n]) liberties.add(n)
    else if (board[n] === color && !stones.has(n)) { stones.add(n); stack.push(n) }
  }
  return { stones, liberties }
}
export function play(board, index, color, previousBoards = []) {
  if (index < 0 || index >= board.length || board[index]) return { error: '此处已有棋子' }
  const next = board.slice(); next[index] = color
  let captured = 0
  for (const n of neighbors(index)) if (next[n] === 3 - color) {
    const g = group(next, n)
    if (!g.liberties.size) for (const s of g.stones) { next[s] = 0; captured++ }
  }
  if (!group(next, index).liberties.size) return { error: '不能下在无气的位置' }
  if (previousBoards.includes(next.join(''))) return { error: '不能重复此前的棋形（禁全局同形）' }
  return { board: next, captured }
}
export function handicapBoard(count) {
  const board = emptyBoard()
  const points = [[3,15],[15,3],[15,15],[3,3],[9,9],[3,9],[15,9],[9,3],[9,15]]
  const order = { 0: [], 2: [0,1], 3: [0,1,2], 4: [0,1,2,3], 5: [0,1,2,3,4], 6: [0,1,2,3,5,6], 7: [0,1,2,3,5,6,4], 8: [0,1,2,3,5,6,7,8], 9: [0,1,2,3,5,6,7,8,4] }
  for (const p of order[count] || []) { const [x,y] = points[p]; board[y * SIZE + x] = 1 }
  return board
}
export function score(board, dead = new Set(), komi = 7.5) {
  const b = board.map((v, i) => dead.has(i) ? 0 : v)
  const result = { blackStones: 0, whiteStones: 0, blackTerritory: 0, whiteTerritory: 0, neutral: 0, ownership: Array(b.length).fill(0) }
  const visited = new Set()
  for (let i = 0; i < b.length; i++) {
    if (b[i]) { result[b[i] === 1 ? 'blackStones' : 'whiteStones']++; continue }
    if (visited.has(i)) continue
    const area = [i], stack = [i], borders = new Set(); visited.add(i)
    while (stack.length) for (const n of neighbors(stack.pop())) {
      if (b[n]) borders.add(b[n])
      else if (!visited.has(n)) { visited.add(n); stack.push(n); area.push(n) }
    }
    const owner = borders.size === 1 ? [...borders][0] : 0
    result[owner === 1 ? 'blackTerritory' : owner === 2 ? 'whiteTerritory' : 'neutral'] += area.length
    for (const n of area) result.ownership[n] = owner
  }
  result.black = result.blackStones + result.blackTerritory
  result.white = result.whiteStones + result.whiteTerritory + Number(komi)
  return result
}
