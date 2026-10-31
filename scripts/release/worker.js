import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.resolve(process.argv[2] || path.join(root, 'releases'))
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-worker-release-'))
try {
    if (!fs.existsSync(path.join(root, 'dist/index.js'))) throw new Error('Run npm run build first')
    const files = ['dist', 'common', 'packages/contracts', 'scripts/api', 'scripts/main', 'scripts/worker', 'scripts/package.json', 'scripts/env.js', 'scripts/utils.js', 'package.json', 'package-lock.json', 'config.example.json']
    const excluded = new Set(['fleet.js', 'nodeProvisioner.js', 'apiFixture.js', 'fixture.js'])
    for (const file of files) fs.cpSync(path.join(root, file), path.join(staging, file), {
        recursive: true, filter: source => !source.endsWith('.test.js') && !excluded.has(path.basename(source)) && path.basename(source) !== 'node_modules'
    })
    const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'))
    pkg.scripts = { start: 'node scripts/worker/server.js' }
    // Keep package identity and dependencies in agreement with the existing lockfile.
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2))
    fs.copyFileSync(path.join(root, 'scripts/worker/install.sh'), path.join(staging, 'install.sh'))
    fs.copyFileSync(path.join(root, 'scripts/worker/README.md'), path.join(staging, 'README.md'))
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ product: 'msrw-worker', protocolVersion: 3, version: pkg.version }))
    execFileSync('tar', ['-czf', path.join(output, 'msrw-worker.tgz'), '-C', staging, '.'])
    console.log(path.join(output, 'msrw-worker.tgz'))
} finally { fs.rmSync(staging, { recursive: true, force: true }) }
