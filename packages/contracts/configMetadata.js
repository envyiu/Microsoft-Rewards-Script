export const SMART_CONFIG_MODE_SCOPES = {
    shared: ['enabled', 'maxParallel', 'sessionTimeoutMinutes', 'networkGroupOverride', 'profiles'],
    normalPolicy: ['normalPolicy', 'dailySearchLimits', 'streakSearchV1', 'retry', 'catchUpThresholdMinutes'],
    warmup: ['cooldownMinutes', 'retry', 'dailySearchLimits', 'streakSearchV1'],
    legacy: ['cooldownMinutes', 'searchTarget', 'searchNoise', 'searchSafetyCap', 'retry', 'catchUpThresholdMinutes']
}

export const SMART_DEADLINE_SEMANTICS = {
    mode: 'priority-window-bound',
    description:
        'profiles[].deadline defines the catch-up priority horizon (catchUpThresholdMinutes); profiles[].windows and quietHours govern hard run-time eligibility.'
}

export const BOT_CONFIG_METADATA = {
    booleanKeys: [
        'headless',
        'errorDiagnostics',
        'ensureStreakProtection',
        'autoClaimPunchcardRewards',
        'contintueOnBotWarning',
        'skipNonPointTasks',
        'searchOnBingLocalQueries',
        'debugLogs'
    ],
    backwardCompatibleAliases: {
        continueOnBotWarning: 'contintueOnBotWarning'
    },
    toggleGroups: [
        {
            title: 'Core',
            fields: {
                headless: { label: 'Headless browser', desc: 'Run browser invisibly' },
                errorDiagnostics: {
                    label: 'Error diagnostics',
                    desc: 'Save error and unknown-login page diagnostics under diagnostics/'
                },
                ensureStreakProtection: {
                    label: 'Ensure streak protection',
                    desc: 'Ensure streak protection is enabled'
                },
                autoClaimPunchcardRewards: {
                    label: 'Auto-claim punchcard rewards',
                    desc: 'Auto-claim completed punchcard rewards'
                },
                contintueOnBotWarning: {
                    label: 'Continue on bot warning',
                    desc: 'Continue searching after a Microsoft bot warning (historical key spelling preserved)'
                },
                skipNonPointTasks: { label: 'Skip non-point tasks', desc: 'Skip tasks that award no points' },
                searchOnBingLocalQueries: {
                    label: 'Local queries for ExploreOnBing',
                    desc: 'Use the local query list for ExploreOnBing'
                }
            }
        },
        {
            title: 'Workers',
            fields: {
                'workers.doDailySet': { label: 'Daily set', desc: 'Complete daily set' },
                'workers.doClaimBonusPoints': { label: 'Claim bonus points', desc: 'Claim bonus points' },
                'workers.doMorePromotions': { label: 'More activities', desc: 'Complete "more activities"' },
                'workers.doPunchCards': { label: 'Punch cards', desc: 'Complete punchcards' },
                'workers.doAppPromotions': { label: 'App promotions', desc: 'Complete app promotions' },
                'workers.doDesktopSearch': { label: 'Desktop search', desc: 'Perform desktop searches' },
                'workers.doMobileSearch': { label: 'Mobile search', desc: 'Perform mobile searches' },
                'workers.doBonusSearches': { label: 'Bonus searches', desc: 'Farm bonus searches beyond the cap' },
                'workers.doDailyCheckIn': { label: 'Daily check-in', desc: 'Complete daily check-in' },
                'workers.doReadToEarn': { label: 'Read to earn', desc: 'Complete Read-to-Earn' },
                'workers.doActivateSearchPerk': {
                    label: 'Activate search perk',
                    desc: 'Activate the "search Nx more" perk when present (runs after the daily set)'
                },
                'workers.doVisualSearch': {
                    label: 'Visual search',
                    desc: 'Activate the visual-search streak and perform visual searches'
                }
            }
        },
        {
            title: 'Activities',
            fields: {
                'activities.urlReward': { label: 'URL reward', desc: 'Complete URL reward activities' },
                'activities.searchOnBing': { label: 'ExploreOnBing', desc: 'Complete ExploreOnBing offers' }
            }
        },
        {
            title: 'Search settings',
            fields: {
                'searchSettings.aiSearch': {
                    label: 'AI Search',
                    desc: 'Use AI Search for 70% of Smart/warmup queries, with optional feedback and up to two same-conversation followups. Requires aiSearchV1.'
                },
                'searchSettings.scrollRandomResults': {
                    label: 'Scroll random results',
                    desc: 'Scroll randomly on results'
                },
                'searchSettings.clickRandomResults': { label: 'Click random results', desc: 'Click random links' },
                'searchSettings.runOnZeroPoints': {
                    label: 'Run on zero points',
                    desc: 'Run searches even when no search points remain'
                },
                'searchSettings.parallelSearching': { label: 'Parallel searching', desc: 'Run searches in parallel' },
                'searchSettings.clusterSearch': {
                    label: 'Cluster search',
                    desc: 'Cluster each main topic with Bing suggestions'
                }
            }
        },
        {
            title: 'Experimental',
            fields: {
                'experimental.apiSearch': {
                    label: 'API search',
                    desc: 'Perform Bing searches over HTTP instead of driving a browser page'
                },
                'experimental.apiSearchOnBing': {
                    label: 'API ExploreOnBing',
                    desc: 'Complete ExploreOnBing offers over HTTP instead of the browser'
                },
                'experimental.blockMedia': {
                    label: 'Block media',
                    desc: 'Block browser image and media requests to reduce traffic'
                },
                'experimental.edgeBrowsing': {
                    label: 'Edge browsing',
                    desc: 'Report the 30-minute Edge browsing activity as a background HTTP task'
                }
            }
        },
        {
            title: 'Logging',
            fields: {
                debugLogs: { label: 'Debug logs', desc: 'Enable debug logging' },
                'consoleLogFilter.enabled': { label: 'Console log filter', desc: 'Enable console log filtering' }
            }
        },
        {
            title: 'Proxy',
            fields: {
                'proxy.queryEngine': { label: 'Proxy query engine requests', desc: 'Proxy query engine requests' },
                'proxy.ignoreCertificateErrors': {
                    label: 'Ignore certificate errors',
                    desc: 'Disable browser TLS certificate verification for intercept proxies'
                }
            }
        },
        {
            title: 'Webhooks',
            fields: {
                'webhook.discord.enabled': { label: 'Discord webhook', desc: 'Enable Discord webhook' },
                'webhook.telegram.enabled': { label: 'Telegram webhook', desc: 'Enable Telegram webhook' },
                'webhook.ntfy.enabled': { label: 'ntfy webhook', desc: 'Enable ntfy notifications' },
                'webhook.webhookLogFilter.enabled': {
                    label: 'Webhook log filter',
                    desc: 'Enable webhook log filtering'
                }
            }
        }
    ],
    fieldGroups: [
        {
            title: 'Core',
            fields: {
                sessionPath: {
                    kind: 'text',
                    label: 'Session path',
                    desc: 'Directory to store browser sessions',
                    placeholder: 'sessions'
                },
                clusters: {
                    kind: 'number',
                    label: 'Clusters',
                    desc: 'Number of concurrent account clusters',
                    min: 0,
                    step: 1,
                    placeholder: '1'
                },
                globalTimeout: {
                    kind: 'text',
                    label: 'Global timeout',
                    desc: 'Timeout for all actions',
                    placeholder: '30sec'
                },
                accountDelay: {
                    kind: 'delay',
                    label: 'Delay before next account',
                    min: {
                        path: 'accountDelay.min',
                        desc: 'Minimum delay before starting the next configured account',
                        placeholder: '1min'
                    },
                    max: {
                        path: 'accountDelay.max',
                        desc: 'Maximum delay before starting the next configured account',
                        placeholder: '3min'
                    }
                }
            }
        },
        {
            title: 'Search settings',
            fields: {
                'searchSettings.maxBonusSearches': {
                    kind: 'number',
                    label: 'Max bonus searches',
                    desc: 'Max bonus searches per run (when Bonus searches is on)',
                    min: 0,
                    step: 1,
                    placeholder: '110'
                },
                'searchSettings.searchResultVisitTime': {
                    kind: 'text',
                    label: 'Search result visit time',
                    desc: 'Time to spend on each search result',
                    placeholder: '10sec'
                },
                'searchSettings.searchDelay': {
                    kind: 'delay',
                    label: 'Delay between searches',
                    min: {
                        path: 'searchSettings.searchDelay.min',
                        desc: 'Minimum delay between searches',
                        placeholder: '30sec'
                    },
                    max: {
                        path: 'searchSettings.searchDelay.max',
                        desc: 'Maximum delay between searches',
                        placeholder: '1min'
                    }
                },
                'searchSettings.readDelay': {
                    kind: 'delay',
                    label: 'Delay for reading',
                    min: {
                        path: 'searchSettings.readDelay.min',
                        desc: 'Minimum delay for reading',
                        placeholder: '30sec'
                    },
                    max: {
                        path: 'searchSettings.readDelay.max',
                        desc: 'Maximum delay for reading',
                        placeholder: '1min'
                    }
                },
                'searchSettings.queryEngines': {
                    kind: 'tags',
                    label: 'Query sources',
                    desc: 'Sources used to build the search query pool',
                    placeholder: 'e.g. google, rss.bbc',
                    hint: 'Valid: google, wikipedia, wikirandom, hackernews, reddit, local, or rss.<source> (e.g. rss.bbc, rss.googleNews).'
                }
            }
        },
        {
            title: 'Logging',
            fields: {
                'consoleLogFilter.mode': {
                    kind: 'select',
                    label: 'Console filter mode',
                    desc: 'Filter mode (whitelist/blacklist)',
                    options: [
                        { value: 'whitelist', label: 'Whitelist' },
                        { value: 'blacklist', label: 'Blacklist' }
                    ]
                },
                'consoleLogFilter.levels': {
                    kind: 'tags',
                    label: 'Console filter levels',
                    desc: 'Log levels to filter',
                    placeholder: 'e.g. error, warn',
                    suggestions: ['error', 'warn', 'info', 'debug']
                },
                'consoleLogFilter.keywords': {
                    kind: 'tags',
                    label: 'Console filter keywords',
                    desc: 'Keywords to filter',
                    placeholder: 'e.g. starting account'
                },
                'consoleLogFilter.regexPatterns': {
                    kind: 'tags',
                    label: 'Console filter regex patterns',
                    desc: 'Regex patterns for filtering',
                    placeholder: 'e.g. ^Error:',
                    mono: true
                }
            }
        },
        {
            title: 'Webhooks',
            fields: {
                'webhook.discord.url': {
                    kind: 'text',
                    label: 'Discord webhook URL',
                    desc: 'Discord webhook URL',
                    placeholder: 'https://discord.com/api/webhooks/...'
                },
                'webhook.telegram.botToken': { kind: 'text', label: 'Telegram bot token', desc: 'Telegram bot token' },
                'webhook.telegram.chatId': { kind: 'text', label: 'Telegram chat ID', desc: 'Telegram chat id' },
                'webhook.ntfy.url': {
                    kind: 'text',
                    label: 'ntfy server URL',
                    desc: 'ntfy server URL',
                    placeholder: 'https://ntfy.sh'
                },
                'webhook.ntfy.topic': { kind: 'text', label: 'ntfy topic', desc: 'ntfy topic' },
                'webhook.ntfy.token': { kind: 'text', label: 'ntfy auth token', desc: 'ntfy authentication token' },
                'webhook.ntfy.title': {
                    kind: 'text',
                    label: 'ntfy notification title',
                    desc: 'Notification title',
                    placeholder: 'Microsoft-Rewards-Script'
                },
                'webhook.ntfy.tags': {
                    kind: 'tags',
                    label: 'ntfy tags',
                    desc: 'Notification tags',
                    placeholder: 'e.g. bot, notify'
                },
                'webhook.ntfy.priority': {
                    kind: 'select',
                    label: 'ntfy priority',
                    desc: 'Notification priority (1-5)',
                    numeric: true,
                    options: [
                        { value: '1', label: '1 \u2013 Min' },
                        { value: '2', label: '2 \u2013 Low' },
                        { value: '3', label: '3 \u2013 Default' },
                        { value: '4', label: '4 \u2013 High' },
                        { value: '5', label: '5 \u2013 Max' }
                    ]
                },
                'webhook.webhookLogFilter.mode': {
                    kind: 'select',
                    label: 'Webhook filter mode',
                    desc: 'Filter mode (whitelist/blacklist)',
                    options: [
                        { value: 'whitelist', label: 'Whitelist' },
                        { value: 'blacklist', label: 'Blacklist' }
                    ]
                },
                'webhook.webhookLogFilter.levels': {
                    kind: 'tags',
                    label: 'Webhook filter levels',
                    desc: 'Log levels to send',
                    placeholder: 'e.g. error, warn',
                    suggestions: ['error', 'warn', 'info', 'debug']
                },
                'webhook.webhookLogFilter.keywords': {
                    kind: 'tags',
                    label: 'Webhook filter keywords',
                    desc: 'Keywords to filter',
                    placeholder: 'e.g. starting account'
                },
                'webhook.webhookLogFilter.regexPatterns': {
                    kind: 'tags',
                    label: 'Webhook filter regex patterns',
                    desc: 'Regex patterns for filtering',
                    placeholder: 'e.g. ^Error:',
                    mono: true
                }
            }
        }
    ],
    recommendedWebhookFilter: {
        webhook: {
            webhookLogFilter: {
                enabled: true,
                mode: 'whitelist',
                levels: [],
                keywords: ['starting account', 'select number', 'collected'],
                regexPatterns: []
            }
        }
    }
}

export const BLOCKER_REMEDIATIONS = {
    SESSION_ACTIVE: 'Wait for the active session to finish or press Stop.',
    SESSION_UNCERTAIN: 'Verify the previous process exited, then acknowledge Release protection.',
    SESSION_LIMIT: 'Rolling 24h session cap reached; wait for the oldest session window to expire.',
    SESSION_REST:
        'Account is resting between conservative sessions; global Run next can skip rest once if a slot is free.',
    ACCOUNT_HOLD:
        'Temporary protection hold after repeated account-level errors; wait for expiry or release after verifying.',
    ACCOUNT_LOCKED: 'Account reported locked/suspended by Microsoft; inspect manually before releasing protection.',
    VERIFICATION_REQUIRED:
        'Interactive verification/CAPTCHA required; open a manual browser session, complete challenge, then release protection.',
    ACCOUNT_HELD: 'Account or proxy group is held by an active manual session or ownership transfer.',
    ACCOUNT_PAUSED: 'Account is paused by operator; click Resume to re-enable scheduling.',
    UPDATE_IN_PROGRESS: 'Worker node is installing or verifying a release update.',
    STOP_COOLDOWN: 'Manual Stop cooldown active; wait for cooldown or trigger an explicit immediate start.',
    PROXY_BUSY: 'Another account sharing this proxy/network group is currently running.',
    PROXY_COOLDOWN: 'Shared proxy is resting for 5–20 minutes after another account session; wait until retryAt.',
    CAPACITY_BUSY: 'All parallel worker slots on this node are currently in use.',
    OUTSIDE_WINDOW: 'Current local time is outside configured run windows or inside quiet hours.',
    APP_AUTH_REQUIRED:
        'Open Mobile manual session, complete Microsoft app sign-in, close session, then Retry app tasks.'
}

export function decorateBlockers(rawBlockers = []) {
    const seen = new Set()
    const out = []
    for (const item of rawBlockers) {
        if (!item?.code) continue
        const key = `${item.code}:${item.scope || 'account'}:${item.source || ''}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
            code: item.code,
            scope: item.scope || 'account',
            source: item.source || 'policy',
            retryAt: item.retryAt ?? null,
            remediation: item.remediation || BLOCKER_REMEDIATIONS[item.code] || null
        })
    }
    return out
}

export function computeAccountAxes({
    state = {},
    runningJob = null,
    queuedJob = null,
    manualLocked = false,
    maintenance = false,
    nodeOnline = true,
    isPreRewards = false,
    now = Date.now()
} = {}) {
    const rawBlockers = [...(state.normalPolicyStatus?.blockers || [])]
    if (queuedJob?.reason === 'PROXY_COOLDOWN') {
        rawBlockers.push({ code: 'PROXY_COOLDOWN', scope: 'network', source: 'proxy-rest', retryAt: queuedJob.dueAt })
    }
    if (state.appAuthorization?.required) {
        rawBlockers.push({
            code: 'APP_AUTH_REQUIRED',
            scope: 'app-oauth',
            source: 'app-authorization',
            retryAt: null
        })
    }
    if (queuedJob?.reason === 'outside-run-window') {
        rawBlockers.push({
            code: 'OUTSIDE_WINDOW',
            scope: 'account',
            source: 'schedule',
            retryAt: null
        })
    }
    const blockers = decorateBlockers(rawBlockers)

    // Axis 1: Progress (done | pending | failed | needs-action)
    const enabledPlatforms = Array.isArray(state.enabledPlatforms) ? state.enabledPlatforms : []
    const platformsDone = enabledPlatforms.every(p => {
        const ps = state.platforms?.[p]
        return ps && (ps.complete || ps.dailySearchComplete)
    })
    const tasksDone =
        Array.isArray(state.pendingWorkers) &&
        state.pendingWorkers.length === 0 &&
        (!Array.isArray(state.workersFailed) || state.workersFailed.length === 0) &&
        (!Array.isArray(state.blockedWorkers) || state.blockedWorkers.length === 0)

    const needsAction = Boolean(
        state.appAuthorization?.required ||
        state.newAccount?.needsAction ||
        ['user-action-required', 'process-check-required'].includes(state.normalPolicyStatus?.recovery)
    )
    const hasFailed = Boolean(
        (Array.isArray(state.workersFailed) && state.workersFailed.length > 0) ||
        enabledPlatforms.some(p => state.platforms?.[p]?.failed)
    )

    let progress = 'pending'
    if (needsAction) progress = 'needs-action'
    else if (
        !isPreRewards &&
        platformsDone &&
        tasksDone &&
        (enabledPlatforms.length > 0 || (state.workersCompleted?.length || 0) > 0)
    ) {
        progress = 'done'
    } else if (hasFailed) {
        progress = 'failed'
    }

    // Axis 2: Execution (running | queued | resting | held | manual | updating | offline)
    let execution
    if (!nodeOnline) execution = 'offline'
    else if (maintenance || blockers.some(b => b.code === 'UPDATE_IN_PROGRESS')) execution = 'updating'
    else if (runningJob) execution = 'running'
    else if (manualLocked || blockers.some(b => b.code === 'ACCOUNT_HELD')) execution = 'manual'
    else if (
        state.operatorPaused ||
        blockers.some(b =>
            ['ACCOUNT_HOLD', 'ACCOUNT_LOCKED', 'VERIFICATION_REQUIRED', 'SESSION_UNCERTAIN', 'ACCOUNT_PAUSED'].includes(
                b.code
            )
        )
    ) {
        execution = 'held'
    } else if (
        blockers.some(b => ['SESSION_REST', 'SESSION_LIMIT', 'STOP_COOLDOWN', 'PROXY_COOLDOWN'].includes(b.code)) ||
        (queuedJob?.dueAt && Date.parse(queuedJob.dueAt) > now + 1000)
    ) {
        execution = 'resting'
    } else if (queuedJob) {
        execution = 'queued'
    } else {
        execution = progress === 'done' ? 'resting' : 'queued'
    }

    const candidateTimes = [
        queuedJob?.dueAt,
        state.normalPolicyStatus?.nextEligibleAt,
        state.manualStopUntil,
        ...blockers.map(b => b.retryAt)
    ]
        .map(v => (v ? Date.parse(v) : NaN))
        .filter(Number.isFinite)

    const indefiniteBlocker = blockers.some(
        b =>
            b.retryAt === null &&
            [
                'ACCOUNT_LOCKED',
                'VERIFICATION_REQUIRED',
                'SESSION_UNCERTAIN',
                'ACCOUNT_HELD',
                'ACCOUNT_PAUSED',
                'UPDATE_IN_PROGRESS'
            ].includes(b.code)
    )
    const earliestStartAt =
        runningJob || !nodeOnline || indefiniteBlocker || (!queuedJob && progress === 'done')
            ? null
            : candidateTimes.length
              ? new Date(Math.max(now, ...candidateTimes)).toISOString()
              : queuedJob
                ? new Date(now).toISOString()
                : null

    return {
        progress,
        execution,
        blockers,
        earliestStartAt
    }
}
