import { chooseMove } from '@shared/logic/gomoku-ai.mjs'
self.onmessage = ({ data }) => {
  try { self.postMessage({ id:data.id, index:chooseMove(data.game, data.difficulty) }) }
  catch { self.postMessage({ id:data.id, error:'AI 思考失败，请重试' }) }
}
