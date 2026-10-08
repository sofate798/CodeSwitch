/**
 * 启动引导（必须最先执行的副作用模块）。
 *
 * main/index.ts 里 `import './bootstrap'` 位于 handlers/store 之前，
 * 因此本文件的顶层调用会在 electron-store 实例化前重定向 userData，
 * 使「自定义数据目录」在重启后真正生效。切勿在此文件中引入 store/handlers。
 */
import { applyCustomDataDir } from '../services/paths'

applyCustomDataDir()
