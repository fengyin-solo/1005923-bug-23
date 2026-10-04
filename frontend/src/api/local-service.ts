import { MODULE_BY_KEY } from '@/data/modules'
import {
  TRACKER_DEVIATION_EVENTS_KEY,
  TRACKER_PATROL_REVIEWS_KEY,
  TRACKER_SCHEMA_KEY,
  TRACKER_SCHEMA_VERSION,
  allRows,
  listRows,
  resetRows,
  saveRows,
  setMeta,
} from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { changeDriveMotor, registerDeviation, resetAndLubricate } from './tracker-service'

// 跟踪支架专域的读取与复核动作从本地服务统一出口，页面仍只依赖 local-service。
export {
  confirmPatrolReview,
  listDeviationEvents,
  listPatrolReviews,
  listTrackers,
  reconciliationGap,
} from './tracker-service'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: { responsibleArray?: string; payload?: string } = {},
): ActionResult {
  const meta = moduleMeta(key)

  // 跟踪支架走专域事务：复位/润滑合成一次动作，通用状态翻转不允许碰它。
  if (key === 'tracker') {
    if (action === '登记偏差') {
      return registerDeviation(id, options.payload ?? '')
    }
    if (action === '复位并润滑' || action === '复位限位') {
      return resetAndLubricate(id)
    }
    if (action === '完成润滑') {
      // 旧入口保留为护栏：跳过复位直接润滑，限位报警时当场拦截并指出缺步骤。
      return resetAndLubricate(id, { skipReset: true })
    }
    if (action === '更换驱动机构') {
      return changeDriveMotor(id, options.payload ?? '', options.responsibleArray ?? '')
    }
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 跟踪支架的两本台账与结构版本跟着支架数据一起回到示例态，不能只重置半套。
  if (key === 'tracker') {
    resetRows(TRACKER_DEVIATION_EVENTS_KEY)
    resetRows(TRACKER_PATROL_REVIEWS_KEY)
    setMeta(TRACKER_SCHEMA_KEY, TRACKER_SCHEMA_VERSION)
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = listRows(meta.key)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
