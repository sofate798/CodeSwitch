import { store } from './store'
import { applyProvider, resetIDE } from './ideScanner'
import { log } from './logger'
import type { Snapshot, OpResult } from '../shared/types'

export function listSnapshots(): Snapshot[] {
  return store.get('snapshots').sort((a, b) => b.createdAt - a.createdAt)
}

export function createSnapshot(name: string, description = ''): OpResult<Snapshot> {
  const bindings = store.get('ideBindings')
  const snap: Snapshot = {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    createdAt: Date.now(),
    ideBindings: Object.fromEntries(
      Object.entries(bindings).map(([ideId, v]) => [ideId, { providerId: v.providerId }])
    )
  }
  const list = store.get('snapshots')
  list.push(snap)
  store.set('snapshots', list)
  log('info', 'snapshot-create', name)
  return { ok: true, code: 'msg.snapshot.createOk', data: snap }
}

export async function applySnapshot(id: string): Promise<OpResult> {
  const snap = store.get('snapshots').find((s) => s.id === id)
  if (!snap) return { ok: false, code: 'msg.snapshot.notFound' }
  const errors: string[] = []
  let applied = 0
  // 先全部重置：resetIDE 现返回 OpResult，canceled=true 表示跳过（manual/assist），不计失败
  for (const ideId of Object.keys(store.get('ideBindings'))) {
    const r = await resetIDE(ideId)
    if (r.canceled) continue
    if (!r.ok) errors.push(`${ideId}: ${r.code ?? 'reset-failed'}`)
  }
  // 再按快照绑定应用：不可写 IDE（notWritable / canceled）跳过，不计失败
  for (const [ideId, binding] of Object.entries(snap.ideBindings)) {
    if (!binding.providerId) continue
    const r = await applyProvider(ideId, binding.providerId)
    if (r.canceled || r.code === 'msg.ide.notWritable') continue
    if (!r.ok) errors.push(`${ideId}: ${r.code ?? 'apply-failed'}`)
    else applied++
  }
  log(
    errors.length === 0 ? 'info' : 'warn',
    'snapshot-apply',
    `${snap.name} applied=${applied}${errors.length ? ' failed=' + errors.join('; ') : ''}`
  )
  // 失败仅回传消息码 + 失败数（errors 内含原始码，不外透以免泄漏 i18n key，明细已落日志）
  return errors.length === 0
    ? { ok: true, code: 'msg.snapshot.applyOk', args: { name: snap.name, applied } }
    : { ok: false, code: 'msg.snapshot.applyFailed', args: { count: errors.length } }
}

export function removeSnapshot(id: string): OpResult {
  store.set('snapshots', store.get('snapshots').filter((s) => s.id !== id))
  log('info', 'snapshot-remove', id)
  return { ok: true, code: 'msg.snapshot.removeOk' }
}

/**
 * 直接插入一个给定绑定关系的快照（用于 .csnap 导入，绑定已重映射到本机供应商 id）。
 * 名称与现有快照重复时自动追加后缀，避免混淆。返回 msg.snapshot.importOk。
 */
export function insertSnapshot(input: { name: string; description?: string; createdAt?: number; ideBindings: Record<string, { providerId: string | null }> }): OpResult<Snapshot> {
  const list = store.get('snapshots')
  const names = new Set(list.map((s) => s.name))
  let name = input.name?.trim() || '导入的快照'
  if (names.has(name)) {
    let i = 2
    while (names.has(`${name} (${i})`)) i++
    name = `${name} (${i})`
  }
  const snap: Snapshot = {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: input.description ?? '',
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    ideBindings: input.ideBindings ?? {}
  }
  list.push(snap)
  store.set('snapshots', list)
  log('info', 'snapshot-import', name)
  return { ok: true, code: 'msg.snapshot.importOk', data: snap }
}
