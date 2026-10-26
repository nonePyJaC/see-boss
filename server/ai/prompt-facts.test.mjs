import test from 'node:test'
import assert from 'node:assert/strict'
import { cardFacts, priceFacts, canonicalCard, cardText } from './prompt-facts.mjs'
import { buildMessages } from './llm.mjs'

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

test('v6 踢脚来源与超对明确，公共踢脚不冒充底牌优势', () => {
  assert.match(cards(['Kd', 'Qd'], ['Ks', 'Th', '2d', 'Qc']), /踢脚来源：底牌 无；公共牌 10/)
  assert.match(cards(['Kc', 'Tc'], ['Kh', 'As', '6h']), /踢脚来源：底牌 10；公共牌 A、6/)
  assert.match(cards(['Jc', 'Jh'], ['Td', '7c', '2h', '4s']), /口袋对 J 高于公共牌最高点数 10（超对）/)
  assert.ok(!cards(['Jc', 'Jh'], ['Td', '7c', '2h', '4s', 'Ah']).includes('（超对）'))
  assert.match(cards(['Qd', '4c'], ['9h', '9s', '9d', 'As', 'Kh']), /踢脚来源：底牌 无；公共牌 A、K/)
})

test('两对和公共牌踢脚，以及七张中三对时的真正最佳五张', () => {
  assert.match(cards(['Ad', '5c'], ['2h', '9d', 'As', '9c', 'Kh']), /两对 A 和 9；踢脚 K/)
  assert.match(cards(['Ad', 'Ac'], ['Kh', 'Kd', 'Qs', 'Qh', '2c']), /两对 A 和 K；踢脚 Q/)
  const trips = cards(['Qd', '4c'], ['9h', '9s', '9d', 'As', 'Kh'])
  assert.match(trips, /三条 9；踢脚 A、K/)
  assert.match(trips, /底牌未提高五张牌力/)
})

test('C2 构建输入区分公共两对踢脚、价格门槛与有对象的行动目的', () => {
  const [system, user] = buildMessages({ gameType: 'long', phase: 'river', mySeatId: 'a',
    myCards: ['Jc', '5d'], board: ['As', 'Ah', 'Ks', 'Kh', '2c'],
    pot: 1800, currentBet: 300, myBet: 0, mySeeds: 1000, actedSeatIds: ['b'],
    publicPlayers: [
      { seatId: 'a', seeds: 1000, bet: 0, totalBet: 600, folded: false, allIn: false },
      { seatId: 'b', seeds: 700, bet: 300, totalBet: 900, folded: false, allIn: false },
      { seatId: 'c', seeds: 1000, bet: 0, totalBet: 300, folded: true, allIn: false },
    ],
    publicActions: [{ seatId: 'b', type: 'bet', amount: 300, betTotal: 300, phase: 'river' }],
    legalActions: [{ type: 'fold' }, { type: 'call', amount: 300 }, { type: 'raise', min: 600, max: 1000 }],
  }, {}, [])
  assert.match(user.content, /两对 A 和 K；踢脚 J/)
  assert.match(user.content, /静态盈亏平衡权益 14.29% = 300\/\(1800\+300\)/)
  assert.match(user.content, /【可追加筹码对手】座2（后手 700）/)
  assert.match(system.content, /区分公共牌与底牌贡献/)
  assert.match(system.content, /是价格参考而非实际权益；结合可赢范围/)
  assert.match(system.content, /不因便宜自动跟，也不凭空放大风险/)
  assert.match(system.content, /价值下注要有可支付对手及可能跟注的较弱范围/)
  assert.match(system.content, /半诈唬\/诈唬须有可弃对象及合理弃牌机会/)
  assert.match(system.content, /不欠注只说明价格，不代表check优于下注/)
  assert.match(system.content, /大注或全压不作统一禁令/)
  assert.match(system.content, /遇危险新牌、较强反击或不合价格可改线或直接弃牌/)
  assert.match(system.content, /弱不同花断张不必硬跟/)
})

test('两头顺子和轮子卡顺的补牌张数/概率，不冒充胜率', () => {
  const open = cards(['Ah', 'Tc'], ['8d', '7s', '9h', 'Qd'])
  assert.match(open, /补牌点数 6、J，8 张未知牌；下一张成顺概率 17.39%/)
  const wheel = cards(['5h', '3c'], ['2d', '9h', 'Ah', '9c'])
  assert.match(wheel, /补牌点数 4，4 张未知牌；下一张成顺概率 8.70%/)
  assert.match(cards(['8s', '2c'], ['Ts', '7c', 'Kh', '9h']), /补牌点数 6、J，8 张/)
})

test('底牌显式标注花色与点数间隔，隔张不能误当连张', () => {
  assert.match(cards(['Qh', 'Tc'], []), /Q10，不同花；常规点数差 2，隔 1 张，非连张/)
  assert.match(cards(['8h', '5h'], []), /85，同花；常规点数差 3，隔 2 张，非连张/)
  assert.match(cards(['Kh', 'Qh'], []), /KQ，同花；常规点数差 1，连张/)
  assert.match(cards(['As', 'Ah'], []), /口袋对 A；不同花，点数相同，非连张/)
  assert.match(cards(['Qh', 'Tc'], ['2d', '7s', 'Jh']), /底牌结构：Q10，不同花；常规点数差 2，隔 1 张，非连张/)
})

test('A高位连张与长/短牌低位特例分开陈述', () => {
  assert.match(cards(['As', 'Kd'], []), /常规点数差 1，连张/)
  assert.match(cards(['As', '2d'], []), /非连张；A低位时点数差 1（低位相连）/)
  assert.match(cards(['As', '5d'], []), /A低位时点数差 4（低位隔3张）/)
  assert.match(cards(['As', '6d'], [], 'short'), /非连张；A低位时点数差 1（低位相连）/)
  assert.match(cards(['As', '9d'], [], 'short'), /A低位时点数差 4（低位隔3张）/)
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

test('零跟注成本只给中性价格事实；缺失边池数据明确说明近似', () => {
  assert.equal(price({ pot: 500 }), '本次跟注成本 0。')
  assert.match(price({ pot: 500, currentBet: 100 }), /累计投入数据不足/)
})
