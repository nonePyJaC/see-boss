// A failed cutover must restore and verify the previous service before returning.
export async function releaseTransaction({ activate, verifyNew, restore, verifyOld, persist }) {
  try {
    await activate()
    await verifyNew()
    await persist()
  } catch (failure) {
    try {
      await restore()
      await verifyOld()
      await persist()
    } catch (rollback) {
      throw new Error(`发布失败且回滚未完成：${failure.message}；回滚：${rollback.message}`)
    }
    throw new Error(`发布失败，已恢复并验证旧服务：${failure.message}`)
  }
}
