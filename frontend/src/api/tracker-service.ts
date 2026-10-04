/**
 * 跟踪支架专域：复位/润滑/换电机的业务规则都在这里，页面只负责渲染。
 *
 * 关键约定：
 * - 「复位并润滑」是一次动作：角度偏差、限位状态、支架状态写进同一笔事务，
 *   写不成就整笔退回，不允许留下半台支架。
 * - 限位报警没复位，不许做润滑；想跳过复位直接润滑，当场拦截并指出缺「复位限位」。
 * - 复位结果同步落巡视侧复核台账，两处挂着的偏差数必须一致，对不上整笔退回。
 * - 角度偏差格里历史值与当前值挤在一起时：当前值为准，历史值不丢也不顶掉新值，
 *   两者数值对不上要标出来。
 * - 更换驱动机构只认本方阵专责，跨方阵操作一律退回。
 * - 润滑周期从上次润滑时间补起，并兼容没有这些字段的既有支架记录。
 */
import type { DataStore } from '@/data/local-store'
import {
  TRACKER_DEVIATION_EVENTS_KEY,
  TRACKER_PATROL_REVIEWS_KEY,
  TRACKER_SCHEMA_KEY,
  TRACKER_SCHEMA_VERSION,
  commitChanges,
  getMeta,
  listRows,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const TRACKER_KEY = 'tracker'
const DEFAULT_LUBE_DAYS = 90
// 角度偏差绝对容差：读数在 1° 以内视为正常跟踪，不算在办偏差（登记与老库补录同一把尺）。
const ANGLE_TOLERANCE = 1
const NORMAL_ANGLE = '0°'
const NORMAL_LIMIT = '正常'

function isDeviationAngle(value: string): boolean {
  const num = angleNumber(value)
  return num !== null && Math.abs(num) > ANGLE_TOLERANCE
}

// ───────────────────────────────── 类型 ─────────────────────────────────

export type DeviationEvent = {
  id: number
  status: '在办' | '已闭环'
  pending: boolean
  abnormal: boolean
  支架编号: string
  所属方阵: string
  偏差值: string
  登记时间: string
  来源: string
  闭环时间: string
  复核单号: string
}

export type PatrolReview = {
  id: number
  status: '待复核' | '已复核'
  pending: boolean
  abnormal: boolean
  复核单号: string
  支架编号: string
  所属方阵: string
  偏差数: number
  复位时间: string
  复核时间: string
  复核人: string
  润滑: string
}

export type TrackerRow = {
  id: number
  支架编号: string
  所属方阵: string
  跟踪方式: string
  驱动电机: string
  角度偏差: string
  限位状态: string
  润滑周期: number
  上次润滑时间: string
  status: string
  pending: boolean
  abnormal: boolean
  // 视图派生
  当前偏差: string
  历史偏差: { value: string; mismatch: boolean }[]
  偏差冲突: boolean
  待润滑: boolean
  润滑超期天数: number
  下次润滑到期: string
  在办偏差数: number
  待复核偏差数: number
}

// ───────────────────────────────── 工具 ─────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function nowStr(): string {
  const d = new Date()
  return `${todayStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function addDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00`)
  if (Number.isNaN(d.getTime())) {
    return ''
  }
  d.setDate(d.getDate() + days)
  return todayStr(d)
}

function daysBetween(from: string, to = todayStr()): number {
  const a = new Date(`${from}T00:00:00`)
  const b = new Date(`${to}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return 0
  }
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** 把各种写法的角度归一成「3.8°」；纯数字也认，解析不出返回空串。 */
function normalizeAngle(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) {
    return ''
  }
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) {
    return ''
  }
  return `${Number(match[0])}°`
}

function angleNumber(value: string): number | null {
  const match = String(value).match(/-?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : null
}

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === null || value === undefined ? '' : String(value)
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// ─────────────────────── 兼容既有支架记录：取值与迁移 ───────────────────────

function lubeDays(row: EntryRow): number {
  const value = Number(row['润滑周期'])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_LUBE_DAYS
}

function lastLube(row: EntryRow): string {
  const raw = text(row, '上次润滑时间')
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}

function normalizeLimit(row: EntryRow): string {
  const raw = text(row, '限位状态')
  if (raw.includes('报警') || raw.includes('越限') || raw.includes('故障')) {
    return '报警'
  }
  if (raw.includes('正常') || raw === '') {
    return raw.includes('正常') ? NORMAL_LIMIT : NORMAL_LIMIT
  }
  // 读不懂的限位字样按报警从严处理，逼一次复位，绝不静默当正常。
  return '报警'
}

/**
 * 老库里「角度偏差」一格可能塞着「当前 3.8° / 历史 2.1°」之类的叠写内容。
 * 拆成当前值 + 历史值列表；拆不出结构时整段当当前值，绝不丢字。
 * 注意：只认真正带角度单位（°/度）的读数，避免「样例1」这种占位文字被当成 1°。
 */
export function parseAngleCell(raw: unknown): { current: string; history: string[] } {
  const text0 = String(raw ?? '').trim()
  if (!text0) {
    return { current: '', history: [] }
  }
  const take = (segment: string): string => {
    const match = segment.match(/-?\d+(?:\.\d+)?\s*(?:°|度)/)
    return match ? `${Number(match[0].match(/-?\d+(?:\.\d+)?/)![0])}°` : ''
  }
  const history: string[] = []
  let current = ''
  for (const segment of text0.split(/[；;\n]+/)) {
    const piece = segment.trim()
    if (!piece) {
      continue
    }
    const histMatch = piece.match(/^历史(?:偏差|值)?[：:](.*)$/)
    const currMatch = piece.match(/^当前(?:偏差|值)?[：:](.*)$/)
    if (histMatch) {
      const value = take(histMatch[1])
      if (value) {
        history.push(value)
      }
    } else if (currMatch) {
      current = take(currMatch[1])
    } else if (!current) {
      const value = take(piece)
      if (value) {
        current = value
      } else {
        current = piece
      }
    } else {
      const value = take(piece)
      if (value) {
        history.push(value)
      }
    }
  }
  return { current, history }
}

/**
 * 老库迁移到 v2：
 * 1) 把既有的角度偏差叠写格拆成当前值/历史值，并按当前值补一条在办偏差事件；
 * 2) 补齐限位状态、润滑周期、上次润滑时间等字段，缺的润滑记录按未登记处理；
 * 3) 整件事走整笔提交，迁不动就整笔退回老数据。
 */
export function ensureTrackerSchema(): void {
  if (getMeta(TRACKER_SCHEMA_KEY) === TRACKER_SCHEMA_VERSION) {
    return
  }
  const rows = listRows(TRACKER_KEY)
  const migrated = rows.map((row) => {
    const parsed = parseAngleCell(row['角度偏差'])
    // 叠写格以外的纯占位/乱码文字（如「跟踪支架样例1」）读不出带单位的读数，按 0° 归一；
    // 只有「当前：x」/「历史：x」这种明确叠写且无单位时才保留原文，交给人工核对。
    const labeled = /[；;]/.test(String(row['角度偏差'] ?? '')) ||
      /^(当前|历史)/.test(String(row['角度偏差'] ?? '').trim())
    const current = parsed.current || (labeled ? '' : NORMAL_ANGLE) || NORMAL_ANGLE
    return {
      ...row,
      角度偏差: current,
      // 从同格拆出来的历史读数单列保存：旧值不顶新值，历史那一版也不丢。
      历史偏差记录: parsed.history.join('；'),
      限位状态: normalizeLimit(row),
      润滑周期: lubeDays(row),
      上次润滑时间: lastLube(row),
    }
  })

  const existingEvents = listRows(TRACKER_DEVIATION_EVENTS_KEY)
  const events = [...existingEvents]
  for (const row of migrated) {
    const code = text(row, '支架编号')
    const angle = normalizeAngle(row['角度偏差'])
    const already = events.some(
      (event) =>
        text(event, '支架编号') === code &&
        text(event, '状态') === '在办' &&
        normalizeAngle(event['偏差值']) === angle,
    )
    const hasDeviation =
      text(row, '支架状态') === '角度偏差' || text(row, 'status') === '角度偏差'
    if (!already && hasDeviation && isDeviationAngle(angle)) {
      events.push({
        id: nextId(events),
        status: '在办',
        pending: true,
        abnormal: true,
        支架编号: code,
        所属方阵: text(row, '所属方阵'),
        偏差值: angle,
        登记时间: '2026-10-01 08:00',
        来源: '历史同格补录',
        闭环时间: '',
        复核单号: '',
      })
    }
  }

  const result = commitChanges(
    { [TRACKER_KEY]: migrated, [TRACKER_DEVIATION_EVENTS_KEY]: events },
    { [TRACKER_SCHEMA_KEY]: TRACKER_SCHEMA_VERSION },
  )
  if (!result.ok) {
    throw new Error(result.reason)
  }
}

// ─────────────────────────────── 状态派生 ────────────────────────────────

function lubeInfo(row: EntryRow): { due: boolean; overdue: number; dueDate: string } {
  const days = lubeDays(row)
  const last = lastLube(row)
  if (!last) {
    // 兼容没有上次润滑时间的既有支架：从投运即视为待润滑，周期仍按字段补算。
    return { due: true, overdue: 0, dueDate: '' }
  }
  const dueDate = addDays(last, days)
  const overdue = daysBetween(addDays(last, 0), todayStr()) - days
  return { due: overdue >= 0, overdue: Math.max(overdue, 0), dueDate }
}

function deriveStatus(row: EntryRow, openCount: number): string {
  // 只认真实状态量：限位字段、在办偏差台账、润滑到期；
  // 「支架状态/status」是历史结论字段，可能停在上一版，不能反过来决定当前红绿。
  if (text(row, '限位状态') === '报警') {
    return '限位报警'
  }
  if (openCount > 0) {
    return '角度偏差'
  }
  if (lubeInfo(row).due) {
    return '待润滑'
  }
  return '正常跟踪'
}

function toEvent(row: EntryRow): DeviationEvent {
  return {
    id: Number(row.id),
    status: text(row, 'status') === '已闭环' ? '已闭环' : '在办',
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    支架编号: text(row, '支架编号'),
    所属方阵: text(row, '所属方阵'),
    偏差值: text(row, '偏差值'),
    登记时间: text(row, '登记时间'),
    来源: text(row, '来源'),
    闭环时间: text(row, '闭环时间'),
    复核单号: text(row, '复核单号'),
  }
}

function toReview(row: EntryRow): PatrolReview {
  return {
    id: Number(row.id),
    status: text(row, 'status') === '已复核' ? '已复核' : '待复核',
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    复核单号: text(row, '复核单号'),
    支架编号: text(row, '支架编号'),
    所属方阵: text(row, '所属方阵'),
    偏差数: Number(row['偏差数']) || 0,
    复位时间: text(row, '复位时间'),
    复核时间: text(row, '复核时间'),
    复核人: text(row, '复核人'),
    润滑: text(row, '润滑') || '否',
  }
}

function openEventsFor(events: DeviationEvent[], code: string): DeviationEvent[] {
  return events.filter((event) => event.支架编号 === code && event.status === '在办')
}

/**
 * 历史值与当前值打架：当前值为准（红不红、在不在办听当前值），
 * 历史值保留在详情里，数值对不上的那一版打 mismatch 标记。
 */
function historyConflicts(history: string[], current: string, hasOpen: boolean) {
  const currentNum = angleNumber(current)
  return history.map((value) => {
    const num = angleNumber(value)
    const mismatch = hasOpen && currentNum !== null && num !== null && num !== currentNum
    return { value, mismatch }
  })
}

// ─────────────────────────────── 读取接口 ────────────────────────────────

export function listTrackers(): TrackerRow[] {
  ensureTrackerSchema()
  const rows = listRows(TRACKER_KEY)
  const events = listRows(TRACKER_DEVIATION_EVENTS_KEY).map(toEvent)
  const reviews = listRows(TRACKER_PATROL_REVIEWS_KEY).map(toReview)
  return rows.map((row) => {
    const code = text(row, '支架编号')
    const open = openEventsFor(events, code)
    const pendingReviewCount = reviews.filter(
      (review) => review.支架编号 === code && review.status === '待复核',
    ).length
    // 已经迁过的数据：当前值单列在「角度偏差」，历史读数保存在「历史偏差记录」；
    // 尚未迁移的叠写格：parseAngleCell 现场拆，两种存储都不丢历史。
    const parsed = parseAngleCell(row['角度偏差'])
    const storedHistory = text(row, '历史偏差记录')
      .split(/[；;]+/)
      .map((item) => normalizeAngle(item))
      .filter(Boolean)
    const current = parsed.current || normalizeAngle(row['角度偏差']) || NORMAL_ANGLE
    const historyValues = [...new Set([...parsed.history, ...storedHistory])]
    const lube = lubeInfo(row)
    const historical = historyConflicts(historyValues, current, open.length > 0)
    // 状态永远由两条实际状态字段 + 在办偏差台账现场推导，
    // 不采信历史遗留的 status 字符串——避免「复位完红格还在」那类状态与字段脱节。
    const status = deriveStatus(row, open.length)
    return {
      id: Number(row.id),
      支架编号: code,
      所属方阵: text(row, '所属方阵'),
      跟踪方式: text(row, '跟踪方式'),
      驱动电机: text(row, '驱动电机'),
      角度偏差: text(row, '角度偏差'),
      限位状态: text(row, '限位状态'),
      润滑周期: lubeDays(row),
      上次润滑时间: lastLube(row),
      status,
      pending: status !== '正常跟踪',
      abnormal: status === '角度偏差' || status === '限位报警',
      当前偏差: current,
      历史偏差: historical,
      偏差冲突: historical.some((item) => item.mismatch),
      待润滑: lube.due,
      润滑超期天数: lube.overdue,
      下次润滑到期: lube.dueDate,
      在办偏差数: open.length,
      待复核偏差数: pendingReviewCount,
    }
  })
}

export function listDeviationEvents(): DeviationEvent[] {
  ensureTrackerSchema()
  return listRows(TRACKER_DEVIATION_EVENTS_KEY).map(toEvent)
}

export function listPatrolReviews(): PatrolReview[] {
  ensureTrackerSchema()
  return listRows(TRACKER_PATROL_REVIEWS_KEY).map(toReview)
}

/** 两处挂着的偏差数：支架侧待复核事件合计 vs 巡视侧待复核台账偏差合计。 */
export function reconciliationGap(
  events: DeviationEvent[] = listDeviationEvents(),
  reviews: PatrolReview[] = listPatrolReviews(),
): { trackerSide: number; patrolSide: number; gap: number } {
  const trackerSide = events.filter(
    (event) => event.status === '已闭环' && Boolean(event.复核单号) && pendingReview(event, reviews),
  ).length
  const patrolSide = reviews
    .filter((review) => review.status === '待复核')
    .reduce((sum, review) => sum + review.偏差数, 0)
  return { trackerSide, patrolSide, gap: trackerSide - patrolSide }
}

function pendingReview(event: DeviationEvent, reviews: PatrolReview[]): boolean {
  const review = reviews.find((item) => item.复核单号 === event.复核单号)
  return Boolean(review && review.status === '待复核')
}

// ─────────────────────────────── 写库基础 ────────────────────────────────

function snapshots(): { rows: EntryRow[]; events: EntryRow[]; reviews: EntryRow[] } {
  return {
    rows: listRows(TRACKER_KEY),
    events: listRows(TRACKER_DEVIATION_EVENTS_KEY),
    reviews: listRows(TRACKER_PATROL_REVIEWS_KEY),
  }
}

/**
 * 提交前对账：支架侧挂待复核的闭环事件数，必须等于巡视侧待复核台账的偏差合计；
 * 对不上说明跳着办或半成品，整笔退回。
 */
function makeLedgerGuard(events: EntryRow[], reviews: EntryRow[]) {
  return (next: DataStore): string | null => {
    const nextEventsRaw = next[TRACKER_DEVIATION_EVENTS_KEY]
    const nextReviewsRaw = next[TRACKER_PATROL_REVIEWS_KEY]
    const nextEvents = (Array.isArray(nextEventsRaw) ? nextEventsRaw : events).map(toEvent)
    const nextReviews = (Array.isArray(nextReviewsRaw) ? nextReviewsRaw : reviews).map(toReview)
    const trackerSide = nextEvents.filter((event) => {
      if (event.status !== '已闭环' || !event.复核单号) {
        return false
      }
      return pendingReview(event, nextReviews)
    }).length
    const patrolSide = nextReviews
      .filter((review) => review.status === '待复核')
      .reduce((sum, review) => sum + review.偏差数, 0)
    if (trackerSide !== patrolSide) {
      return `两处台账对不上：支架侧待复核偏差 ${trackerSide} 条，巡视侧复核台账 ${patrolSide} 条，已整笔退回`
    }
    return null
  }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

// ─────────────────────────────── 动作：登记偏差 ───────────────────────────────

/**
 * 登记偏差：只动当前值一格，历史值原样保留（旧值顶不掉新值，历史也不丢）。
 * 同一支架、同一读数、同一天连点两次只产生一条在办事件，详情面板不再重复显示。
 */
export function registerDeviation(trackerId: number, rawValue: string): ActionResult {
  ensureTrackerSchema()
  const value = normalizeAngle(rawValue)
  if (!value) {
    return fail('角度偏差读数无效，需填写如 3.8° 的数值')
  }
  if (!isDeviationAngle(value)) {
    return fail(`读数 ${value} 在 ±${ANGLE_TOLERANCE}° 容差内，属于正常跟踪，不用登记偏差`)
  }
  const { rows, events, reviews } = snapshots()
  const index = rows.findIndex((row) => Number(row.id) === trackerId)
  if (index < 0) {
    return fail(`没有找到编号为 ${trackerId} 的跟踪支架`)
  }
  const code = text(rows[index], '支架编号')
  const day = todayStr()
  const duplicate = events.some(
    (event) =>
      text(event, '支架编号') === code &&
      text(event, 'status') === '在办' &&
      normalizeAngle(event['偏差值']) === value &&
      text(event, '登记时间').startsWith(day),
  )
  if (duplicate) {
    return fail('该偏差今天已登记过一条在办记录，同一件事不重复显示')
  }

  const nextRows = [...rows]
  nextRows[index] = {
    ...rows[index],
    角度偏差: value,
    支架状态: '角度偏差',
    status: '角度偏差',
    pending: true,
    abnormal: true,
  }
  const nextEvents = [
    ...events,
    {
      id: nextId(events),
      status: '在办',
      pending: true,
      abnormal: true,
      支架编号: code,
      所属方阵: text(rows[index], '所属方阵'),
      偏差值: value,
      登记时间: nowStr(),
      来源: '登记偏差',
      闭环时间: '',
      复核单号: '',
    },
  ]
  const result = commitChanges(
    { [TRACKER_KEY]: nextRows, [TRACKER_DEVIATION_EVENTS_KEY]: nextEvents },
    {},
    makeLedgerGuard(nextEvents, reviews),
  )
  if (!result.ok) {
    return fail(result.reason)
  }
  return { ok: true, message: `已登记偏差 ${value}，当前值已更新，历史读数保留备查` }
}

// ───────────────────────────── 动作：复位并润滑 ─────────────────────────────

function reviewNo(): string {
  const reviews = listRows(TRACKER_PATROL_REVIEWS_KEY)
  const seq = String(reviews.length + 1).padStart(2, '0')
  return `RC-${todayStr().replace(/-/g, '')}-${seq}`
}

/**
 * 复位并润滑（一次动作，一个事务，三条写入缺一不可）：
 *  1. 限位报警没复位不许做润滑——本动作内复位永远排在润滑前面；
 *     若有人想跳过复位（旧入口「完成润滑」直调），当场拦截并指出缺「复位限位」。
 *  2. 角度偏差、限位状态与支架状态写进同一份支架记录；在办偏差一次性闭环，
 *     并在巡视侧复核台账落一行。
 *  3. 润滑完成才销待润滑标记，并从上次润滑时间按周期补算下一周期。
 */
export function resetAndLubricate(
  trackerId: number,
  options: { skipReset?: boolean; forceLube?: boolean } = {},
): ActionResult {
  ensureTrackerSchema()
  // 跳着办：跳过复位直接润滑，且限位还在报警——缺哪一步当场指出。
  if (options.skipReset) {
    const guarded = listRows(TRACKER_KEY).find((row) => Number(row.id) === trackerId)
    if (guarded && text(guarded, '限位状态') === '报警') {
      return fail('限位报警尚未复位，禁止做润滑：缺少步骤「复位限位」，请改用「复位并润滑」整笔办理')
    }
  }

  const { rows, events, reviews } = snapshots()
  const index = rows.findIndex((row) => Number(row.id) === trackerId)
  if (index < 0) {
    return fail(`没有找到编号为 ${trackerId} 的跟踪支架`)
  }
  const row = rows[index]
  const code = text(row, '支架编号')
  const limitAlarm = text(row, '限位状态') === '报警'
  const open = events
    .map(toEvent)
    .filter((event) => event.支架编号 === code && event.status === '在办')
  const lube = lubeInfo(row)
  const shouldLube = options.forceLube || lube.due

  if (!limitAlarm && open.length === 0 && !shouldLube) {
    // 幂等：复位过、没偏差、没到润滑周期，连点两次不再多出任何行。
    return fail('限位正常、无在办偏差且未到润滑周期，无需重复「复位并润滑」')
  }

  const no = reviewNo()
  const stamp = nowStr()

  // 先在内存里把下一版三份数据全部准备齐，再一次性提交——不允许半成品。
  const nextRows = [...rows]
  nextRows[index] = {
    ...row,
    角度偏差: NORMAL_ANGLE,
    限位状态: NORMAL_LIMIT,
    支架状态: '正常跟踪',
    上次润滑时间: shouldLube ? todayStr() : lastLube(row),
    status: '正常跟踪',
    pending: false,
    abnormal: false,
  }

  const closedIds = new Set(open.map((event) => event.id))
  const nextEvents = events.map((event) =>
    closedIds.has(Number(event.id))
      ? { ...event, status: '已闭环', pending: false, abnormal: false, 闭环时间: stamp, 复核单号: no }
      : event,
  )
  const nextReviews = [
    ...reviews,
    {
      id: nextId(reviews),
      status: '待复核',
      pending: true,
      abnormal: false,
      复核单号: no,
      支架编号: code,
      所属方阵: text(row, '所属方阵'),
      偏差数: open.length,
      复位时间: stamp,
      复核时间: '',
      复核人: '',
      润滑: shouldLube ? '是' : '否',
    },
  ]

  const result = commitChanges(
    {
      [TRACKER_KEY]: nextRows,
      [TRACKER_DEVIATION_EVENTS_KEY]: nextEvents,
      [TRACKER_PATROL_REVIEWS_KEY]: nextReviews,
    },
    {},
    makeLedgerGuard(nextEvents, nextReviews),
  )
  if (!result.ok) {
    return fail(result.reason)
  }

  // 提交成功后再回读一遍，确认两条状态（角度偏差、限位状态）确实落成，不成立则报告。
  const written = listRows(TRACKER_KEY)[index]
  if (text(written, '角度偏差') !== NORMAL_ANGLE || text(written, '限位状态') !== NORMAL_LIMIT) {
    return fail('回写校验失败：角度偏差/限位状态未同时复位，请整笔重办')
  }

  const done: string[] = []
  if (limitAlarm) {
    done.push('限位已复位')
  }
  if (open.length > 0) {
    done.push(`角度偏差 ${open.length} 条已闭环`)
  }
  if (shouldLube) {
    done.push(`润滑完成（周期 ${lubeDays(row)} 天，从上次润滑 ${lastLube(row) || '未登记'} 补起）`)
  }
  return {
    ok: true,
    message: `整笔办成：${done.join('、')}；角度偏差/限位状态已一起回写，复核单 ${no} 已挂巡视台账`,
  }
}

// ───────────────────────────── 动作：更换驱动机构 ─────────────────────────────

/** 改驱动机构只归本方阵专责：所选专责方阵与支架所属方阵不一致，一律退回。 */
export function changeDriveMotor(
  trackerId: number,
  newMotor: string,
  responsibleArray: string,
): ActionResult {
  ensureTrackerSchema()
  const motor = String(newMotor ?? '').trim()
  if (!motor) {
    return fail('新驱动机构编号不能为空')
  }
  if (!responsibleArray) {
    return fail('未选定本班专责方阵，不能更换驱动机构')
  }
  const { rows } = snapshots()
  const index = rows.findIndex((row) => Number(row.id) === trackerId)
  if (index < 0) {
    return fail(`没有找到编号为 ${trackerId} 的跟踪支架`)
  }
  const row = rows[index]
  const owner = text(row, '所属方阵')
  if (owner !== responsibleArray) {
    return fail(`跨方阵操作退回：该支架属「${owner}」，本班专责为「${responsibleArray}」，驱动机构只归本方阵专责管`)
  }
  const nextRows = [...rows]
  nextRows[index] = { ...row, 驱动电机: motor }
  const result = commitChanges({ [TRACKER_KEY]: nextRows })
  if (!result.ok) {
    return fail(result.reason)
  }
  return { ok: true, message: `${owner} 专责确认，驱动机构已更换为 ${motor}` }
}

// ───────────────────────── 巡视侧：确认复核（台账回写） ─────────────────────────

/** 巡视复核：把待复核行核销。支架侧同一复核单挂着的闭环偏差数必须与本行偏差数一致。 */
export function confirmPatrolReview(reviewId: number, reviewer: string): ActionResult {
  ensureTrackerSchema()
  const person = String(reviewer ?? '').trim() || '巡检值班员'
  const { rows, events, reviews } = snapshots()
  const index = reviews.findIndex((review) => Number(review.id) === reviewId)
  if (index < 0) {
    return fail(`没有找到编号为 ${reviewId} 的复核记录`)
  }
  const review = toReview(reviews[index])
  if (review.status === '已复核') {
    return fail(`复核单 ${review.复核单号} 已复核过，不重复办理`)
  }
  const linked = events
    .map(toEvent)
    .filter((event) => event.复核单号 === review.复核单号 && event.status === '已闭环')
  if (linked.length !== review.偏差数) {
    return fail(
      `两处偏差数对不上：复核单 ${review.复核单号} 登记 ${review.偏差数} 条，支架侧实际闭环 ${linked.length} 条，已拦截`,
    )
  }
  const nextReviews = [...reviews]
  nextReviews[index] = {
    ...reviews[index],
    status: '已复核',
    pending: false,
    abnormal: false,
    复核时间: nowStr(),
    复核人: person,
  }
  const result = commitChanges(
    {
      [TRACKER_KEY]: rows,
      [TRACKER_DEVIATION_EVENTS_KEY]: events,
      [TRACKER_PATROL_REVIEWS_KEY]: nextReviews,
    },
    {},
    makeLedgerGuard(events, nextReviews),
  )
  if (!result.ok) {
    return fail(result.reason)
  }
  return { ok: true, message: `复核单 ${review.复核单号} 已复核，两端 ${review.偏差数} 条偏差对账一致` }
}
