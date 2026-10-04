/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  // 组合动作真正走完的步骤，落库后校验/排障时能对着看。
  steps?: string[]
  // 被拦下时缺的是哪一步（如「先复位限位」），前端可直接提示。
  missingStep?: string
}

// 动作的附带参数：组合复位润滑需要操作人方阵、本次读数等。
export type ActionPayload = {
  operatorArrays?: string[]
  currentDeviation?: string
  failNextCommit?: boolean
  [key: string]: string | string[] | boolean | undefined
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
