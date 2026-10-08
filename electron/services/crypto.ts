import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto'
import { networkInterfaces, hostname } from 'node:os'
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './logger'

/**
 * AES-256-GCM 加密服务（随机 IV + authTag）。
 *
 * 主密钥策略（C1 修复）：
 * - 新版：首次运行生成随机 256-bit 主密钥，用 Electron safeStorage（Windows=DPAPI）加密后
 *   持久化到 <userData>/secure/master.key；后续启动读取并还原。与设备指纹彻底解耦，
 *   网络切换 / VPN / 扩展坞 / Windows 随机硬件地址不再影响历史密文的可解密性。
 * - 遗留：旧密文 enc: 由 hostname + 非内网 MAC 经 scrypt(静态盐) 派生的密钥加密，
 *   仅为兼容解密旧数据而保留（M-3：静态盐不再作为唯一熵源）。
 *
 * 密文格式（版本化，支持无损惰性迁移）：
 * - 新格式 enc2:<ivHex>:<tagHex>:<dataHex>（主密钥加密）
 * - 旧格式 enc:<ivHex>:<tagHex>:<dataHex>（遗留派生密钥加密）
 * encrypt() 一律输出新格式；decrypt() 同时支持新旧两种格式。旧 Key 仍可读，
 * 并在下次保存时被 encrypt() 自动升级为新格式，零数据丢失。
 *
 * 惰性初始化：主密钥与遗留派生密钥都在首次调用 encrypt/decrypt 时才计算，并实时读取
 * app.getPath('userData')，以尊重 bootstrap.ts 对 userData 的重定向；绝不在模块 import
 * 时读取路径或派生密钥。
 *
 * 安全：绝不将明文 Key 或主密钥写入日志。
 */

const NEW_PREFIX = 'enc2:'
const LEGACY_PREFIX = 'enc:'
const LEGACY_SALT = 'codeswitch-static-salt-v1'

/** 主密钥不可用（文件损坏 / safeStorage 无法解密 / 认证失败）时抛出，供上层区分处理 */
export class KeyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeyUnavailableError'
  }
}

/** 遗留设备指纹：hostname + 所有非内网 MAC（仅用于解密旧 enc: 密文） */
function deviceFingerprint(): string {
  const nets = networkInterfaces()
  const macs: string[] = []
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.mac && a.mac !== '00:00:00:00:00:00') macs.push(a.mac)
    }
  }
  macs.sort()
  return `${hostname()}|${macs.join(',')}`
}

function isSafeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 主密钥文件路径：实时取 userData，尊重 bootstrap 的重定向 */
function masterKeyFile(): string {
  return path.join(app.getPath('userData'), 'secure', 'master.key')
}

interface KeyEnvelope {
  v: number
  mode: 'safeStorage' | 'fallback'
  key: string
}

let masterKey: Buffer | null = null
let legacyKey: Buffer | null = null

function writeKeyFile(file: string, env: KeyEnvelope): void {
  const data = JSON.stringify(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    // 0o600：POSIX 平台限制仅属主可读写；Windows 上由 DPAPI/用户目录 ACL 兜底
    fs.writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 })
  } catch {
    fs.writeFileSync(file, data, 'utf8')
  }
}

/** 首次运行：生成随机 256-bit 主密钥并落盘（优先 safeStorage 保护，否则降级为受文件权限保护的本地密钥） */
function createMasterKey(file: string): Buffer {
  const key = randomBytes(32)
  if (isSafeStorageAvailable()) {
    const blob = safeStorage.encryptString(key.toString('hex')).toString('base64')
    writeKeyFile(file, { v: 1, mode: 'safeStorage', key: blob })
  } else {
    // 极少数环境 safeStorage 不可用：降级为受文件权限保护的本地密钥文件，保证 Windows 上始终可用
    log('warn', 'crypto.masterKey', 'safeStorage 不可用，主密钥已降级为受文件权限保护的本地密钥文件')
    writeKeyFile(file, { v: 1, mode: 'fallback', key: key.toString('base64') })
  }
  return key
}

/** 从磁盘还原主密钥；文件存在但无法解密时抛 KeyUnavailableError（绝不重新生成，避免历史 enc2 密文永久失效） */
function loadMasterKey(file: string): Buffer {
  let env: KeyEnvelope
  try {
    env = JSON.parse(fs.readFileSync(file, 'utf8')) as KeyEnvelope
  } catch {
    throw new KeyUnavailableError('主密钥文件损坏或无法解析')
  }
  const raw = env && typeof env.key === 'string' ? env.key : ''
  if (!raw) throw new KeyUnavailableError('主密钥文件内容缺失')

  if (env.mode === 'fallback') {
    const buf = Buffer.from(raw, 'base64')
    if (buf.length !== 32) throw new KeyUnavailableError('主密钥长度异常')
    return buf
  }

  // 默认按 safeStorage 处理
  if (!isSafeStorageAvailable()) {
    throw new KeyUnavailableError('safeStorage 当前不可用，无法解密主密钥')
  }
  let hex: string
  try {
    hex = safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    throw new KeyUnavailableError('主密钥解密失败（safeStorage/DPAPI）')
  }
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) throw new KeyUnavailableError('主密钥长度异常')
  return buf
}

/** 惰性获取主密钥：首次调用时读取/生成并缓存 */
function ensureMasterKey(): Buffer {
  if (masterKey) return masterKey
  const file = masterKeyFile()
  try {
    masterKey = fs.existsSync(file) ? loadMasterKey(file) : createMasterKey(file)
    return masterKey
  } catch (e) {
    masterKey = null
    throw e instanceof KeyUnavailableError
      ? e
      : new KeyUnavailableError(`主密钥不可用: ${(e as Error).message}`)
  }
}

/** 惰性获取遗留派生密钥（仅用于解密旧 enc: 密文） */
function ensureLegacyKey(): Buffer {
  if (!legacyKey) legacyKey = scryptSync(deviceFingerprint(), LEGACY_SALT, 32)
  return legacyKey
}

/** 用指定密钥解密 <ivHex>:<tagHex>:<dataHex>；结构损坏或 GCM 认证失败抛 KeyUnavailableError */
function decryptBody(body: string, key: Buffer, label: string): string {
  const parts = body.split(':')
  if (parts.length !== 3) throw new KeyUnavailableError(`${label} 密文结构损坏`)
  const [ivHex, tagHex, dataHex] = parts
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
  } catch {
    // GCM 认证失败：密钥不匹配或密文被篡改
    throw new KeyUnavailableError(`${label} 密文解密失败（认证失败）`)
  }
}

/** 加密：一律输出新格式 enc2:（主密钥） */
export function encrypt(plain: string): string {
  const key = ensureMasterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain ?? '', 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${NEW_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/**
 * 解密：同时支持新格式 enc2:（主密钥）与旧格式 enc:（遗留派生密钥）。
 * 已移除静默明文回退：既非 enc: 也非 enc2: 前缀的值一律记录告警并抛 KeyUnavailableError。
 * 空值（无密钥）幂等返回空串——空串不含机密，不视为明文回退。
 */
export function decrypt(cipher: string): string {
  if (typeof cipher !== 'string' || cipher === '') return ''
  if (cipher.startsWith(NEW_PREFIX)) return decryptBody(cipher.slice(NEW_PREFIX.length), ensureMasterKey(), 'enc2')
  if (cipher.startsWith(LEGACY_PREFIX)) return decryptBody(cipher.slice(LEGACY_PREFIX.length), ensureLegacyKey(), 'enc')
  log('warn', 'crypto.decrypt', '收到无 enc/enc2 前缀的值，已拒绝按明文返回（强制静态加密）')
  throw new KeyUnavailableError('密文格式无法识别，且不允许明文回退')
}

/** 脱敏显示：统一为 sk-****xxxx 规格（前缀 sk- + **** + 明文后 4 位） */
export function maskKey(value: string): string {
  if (!value) return ''
  return `sk-****${value.slice(-4)}`
}

/** 解密密文并返回明文后 4 位；任何失败返回 ''（供上层组装脱敏展示，不抛错） */
export function keyTail(cipher: string): string {
  try {
    const plain = decrypt(cipher)
    return plain ? plain.slice(-4) : ''
  } catch {
    return ''
  }
}

/** 是否为旧 enc: 格式（enc2: 不匹配 enc: 前缀，无歧义） */
export function isLegacyCipher(cipher: string): boolean {
  return typeof cipher === 'string' && cipher.startsWith(LEGACY_PREFIX)
}

/**
 * 旧格式 → 新格式重加密（供启动批量迁移调用）。
 * 非旧格式（已是 enc2: 或无法识别）原样返回，保证幂等；
 * 旧格式解密失败时抛 KeyUnavailableError，绝不吞掉数据丢失。
 */
export function migrateCipher(cipher: string): string {
  if (!isLegacyCipher(cipher)) return cipher
  return encrypt(decrypt(cipher))
}
