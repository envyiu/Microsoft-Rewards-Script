// One-time bootstrap. Does not stop services, edit account data or resume work.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import release from '../../common/workerRelease.cjs'
export function setupUpdater({
    root,
    data,
    kind,
    platform = process.platform,
    node = process.execPath,
    source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
}) {
    root = path.resolve(root)
    data = path.resolve(data)
    if (
        !path.isAbsolute(root) ||
        !path.isAbsolute(data) ||
        !['local', 'remote'].includes(kind) ||
        !['linux', 'win32'].includes(platform)
    )
        throw Error('Invalid updater installation')
    const directory = path.join(root, 'updater')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const runner = fs
        .readFileSync(path.join(source, 'scripts/worker/updateRunner.js'), 'utf8')
        .replace("'../../common/workerRelease.cjs'", "'./workerRelease.cjs'")
    fs.writeFileSync(path.join(directory, 'runner.js.tmp'), runner, { mode: 0o600 })
    fs.renameSync(path.join(directory, 'runner.js.tmp'), path.join(directory, 'runner.js'))
    fs.copyFileSync(
        path.join(source, 'packages/contracts/workerRelease.cjs'),
        path.join(directory, 'workerRelease.cjs')
    )
    release.atomicJson(path.join(directory, 'package.json'), { type: 'module' })
    release.atomicJson(path.join(directory, 'config.json'), {
        schema: 1,
        root,
        data,
        kind,
        platform,
        node,
        user: os.userInfo().username
    })
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = Object.fromEntries(
        process.argv.slice(2).reduce((a, v, i, all) => {
            if (i % 2 === 0) a.push([v.replace(/^--/, ''), all[i + 1]])
            return a
        }, [])
    )
    setupUpdater(args)
    console.log('Updater installed; restart a drained Worker once to enable Fleet updates.')
}
