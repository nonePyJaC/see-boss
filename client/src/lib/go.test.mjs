import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyBoard, play, placeSetup, handicapBoard, score, SIZE } from './go.mjs'
test('提子、自杀和重复棋形', () => {
  const b = emptyBoard(); b[1] = 2; b[0] = 1; b[2] = 1
  const capture = play(b, SIZE + 1, 1)
  assert.equal(capture.captured, 1); assert.equal(capture.board[1], 0)
  assert.ok(play(capture.board, 1, 2).error)
  assert.ok(play(b, SIZE + 1, 1, [capture.board.join('')]).error)
})
test('让子和数子包含中立点与死子', () => {
  assert.equal(handicapBoard(9).filter(Boolean).length, 9)
  assert.equal(score(emptyBoard()).neutral, 361)
  const b = Array(361).fill(1); b[0] = 2; b[1] = 0
  const s = score(b, new Set([0]), 7.5)
  assert.equal(s.black, 361); assert.equal(s.white, 7.5)
})

test('摆子时自动提掉整块棋，也可关闭以摆出特殊局面', () => {
  const b = emptyBoard(); b[20] = 2; b[21] = 2
  for (const i of [1, 2, 19, 22, 39]) b[i] = 1
  const captured = placeSetup(b, 40, 1)
  assert.equal(captured.captured, 2)
  assert.equal(captured.board[20], 0); assert.equal(captured.board[21], 0)
  assert.equal(b[20], 2)
  const free = placeSetup(b, 40, 1, false)
  assert.equal(free.captured, 0); assert.equal(free.board[20], 2)
})
test('正常落子提掉多个相邻棋块，仍有气时不提', () => {
  const b = emptyBoard(); b[1] = 2; b[19] = 2; b[2] = 1; b[20] = 1; b[38] = 1
  const move = play(b, 0, 1)
  assert.equal(move.captured, 2); assert.equal(move.board[1], 0); assert.equal(move.board[19], 0)
  const alive = emptyBoard(); alive[20] = 2; alive[19] = 1; alive[1] = 1
  assert.equal(play(alive, 21, 1).board[20], 2)
})
