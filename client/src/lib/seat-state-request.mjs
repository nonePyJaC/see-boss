/** 将请求绑定到发出时的房间与座位身份；凭证只在内存比较，不写日志。 */
export function captureSeatRequest(roomId, credential) {
  return {
    roomId: String(roomId),
    credential: credential ? { seatId: credential.seatId, seatToken: credential.seatToken } : null,
  }
}

export function isCurrentSeatRequest(request, roomId, credential) {
  return request.roomId === String(roomId)
    && (request.credential?.seatId ?? null) === (credential?.seatId ?? null)
    && (request.credential?.seatToken ?? null) === (credential?.seatToken ?? null)
}
