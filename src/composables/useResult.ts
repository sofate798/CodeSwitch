import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { OpResult } from '../../electron/shared/types'

/**
 * 统一操作结果反馈（Jack-Med14 / M-2）。
 *
 * 后端所有"操作类" IPC 已统一返回 OpResult{ ok, code, args, canceled }。视图不再各自
 * 读取 r.message / 比较中文 '已取消'，而是经本助手按消息码 + 参数走 i18n 渲染：
 *  - r.canceled：用户取消系统对话框 -> 静默处理，返回 false；
 *  - r.ok：message.success(t(code ?? 'msg.common.ok', args))；
 *  - 否则：message.error(t(code ?? 'msg.common.error', args))。
 *
 * 返回值即 r.ok，调用方可据此决定是否关闭弹窗 / 刷新列表。
 * message / t 一并返回，方便视图复用（避免重复 useMessage/useI18n）。
 */
export function useResult() {
  const message = useMessage()
  const { t } = useI18n()

  function showResult(r: OpResult): boolean {
    if (r.canceled) return false
    const key = r.code ?? (r.ok ? 'msg.common.ok' : 'msg.common.error')
    const args = r.args ?? {}
    if (r.ok) message.success(t(key, args))
    else message.error(t(key, args))
    return r.ok
  }

  return { message, t, showResult }
}
