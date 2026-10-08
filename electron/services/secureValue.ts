import { safeStorage } from 'electron'

/**
 * safeStorage（Windows=DPAPI，同用户跨应用可通）封装。
 * 用于「劫持」目标 IDE 的加密格式：
 * - 读取时若原值是 DPAPI 密文（base64），尝试解密还原明文；
 * - 写入时按原格式镜像：原值是密文就用 safeStorage 重新加密，原值是明文就写明文。
 * 绝不写入目标 IDE 无法解析的格式。
 */

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * base64 形态启发：DPAPI/safeStorage 密文以文本存储时是「带填充的标准 base64」，
 * 且长度较长、必为 4 的倍数。收紧判据以修正 L5——避免把恰好是纯 base64 字母表的
 * 明文 token（无 enc 前缀特征、长度非 4 的倍数或过短）误判为需 safeStorage 解密的密文。
 * 真正的 safeStorage 密文仍会命中；误判时 tryDecryptSecret 的 try/catch 亦会回退为明文。
 */
const MIN_CIPHER_LEN = 32
function isBase64ish(s: string): boolean {
  if (typeof s !== 'string') return false
  // 过短或非 4 的倍数：几乎不可能是标准 base64 密文，多为明文 token
  if (s.length < MIN_CIPHER_LEN || s.length % 4 !== 0) return false
  // 仅允许标准 base64 字母表，'=' 只能出现在末尾（至多两个）
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

/**
 * 尝试把一个可能是密文的字符串还原为明文。
 * 返回 encrypted 标记，供写回时镜像加密格式。
 */
export function tryDecryptSecret(raw: unknown): { plain: string; encrypted: boolean } {
  if (typeof raw !== 'string' || !raw) return { plain: typeof raw === 'string' ? raw : '', encrypted: false }
  // 明文快路径：含非 base64 字符（如 sk- 前缀里的 '-'、JSON、URL）直接视为明文
  if (!isBase64ish(raw)) return { plain: raw, encrypted: false }
  if (encryptionAvailable()) {
    try {
      const plain = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      if (plain) return { plain, encrypted: true }
    } catch {
      // 不是本机制可解的 safeStorage 密文，按明文 token 处理
    }
  }
  return { plain: raw, encrypted: false }
}

/** 按镜像标记加密：mirrorEncrypted=true 且加密可用时输出 base64 密文，否则明文 */
export function encryptSecret(plain: string, mirrorEncrypted: boolean): string {
  if (mirrorEncrypted && encryptionAvailable()) {
    try {
      return safeStorage.encryptString(plain).toString('base64')
    } catch {
      // 加密失败降级为明文，避免写入不可解析内容
    }
  }
  return plain
}
