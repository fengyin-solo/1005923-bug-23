import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
    // 驱动机构/复位润滑只许本方阵专责动手；默认 A 方阵，B 方阵操作应被退回。
    responsibleArrays: ['A方阵'] as string[],
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setResponsibleArrays(arrays: string[]) {
      this.responsibleArrays = arrays
    },
  },
})
