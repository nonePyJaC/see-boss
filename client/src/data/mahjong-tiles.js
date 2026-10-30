// 由 scripts/generate-mahjong-tiles.mjs 生成，请勿手改
// 牌面 SVG 位于 client/public/mahjong/tiles/，构建后随 dist 输出
export const MAHJONG_TILE_DIR = 'mahjong/tiles/'
export const MAHJONG_TILE_BACK = 'back.svg'

/** 全部牌面（42 种：万/饼/条 各9，四风+三箭，四花+四季） */
export const MAHJONG_TILES = [
  { id: 'wan-1', file: 'wan-1.svg', name: '一万', suit: 'wan', rank: 1, kind: 'suit', notation: '1m', unicode: '🀇' },
  { id: 'wan-2', file: 'wan-2.svg', name: '二万', suit: 'wan', rank: 2, kind: 'suit', notation: '2m', unicode: '🀈' },
  { id: 'wan-3', file: 'wan-3.svg', name: '三万', suit: 'wan', rank: 3, kind: 'suit', notation: '3m', unicode: '🀉' },
  { id: 'wan-4', file: 'wan-4.svg', name: '四万', suit: 'wan', rank: 4, kind: 'suit', notation: '4m', unicode: '🀊' },
  { id: 'wan-5', file: 'wan-5.svg', name: '五万', suit: 'wan', rank: 5, kind: 'suit', notation: '5m', unicode: '🀋' },
  { id: 'wan-6', file: 'wan-6.svg', name: '六万', suit: 'wan', rank: 6, kind: 'suit', notation: '6m', unicode: '🀌' },
  { id: 'wan-7', file: 'wan-7.svg', name: '七万', suit: 'wan', rank: 7, kind: 'suit', notation: '7m', unicode: '🀍' },
  { id: 'wan-8', file: 'wan-8.svg', name: '八万', suit: 'wan', rank: 8, kind: 'suit', notation: '8m', unicode: '🀎' },
  { id: 'wan-9', file: 'wan-9.svg', name: '九万', suit: 'wan', rank: 9, kind: 'suit', notation: '9m', unicode: '🀏' },
  { id: 'tong-1', file: 'tong-1.svg', name: '一饼', suit: 'tong', rank: 1, kind: 'suit', notation: '1p', unicode: '🀙' },
  { id: 'tong-2', file: 'tong-2.svg', name: '二饼', suit: 'tong', rank: 2, kind: 'suit', notation: '2p', unicode: '🀚' },
  { id: 'tong-3', file: 'tong-3.svg', name: '三饼', suit: 'tong', rank: 3, kind: 'suit', notation: '3p', unicode: '🀛' },
  { id: 'tong-4', file: 'tong-4.svg', name: '四饼', suit: 'tong', rank: 4, kind: 'suit', notation: '4p', unicode: '🀜' },
  { id: 'tong-5', file: 'tong-5.svg', name: '五饼', suit: 'tong', rank: 5, kind: 'suit', notation: '5p', unicode: '🀝' },
  { id: 'tong-6', file: 'tong-6.svg', name: '六饼', suit: 'tong', rank: 6, kind: 'suit', notation: '6p', unicode: '🀞' },
  { id: 'tong-7', file: 'tong-7.svg', name: '七饼', suit: 'tong', rank: 7, kind: 'suit', notation: '7p', unicode: '🀟' },
  { id: 'tong-8', file: 'tong-8.svg', name: '八饼', suit: 'tong', rank: 8, kind: 'suit', notation: '8p', unicode: '🀠' },
  { id: 'tong-9', file: 'tong-9.svg', name: '九饼', suit: 'tong', rank: 9, kind: 'suit', notation: '9p', unicode: '🀡' },
  { id: 'tiao-1', file: 'tiao-1.svg', name: '幺鸡', suit: 'tiao', rank: 1, kind: 'suit', notation: '1s', unicode: '🀐' },
  { id: 'tiao-2', file: 'tiao-2.svg', name: '二条', suit: 'tiao', rank: 2, kind: 'suit', notation: '2s', unicode: '🀑' },
  { id: 'tiao-3', file: 'tiao-3.svg', name: '三条', suit: 'tiao', rank: 3, kind: 'suit', notation: '3s', unicode: '🀒' },
  { id: 'tiao-4', file: 'tiao-4.svg', name: '四条', suit: 'tiao', rank: 4, kind: 'suit', notation: '4s', unicode: '🀓' },
  { id: 'tiao-5', file: 'tiao-5.svg', name: '五条', suit: 'tiao', rank: 5, kind: 'suit', notation: '5s', unicode: '🀔' },
  { id: 'tiao-6', file: 'tiao-6.svg', name: '六条', suit: 'tiao', rank: 6, kind: 'suit', notation: '6s', unicode: '🀕' },
  { id: 'tiao-7', file: 'tiao-7.svg', name: '七条', suit: 'tiao', rank: 7, kind: 'suit', notation: '7s', unicode: '🀖' },
  { id: 'tiao-8', file: 'tiao-8.svg', name: '八条', suit: 'tiao', rank: 8, kind: 'suit', notation: '8s', unicode: '🀗' },
  { id: 'tiao-9', file: 'tiao-9.svg', name: '九条', suit: 'tiao', rank: 9, kind: 'suit', notation: '9s', unicode: '🀘' },
  { id: 'feng-dong', file: 'feng-dong.svg', name: '东风', suit: 'feng', rank: null, kind: 'honor', notation: '1z', unicode: '🀀' },
  { id: 'feng-nan', file: 'feng-nan.svg', name: '南风', suit: 'feng', rank: null, kind: 'honor', notation: '2z', unicode: '🀁' },
  { id: 'feng-xi', file: 'feng-xi.svg', name: '西风', suit: 'feng', rank: null, kind: 'honor', notation: '3z', unicode: '🀂' },
  { id: 'feng-bei', file: 'feng-bei.svg', name: '北风', suit: 'feng', rank: null, kind: 'honor', notation: '4z', unicode: '🀃' },
  { id: 'jian-zhong', file: 'jian-zhong.svg', name: '红中', suit: 'jian', rank: null, kind: 'honor', notation: '5z', unicode: '🀄' },
  { id: 'jian-fa', file: 'jian-fa.svg', name: '发财', suit: 'jian', rank: null, kind: 'honor', notation: '6z', unicode: '🀅' },
  { id: 'jian-bai', file: 'jian-bai.svg', name: '白板', suit: 'jian', rank: null, kind: 'honor', notation: '7z', unicode: '🀆' },
  { id: 'hua-mei', file: 'hua-mei.svg', name: '梅花', suit: 'hua', rank: 1, kind: 'bonus', notation: 'f1', unicode: '🀢' },
  { id: 'hua-lan', file: 'hua-lan.svg', name: '兰花', suit: 'hua', rank: 2, kind: 'bonus', notation: 'f2', unicode: '🀣' },
  { id: 'hua-zhu', file: 'hua-zhu.svg', name: '竹花', suit: 'hua', rank: 3, kind: 'bonus', notation: 'f3', unicode: '🀤' },
  { id: 'hua-ju', file: 'hua-ju.svg', name: '菊花', suit: 'hua', rank: 4, kind: 'bonus', notation: 'f4', unicode: '🀥' },
  { id: 'ji-chun', file: 'ji-chun.svg', name: '春', suit: 'ji', rank: 1, kind: 'bonus', notation: 'f5', unicode: '🀦' },
  { id: 'ji-xia', file: 'ji-xia.svg', name: '夏', suit: 'ji', rank: 2, kind: 'bonus', notation: 'f6', unicode: '🀧' },
  { id: 'ji-qiu', file: 'ji-qiu.svg', name: '秋', suit: 'ji', rank: 3, kind: 'bonus', notation: 'f7', unicode: '🀨' },
  { id: 'ji-dong', file: 'ji-dong.svg', name: '冬', suit: 'ji', rank: 4, kind: 'bonus', notation: 'f8', unicode: '🀩' },
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
