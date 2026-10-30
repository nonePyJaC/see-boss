import { request } from './http.js'
import { getUid } from './account-repo.js'

const auth = (roomId, cred) => ({ uid: getUid(), roomId, ...cred })
export const mahjongReady = (roomId, cred, state, ready = true) => request('/api/mahjong/ready', {
  ...auth(roomId, cred), matchId: state.matchId, handId: state.handId, ready,
})
export const mahjongStart = (roomId, cred, state) => request('/api/room/start', {
  ...auth(roomId, cred), matchId: state.matchId, handId: state.handId,
})
export const mahjongAction = (roomId, cred, state, action) => request('/api/room/action', {
  ...auth(roomId, cred), matchId: state.matchId, handId: state.handId, windowId: state.windowId, action,
})
export const mahjongReset = (roomId, cred, state) => request('/api/mahjong/reset', {
  ...auth(roomId, cred), matchId: state.matchId, handId: state.handId,
})
