import test from 'node:test'
import assert from 'node:assert/strict'
import { cardFacts, priceFacts, canonicalCard, cardText } from './prompt-facts.mjs'

// 匿名构造的牌型/赔率场景；不读写玩家复盘或线上数据。
const cards = (myCards, board, gameType = 'long') => cardFacts({ myCards, board, gameType }).join('\n')
const price = (more) => priceFacts({ phase: 'river', pot: 0, currentBet: 0, myBet: 0, mySeeds: 5000,
  mySeatId: 'me', publicPlayers: [], publicActions: [], ...more }).join('\n')

test('兼容引擎和旧编码，缺失/重复牌不生成虚构事实', () => {
  assert.equal(canonicalCard('As'), 'As')
  assert.equal(canonicalCard('s14'), 'As')
  assert.equal(cardText(['As', 'h10', 'Kd']), '♠A ♥10 ♦K')
  assert.match(cards(['As', 'As'], ['7d', '8c', '9h']), /无法提供确定性/)
  assert.match(cards(['?', 'As'], []), /无法提供确定性/)
})

test('次对和最高踢脚明确给出，不由模型自行猜牌型', () => {
  assert.match(cards(['Ah', '9c'], ['9s', '6c', 'Qh']), /一对 9；踢脚 A、Q、6/)
  assert.match(cards(['Ah', '9c'], ['9s', '6c', 'Qh']), /第 2 对（次对）/)
})

test('两对和公共牌踢脚，以及七张中三对时的真正最佳五张', () => {
  assert.match(cards(['Ad', '5c'], ['2h', '9d', 'As', '9c', 'Kh']), /两对 A 和 9；踢脚 K/)
  assert.match(cards(['Ad', 'Ac'], ['Kh', 'Kd', 'Qs', 'Qh', '2c']), /两对 A 和 K；踢脚 Q/)
})

test('两头顺子和轮子卡顺的补牌张数/概率，不冒充胜率', () => {
  const open = cards(['Ah', 'Tc'], ['8d', '7s', '9h', 'Qd'])
  assert.match(open, /补牌点数 6、J，8 张未知牌；下一张成顺概率 17.39%/)
  assert.match(open, /不是干净赢牌补牌数，也不是摊牌胜率/)
  const wheel = cards(['5h', '3c'], ['2d', '9h', 'Ah', '9c'])
  assert.match(wheel, /补牌点数 4，4 张未知牌；下一张成顺概率 8.70%/)
  assert.match(cards(['8s', '2c'], ['Ts', '7c', 'Kh', '9h']), /补牌点数 6、J，8 张/)
})

test('J高同花听牌不误称坚果，河牌次坚果同花不当成小同花', () => {
  const draw = cards(['Js', '3s'], ['4d', 'As', '8s'])
  assert.match(draw, /♠同花听牌：9 张未知牌/)
  assert.match(draw, /更高同色牌 ♠Q ♠K，不能据此称为坚果同花听牌/)
  const made = cards(['Js', '3s'], ['As', 'Ks', '8s', '6h', '2d'])
  assert.match(made, /同花；点数从大到小 A、K、J、8、3/)
  assert.match(made, /次坚果同花/)
  assert.match(made, /更高同花需未知高张 ♠Q/)
  assert.match(made, /河牌已无下一张牌/)
})

test('公共顺子/同花不等于独赢；成对牌面不能因坚果同花忽略葫芦', () => {
  assert.match(cards(['2h', '3d'], ['Ts', 'Jh', 'Qd', 'Kc', 'As']), /底牌未提高五张牌力/)
  const flush = cards(['As', '2s'], ['Ks', '8s', '3s', 'Kh', '9d'])
  assert.match(flush, /坚果同花（仅按同花差异高张分层，不代表绝对坚果）/)
  assert.match(flush, /葫芦或四条风险/)
})

test('短牌按36张与A6789计算补牌、牌型，不能使用长牌52张分母', () => {
  assert.match(cards(['Ah', '6c'], ['7d', '8s', 'Kh', 'Qc'], 'short'), /补牌点数 9，4 张未知牌；下一张成顺概率 13.33%/)
  assert.match(cards(['Ah', '6c'], ['7d', '8s', '9h'], 'short'), /顺子，9 高/)
  assert.match(cards(['Ah', '2c'], [], 'short'), /无法提供确定性/)
})

test('下注比例使用出手前底池；赔率用底池加跟注成本', () => {
  const full = price({ pot: 1800, currentBet: 900, publicActions: [
    { seatId: 'villain', type: 'bet', phase: 'river', amount: 900, betTotal: 900 },
  ] })
  assert.match(full, /底池赔率 2:1；静态盈亏平衡权益 33.33% = 900\/\(1800\+900\)/)
  assert.match(full, /投入 900 \/ 出手前底池 900 = 100.00%/)
  assert.match(price({ phase: 'flop', pot: 800, publicActions: [
    { seatId: 'villain', type: 'bet', phase: 'flop', amount: 200, betTotal: 200 },
  ] }), /投入 200 \/ 出手前底池 600 = 33.33%/)
  assert.match(price({ pot: 8300, currentBet: 2700, mySeeds: 2700 }), /底池赔率 3.074:1；静态盈亏平衡权益 24.55%/)
})

test('短码全下只计算可争夺部分，保留弃牌者已投入的死钱', () => {
  const text = price({ pot: 2300, currentBet: 1000, myBet: 100, mySeeds: 100,
    publicPlayers: [
      { seatId: 'me', totalBet: 100 }, { seatId: 'a', totalBet: 1000 },
      { seatId: 'b', totalBet: 1000 }, { seatId: 'folded', totalBet: 200, folded: true },
    ] })
  assert.match(text, /平注尚欠 900，本次跟注实际投入 100（只能短码全下/)
  assert.match(text, /可争夺底池 700，跟注后 800/)
  assert.match(text, /静态盈亏平衡权益 12.50%/)
  assert.ok(!text.includes('按全池简化'))
})

test('免费过牌不虚构跟注成本；缺失边池数据明确说明近似', () => {
  assert.match(price({ pot: 500 }), /过牌成本 0/)
  assert.match(price({ pot: 500, currentBet: 100 }), /累计投入数据不足/)
})
