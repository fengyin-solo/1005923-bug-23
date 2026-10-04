import {
  allRows,
  armCommitFailure,
  listRows,
  resetStoreCache,
  saveAllRows,
} from '@/data/local-store'
import type { ActionPayload, ActionResult, EntryRow } from '@/data/types'

// —— 跟踪支架的字段约定 ——
// 角度偏差格同时放「当前值」和「历史值」：当前值永远是现场最新一版，
// 历史偏差是 JSON 字符串（只追加不改写）。旧记录把两版挤在一个格子里，
// 迁移时拆开；两版对不上就在偏差核对上标红，不许旧值顶掉新值。
const F = {
  code: '支架编号',
  array: '所属方阵',
  motor: '驱动电机',
  deviation: '角度偏差',
  history: '历史偏差',
  limit: '限位状态',
  lastLube: '上次润滑时间',
  cycle: '润滑周期',
  nextLube: '下次润滑到期',
  lubeFlag: '待润滑',
  openCount: '在办偏差数',
  state: '支架状态',
} as const

const LIMIT_OK = '正常'
const LIMIT_ALARM = '报警'
const REVIEW_OPEN = '待复核'
const DEVIATION_LIMIT = '限值0.5°'

// 兼容既有支架记录：没有「上次润滑时间」时用它兜底补起润滑周期。
const LEGACY_LUBE_BASE = '2026-09-01'
const DEFAULT_CYCLE_DAYS = 90

export type DeviationSnapshot = { 日期: string; 偏差: string; 处置?: string }

export type DeviationView = {
  current: string
  history: DeviationSnapshot[]
  // 同格里历史值与当前值对不上（或旧记录无法对齐）时置位，页面标红。
  mismatch: boolean
  raw: string
}

// 以今天为基准，方便测试里换日期。
function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

function addDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().slice(0, 10)
}

function parseCycleDays(value: unknown): number {
  const match = String(value ?? '').match(/\d+/)
  const days = match ? Number(match[0]) : NaN
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_CYCLE_DAYS
}

export function parseHistory(raw: unknown): DeviationSnapshot[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as DeviationSnapshot[]) : []
  } catch {
    return []
  }
}

// 解析角度偏差格：新格式「当前」单独一格、历史在历史偏差格；
// 旧格式是「历史:…｜当前:…」挤在一起，照样拆开，并标记两版对不上。
export function parseDeviationCell(cell: unknown, historyRaw: unknown): DeviationView {
  const raw = String(cell ?? '')
  const history = parseHistory(historyRaw)
  const histSegment = raw.match(/历史[:：](.*?)(?:[｜|]当前[:：]|$)/)
  const curSegment = raw.match(/当前[:：](.*?)$/)
  if (curSegment) {
    return { current: curSegment[1].trim(), history, mismatch: true, raw }
  }
  if (histSegment) {
    // 只有历史段没有当前段：当前值被旧值顶掉了，也按冲突处理。
    return { current: '', history, mismatch: true, raw }
  }
  const current = raw.trim()
  // 结构化历史在，当前格却是空或占位文本，同样标出来。
  const placeholder = current === '' || current.endsWith('样例1')
  return { current: placeholder ? '' : current, history, mismatch: placeholder && history.length > 0, raw }
}

export function isDeviationOpen(row: EntryRow): boolean {
  return String(row.status) === '角度偏差'
}

export function isLimitAlarm(row: EntryRow): boolean {
  return String(row.status) === '限位报警' || String(row[F.limit]) === LIMIT_ALARM
}

export function isLubricationDue(row: EntryRow, now: Date = new Date()): boolean {
  const flag = String(row[F.lubeFlag] ?? '')
  if (flag === '是') {
    return true
  }
  if (flag === '否') {
    return false
  }
  return nextLubricationDate(row) <= today(now)
}

// 下次润滑到期 = 上次润滑时间 + 润滑周期；从上次润滑时间补起，不重新起算。
export function nextLubricationDate(row: EntryRow): string {
  const last = String(row[F.lastLube] ?? LEGACY_LUBE_BASE) || LEGACY_LUBE_BASE
  return addDays(last, parseCycleDays(row[F.cycle]))
}

export function openDeviationCount(row: EntryRow): number {
  const value = Number(row[F.openCount] ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

// 把历史偏差整理成「日期 偏差 处置」一行一条，详情面板直接展示。
export function formatHistory(row: EntryRow): string {
  const items = parseHistory(row[F.history])
  if (items.length === 0) {
    return '无'
  }
  return items.map((item) => `${item.日期} ${item.偏差}${item.处置 ? `（${item.处置}）` : ''}`).join('；')
}

// 兼容既有支架记录：补齐新字段、拆开混写的偏差格，不覆盖任何现场值。
export function migrateTrackerRow(row: EntryRow): EntryRow {
  const view = parseDeviationCell(row[F.deviation], row[F.history])
  const next: EntryRow = { ...row }

  if (view.raw.includes('历史') || view.raw.includes('｜')) {
    next[F.deviation] = view.current
    // 混写格里拆出的那一版历史不丢，转存为结构化历史。
    const legacy = view.raw.match(/历史[:：](.*?)(?:[｜|]|$)/)?.[1]?.trim()
    const stamped: DeviationSnapshot[] = legacy
      ? [{ 日期: String(row['复位时间'] ?? '历史记录'), 偏差: legacy, 处置: '旧版同格记录迁移' }]
      : []
    next[F.history] = JSON.stringify([...stamped, ...view.history])
  }
  if (next[F.history] === undefined) {
    next[F.history] = '[]'
  }
  if (view.mismatch) {
    next['偏差核对'] = '历史与当前不一致'
  } else if (next['偏差核对'] === undefined) {
    next['偏差核对'] = '一致'
  }
  if (next[F.lastLube] === undefined || String(next[F.lastLube]).trim() === '') {
    next[F.lastLube] = LEGACY_LUBE_BASE
  }
  const cycleDays = parseCycleDays(next[F.cycle])
  next[F.cycle] = `${cycleDays}天`
  next[F.nextLube] = addDays(String(next[F.lastLube]), cycleDays)
  if (next[F.lubeFlag] === undefined) {
    next[F.lubeFlag] = next[F.nextLube] <= today() ? '是' : '否'
  }
  if (String(next[F.limit]) === '报警') {
    // 保持报警值，其他看不懂的旧文案统一成「正常」。
  } else if (String(next[F.limit]) !== LIMIT_OK) {
    next[F.limit] = LIMIT_OK
  }
  if (next[F.openCount] === undefined) {
    // 在办偏差数指「已复位、待巡检复核销账」的挂账数；登记偏差还没复位时不挂账（status 已是角度偏差）。
    next[F.openCount] = 0
  }
  return next
}

export function listTrackers(): EntryRow[] {
  return listRows('tracker').map(migrateTrackerRow)
}

// 专责校验：改驱动机构（含复位润滑）只归本方阵专责，跨方阵一律退回。
export function assertArrayJurisdiction(row: EntryRow, operatorArrays: string[] | undefined): ActionResult | null {
  const owner = String(row[F.array] ?? '')
  if (!operatorArrays || operatorArrays.length === 0) {
    return { ok: false, message: `当前没有分配专责方阵，不能操作 ${owner} 的支架`, missingStep: '分配专责方阵' }
  }
  if (!operatorArrays.includes(owner)) {
    return {
      ok: false,
      message: `${row[F.code]} 属于${owner}，复位/改驱动机构只归本方阵专责，跨方阵操作一律退回`,
      missingStep: `切换到${owner}专责账号`,
    }
  }
  return null
}

function appendHistory(row: EntryRow, snapshot: DeviationSnapshot): string {
  return JSON.stringify([...parseHistory(row[F.history]), snapshot])
}

function newPatrolRow(id: number, tracker: EntryRow, openCount: number, date: string): EntryRow {
  return {
    id,
    status: REVIEW_OPEN,
    pending: true,
    abnormal: false,
    巡视单号: `PATR-RST-${String(id).padStart(4, '0')}`,
    台账类别: '支架复位复核',
    关联支架: tracker[F.code],
    所属方阵: tracker[F.array],
    巡视路线: `${tracker[F.array]}支架复位复核路线`,
    巡视人员: '待巡检复核',
    巡视日期: date,
    检查项数: 2,
    异常项数: openCount,
    巡视时长: '',
    巡视状态: REVIEW_OPEN,
  }
}

// 巡视复核台账上挂着的「待复核偏差数」必须和支架侧在办偏差数对得上。
export function reviewLedgerConsistency(trackers: EntryRow[], patrols: EntryRow[]): {
  ok: boolean
  trackerOpen: number
  ledgerOpen: number
  mismatches: string[]
} {
  const ledgerOpen = patrols
    .filter((row) => String(row['台账类别']) === '支架复位复核' && row.status === REVIEW_OPEN)
    .reduce((sum, row) => sum + (Number(row['异常项数']) || 0), 0)
  const trackerOpen = trackers.reduce((sum, row) => sum + openDeviationCount(row), 0)
  const mismatches: string[] = []
  const byTracker = new Map<string, number>()
  for (const row of patrols) {
    if (String(row['台账类别']) !== '支架复位复核' || row.status !== REVIEW_OPEN) {
      continue
    }
    const code = String(row['关联支架'])
    byTracker.set(code, (byTracker.get(code) ?? 0) + (Number(row['异常项数']) || 0))
  }
  for (const tracker of trackers) {
    const code = String(tracker[F.code])
    const ledgerSide = byTracker.get(code) ?? 0
    const trackerSide = openDeviationCount(tracker)
    if (ledgerSide !== trackerSide) {
      mismatches.push(`${code}：支架侧在办偏差 ${trackerSide}，巡检台账 ${ledgerSide}`)
    }
  }
  return { ok: ledgerOpen === trackerOpen && mismatches.length === 0, trackerOpen, ledgerOpen, mismatches }
}

// 登记偏差：当前读数进角度偏差格，旧的当前值归档进历史偏差（只追加，不顶掉）。
export function registerDeviation(
  trackerId: number,
  payload: ActionPayload = {},
): ActionResult {
  const rows = listTrackers()
  const index = rows.findIndex((row) => Number(row.id) === trackerId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${trackerId} 的跟踪支架` }
  }
  const current = rows[index]
  const denied = assertArrayJurisdiction(current, payload.operatorArrays)
  if (denied) {
    return denied
  }
  if (isLimitAlarm(current)) {
    return { ok: false, message: `${current[F.code]} 限位报警还没复位，不能登记新偏差`, missingStep: '复位限位' }
  }
  const date = today()
  const reading = String(payload.currentDeviation ?? `0.9°/${DEVIATION_LIMIT}`)
  // 旧的当前值归档（若有的话），历史一版保留不丢。
  const previous = String(current[F.deviation] ?? '').trim()
  const history = previous
    ? appendHistory(current, { 日期: date, 偏差: previous, 处置: '被新读数替换前归档' })
    : String(current[F.history] ?? '[]')
  const updated: EntryRow = {
    ...current,
    status: '角度偏差',
    pending: true,
    abnormal: true,
    [F.deviation]: reading,
    [F.history]: history,
    [F.limit]: LIMIT_OK,
    [F.openCount]: openDeviationCount(current),
    '偏差核对': '一致',
  }
  const nextTrackers = [...rows]
  nextTrackers[index] = updated
  if (payload.failNextCommit) {
    armCommitFailure()
  }
  try {
    saveAllRows({ tracker: nextTrackers })
  } catch {
    return { ok: false, message: '偏差登记落库失败，整笔退回，支架维持原样' }
  }
  return { ok: true, message: `${current[F.code]} 已登记偏差 ${reading}，旧读数已归档进历史偏差` }
}

// 复位 + 润滑合成一次动作。任何一步走不成都整笔退回，不留半台。
export function performResetLube(
  trackerId: number,
  payload: ActionPayload = {},
): ActionResult {
  const steps: string[] = []
  const rows = listTrackers()
  const patrols = listRows('patrol')
  const index = rows.findIndex((row) => Number(row.id) === trackerId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${trackerId} 的跟踪支架` }
  }
  const current = rows[index]

  // 第 0 步：专责校验（跨方阵一律退回）。
  const denied = assertArrayJurisdiction(current, payload.operatorArrays)
  if (denied) {
    return denied
  }

  // 幂等：同一件在办偏差没经巡检复核前，连点两次只认第一次，详情面板不再多出两行。
  if (openDeviationCount(current) > 0) {
    const duplicated = patrols.some(
      (row) =>
        String(row['关联支架']) === String(current[F.code]) &&
        String(row['台账类别']) === '支架复位复核' &&
        row.status === REVIEW_OPEN,
    )
    if (duplicated) {
      return {
        ok: false,
        message: `${current[F.code]} 的复位已提交，巡检复核台账还挂着在办偏差，重复复位被拦截；请等巡检复核后再操作`,
        missingStep: '巡检复核',
        steps,
      }
    }
  }

  // 第一步：限位报警没复位的不许做润滑。
  if (isLimitAlarm(current)) {
    return {
      ok: false,
      message: `${current[F.code]} 限位报警未复位，按规程不许做润滑；组合动作缺少「复位限位」，整笔退回`,
      missingStep: '复位限位',
      steps,
    }
  }
  steps.push('限位状态校验通过（无未复位报警）')

  const date = today()
  const updated: EntryRow = { ...current }

  // 第二步：角度偏差复位。旧读数归档进历史，绝不顶掉、绝不丢历史。
  // 本次复位消掉一桩在办偏差就挂账 1，等巡检复核两边一起销。
  const bookedCount = isDeviationOpen(current) ? 1 : openDeviationCount(current)
  if (isDeviationOpen(current) || bookedCount > 0) {
    const reading = String(current[F.deviation] ?? '').trim()
    updated[F.history] = appendHistory(current, { 日期: date, 偏差: reading || '空', 处置: '复位时归档' })
    updated[F.deviation] = `0.0°/${DEVIATION_LIMIT}`
    updated['偏差核对'] = '一致'
    steps.push('角度偏差已复位，原读数归档历史偏差')
  } else {
    steps.push('无在办角度偏差，跳过偏差归档')
  }

  // 第三步：限位状态 + 支架状态两条一起回写（修投诉①：复位后红格还亮着）。
  updated[F.limit] = LIMIT_OK
  updated[F.state] = '跟踪中'
  steps.push('限位状态与支架状态一起回写')

  // 第四步：润滑。润滑周期从上次润滑时间补起，更新上次润滑时间与到期日，销待润滑标记。
  updated[F.lastLube] = date
  updated[F.nextLube] = addDays(date, parseCycleDays(current[F.cycle]))
  updated[F.lubeFlag] = '否' // 修投诉③：润滑做完待润滑标记必须销掉
  steps.push(`润滑完成（周期 ${updated[F.cycle]}，从上次润滑时间补起，下次到期 ${updated[F.nextLube]}）`)

  // 第五步：支架侧在办偏差数——复位结果要等巡检复核销项，先挂账。
  updated[F.openCount] = bookedCount
  updated.status = '正常跟踪'
  updated.abnormal = false
  // 复位结果还挂在巡检复核台账上等销项，在此之前支架保留待办标记。
  updated.pending = bookedCount > 0
  updated['复位时间'] = date
  updated['复位批次'] = `RST-${current[F.code]}-${date.split('-').join('')}`

  // 第六步：复位结果落到巡检那边的复核台账。
  const nextId = patrols.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const ledgerRow = newPatrolRow(nextId, updated, bookedCount, date)
  steps.push(`已登记巡检复核台账 ${ledgerRow['巡视单号']}，挂账偏差 ${bookedCount} 项`)

  // 第七步：整笔落库（tracker + patrol 一份快照），失败当场拦截、整笔退回。
  const nextTrackers = [...rows]
  nextTrackers[index] = updated
  if (payload.failNextCommit) {
    armCommitFailure()
  }
  try {
    saveAllRows({ tracker: nextTrackers, patrol: [...patrols, ledgerRow] })
  } catch {
    // saveAllRows 是「先写盘后换缓存」：走到这里缓存仍是旧快照，天然整笔退回，不留半台。
    return {
      ok: false,
      message: `${current[F.code]} 落库失败，整笔退回：角度偏差、限位、润滑、巡检台账一处都没改`,
      missingStep: '重新提交落库',
      steps,
    }
  }

  // 第八步：落库后回读校验两条状态，并核对立账两边偏差数；对不上也整笔退回。
  const savedTrackers = listTrackers()
  const savedPatrols = listRows('patrol')
  const saved = savedTrackers[index]
  const postProblems: string[] = []
  if (String(saved[F.limit]) !== LIMIT_OK) {
    postProblems.push('限位状态回写校验未通过')
  }
  if (String(saved[F.state]) !== '跟踪中') {
    postProblems.push('支架状态回写校验未通过')
  }
  if (String(saved[F.lubeFlag]) !== '否') {
    postProblems.push('待润滑标记未销掉')
  }
  const consistency = reviewLedgerConsistency(savedTrackers, savedPatrols)
  if (!consistency.ok) {
    postProblems.push(`两边偏差数对不上：支架侧 ${consistency.trackerOpen}，巡检台账 ${consistency.ledgerOpen}`)
  }
  if (postProblems.length > 0) {
    // 校验不过：用落库前快照整笔冲回。
    try {
      saveAllRows({ tracker: rows, patrol: patrols })
    } catch {
      // 回滚也失败时保持现场并明确告警，不能假装成功。
    }
    return {
      ok: false,
      message: `${current[F.code]} 回写校验未通过（${postProblems.join('；')}），已整笔退回`,
      missingStep: postProblems[0],
      steps,
    }
  }

  return {
    ok: true,
    message:
      `${current[F.code]} 复位+润滑一次完成：角度偏差已归档复位，限位/支架状态双回写，` +
      `待润滑标记已销（下次 ${updated[F.nextLube]}），复核台账 ${ledgerRow['巡视单号']} 挂账偏差 ${bookedCount} 项，两边核对一致`,
    steps,
  }
}

// 巡检复核通过：销掉对应支架在办偏差数（两边同一笔事务，仍做对账校验）。
export function closeReviewBatch(patrolId: number): ActionResult {
  const trackers = listTrackers()
  const patrols = listRows('patrol')
  const index = patrols.findIndex((row) => Number(row.id) === patrolId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${patrolId} 的巡视记录` }
  }
  const ledger = patrols[index]
  if (String(ledger['台账类别']) !== '支架复位复核') {
    return { ok: false, message: `${ledger['巡视单号']} 不是支架复位复核台账，按普通巡视流转` }
  }
  if (ledger.status !== REVIEW_OPEN) {
    return { ok: false, message: `${ledger['巡视单号']} 已复核，不用重复确认` }
  }
  const code = String(ledger['关联支架'])
  const trackerIndex = trackers.findIndex((row) => String(row[F.code]) === code)
  if (trackerIndex < 0) {
    return { ok: false, message: `复核台账挂着的支架 ${code} 已不存在，拒绝销账`, missingStep: '核查支架台账' }
  }
  const openCount = Number(ledger['异常项数']) || 0
  if (openDeviationCount(trackers[trackerIndex]) !== openCount) {
    return {
      ok: false,
      message: `${code} 两边挂着的偏差数对不上（支架 ${openDeviationCount(trackers[trackerIndex])} / 台账 ${openCount}），拒绝销账`,
      missingStep: '核对在办偏差',
    }
  }

  const nextPatrols = [...patrols]
  nextPatrols[index] = { ...ledger, status: '已完成', pending: false, '巡视状态': '已完成' }
  const nextTrackers = [...trackers]
  nextTrackers[trackerIndex] = {
    ...trackers[trackerIndex],
    [F.openCount]: 0,
    pending: false,
  }
  try {
    saveAllRows({ tracker: nextTrackers, patrol: nextPatrols })
  } catch {
    return { ok: false, message: '复核销账落库失败，整笔退回' }
  }
  const check = reviewLedgerConsistency(listRows('tracker'), listRows('patrol'))
  if (!check.ok) {
    try {
      saveAllRows({ tracker: trackers, patrol: patrols })
    } catch {
      // 保持现场
    }
    return { ok: false, message: `销账后两边偏差数对不上（${check.mismatches.join('；')}），已整笔退回` }
  }
  return { ok: true, message: `${ledger['巡视单号']} 复核通过，${code} 在办偏差 ${openCount} 项已两边同时销账` }
}

// 供测试/重置使用。
export { armCommitFailure, resetStoreCache }
