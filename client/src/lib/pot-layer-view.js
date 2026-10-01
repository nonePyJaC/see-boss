/**
 * 线上结算奖池层的展示口径（review C-R2）。
 *
 * 「未匹配退回」只是层分类（服务端 isUncalledReturn），实际到账必须来自
 * 权威 awards 分配。awards 为空或缺失时绝不凭「出资人 + 层金额」凭空拼出
 * 退款数字——返回空 awards，由视图渲染空态标签。
 */

/**
 * @param {{isUncalledReturn?:boolean, contributorUids?:string[], eligibleUids?:string[], awards?:{uid:string,amount:number}[]}} layer
 * @param {number} index 层序号（0 = 主池）
 */
export function potLayerView(layer, index = 0) {
  const awards = Array.isArray(layer?.awards) ? layer.awards : []
  const uncalledReturn = layer?.isUncalledReturn === true
  return {
    uncalledReturn,
    title: uncalledReturn ? '未匹配退回' : index === 0 ? '主池' : `边池 ${index}`,
    contributorUids: Array.isArray(layer?.contributorUids) ? layer.contributorUids : [],
    eligibleUids: Array.isArray(layer?.eligibleUids) ? layer.eligibleUids : [],
    /** 权威到账对象/金额：退回与派彩都只从这里渲染 */
    awards,
    recipientUids: awards.map((a) => a.uid),
    hasAwards: awards.length > 0,
    awardLabel: uncalledReturn ? '未匹配退回' : '本层派彩',
    emptyAwardsLabel: uncalledReturn ? '未到账' : '暂无派彩',
  }
}
