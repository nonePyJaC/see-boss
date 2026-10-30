import test from 'node:test'
import assert from 'node:assert/strict'
import { createWall, createWallLayout, wallLayoutStacks, openWall, drawWithFlowers, takeTile } from './online-wall.mjs'
import { ALL_TILES, maxCopies } from './tiles.mjs'

test('牌墙 144 张，各牌张数正确，随机源可复现', () => {
  const a = createWall(() => 0.5)
  assert.deepEqual(a, createWall(() => 0.5))
  assert.equal(a.length, 144)
  for (const tile of ALL_TILES) assert.equal(a.filter((t) => t === tile).length, maxCopies(tile), tile)
  assert.throws(() => createWall(() => 1))
})
test('墙头摸花后连续从墙尾补花，保留未取的牌', () => {
  const original = ['Z', '1m', '2m', 'f1', 'F']
  assert.deepEqual(drawWithFlowers(original), { tile: '2m', flowers: ['Z', 'F', 'f1'], wall: ['1m'] })
  assert.deepEqual(original, ['Z', '1m', '2m', 'f1', 'F'])
})
test('补花耗尽牌墙仍保留所有已摸到的花', () => {
  assert.deepEqual(drawWithFlowers(['Z', 'f1']), { tile: null, flowers: ['Z', 'f1'], wall: [] })
  assert.deepEqual(takeTile([], 'tail'), { tile: null, wall: [] })
  assert.throws(() => takeTile([], 'middle'))
})
test('骰子决定开墙位置，墙头与墙尾分别按墩消耗', () => {
  const values = [.2, .4], layout = createWallLayout(0, () => values.shift())
  assert.deepEqual(layout, { version: 2, dice: [2, 3], breakSeat: 0, breakStack: 15, headTaken: 0, tailTaken: 0 })
  layout.headTaken = 3; layout.tailTaken = 3
  const stacks = wallLayoutStacks(layout)
  assert.equal(stacks[0][15], 0); assert.equal(stacks[0][14], 1)
  assert.equal(stacks[0][16], 0); assert.equal(stacks[0][17], 1)
  assert.equal(stacks.flat().reduce((a, b) => a + b, 0), 138)
  for (let head = 0; head <= 144; head++) {
    for (const tail of [0, Math.floor((144 - head) / 2), 144 - head]) {
      const tiles = wallLayoutStacks({ ...layout, headTaken: head, tailTaken: tail }).flat()
      assert.ok(tiles.every((n) => n >= 0 && n <= 2))
      assert.equal(tiles.reduce((a, b) => a + b, 0), 144 - head - tail)
    }
  }
  assert.throws(() => createWallLayout(0, () => 1))
  const physicalWall = Array.from({ length: 144 }, (_, i) => i)
  const opened = openWall(physicalWall, layout)
  assert.deepEqual(opened.slice(0, 4), [30, 31, 28, 29])
  assert.equal(opened.at(-1), 33)
  const otherValues = [0, .5]
  const otherLayout = createWallLayout(0, () => otherValues.shift())
  assert.equal(otherLayout.breakSeat, layout.breakSeat)
  assert.equal(otherLayout.breakStack, 16)
  const another = openWall(physicalWall, { ...layout, breakSeat: 1 })
  assert.notEqual(opened[0], another[0])
  assert.deepEqual(physicalWall, Array.from({ length: 144 }, (_, i) => i))
})
