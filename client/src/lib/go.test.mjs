import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyBoard, play, handicapBoard, score, SIZE } from './go.mjs'
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
