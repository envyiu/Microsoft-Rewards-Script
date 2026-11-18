import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import release from '../../common/workerRelease.cjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export function publishWorker({ directory = root, output = path.join(directory, 'releases'), check = true } = {}) {
    fs.mkdirSync(output, { recursive: true })
    const lock = path.join(output, '.publish.lock')
    const fd = fs.openSync(lock, 'wx', 0o600)
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'msrw-worker-release-'))
    const original = ['package.json', 'package-lock.json'].map(name => [
        name,
        fs.readFileSync(path.join(directory, name))
    ])
    const previousCatalog = ['latest.json', 'msrw-worker.tgz'].map(name => [
        name,
        fs.existsSync(path.join(output, name)) ? fs.readFileSync(path.join(output, name)) : null
    ])
    let published = null
    try {
        if (check) {
            for (const task of ['build', 'lint'])
                execFileSync('npm', ['run', task], { cwd: directory, stdio: 'inherit' })
            execFileSync(
                process.execPath,
                ['--test', 'scripts/worker/update.test.js', 'scripts/release/worker.test.js'],
                { cwd: directory, stdio: 'inherit' }
            )
        }
        if (!fs.existsSync(path.join(directory, 'dist/index.js'))) throw Error('Run npm run build first')
        const pkg = JSON.parse(original[0][1]),
            lockfile = JSON.parse(original[1][1])
        if (
            !release.versionPattern.test(pkg.version) ||
            lockfile.version !== pkg.version ||
            lockfile.packages[''].version !== pkg.version
        )
            throw Error('Package versions disagree')
        const parts = pkg.version.split('.').map(Number)
        parts[2]++
        const version = parts.join('.')
        pkg.version = lockfile.version = lockfile.packages[''].version = version
        const excluded = new Set(['fleet.js', 'nodeProvisioner.js', 'apiFixture.js', 'fixture.js'])
        for (const file of [
            'dist',
            'common',
            'packages/contracts',
            'scripts/api',
            'scripts/learning',
            'scripts/main',
            'scripts/worker',
            'scripts/package.json',
            'scripts/env.js',
            'scripts/utils.js',
            'package.json',
            'package-lock.json',
            'config.example.json'
        ])
            fs.cpSync(path.join(directory, file), path.join(staging, file), {
                recursive: true,
                filter: source =>
                    !source.endsWith('.test.js') &&
                    !excluded.has(path.basename(source)) &&
                    path.basename(source) !== 'node_modules'
            })
        const runtimePkg = { ...pkg, scripts: { start: 'node scripts/worker/server.js' } }
        fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n')
        fs.writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify(lockfile, null, 4) + '\n')
        fs.copyFileSync(path.join(directory, 'scripts/worker/install.sh'), path.join(staging, 'install.sh'))
        fs.copyFileSync(path.join(directory, 'scripts/worker/README.md'), path.join(staging, 'README.md'))
        const files = {}
        function visit(dir) {
            for (const name of fs.readdirSync(dir).sort()) {
                const file = path.join(dir, name)
                if (fs.statSync(file).isDirectory()) visit(file)
                else files[path.relative(staging, file).split(path.sep).join('/')] = release.hash(fs.readFileSync(file))
            }
        }
        visit(staging)
        const browser = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules/patchright-core/browsers.json')))
            .browsers.filter(b => ['chromium', 'chromium-headless-shell', 'ffmpeg'].includes(b.name))
            .map(({ name, revision, browserVersion }) => ({ name, revision, browserVersion }))
        const manifest = {
            product: 'msrw-worker',
            version,
            protocolVersion: 3,
            builtAt: new Date().toISOString(),
            node: pkg.engines.node,
            browser,
            files
        }
        manifest.releaseId = release.hash(JSON.stringify(manifest))
        fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify(manifest))
        const destination = path.join(output, 'worker', version)
        if (fs.existsSync(destination)) throw Error('RELEASE_ALREADY_EXISTS')
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        const pending = fs.mkdtempSync(path.join(output, '.pending-'))
        try {
            const archive = path.join(pending, 'msrw-worker.tgz')
            execFileSync('tar', ['--format=gnu', '-czf', archive, '-C', staging, '.'])
            const artifact = {
                version,
                releaseId: manifest.releaseId,
                sha256: release.hash(fs.readFileSync(archive)),
                size: fs.statSync(archive).size,
                builtAt: manifest.builtAt,
                manifest
            }
            fs.writeFileSync(path.join(pending, 'artifact.json'), JSON.stringify(artifact))
            fs.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify(manifest))
            fs.writeFileSync(path.join(pending, 'msrw-worker.tgz.sha256'), artifact.sha256 + '  msrw-worker.tgz\n')
            // Commit the version only after all build/package checks succeeded.
            for (const [name, value] of [
                ['package.json', pkg],
                ['package-lock.json', lockfile]
            ]) {
                fs.writeFileSync(path.join(directory, name + '.release-tmp'), JSON.stringify(value, null, 4) + '\n')
                fs.renameSync(path.join(directory, name + '.release-tmp'), path.join(directory, name))
            }
            fs.renameSync(pending, destination)
            published = destination
            release.atomicJson(path.join(output, 'latest.json'), {
                version,
                releaseId: artifact.releaseId,
                sha256: artifact.sha256
            })
            // Compatibility alias for old installers; immutable versions remain above.
            fs.copyFileSync(path.join(destination, 'msrw-worker.tgz'), path.join(output, 'msrw-worker.tgz.tmp'))
            fs.renameSync(path.join(output, 'msrw-worker.tgz.tmp'), path.join(output, 'msrw-worker.tgz'))
            return { ...artifact, directory: destination }
        } finally {
            fs.rmSync(pending, { recursive: true, force: true })
        }
    } catch (error) {
        for (const [name, bytes] of original) fs.writeFileSync(path.join(directory, name), bytes)
        for (const [name, bytes] of previousCatalog) {
            if (bytes === null) fs.rmSync(path.join(output, name), { force: true })
            else {
                fs.writeFileSync(path.join(output, name + '.restore'), bytes)
                fs.renameSync(path.join(output, name + '.restore'), path.join(output, name))
            }
        }
        if (published) fs.rmSync(published, { recursive: true, force: true })
        throw error
    } finally {
        fs.closeSync(fd)
        fs.rmSync(lock, { force: true })
        fs.rmSync(staging, { recursive: true, force: true })
    }
}
if (
    process.argv[1] &&
    fs.existsSync(process.argv[1]) &&
    fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const result = publishWorker({ output: path.resolve(process.argv[2] || path.join(root, 'releases')) })
    console.log(`Worker ${result.version}: ${path.join(result.directory, 'msrw-worker.tgz')}`)
}
