import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'pv-plant-ops:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAllRows({ [key]: rows })
}

// 一次落库多个模块：整份快照一次 setItem，localStorage 写失败时保留旧缓存，
// 由调用方回滚内存态，保证「写不成整笔退回，不留半台」。
export function saveAllRows(changes: Record<string, EntryRow[]>): void {
  if (failNextCommit) {
    failNextCommit = false
    throw new Error('本地存储落库失败')
  }
  const next = { ...allRows(), ...changes }
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先写盘再换缓存：setItem 抛错（配额/不可用）时缓存保持旧值，没有半截状态。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

// 故障注入：下一次落库必然失败。支架班要求「落库失败当场拦截」，留着便于演示与自测。
let failNextCommit = false
export function armCommitFailure(): void {
  failNextCommit = true
}

// 清掉模块级缓存（仅自测用：localStorage 垫片换库后需要重读）。
export function resetStoreCache(): void {
  cache = null
  failNextCommit = false
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
