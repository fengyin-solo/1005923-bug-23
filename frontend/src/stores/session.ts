import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '光伏电站运行维护管理平台',
    // 本班专责方阵：驱动机构等跨方阵作业的权限边界，空串表示未选定（一律不放行）。
    responsibleArray: '',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setResponsibleArray(label: string) {
      this.responsibleArray = label
    },
  },
})
