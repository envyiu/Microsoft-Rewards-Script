export const SMART_WORKERS = [
    'dailySet',
    'morePromotions',
    'claimBonusPoints',
    'punchCards',
    'appPromotions',
    'dailyCheckIn',
    'readToEarn',
    'activateSearchPerk',
    'visualSearch',
    'bonusSearches',
    'streakProtection'
] as const

export type SmartWorker = (typeof SMART_WORKERS)[number]

export type ExecutionPlan =
    | { version: 1; jobId: string; type: 'search'; platform: 'mobile' | 'desktop'; searchBudget: number }
    | { version: 1; jobId: string; type: 'workers'; workers: SmartWorker[] }

export function loadExecutionPlan(value = process.env.MRS_EXECUTION_PLAN): ExecutionPlan | null {
    if (!value) return null
    let raw: unknown
    try {
        raw = JSON.parse(value)
    } catch {
        throw new Error('MRS_EXECUTION_PLAN must contain valid JSON')
    }
    if (!raw || typeof raw !== 'object') throw new Error('MRS_EXECUTION_PLAN must be an object')
    const plan = raw as Record<string, unknown>
    if (plan.version !== 1 || typeof plan.jobId !== 'string' || !plan.jobId.trim()) {
        throw new Error('MRS_EXECUTION_PLAN has an unsupported version or missing jobId')
    }
    if (plan.type === 'search') {
        if (!['mobile', 'desktop'].includes(String(plan.platform))) throw new Error('Invalid smart search platform')
        if (!Number.isSafeInteger(plan.searchBudget) || Number(plan.searchBudget) < 1 || Number(plan.searchBudget) > 100) {
            throw new Error('Smart search budget must be an integer from 1 to 100')
        }
        return plan as ExecutionPlan
    }
    if (plan.type === 'workers') {
        if (!Array.isArray(plan.workers) || plan.workers.length < 1 || plan.workers.length > 2) {
            throw new Error('Smart worker sessions require one or two workers')
        }
        if (plan.workers.some(worker => !SMART_WORKERS.includes(worker as SmartWorker))) {
            throw new Error('Smart execution plan contains an unknown worker')
        }
        return { version: 1, jobId: plan.jobId, type: 'workers', workers: [...new Set(plan.workers)] as SmartWorker[] }
    }
    throw new Error('Smart execution plan has an invalid type')
}
