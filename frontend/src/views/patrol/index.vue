<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>巡视检查管理</h2>
        <p class="page-desc">维护巡视记录，围绕巡视单号、巡视路线、巡视人员、巡视日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡视记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡视检查清单</button>
      </div>
    </header>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
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
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡视检查数据，可先登记巡视记录</td>
        </tr>
      </tbody>
    </table>

    <section class="review-ledger">
      <header class="ledger-head">
        <h3>跟踪支架复位复核台账</h3>
        <span class="ledger-recon" :class="{ 'recon-bad': ledger.gap !== 0 }">
          待复核偏差对账：支架侧 {{ ledger.trackerSide }} 条 / 本台账 {{ ledger.patrolSide }} 条
          <template v-if="ledger.gap !== 0">（对不上，已拦截新动作）</template>
        </span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>复核单号</th><th>支架编号</th><th>所属方阵</th><th>偏差数</th>
            <th>复位时间</th><th>是否带润滑</th><th>复核状态</th><th>复核人/时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="review in reviewRows" :key="review.id" :class="{ 'row-warn': review.status === '待复核' }">
            <td>{{ review.复核单号 }}</td>
            <td>{{ review.支架编号 }}</td>
            <td>{{ review.所属方阵 }}</td>
            <td>{{ review.偏差数 }}</td>
            <td>{{ review.复位时间 }}</td>
            <td>{{ review.润滑 }}</td>
            <td :class="{ 'cell-warn': review.status === '待复核' }">{{ review.status }}</td>
            <td>
              <template v-if="review.复核时间">{{ review.复核人 }} · {{ review.复核时间 }}</template>
              <template v-else>—</template>
            </td>
            <td class="row-actions">
              <button
                v-if="review.status === '待复核'"
                class="link primary-link"
                type="button"
                @click="confirmReview(review)"
              >确认复核</button>
              <span v-else class="cell-sub">已归档</span>
            </td>
          </tr>
          <tr v-if="!reviewRows.length">
            <td colspan="9" class="empty-state">暂无支架复位复核记录，支架侧执行「复位并润滑」后自动落账</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡视检查记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmPatrolReview,
  downloadEntries,
  listEntries,
  listPatrolReviews,
  moduleMeta,
  reconciliationGap,
  runAction as applyAction,
} from '@/api/local-service'
import type { PatrolReview } from '@/api/tracker-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('patrol')
const columns = ["巡视单号", "巡视路线", "巡视人员", "巡视日期", "检查项数", "异常项数", "巡视时长", "巡视状态"]
const actions = ["开始巡视", "提交复核", "确认完成"]
const statuses = ["待巡视", "巡视中", "待复核", "已完成"]
const stats = [{"label": "今日巡视单", "value": 0}, {"label": "巡视中记录", "value": 0}, {"label": "发现异常项", "value": 0}]

const session = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const reviewRows = ref<PatrolReview[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const ledger = computed(() => reconciliationGap(undefined, reviewRows.value))

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡视记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function confirmReview(review: PatrolReview) {
  errorMessage.value = ''
  const result = confirmPatrolReview(review.id, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reviewRows.value = listPatrolReviews()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡视检查列表读取失败'
  }
}

onMounted(reload)
</script>
