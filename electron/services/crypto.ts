import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto'
import { networkInterfaces, hostname } from 'node:os'

/**
 * AES-256-GCM 加密，密钥由设备指纹派生（PBKDF2/scrypt），绑定本机。
 * 格式: enc:<ivHex>:<tagHex>:<dataHex>
 */

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

const SALT = 'codeswitch-static-salt-v1'
const KEY = scryptSync(deviceFingerprint(), SALT, 32)

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

export function decrypt(payload: string): string {
  if (!payload.startsWith('enc:')) return payload // 兼容明文（旧数据/测试）
  const [, ivHex, tagHex, dataHex] = payload.split(':')
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8')
}

/** 脱敏显示: sk-****abcd */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 6) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}
