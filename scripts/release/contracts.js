import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const target = path.join(root, 'packages/contracts/dist')
fs.mkdirSync(path.join(target, 'contracts'), { recursive: true })
fs.mkdirSync(path.join(target, 'util'), { recursive: true })
for (const file of ['contracts/BotConfig.js', 'util/Locale.js', 'util/Proxy.js']) {
    fs.copyFileSync(path.join(root, 'dist', file), path.join(target, file))
}
fs.writeFileSync(path.join(target, 'package.json'), '{"type":"commonjs"}\n')
