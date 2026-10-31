import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

function fail(message, code = 'BAD_REQUEST', status = 400) {
    throw Object.assign(new Error(message), { code, status })
}
function command(binary, args, { input, timeout = 30000, cwd } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        const chunks = []
        let bytes = 0
        const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(Object.assign(new Error('Operation timed out.'), { code: 'SSH_TIMEOUT' }))
        }, timeout)
        child.stdout.on('data', b => {
            bytes += b.length
            if (bytes <= 1024 * 1024) chunks.push(b)
        })
        // Remote installers may print credentials in package errors; never retain or expose stderr.
        child.stderr.resume()
        child.on('error', error => {
            clearTimeout(timer)
            reject(Object.assign(new Error('Could not start the required system command.'), { code: error.code }))
        })
        child.on('close', code => {
            clearTimeout(timer)
            if (code === 0) resolve(Buffer.concat(chunks).toString())
            else
                reject(
                    Object.assign(
                        new Error(
                            'SSH or installation step failed. Check connectivity, SSH key and passwordless sudo.'
                        ),
                        { code: 'SSH_STEP_FAILED' }
                    )
                )
        })
        child.stdin.on('error', () => {})
        child.stdin.end(input)
    })
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const unitQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
export class NodeProvisioner {
    constructor(fleet, { runCommand = command, home = os.homedir(), upload, fetcher = fetch } = {}) {
        this.command = runCommand
        this.home = home
        this.upload = upload
        this.fetch = fetcher
        this.fleet = fleet
        this.active = new Set()
    }
    keys() {
        const dir = path.join(this.home, '.ssh')
        try {
            return fs
                .readdirSync(dir)
                .filter(n => /^[A-Za-z0-9_.-]+\.pub$/.test(n) && fs.existsSync(path.join(dir, n.slice(0, -4))))
                .map(n => ({ id: n.slice(0, -4), name: n.slice(0, -4), recommended: n === 'id_ed25519.pub' }))
        } catch {
            return []
        }
    }
    sshArgs(op) {
        return [
            '-F',
            '/dev/null',
            '-o',
            'BatchMode=yes',
            '-o',
            'IdentitiesOnly=yes',
            '-o',
            'IdentityAgent=none',
            '-o',
            'StrictHostKeyChecking=yes',
            '-o',
            `UserKnownHostsFile=${this.knownHosts(op)}`,
            '-o',
            'ConnectTimeout=10',
            '-o',
            'ServerAliveInterval=15',
            '-o',
            'ServerAliveCountMax=3',
            '-i',
            path.join(this.home, '.ssh', op.ssh.key),
            '-p',
            String(op.ssh.port),
            `${op.ssh.user}@${op.ssh.host}`
        ]
    }
    knownHosts(op) {
        return path.join(this.fleet.store.directory, 'ssh', `${op.id}.known_hosts`)
    }
    async add(body) {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80)
            fail('Machine name must be 1–80 characters.')
        if (
            !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(body.host || '') ||
            !/^[a-z_][a-z0-9_-]{0,31}$/.test(body.user || '')
        )
            fail('Invalid SSH host or username.')
        const port = Number(body.port ?? 22)
        if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Invalid SSH port.')
        const key = body.key || 'id_ed25519'
        if (!this.keys().some(k => k.id === key)) fail('Choose an existing SSH key on the Local machine.')
        if (
            this.fleet.registry.nodes.some(n => n.ssh?.host === body.host && n.ssh?.port === port) ||
            this.fleet.operations.some(
                o => o.kind === 'install' && o.phase !== 'done' && o.ssh?.host === body.host && o.ssh?.port === port
            )
        )
            fail('This SSH machine is already registered or being installed.', 'DUPLICATE_NODE', 409)
        const op = {
            id: crypto.randomUUID(),
            kind: 'install',
            phase: 'fingerprint',
            status: 'pending',
            name: body.name.trim(),
            ssh: { host: body.host, user: body.user, port, key },
            steps: [],
            createdAt: new Date().toISOString()
        }
        this.fleet.operations.push(op)
        this.fleet.saveOperations()
        void this.run(op)
        return op
    }
    async step(op, name, callback) {
        op.steps = op.steps.slice(-99)
        op.steps.push({ name, status: 'running' })
        op.updatedAt = new Date().toISOString()
        this.fleet.saveOperations()
        const value = await callback()
        op.steps.at(-1).status = 'done'
        this.fleet.saveOperations()
        return value
    }
    async cancel(op) {
        if (this.active.has(op.id)) fail('Wait for the running install step before cancelling.', 'OPERATION_BUSY', 409)
        if (op.target) fail('Remove the registered machine instead.', 'NODE_BUSY', 409)
        if (op.tunnelPort) {
            try {
                await this.command('systemctl', ['--user', 'disable', '--now', `msrw-node-${op.id}.service`])
            } catch {}
        }
        fs.rmSync(path.join(this.fleet.store.directory, 'install', op.id), { recursive: true, force: true })
        fs.rmSync(this.knownHosts(op), { force: true })
        op.phase = 'done'
        op.status = 'cancelled'
        op.error = null
        this.fleet.saveOperations()
    }
    async resume(op, action, body) {
        if (this.active.has(op.id)) fail('Installation is already running.', 'OPERATION_BUSY', 409)
        if (op.phase === 'done') return
        if (action === 'trust') {
            if (op.phase !== 'trust' || body.fingerprint !== op.hostFingerprint)
                fail('Host fingerprint does not match.')
            op.trusted = true
            op.phase = 'install'
        }
        op.status = 'pending'
        op.error = null
        this.fleet.saveOperations()
        void this.run(op)
    }
    async run(op) {
        if (this.active.has(op.id)) return
        this.active.add(op.id)
        try {
            if (!op.trusted) {
                await this.step(op, 'Read SSH host fingerprint', async () => {
                    const scan = await this.command('ssh-keyscan', [
                        '-T',
                        '10',
                        '-p',
                        String(op.ssh.port),
                        '-t',
                        'ed25519',
                        op.ssh.host
                    ])
                    if (!scan.trim()) fail('No SSH host key returned.', 'SSH_HOST_KEY')
                    fs.mkdirSync(path.dirname(this.knownHosts(op)), { recursive: true, mode: 0o700 })
                    fs.writeFileSync(this.knownHosts(op), scan, { mode: 0o600 })
                    const fingerprint = await this.command('ssh-keygen', ['-lf', this.knownHosts(op)])
                    op.hostFingerprint = fingerprint.trim().split(/\s+/)[1]
                    if (!op.hostFingerprint?.startsWith('SHA256:')) fail('Unsupported host fingerprint.')
                })
                op.phase = 'trust'
                op.status = 'waiting'
                return
            }
            op.status = 'running'
            const remote = await this.step(op, 'Check SSH, Ubuntu and sudo', async () => {
                const output = await this.command('ssh', [...this.sshArgs(op), 'python3 -'], {
                    input: `import os,json,subprocess\nv={}\nfor l in open('/etc/os-release'):\n if '=' in l:\n  k,x=l.strip().split('=',1);v[k]=x.strip('"')\nassert v.get('ID')=='ubuntu' and v.get('VERSION_ID')=='24.04', 'Ubuntu 24.04 required'\nassert os.uname().machine=='x86_64', 'x86_64 required'\nsubprocess.run(['sudo','-n','true'],check=True)\nmem=int(next(l.split()[1] for l in open('/proc/meminfo') if l.startswith('MemTotal:')))\nassert mem>=1536*1024,'At least 1.5 GiB RAM required'\ndisk=os.statvfs(os.path.expanduser('~'))\nassert disk.f_bavail*disk.f_frsize>=5*1024**3,'At least 5 GiB disk space required'\nprint(json.dumps({'home':os.path.expanduser('~')}))\n`
                })
                const value = JSON.parse(output)
                if (!/^\/[A-Za-z0-9_./-]+$/.test(value.home)) fail('Unsupported remote home directory.')
                return value
            })
            const directory = path.join(this.fleet.store.directory, 'install', op.id)
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
            const archive = path.join(directory, 'runtime.tgz')
            await this.step(op, 'Prepare matching runtime', async () => {
                if (!fs.existsSync(path.join(this.fleet.root, 'dist', 'index.js')))
                    fail('Build the runtime before adding a machine.', 'BUILD_REQUIRED')
                await this.command(
                    'tar',
                    [
                        '--exclude=*.test.js',
                        '--exclude=*.test.cjs',
                        '--exclude=config.json',
                        '--exclude=.env',
                        '--exclude=*.db',
                        '--exclude=*.db-wal',
                        '--exclude=*.db-shm',
                        '-czf',
                        archive,
                        '-C',
                        this.fleet.root,
                        'dist',
                        'scripts/api',
                        'scripts/main',
                        'scripts/env.js',
                        'scripts/utils.js',
                        'scripts/package.json',
                        'common',
                        'packages/contracts',
                        'package.json',
                        'package-lock.json',
                        'config.example.json'
                    ],
                    { timeout: 60000 }
                )
            })
            const staging = `${remote.home}/.cache/msrw-install-${op.id}.tgz`
            await this.step(op, 'Upload runtime', () =>
                this.command(
                    'ssh',
                    [...this.sshArgs(op), `mkdir -p ${quote(remote.home + '/.cache')} && cat > ${quote(staging)}`],
                    {}
                ).then(async () => {
                    // Stream the archive without putting account/session data into the release.
                    if (this.upload) return this.upload(op, archive, staging)
                    await new Promise((resolve, reject) => {
                        const child = spawn('ssh', [...this.sshArgs(op), `cat > ${quote(staging)}`], {
                            stdio: ['pipe', 'ignore', 'ignore']
                        })
                        const timer = setTimeout(() => {
                            child.kill()
                            reject(new Error('Upload timed out.'))
                        }, 120000)
                        const stream = fs.createReadStream(archive)
                        stream.on('error', reject)
                        child.stdin.on('error', () => {})
                        stream.pipe(child.stdin)
                        child.on('error', reject)
                        child.on('close', code => {
                            clearTimeout(timer)
                            if (code === 0) resolve()
                            else reject(new Error('Upload failed.'))
                        })
                    })
                })
            )
            op.token ||= crypto.randomBytes(32).toString('hex')
            this.fleet.saveOperations()
            const root = `${remote.home}/msrw`,
                data = `${remote.home}/.local/share/msrw`
            const unit = `[Unit]\nDescription=Microsoft Rewards browser worker\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nUser=${op.ssh.user}\nWorkingDirectory=${data}\nEnvironment=PATH=/opt/msrw-node/bin:/usr/local/bin:/usr/bin:/bin\nEnvironmentFile=${data}/service.env\nExecStart=/opt/msrw-node/bin/node ${root}/current/scripts/api/server.js\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=45\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`
            const environment = `MRS_NODE_ROLE=vps\nMRS_NODE_DATA=${data}/hybrid\nSMART_SCHEDULE_FILE=${data}/smart-schedule.json\nAPI_HOST=127.0.0.1\nAPI_PORT=3010\nAPI_TOKEN=${op.token}\nAPI_LOG_BUFFER=3000\nAPI_STOP_TIMEOUT_MS=30000\n`
            const release = `${root}/releases/fleet-${op.id}`
            const encoded = Buffer.from(
                JSON.stringify({ unit, environment, coordinator: this.fleet.store.nodeId })
            ).toString('base64')
            await this.step(op, 'Install Node, Chromium and worker service', () =>
                this.command('ssh', [...this.sshArgs(op), 'bash -s'], {
                    timeout: 900000,
                    input: `set -eu\numask 077\nDATA=${quote(data)}\nRELEASE=${quote(release)}\nmkdir -p "$DATA"\npython3 - "$DATA" <<'PY'\nimport sys,json,base64,os\nv=json.loads(base64.b64decode('${encoded}'));p=sys.argv[1]+'/install-owner.json'\nif os.path.exists(p):\n assert json.load(open(p))['coordinator']==v['coordinator'],'Installation belongs to another coordinator'\nelif os.path.exists(sys.argv[1]+'/service.env'):\n raise Exception('Existing installation must be registered through its original coordinator')\njson.dump({'coordinator':v['coordinator']},open(p,'w'))\nopen(sys.argv[1]+'/service.env','w').write(v['environment'])\nopen(sys.argv[1]+'/worker.service','w').write(v['unit'])\nPY\nif ! test -x /opt/msrw-node/bin/node; then\n sudo -n apt-get update -qq\n sudo -n apt-get install -y -qq curl ca-certificates xz-utils\n TMP=$(mktemp -d)\n cd "$TMP"\n curl -fsSLO https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz\n curl -fsSLO https://nodejs.org/dist/v24.22.1/SHASUMS256.txt\n grep ' node-v24.22.1-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -\n sudo -n mkdir -p /opt/msrw-node\n sudo -n tar -xJf node-v24.22.1-linux-x64.tar.xz --strip-components=1 -C /opt/msrw-node\n rm -rf "$TMP"\nfi\nmkdir -p "$RELEASE"\ntar -xzf ${quote(staging)} -C "$RELEASE"\ncd "$RELEASE"\nexport PATH=/opt/msrw-node/bin:/usr/local/bin:/usr/bin:/bin\nnpm ci --omit=dev --ignore-scripts\nsudo -n env PATH="$PATH" /opt/msrw-node/bin/node node_modules/patchright/cli.js install-deps chromium\nnode node_modules/patchright/cli.js install chromium\nnode -e 'const {chromium}=require("patchright");(async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();await p.setContent("<title>worker-ready</title>");if(await p.title()!=="worker-ready")throw Error("Browser check failed");await b.close()})().catch(()=>process.exit(1))'\ncp config.example.json config.json\nln -sfn "$RELEASE" ${quote(root + '/current')}\nsudo -n cp "$DATA/worker.service" /etc/systemd/system/msrw-vps.service\nsudo -n systemctl daemon-reload\nsudo -n systemctl enable --now msrw-vps.service\nrm -f ${quote(staging)}\n`
                })
            )
            const connection = await this.step(op, 'Create private SSH tunnel', async () => {
                const net = await import('node:net')
                const server = net.createServer()
                await new Promise(r => server.listen(0, '127.0.0.1', r))
                const port = server.address().port
                await new Promise(r => server.close(r))
                op.tunnelPort ||= port
                const name = `msrw-node-${op.id}.service`
                const args = [
                    '/usr/bin/ssh',
                    '-NT',
                    ...this.sshArgs(op).slice(0, -1),
                    '-o',
                    'ExitOnForwardFailure=yes',
                    '-L',
                    `127.0.0.1:${op.tunnelPort}:127.0.0.1:3010`,
                    `${op.ssh.user}@${op.ssh.host}`
                ]
                const unitPath = path.join(this.home, '.config/systemd/user', name)
                fs.mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 })
                fs.writeFileSync(
                    unitPath,
                    `[Unit]\nDescription=MSRW private worker connection\nAfter=network-online.target\n[Service]\nExecStart=${args.map(unitQuote).join(' ')}\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=default.target\n`,
                    { mode: 0o600 }
                )
                await this.command('systemctl', ['--user', 'daemon-reload'])
                await this.command('systemctl', ['--user', 'enable', '--now', name])
                return { url: `http://127.0.0.1:${op.tunnelPort}`, service: name }
            })
            await this.step(op, 'Verify worker and register machine', async () => {
                let status
                for (let i = 0; i < 20; i++) {
                    try {
                        const r = await this.fetch(connection.url + '/internal/hybrid/status', {
                            headers: { Authorization: `Bearer ${op.token}` },
                            signal: AbortSignal.timeout(2000)
                        })
                        if (r.ok) {
                            status = await r.json()
                            break
                        }
                    } catch {}
                    await new Promise(r => setTimeout(r, 1000))
                }
                if (status?.protocolVersion !== 2 || !/^[a-f0-9-]{36}$/.test(status?.nodeId || ''))
                    fail('Worker health check failed.', 'HEALTH_CHECK_FAILED', 503)
                if (this.fleet.registry.nodes.some(n => n.id === status.nodeId))
                    fail('This worker is already registered.', 'DUPLICATE_NODE', 409)
                this.fleet.registry.nodes.push({
                    id: status.nodeId,
                    name: op.name,
                    kind: 'vps',
                    protocolVersion: 2,
                    url: connection.url,
                    token: op.token,
                    ssh: { ...op.ssh, service: connection.service },
                    overrides: { schedule: { enabled: false, maxParallel: 1 } }
                })
                this.fleet.save()
                op.target = status.nodeId
            })
            op.phase = 'done'
            op.status = 'applied'
            op.error = null
            fs.rmSync(directory, { recursive: true, force: true })
            void this.fleet.sync()
        } catch (error) {
            op.status = 'error'
            op.error = error.code || 'INSTALL_FAILED'
            op.updatedAt = new Date().toISOString()
            if (op.steps.at(-1)?.status === 'running') op.steps.at(-1).status = 'error'
        } finally {
            this.fleet.saveOperations()
            this.active.delete(op.id)
        }
    }
    async remove(node) {
        if (node.ssh?.service) await this.command('systemctl', ['--user', 'disable', '--now', node.ssh.service])
    }
}
