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

export async function applySnapshot(id: string): Promise<{ ok: boolean; message: string }> {
  const snap = store.get('snapshots').find((s) => s.id === id)
  if (!snap) return { ok: false, message: '快照不存在' }
  const errors: string[] = []
  // 先全部重置，再按快照绑定应用（resetIDE 内部会安全跳过手动/辅助配置型 IDE）
  for (const ideId of Object.keys(store.get('ideBindings'))) {
    const r = await resetIDE(ideId)
    if (!r.ok && !r.skipped) errors.push(`${ideId}: ${r.message}`)
  }
  for (const [ideId, binding] of Object.entries(snap.ideBindings)) {
    if (binding.providerId) {
      const r = await applyProvider(ideId, binding.providerId)
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

/**
 * 直接插入一个给定绑定关系的快照（用于 .csnap 导入，绑定已重映射到本机供应商 id）。
 * 名称与现有快照重复时自动追加后缀，避免混淆。
 */
export function insertSnapshot(input: { name: string; description?: string; createdAt?: number; ideBindings: Record<string, { providerId: string | null }> }): Snapshot {
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
  return snap
}
