import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'
// 跟踪支架两本台账（在办偏差事件、巡视复核台账）与业务模块同库分表存放。
export const TRACKER_DEVIATION_EVENTS_KEY = 'tracker_deviation_events'
export const TRACKER_PATROL_REVIEWS_KEY = 'tracker_patrol_reviews'
export const TRACKER_SCHEMA_KEY = 'tracker_schema_version'
export const TRACKER_SCHEMA_VERSION = 2

// 跟踪支架数据结构版本：随示例数据一起播入，老库没有这一项才会触发迁移，
// 避免对已经带台账的新示例数据重复补录偏差事件。
const SEED_META: Record<string, string | number | boolean> = {
  [TRACKER_SCHEMA_KEY]: TRACKER_SCHEMA_VERSION,
}

// 跟踪支架数据结构版本：写在数据库里，老数据播进来后按版本补迁移。
export const STORE_KEYS = [
  ...Object.keys(SEED_ROWS),
  TRACKER_DEVIATION_EVENTS_KEY,
  TRACKER_PATROL_REVIEWS_KEY,
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): DataStore {
  const seedRows = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ...seedRows, ...SEED_META }
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    // 全新库：示例数据与当前结构版本一起播种。
    const seeded = { ...seedRows, ...SEED_META }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('存储内容不是数据对象')
    }
    // 老库可能只存了业务模块、没有两本台账与版本号：
    // 行数据以老库为准逐份保留，缺失的新表补空；结构版本绝不能拿种子里的现值顶上，
    // 否则老数据会被误判成最新结构、跳过迁移。
    const merged: DataStore = { ...(parsed as DataStore) }
    for (const key of Object.keys(seedRows)) {
      if (!Array.isArray(merged[key])) {
        merged[key] = seedRows[key]
      }
    }
    for (const key of [TRACKER_DEVIATION_EVENTS_KEY, TRACKER_PATROL_REVIEWS_KEY]) {
      if (!Array.isArray(merged[key])) {
        merged[key] = []
      }
    }
    return merged
  } catch {
    const fallback = { ...seedRows, ...SEED_META }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

// 行数据集合与少量标量元数据（结构版本）同库存放。
export type DataStore = Record<string, EntryRow[] | string | number | boolean>

let cache: DataStore | null = null

export function allRows(): DataStore {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  const value = allRows()[key]
  return Array.isArray(value) ? value : []
}

export function getMeta(key: string): string | number | boolean | null {
  const value = allRows()[key]
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return null
}

export function setMeta(key: string, value: string | number | boolean): void {
  const next: DataStore = { ...allRows(), [key]: value }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next: DataStore = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/**
 * 整笔落库：把多个集合（支架、偏差事件、复核台账）的改动打成一笔提交。
 * 先在内存里把下一版全量数据准备好，再一次性写入 localStorage，写完立刻按集合
 * 逐份回读比对；任一份对不上（落库失败 / 跳着办）就回滚到提交前的快照，
 * 绝不允许只写进半台支架、或事件写了台账没写。
 */
export function commitChanges(
  changes: Record<string, EntryRow[]>,
  metaChanges: Record<string, string | number | boolean> = {},
  verify?: (next: DataStore) => string | null,
): { ok: true } | { ok: false; reason: string } {
  const before = allRows()
  const snapshot = JSON.stringify(before)
  const next: DataStore = { ...before, ...changes, ...metaChanges }

  // 提交前先让业务侧校验：缺步骤、两处台账对不上的，连写都不写。
  const verifyError = verify?.(next) ?? null
  if (verifyError) {
    cache = before
    return { ok: false, reason: verifyError }
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
    cache = next
  } catch (error) {
    // 写不进去（容量/隐私模式）当场回滚，调用方按拦截处理。
    cache = JSON.parse(snapshot) as DataStore
    return {
      ok: false,
      reason: `落库失败，整笔退回：${error instanceof Error ? error.message : '存储不可用'}`,
    }
  }

  // 回读校验：写进存储的内容必须与准备提交的下一版逐字节一致。
  if (typeof window !== 'undefined' && window.localStorage) {
    let stored: Record<string, unknown>
    try {
      stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    } catch {
      stored = {}
    }
    for (const key of [...Object.keys(changes), ...Object.keys(metaChanges)]) {
      if (JSON.stringify(stored[key]) !== JSON.stringify(next[key])) {
        window.localStorage.setItem(STORAGE_KEY, snapshot)
        cache = JSON.parse(snapshot) as DataStore
        return { ok: false, reason: `落库失败：「${key}」回读与提交内容不一致，已整笔退回` }
      }
    }
  }
  return { ok: true }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
