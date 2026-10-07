// 用 png-to-ico 生成兼容 rcedit/Windows 的 ico
import pngToIco from 'png-to-ico'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('resources/icons')
const src = path.join(root, 'icon-512.png')

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngPaths = []

for (const size of sizes) {
  const p = path.join(root, `icon-${size}.png`)
  await sharp(src).resize(size, size, { kernel: 'lanczos3' }).png().toFile(p)
  pngPaths.push(p)
  console.log(`prepared icon-${size}.png`)
}

const buf = await pngToIco(pngPaths)
fs.writeFileSync(path.join(root, 'icon.ico'), buf)
console.log(`generated icon.ico (${buf.length} bytes)`)
