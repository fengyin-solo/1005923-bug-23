<template>
  <section class="page" data-module="tracker">
    <header class="page-head">
      <div>
        <h2>跟踪支架管理</h2>
        <p class="page-desc">
          复位与润滑合为一次整笔动作：角度偏差、限位状态、支架状态同写同退；复位结果同步挂巡视复核台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记跟踪支架</button>
        <button class="btn" type="button" @click="exportRows">导出跟踪支架清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-alert': item.alert }">{{ item.value }}</strong>
      </article>
    </div>

    <div class="duty-bar">
      <label class="filter-item">
        <span>本班专责方阵（改驱动机构用）</span>
        <select v-model="responsibleArray">
          <option value="">未选定</option>
          <option v-for="item in arrays" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <span class="duty-hint">跨方阵更换驱动机构一律退回；未选定专责时不放行。</span>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table tracker-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>在办偏差</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :class="{ 'row-open': detailId === row.id }"
          @click="toggleDetail(row.id)"
        >
          <td>{{ row['支架编号'] }}</td>
          <td>{{ row['所属方阵'] }}</td>
          <td>{{ row['跟踪方式'] }}</td>
          <td>{{ row['驱动电机'] }}</td>
          <td>
            <span class="cell-stack">
              <span :class="angleCellClass(row)">{{ row.当前偏差 }}</span>
              <span v-if="row.历史偏差.length" class="cell-sub">
                历史 {{ row.历史偏差.map((item) => item.value).join('、') }}
              </span>
              <span v-if="row.偏差冲突" class="conflict-flag" title="历史读数与当前值对不上，以当前值为准，历史值保留备查">
                ⚠ 历史/当前对不上
              </span>
            </span>
          </td>
          <td :class="{ 'cell-bad': row['限位状态'] === '报警' }">{{ row['限位状态'] }}</td>
          <td>
            <span class="cell-stack">
              <span>{{ row.润滑周期 }} 天</span>
              <span class="cell-sub">
                上次：{{ row['上次润滑时间'] || '未登记' }}
                <template v-if="row.待润滑">
                  <b v-if="row.润滑超期天数 > 0" class="lube-due">已超期 {{ row.润滑超期天数 }} 天</b>
                  <b v-else class="lube-due">已到期</b>
                </template>
                <template v-else>· 下次 {{ row.下次润滑到期 }}</template>
              </span>
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td>
            <span :class="badgeClass(row.在办偏差数)">{{ row.在办偏差数 }} 条</span>
            <span v-if="row.待复核偏差数" class="review-badge">待复核 {{ row.待复核偏差数 }}</span>
          </td>
          <td :class="statusCellClass(row)">{{ row.status }}</td>
          <td class="row-actions" @click.stop>
            <button class="link" type="button" @click="runAction('登记偏差', row)">登记偏差</button>
            <button class="link primary-link" type="button" @click="runAction('复位并润滑', row)">复位并润滑</button>
            <button class="link" type="button" @click="runAction('更换驱动机构', row)">更换驱动机构</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无跟踪支架数据，可先登记跟踪支架</td>
        </tr>
      </tbody>
    </table>

    <div v-if="detail" class="detail-panel">
      <header class="detail-head">
        <h3>{{ detail['支架编号'] }} · {{ detail['所属方阵'] }} 详情</h3>
        <button class="btn ghost" type="button" @click="detailId = null">收起</button>
      </header>
      <div class="detail-grid">
        <section class="detail-block">
          <h4>在办偏差（同一件事只显示一行）</h4>
          <p v-if="!openEvents.length" class="empty-state">暂无在办偏差</p>
          <table v-else class="data-table sub-table">
            <thead><tr><th>偏差值</th><th>登记时间</th><th>来源</th></tr></thead>
            <tbody>
              <tr v-for="event in openEvents" :key="event.id">
                <td>{{ event.偏差值 }}</td>
                <td>{{ event.登记时间 }}</td>
                <td>{{ event.来源 }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section class="detail-block">
          <h4>历史偏差读数（不顶新值，不丢旧版）</h4>
          <p v-if="!detail.历史偏差.length" class="empty-state">暂无历史读数</p>
          <ul v-else class="history-list">
            <li v-for="(item, idx) in detail.历史偏差" :key="idx" :class="{ mismatch: item.mismatch }">
              {{ item.value }}
              <span v-if="item.mismatch" class="conflict-flag">⚠ 与当前值 {{ detail.当前偏差 }} 对不上，按当前值办</span>
            </li>
          </ul>
        </section>
        <section class="detail-block">
          <h4>复位/复核记录</h4>
          <p v-if="!reviews.length" class="empty-state">暂无复位复核记录</p>
          <table v-else class="data-table sub-table">
            <thead><tr><th>复核单号</th><th>复位时间</th><th>偏差数</th><th>润滑</th><th>复核状态</th></tr></thead>
            <tbody>
              <tr v-for="review in reviews" :key="review.id">
                <td>{{ review.复核单号 }}</td>
                <td>{{ review.复位时间 }}</td>
                <td>{{ review.偏差数 }}</td>
                <td>{{ review.润滑 }}</td>
                <td>{{ review.status }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条跟踪支架记录 · 待复核偏差合计 {{ ledger.trackerSide }}（巡视台账 {{ ledger.patrolSide }}）</span>
      <span v-if="ledger.gap !== 0" class="error-text">⚠ 两处偏差数对不上，整笔动作将被拦截</span>
      <span v-if="message && message.ok" class="ok-text">{{ message.text }}</span>
      <span v-if="message && !message.ok" class="error-text">{{ message.text }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listDeviationEvents,
  listPatrolReviews,
  listTrackers,
  moduleMeta,
  reconciliationGap,
  runAction as applyAction,
} from '@/api/local-service'
import type { DeviationEvent, PatrolReview, TrackerRow } from '@/api/tracker-service'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('tracker')
const columns = ["支架编号", "所属方阵", "跟踪方式", "驱动电机", "角度偏差", "限位状态", "润滑周期", "支架状态"]
const statuses = ["正常跟踪", "角度偏差", "限位报警", "待润滑"]

const session = useSessionStore()
const responsibleArray = computed({
  get: () => session.responsibleArray,
  set: (value: string) => session.setResponsibleArray(value),
})

const rows = ref<TrackerRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = ["支架编号", "所属方阵", "跟踪方式"]
const detailId = ref<number | null>(null)
const message = ref<{ ok: boolean; text: string } | null>(null)

const arrays = computed(() => [...new Set(rows.value.map((row) => row['所属方阵']))])
const allEvents = ref<DeviationEvent[]>([])
const allReviews = ref<PatrolReview[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const stats = computed(() => [
  { label: '在运支架', value: rows.value.length, alert: false },
  { label: '角度偏差支架', value: rows.value.filter((row) => row.status === '角度偏差').length, alert: true },
  { label: '限位报警支架', value: rows.value.filter((row) => row.status === '限位报警').length, alert: true },
  { label: '待润滑支架', value: rows.value.filter((row) => row.待润滑).length, alert: true },
  {
    label: '待复核偏差（支架/巡视）',
    value: `${ledger.value.trackerSide}/${ledger.value.patrolSide}`,
    alert: ledger.value.gap !== 0,
  },
])

const ledger = computed(() => reconciliationGap(allEvents.value, allReviews.value))

const detail = computed(() => rows.value.find((row) => row.id === detailId.value) ?? null)
const openEvents = computed(() =>
  detail.value
    ? allEvents.value.filter(
        (event) => event.支架编号 === detail.value?.['支架编号'] && event.status === '在办',
      )
    : [],
)
const reviews = computed(() =>
  detail.value
    ? allReviews.value.filter((review) => review.支架编号 === detail.value?.['支架编号'])
    : [],
)

function angleCellClass(row: TrackerRow): Record<string, boolean> {
  return {
    'cell-bad': row.status === '角度偏差',
    'cell-conflict': row.偏差冲突,
  }
}

function statusCellClass(row: TrackerRow): Record<string, boolean> {
  return {
    'cell-bad': row.status === '角度偏差' || row.status === '限位报警',
    'cell-warn': row.status === '待润滑',
  }
}

function badgeClass(count: number): string {
  return count > 0 ? 'event-badge open' : 'event-badge'
}

function toggleDetail(id: number) {
  detailId.value = detailId.value === id ? null : id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  message.value = { ok: false, text: '跟踪支架登记入口尚未接入审批流' }
}

function askAngle(): string {
  const input = window.prompt('录入当前角度偏差读数（如 3.8°，复位口径以整笔动作为准）')
  return input === null ? '' : input.trim()
}

function askMotor(current: string): string {
  const input = window.prompt('输入新驱动机构编号（只允许本班专责方阵内办理）', current)
  return input === null ? '' : input.trim()
}

function runAction(action: string, row: TrackerRow) {
  message.value = null
  let payload: string | undefined
  if (action === '登记偏差') {
    payload = askAngle()
    if (!payload) {
      return
    }
  } else if (action === '更换驱动机构') {
    payload = askMotor(row.驱动电机)
    if (!payload) {
      return
    }
  }
  const result = applyAction(meta.key, Number(row.id), action, {
    responsibleArray: responsibleArray.value,
    payload,
  })
  message.value = { ok: result.ok, text: result.message }
  if (result.ok) {
    detailId.value = Number(row.id)
    reload()
  }
}

function matches(row: TrackerRow): boolean {
  return Object.entries(filters.value).every(([field, value]) => {
    const keyword = value.trim()
    const cell = (row as unknown as Record<string, string | number>)[field]
    return keyword === '' || String(cell ?? '').includes(keyword)
  })
}

function reload() {
  message.value = null
  try {
    const trackers = listTrackers()
    allEvents.value = listDeviationEvents()
    allReviews.value = listPatrolReviews()
    rows.value = trackers.filter(matches)
    total.value = rows.value.length
  } catch (error) {
    message.value = {
      ok: false,
      text: error instanceof Error ? error.message : '跟踪支架列表读取失败',
    }
  }
}

onMounted(reload)
</script>
