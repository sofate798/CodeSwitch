import { store } from './store'
import { applyProvider, resetIDE } from './ideScanner'
import { log } from './logger'
import type { Snapshot } from '../shared/types'

export function listSnapshots(): Snapshot[] {
  return store.get('snapshots').sort((a, b) => b.createdAt - a.createdAt)
}

export function createSnapshot(name: string, description = ''): Snapshot {
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
  return snap
}

export function applySnapshot(id: string): { ok: boolean; message: string } {
  const snap = store.get('snapshots').find((s) => s.id === id)
  if (!snap) return { ok: false, message: '快照不存在' }
  const errors: string[] = []
  // 先全部重置，再按快照绑定应用（resetIDE 内部会安全跳过手动配置型 IDE）
  for (const ideId of Object.keys(store.get('ideBindings'))) {
    const r = resetIDE(ideId)
    if (!r.ok && !r.skipped) errors.push(`${ideId}: ${r.message}`)
  }
  for (const [ideId, binding] of Object.entries(snap.ideBindings)) {
    if (binding.providerId) {
      const r = applyProvider(ideId, binding.providerId)
      if (!r.ok) errors.push(`${ideId}: ${r.message}`)
    }
  }
  log('info', 'snapshot-apply', snap.name)
  return errors.length === 0
    ? { ok: true, message: `已应用快照「${snap.name}」` }
    : { ok: false, message: `部分失败: ${errors.join('; ')}` }
}

export function removeSnapshot(id: string): void {
  store.set('snapshots', store.get('snapshots').filter((s) => s.id !== id))
  log('info', 'snapshot-remove', id)
}
