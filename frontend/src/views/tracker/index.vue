<template>
  <section class="page" data-module="tracker">
    <header class="page-head">
      <div>
        <h2>跟踪支架管理</h2>
        <p class="page-desc">复位与润滑合成一次动作：角度偏差、限位状态、支架状态同一份落库，写不成整笔退回；结果回写巡检复核台账两边对账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记跟踪支架</button>
        <button class="btn" type="button" @click="exportRows">导出跟踪支架清单</button>
      </div>
    </header>

    <div class="jurisdiction-bar">
      <span class="jurisdiction-label">当前操作人专责方阵：</span>
      <label v-for="array in availableArrays" :key="array" class="jurisdiction-item">
        <input type="checkbox" :value="array" :checked="responsibleArrays.includes(array)" @change="toggleArray(array)" />
        {{ array }}
      </label>
      <label class="jurisdiction-item fault-item">
        <input type="checkbox" :checked="failNextCommit" @change="failNextCommit = !failNextCommit" />
        模拟下一笔落库失败（演练整笔退回）
      </label>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item mismatch-legend">红格=历史值与当前值对不上</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>详情</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="String(row.id)">
          <tr :class="{ 'row-mismatch': deviationView(row).mismatch }">
            <td>
              <button class="link" type="button" @click="toggleDetail(row)">{{ expandedId === row.id ? '收起' : '详情' }}</button>
            </td>
            <td v-for="column in columns" :key="column" :class="cellClass(row, column)">
              {{ displayCell(row, column) }}
            </td>
            <td :class="{ 'cell-danger': row.abnormal || isAlarm(row) }">{{ row.status }}</td>
            <td class="row-actions">
              <button
                v-for="action in actions"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedId === row.id" class="detail-row">
            <td :colspan="columns.length + 3">
              <dl class="detail-panel">
                <div>
                  <dt>当前偏差读数</dt>
                  <dd :class="{ 'cell-danger': deviationView(row).mismatch }">{{ deviationView(row).current || '—' }}</dd>
                </div>
                <div>
                  <dt>在办偏差（挂巡检复核）</dt>
                  <dd :class="{ 'cell-danger': openCount(row) > 0 }">{{ openCount(row) }} 项</dd>
                </div>
                <div>
                  <dt>限位 / 支架状态</dt>
                  <dd :class="{ 'cell-danger': isAlarm(row) }">{{ row['限位状态'] }} ｜ {{ row['支架状态'] }}</dd>
                </div>
                <div>
                  <dt>待润滑 / 下次到期</dt>
                  <dd :class="{ 'cell-danger': row['待润滑'] === '是' }">
                    {{ row['待润滑'] }} ｜ {{ row['下次润滑到期'] }}
                  </dd>
                </div>
                <div class="detail-history">
                  <dt>历史偏差（只追加，旧版不丢）</dt>
                  <dd>
                    <p v-for="(item, i) in deviationView(row).history" :key="i">
                      {{ item.日期 }} {{ item.偏差 }}<template v-if="item.处置">（{{ item.处置 }}）</template>
                    </p>
                    <span v-if="deviationView(row).history.length === 0">无</span>
                  </dd>
                </div>
                <div v-if="deviationView(row).mismatch" class="detail-mismatch">
                  ⚠ 历史值与当前值对不上：以当前读数为准，旧版已保留进历史偏差，请核对后复位。
                </div>
              </dl>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无跟踪支架数据，可先登记跟踪支架</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条跟踪支架记录</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  isLimitAlarm,
  nextLubricationDate,
  openDeviationCount,
  parseDeviationCell,
  type DeviationView,
} from '@/api/tracker-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('tracker')
const columns = meta.fields
const actions = meta.actions
const statuses = meta.statuses
const availableArrays = ['A方阵', 'B方阵']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const expandedId = ref<number | null>(null)
const failNextCommit = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = ['支架编号', '所属方阵', '跟踪方式']

const responsibleArrays = computed(() => session.responsibleArrays)

function toggleArray(array: string) {
  const next = responsibleArrays.value.includes(array)
    ? responsibleArrays.value.filter((item) => item !== array)
    : [...responsibleArrays.value, array]
  session.setResponsibleArrays(next)
}

const stats = computed(() => [
  { label: '在运支架', value: rows.value.length },
  { label: '角度偏差支架', value: rows.value.filter((row) => String(row.status) === '角度偏差').length },
  { label: '待润滑支架', value: rows.value.filter((row) => String(row['待润滑']) === '是').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function deviationView(row: EntryRow): DeviationView {
  return parseDeviationCell(row['角度偏差'], row['历史偏差'])
}

function openCount(row: EntryRow): number {
  return openDeviationCount(row)
}

function isAlarm(row: EntryRow): boolean {
  return isLimitAlarm(row)
}

function displayCell(row: EntryRow, column: string): string {
  if (column === '下次润滑到期') {
    return String(row[column] ?? nextLubricationDate(row))
  }
  return String(row[column] ?? '—')
}

function cellClass(row: EntryRow, column: string): Record<string, boolean> {
  if (column === '角度偏差') {
    return { 'cell-danger': deviationView(row).mismatch }
  }
  if (column === '限位状态') {
    return { 'cell-danger': isAlarm(row) }
  }
  if (column === '待润滑') {
    return { 'cell-danger': row[column] === '是' }
  }
  if (column === '在办偏差数') {
    return { 'cell-danger': openCount(row) > 0 }
  }
  return {}
}

function toggleDetail(row: EntryRow) {
  expandedId.value = expandedId.value === row.id ? null : row.id
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '跟踪支架登记入口尚未接入审批流'
  okMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  const currentDeviation =
    action === '登记偏差' ? window.prompt('本次实测角度偏差（如 0.9°/限值0.5°）', '0.9°/限值0.5°') ?? undefined : undefined
  const result = applyAction(meta.key, Number(row.id), action, {
    operatorArrays: responsibleArrays.value,
    currentDeviation,
    failNextCommit: failNextCommit.value,
  })
  failNextCommit.value = false
  if (!result.ok) {
    errorMessage.value = result.missingStep
      ? `${result.message}（缺的步骤：${result.missingStep}）`
      : result.message
    reload()
    return
  }
  okMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '跟踪支架列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.jurisdiction-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border: 1px dashed var(--border, #d0d5dd);
  border-radius: 8px;
  background: #fafafa;
  font-size: 13px;
}
.jurisdiction-label { color: #475467; }
.jurisdiction-item { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.fault-item { margin-left: auto; color: #b42318; }
.cell-danger { color: #b42318; font-weight: 600; }
.row-mismatch { background: #fef3f2; }
.mismatch-legend { color: #b42318; }
.detail-row td { background: #f9fafb; padding: 0; }
.detail-panel {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 16px;
  margin: 0;
  padding: 12px 16px;
}
.detail-panel dt { color: #667085; font-size: 12px; }
.detail-panel dd { margin: 2px 0 0; }
.detail-history { grid-column: 1 / -1; }
.detail-history p { margin: 2px 0; }
.detail-mismatch {
  grid-column: 1 / -1;
  color: #b42318;
  background: #fef3f2;
  border: 1px solid #fecdca;
  border-radius: 6px;
  padding: 6px 10px;
}
.ok-text { color: #027a48; }
</style>
