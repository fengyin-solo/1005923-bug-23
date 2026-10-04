/* 支架复位+润滑组合动作的规则自测：不引第三方框架，node 直接跑。
 * 覆盖：同格历史/当前拆分、跨方阵退回、限位未复位拦截、原子落库回滚、
 * 双状态回写校验、重复复位幂等、润滑周期从上次补起、巡检台账两边对账与销账。 */
import { strict as assert } from 'node:assert'
import { listEntries, runAction, resetModule } from '../src/api/local-service'
import { armCommitFailure, resetStoreCache } from '../src/api/tracker-service'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}
function eq(actual: unknown, expected: unknown, hint = '') {
  assert.deepStrictEqual(actual, expected, hint)
}
function truthy(value: unknown, hint = '') {
  assert.ok(value, hint || '期望为真')
}
function falsy(value: unknown, hint = '') {
  assert.ok(!value, hint || '期望为假')
}

function seedEnv() {
  const db = new Map<string, string>()
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => db.get(key) ?? null,
      setItem: (key: string, value: string) => db.set(key, value),
      removeItem: (key: string) => db.delete(key),
    },
  }
  resetStoreCache()
  resetModule('tracker')
  resetModule('patrol')
}

function tracker(id: number) {
  return listEntries('tracker').items.find((row) => Number(row.id) === id)!
}
function openReviewLedger(code: string) {
  return listEntries('patrol').items.filter(
    (row) => String(row['关联支架']) === code && String(row.status) === '待复核',
  )
}

check('兼容既有支架记录：历史/当前挤同一格拆开、对不上标红、旧值不丢、润滑周期补起', () => {
  seedEnv()
  const row = tracker(1) // 旧格式：历史:0.8°｜当前:0.2°
  eq(row['角度偏差'], '0.2°/限值0.5°', '当前值应取当前段')
  truthy(String(row['历史偏差']).includes('0.8°/限值0.5°'), '历史段必须保留进历史偏差')
  eq(row['偏差核对'], '历史与当前不一致', '两版对不上必须标出来')
  eq(row['下次润滑到期'], '2026-11-30', '缺上次润滑时间时从 2026-09-01 补起 +90 天')
  eq(row['润滑周期'], '90天', '看不懂的周期文案兜底为 90 天')
  eq(row['在办偏差数'], 0, '还没复位的偏差不挂在办账')
})

check('跨方阵专责：B 方阵支架由 A 方阵专责操作一律退回，数据不动', () => {
  seedEnv()
  const before = JSON.stringify(tracker(3))
  const res = runAction('tracker', 3, '复位润滑', { operatorArrays: ['A方阵'] })
  falsy(res.ok, '必须拒绝')
  truthy(res.message.includes('跨方阵操作一律退回'), res.message)
  eq(res.missingStep, '切换到B方阵专责账号')
  eq(JSON.stringify(tracker(3)), before, '退回后数据原样')
})

check('限位报警没复位不许做润滑，并指出缺「复位限位」', () => {
  seedEnv()
  const res = runAction('tracker', 3, '复位润滑', { operatorArrays: ['B方阵'] })
  falsy(res.ok)
  truthy(res.message.includes('限位报警未复位'), res.message)
  eq(res.missingStep, '复位限位')
  eq(tracker(3).status, '限位报警', '支架仍停在限位报警')
})

check('落库失败当场拦截、整笔退回，不留半台', () => {
  seedEnv()
  const beforeTracker = JSON.stringify(tracker(2))
  const beforePatrolCount = listEntries('patrol').items.length
  armCommitFailure()
  const res = runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  falsy(res.ok, '落库失败必须返回失败')
  truthy(res.message.includes('整笔退回'), res.message)
  eq(JSON.stringify(tracker(2)), beforeTracker, '支架字段全部回到落库前')
  eq(listEntries('patrol').items.length, beforePatrolCount, '巡检台账不得留下半行')
})

check('复位+润滑成功：三状态同一笔、待润滑销掉、台账两边对账一致', () => {
  seedEnv()
  const reg = runAction('tracker', 2, '登记偏差', { operatorArrays: ['A方阵'], currentDeviation: '0.7°/限值0.5°' })
  truthy(reg.ok, reg.message)
  eq(tracker(2)['在办偏差数'], 0, '仅登记偏差不挂复核账')
  const res = runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  truthy(res.ok, res.message)
  const row = tracker(2)
  eq(row['角度偏差'], '0.0°/限值0.5°', '角度偏差复位为零值')
  eq(row['限位状态'], '正常', '限位状态回写')
  eq(row['支架状态'], '跟踪中', '支架状态回写')
  eq(row['待润滑'], '否', '润滑做完待润滑标记必须销掉')
  eq(row['上次润滑时间'], '2026-10-04', '上次润滑时间更新为今天')
  eq(row['下次润滑到期'], '2027-01-02', '周期从新的上次润滑时间 +90 天补起')
  truthy(String(row['历史偏差']).includes('0.7°/限值0.5°'), '复位前读数归档，历史不丢')
  eq(row['在办偏差数'], 1, '在办偏差挂账等巡检复核')
  eq(row.status, '正常跟踪', '支架状态已正常，红格消掉')
  const ledger = openReviewLedger('TRAC-0002')
  eq(ledger.length, 1, '巡检复核台账只此一条')
  eq(ledger[0]['异常项数'], 1, '台账挂账偏差数=支架侧')
  eq(ledger[0]['台账类别'], '支架复位复核')
})

check('同一件事连点两次复位：第二次拦截，详情/台账不再多出两行', () => {
  seedEnv()
  runAction('tracker', 2, '登记偏差', { operatorArrays: ['A方阵'], currentDeviation: '0.9°/限值0.5°' })
  const first = runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  truthy(first.ok, first.message)
  const second = runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  falsy(second.ok, '重复复位必须拦截')
  truthy(second.message.includes('重复复位被拦截'), second.message)
  eq(second.missingStep, '巡检复核')
  eq(openReviewLedger('TRAC-0002').length, 1, '台账不得重复出行')
  eq(tracker(2)['在办偏差数'], 1, '在办偏差数不重复累加')
})

check('巡检复核确认：两边偏差数同时销账；对不上拒绝销账', () => {
  seedEnv()
  runAction('tracker', 2, '登记偏差', { operatorArrays: ['A方阵'], currentDeviation: '0.9°/限值0.5°' })
  runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  const ledgerId = openReviewLedger('TRAC-0002')[0].id
  const done = runAction('patrol', Number(ledgerId), '确认完成')
  truthy(done.ok, done.message)
  eq(tracker(2)['在办偏差数'], 0, '支架侧销账')
  eq(tracker(2).pending, false, '待办标记清除')
  eq(openReviewLedger('TRAC-0002').length, 0, '台账关闭')

  // 再走一笔，并直接改盘模拟两边打架，销账必须被拦
  runAction('tracker', 2, '登记偏差', { operatorArrays: ['A方阵'], currentDeviation: '0.8°/限值0.5°' })
  runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  const secondLedger = openReviewLedger('TRAC-0002')[0]
  const store = (globalThis as { window: { localStorage: Storage } }).window.localStorage
  const raw = JSON.parse(store.getItem('pv-plant-ops:entries')!)
  raw.tracker.find((row: { id: number }) => row.id === 2)['在办偏差数'] = 9
  store.setItem('pv-plant-ops:entries', JSON.stringify(raw))
  resetStoreCache()
  const reject = runAction('patrol', Number(secondLedger.id), '确认完成')
  falsy(reject.ok, '两边对不上不许销账')
  truthy(reject.message.includes('对不上'), reject.message)
})

check('复位无偏差的待润滑支架：润滑照样完成，台账挂 0，不产生红格', () => {
  seedEnv()
  const res = runAction('tracker', 2, '复位润滑', { operatorArrays: ['A方阵'] })
  truthy(res.ok, res.message)
  eq(tracker(2)['待润滑'], '否')
  eq(tracker(2)['在办偏差数'], 0)
  eq(openReviewLedger('TRAC-0002')[0]['异常项数'], 0)
  falsy(tracker(2).abnormal)
})

check('旧版冲突复位后：以当前值为准、旧版归档不丢、核对恢复一致', () => {
  seedEnv()
  eq(tracker(1)['偏差核对'], '历史与当前不一致')
  const res = runAction('tracker', 1, '复位润滑', { operatorArrays: ['A方阵'] })
  truthy(res.ok, res.message)
  const after = tracker(1)
  eq(after['偏差核对'], '一致')
  truthy(String(after['历史偏差']).includes('0.8°/限值0.5°'), '迁移归档的旧版还在')
  truthy(String(after['历史偏差']).includes('0.2°/限值0.5°'), '复位前的当前读数也归档了')
  eq(after['角度偏差'], '0.0°/限值0.5°', '当前格被新值占据，旧值没有顶回来')
})

check('润滑周期兼容结构化既有记录：TRAC-0004 上次 2026-09-10 则 2026-12-09 到期', () => {
  seedEnv()
  const row = tracker(4)
  eq(row['下次润滑到期'], '2026-12-09')
  eq(row['待润滑'], '否', '2026-10-04 时未到期')
})

console.log(`\n${passed} 项检查全部通过`)
