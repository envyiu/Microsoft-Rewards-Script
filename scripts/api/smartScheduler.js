import { EventEmitter } from 'node:events'

import { DEFAULT_SMART_CONFIG, SMART_WORKERS, deriveNetworkGroup } from '../../packages/contracts/smartConfig.js'
import {
    calculateSearchBudget,
    calculateSearchDue,
    dailySetDependencySatisfied,
    legacyPlannerMethods,
    normalizeSearchResult,
    selectRunnableJobs,
    selectUrgentWorkerSession,
    selectWorkerSession,
    shouldPlanSearch
} from './scheduler/LegacyPlanner.js'
import { normalPlannerMethods } from './scheduler/NormalSessionPlanner.js'
import {
    applyEarnScan,
    earnRecheckDue,
    migrateRewardsVerification,
    scheduleStoreMethods,
    validateSmartConfig
} from './scheduler/ScheduleStore.js'
import { schedulerCommandMethods } from './scheduler/SchedulerCommands.js'
import { sessionRunnerMethods } from './scheduler/SessionRunner.js'
import { warmupMethods } from './scheduler/WarmupPlanner.js'

export {
    SMART_WORKERS,
    DEFAULT_SMART_CONFIG,
    deriveNetworkGroup,
    validateSmartConfig,
    migrateRewardsVerification,
    earnRecheckDue,
    applyEarnScan,
    calculateSearchBudget,
    normalizeSearchResult,
    shouldPlanSearch,
    calculateSearchDue,
    dailySetDependencySatisfied,
    selectUrgentWorkerSession,
    selectWorkerSession,
    selectRunnableJobs
}

export class SmartScheduler extends EventEmitter {
    constructor({
        projectRoot,
        command,
        args,
        stopTimeoutMs,
        configFile,
        onLog = () => {},
        accountFilter = () => true,
        hardParallel = null,
        manualLocks = new Map(),
        learning = null
    }) {
        super()
        this.setMaxListeners(0)
        this.projectRoot = projectRoot
        this.command = command
        this.args = args
        this.stopTimeoutMs = stopTimeoutMs
        this.configFile = configFile
        this.onLog = onLog
        this.running = new Map()
        this.manualLocks = manualLocks
        this.learning = learning
        this.accountFilter = accountFilter
        this.hardParallel = hardParallel
        this.queue = []
        this.timer = null
        this.suspended = false
        this.runNextRestOverrides = new Set()
        this._accountsCache = { signature: null, accounts: [] }
        this._botConfigCache = { path: null, mtimeMs: -1, size: -1, value: {} }
        this.document = this._load()
        this._recoverNormalSessions()
        migrateRewardsVerification(this.document.state)
        this.replan()
        this._arm()
    }
}

Object.assign(
    SmartScheduler.prototype,
    scheduleStoreMethods,
    warmupMethods,
    normalPlannerMethods,
    legacyPlannerMethods,
    schedulerCommandMethods,
    sessionRunnerMethods
)
