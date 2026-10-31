#!/usr/bin/env bash
set -euo pipefail
umask 077
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKER_KIND=remote
WORKER_USER=$(id -un)
WORKER_DATA=
WORKER_ROOT=
TOKEN_FILE=
NO_START=0
DRY_RUN=0
ANDROID=false
while [ "$#" -gt 0 ]; do
    case "$1" in
        --kind) WORKER_KIND=$2; shift 2 ;;
        --user) WORKER_USER=$2; shift 2 ;;
        --data-dir) WORKER_DATA=$2; shift 2 ;;
        --install-dir) WORKER_ROOT=$2; shift 2 ;;
        --token-file) TOKEN_FILE=$2; shift 2 ;;
        --android) ANDROID=true; shift ;;
        --no-start) NO_START=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done
case "$WORKER_KIND" in local|remote) ;; *) echo 'Kind must be local or remote' >&2; exit 2 ;; esac
[ "$(uname -s)" = Linux ] || { echo 'Linux is required' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo 'Run as the worker user with sudo access, not as root' >&2; exit 1; }
[ "$WORKER_USER" = "$(id -un)" ] || { echo '--user must match the invoking user' >&2; exit 1; }
WORKER_DATA=${WORKER_DATA:-$HOME/.local/share/msrw-worker}
WORKER_ROOT=${WORKER_ROOT:-$HOME/.local/lib/msrw-worker}
case "$WORKER_DATA$WORKER_ROOT" in *$'\n'*|*'%'*|*'"'*|*'\\'*) echo 'Unsupported installation path' >&2; exit 1 ;; esac
[ "${WORKER_DATA:0:1}" = / ] && [ "${WORKER_ROOT:0:1}" = / ] || { echo 'Absolute paths are required' >&2; exit 1; }
if [ "$DRY_RUN" = 1 ]; then
    echo "Worker kind: $WORKER_KIND; state: $WORKER_DATA; releases: $WORKER_ROOT; systemd: $([ "$WORKER_KIND" = local ] && echo user || echo system)"
    exit 0
fi
[ -f "$SOURCE_DIR/release.json" ] || { echo 'Extract the worker release before running its installer' >&2; exit 1; }
WORKER_NODE=$(command -v node || true)
if [ -z "$WORKER_NODE" ] || ! "$WORKER_NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=24?0:1)'; then
    if command -v pacman >/dev/null 2>&1; then
        sudo -n pacman -S --needed --noconfirm nodejs npm
        WORKER_NODE=$(command -v node)
    else
    [ "$(uname -m)" = x86_64 ] || { echo 'Automatic Node installation requires x86_64' >&2; exit 1; }
    sudo -n apt-get update -qq
    sudo -n apt-get install -y -qq curl ca-certificates xz-utils
    NODE_TEMP=$(mktemp -d)
    (
        cd "$NODE_TEMP"
        curl -fsSLO https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz
        curl -fsSLO https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
        rg_line=' node-v24.22.1-linux-x64.tar.xz$'
        grep "$rg_line" SHASUMS256.txt | sha256sum -c -
        sudo -n mkdir -p /opt/msrw-node
        sudo -n tar -xJf node-v24.22.1-linux-x64.tar.xz --strip-components=1 -C /opt/msrw-node
    )
    rm -rf "$NODE_TEMP"
    WORKER_NODE=/opt/msrw-node/bin/node
    fi
fi
export PATH="$(dirname "$WORKER_NODE"):$PATH"
mkdir -p "$WORKER_ROOT/releases" "$WORKER_DATA"
WORKER_RELEASE="$WORKER_ROOT/releases/$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir "$WORKER_RELEASE"
cp -a "$SOURCE_DIR/." "$WORKER_RELEASE/"
cd "$WORKER_RELEASE"
npm ci --omit=dev --ignore-scripts
if [ "$WORKER_KIND" = local ]; then
    "$WORKER_NODE" node_modules/patchright/cli.js install chromium
else
    "$WORKER_NODE" node_modules/patchright/cli.js install --only-shell chromium
fi
browser_check() {
    "$WORKER_NODE" --input-type=commonjs -e 'const {chromium}=require("patchright"); (async()=>{const b=await chromium.launch({headless:true});const p=await b.newPage();await p.setContent("<title>worker-ready</title>");if(await p.title()!=="worker-ready")throw Error("Browser unavailable");await b.close()})().catch(()=>process.exit(1))'
}
if ! browser_check >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        sudo -n env PATH="$PATH" "$WORKER_NODE" node_modules/patchright/cli.js install-deps chromium
    elif command -v pacman >/dev/null 2>&1; then
        sudo -n pacman -S --needed --noconfirm chromium
    else
        echo 'Install Chromium system libraries for this Linux distribution, then retry' >&2; exit 1
    fi
fi
browser_check || { echo 'Chromium readiness check failed' >&2; exit 1; }
# Building a release is harmless while the old process exists; switching it is
# permitted only after its scheduler and manual sessions have drained.
if [ "$WORKER_KIND" = remote ] && sudo -n systemctl is-active --quiet msrw-vps.service; then
    echo 'Use Manager to pause and upgrade the legacy VPS service first' >&2; exit 1
fi
WORKER_ACTIVE=0
if [ "$WORKER_KIND" = local ]; then
    if systemctl --user is-active --quiet msrw-worker.service; then WORKER_ACTIVE=1; fi
else
    if sudo -n systemctl is-active --quiet msrw-worker.service; then WORKER_ACTIVE=1; fi
fi
if [ "$WORKER_ACTIVE" = 1 ]; then
    export WORKER_DATA
    "$WORKER_NODE" --input-type=commonjs <<'JSDRAIN'
const fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.WORKER_DATA,'worker.env'),env={};
for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(match){let value=match[2];try{value=JSON.parse(value)}catch{}env[match[1]]=value}}
(async()=>{const response=await fetch(`http://127.0.0.1:${env.API_PORT||3010}/internal/hybrid/status`,{headers:{Authorization:`Bearer ${env.API_TOKEN}`},signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error();const status=await response.json();if(status.smart?.config?.enabled||status.smart?.urgent?.active||status.smart?.running?.length||status.manualSessions?.length||status.holds?.length||status.syncPending)throw Error()})().catch(()=>{console.error('Pause, drain and return all sessions before updating the worker.');process.exit(1)});
JSDRAIN
    if [ "$WORKER_KIND" = local ]; then systemctl --user stop msrw-worker.service; else sudo -n systemctl stop msrw-worker.service; fi
fi
# The legacy VPS journal contains the stable worker identity and accepted subset.
# Both services must be stopped before this offline database migration.
if [ ! -e "$WORKER_DATA/journal/node.sqlite" ] && [ -f "$WORKER_DATA/hybrid/node.sqlite" ]; then
    python3 - "$WORKER_DATA" <<'PYMIGRATE'
import os,sys,sqlite3
root=sys.argv[1];os.makedirs(root+'/journal',mode=0o700,exist_ok=True)
source=sqlite3.connect(root+'/hybrid/node.sqlite');target=sqlite3.connect(root+'/journal/node.sqlite')
source.backup(target);target.close();source.close();os.chmod(root+'/journal/node.sqlite',0o600)
PYMIGRATE
fi
export WORKER_DATA WORKER_KIND WORKER_ROOT TOKEN_FILE ANDROID
"$WORKER_NODE" --input-type=commonjs <<'JS'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const dir=process.env.WORKER_DATA,file=path.join(dir,'worker.env');
if(!fs.existsSync(file)) {
    const token=process.env.TOKEN_FILE?fs.readFileSync(process.env.TOKEN_FILE,'utf8').trim():crypto.randomBytes(32).toString('hex');
    if(token.length<16||/[\r\n]/.test(token))throw Error('Invalid token');
    const values={MRS_WORKER_KIND:process.env.WORKER_KIND,MRS_WORKER_DATA:dir,MRS_WORKER_ROOT:process.env.WORKER_ROOT,API_HOST:'127.0.0.1',API_PORT:'3010',API_TOKEN:token,MRS_ANDROID_ENABLED:process.env.ANDROID,TZ:process.env.TZ||'Asia/Ho_Chi_Minh'};
    fs.writeFileSync(file,Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600});
} else if(!/^MRS_WORKER_ROOT=/m.test(fs.readFileSync(file,'utf8'))) {
    fs.appendFileSync(file,'\nMRS_WORKER_ROOT='+JSON.stringify(process.env.WORKER_ROOT)+'\n');
}
JS
if [ "$WORKER_KIND" = local ]; then
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    SERVICE_USER=
else
    UNIT_DIR="$WORKER_DATA/systemd"
    mkdir -p "$UNIT_DIR"
    SERVICE_USER="User=$WORKER_USER"
fi
cat > "$UNIT_DIR/msrw-worker.service" <<EOF
[Unit]
Description=MSRW Worker
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
$SERVICE_USER
WorkingDirectory=$WORKER_DATA
EnvironmentFile=$WORKER_DATA/worker.env
Environment="PATH=$PATH"
ExecStart="$WORKER_NODE" "$WORKER_ROOT/current/scripts/worker/server.js"
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=60
UMask=0077
[Install]
WantedBy=$([ "$WORKER_KIND" = local ] && echo default.target || echo multi-user.target)
EOF
if [ -e "$WORKER_ROOT/current" ] && [ ! -L "$WORKER_ROOT/current" ]; then
    echo 'Refusing to replace a current directory that is not a release symlink' >&2; exit 1
fi
if [ -L "$WORKER_ROOT/current" ] && [ ! -f "$WORKER_DATA/legacy-install.json" ] && [ -f /etc/systemd/system/msrw-vps.service ]; then
    export WORKER_ROOT
    "$WORKER_NODE" --input-type=commonjs <<'JSLEGACY'
const fs=require('node:fs'),path=require('node:path');
const data=process.env.WORKER_DATA,root=process.env.WORKER_ROOT;
fs.writeFileSync(path.join(data,'legacy-install.json'),JSON.stringify({root,data,release:fs.realpathSync(path.join(root,'current')),service:'msrw-vps.service'}),{mode:0o600});
JSLEGACY
fi
ln -sfn "$WORKER_RELEASE" "$WORKER_ROOT/current"
if [ "$WORKER_KIND" = local ]; then
    systemctl --user daemon-reload
    if [ "$NO_START" = 0 ]; then systemctl --user enable msrw-worker.service; systemctl --user restart msrw-worker.service; fi
else
    sudo -n cp "$UNIT_DIR/msrw-worker.service" /etc/systemd/system/msrw-worker.service
    sudo -n systemctl daemon-reload
    if [ "$NO_START" = 0 ]; then
        sudo -n systemctl enable msrw-worker.service
        sudo -n systemctl restart msrw-worker.service
        if [ -f /etc/systemd/system/msrw-vps.service ]; then sudo -n systemctl disable msrw-vps.service; fi
    fi
fi
echo "Worker installed. Configuration: $WORKER_DATA/worker.env"
echo 'New workers start paused and wait for Manager assignment.'
