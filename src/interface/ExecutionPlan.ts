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

export type ExecutionPlan = { urgent?: boolean; rewardsEligibleAt?: string } & (
    | {
          version: 1
          jobId: string
          type: 'accountSession'
          workers: SmartWorker[]
          platform: 'mobile' | 'desktop'
          searchBudget: number
          normalSearchBudget?: number
          environment: 'mobile' | 'desktop'
      }
    | { version: 1; jobId: string; type: 'quota' }
    | {
          version: 1
          jobId: string
          type: 'search'
          recheckEarn?: boolean
          platform: 'mobile' | 'desktop'
          searchBudget: number
      }
    | { version: 1; jobId: string; type: 'workers'; workers: SmartWorker[] }
    | {
          version: 1
          jobId: string
          type: 'warmup'
          platform: 'mobile' | 'desktop'
          searchBudget: number
          services: string[]
          newAccountPolicy?: 'standard168h' | 'search72h'
          artifacts?: string[]
          warmupStartedAt?: string
          warmupReadyAt?: string
      }
)

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
    if (plan.urgent != null && typeof plan.urgent !== 'boolean') throw new Error('Smart urgent flag must be a boolean')
    if (plan.version !== 1 || typeof plan.jobId !== 'string' || !plan.jobId.trim()) {
        throw new Error('MRS_EXECUTION_PLAN has an unsupported version or missing jobId')
    }
    if (
        plan.rewardsEligibleAt != null &&
        (typeof plan.rewardsEligibleAt !== 'string' || !Number.isFinite(Date.parse(plan.rewardsEligibleAt)))
    )
        throw new Error('Invalid Rewards eligibility time')
    if (plan.recheckEarn != null && (plan.type !== 'search' || typeof plan.recheckEarn !== 'boolean'))
        throw new Error('Invalid Earn recheck flag')
    if (plan.type === 'accountSession') {
        if (
            plan.normalSearchBudget != null &&
            (!Number.isSafeInteger(plan.normalSearchBudget) ||
                Number(plan.normalSearchBudget) < 0 ||
                Number(plan.normalSearchBudget) > Number(plan.searchBudget))
        )
            throw new Error('Invalid normal search budget')
        if (
            !['mobile', 'desktop'].includes(String(plan.platform)) ||
            plan.environment !== plan.platform ||
            !Number.isSafeInteger(plan.searchBudget) ||
            Number(plan.searchBudget) < 0 ||
            Number(plan.searchBudget) > 5 ||
            !Array.isArray(plan.workers) ||
            plan.workers.length > 4 ||
            plan.workers.some(w => !SMART_WORKERS.includes(w as SmartWorker) || w === 'bonusSearches') ||
            plan.workers.some(
                w =>
                    ['readToEarn', 'dailyCheckIn', 'appPromotions'].includes(String(w)) !==
                    (plan.environment === 'mobile')
            ) ||
            new Set(plan.workers).size !== plan.workers.length
        )
            throw new Error('Invalid conservative account session')
        return plan as ExecutionPlan
    }
    if (plan.type === 'quota')
        return {
            version: 1,
            jobId: plan.jobId,
            type: 'quota',
            ...(plan.rewardsEligibleAt ? { rewardsEligibleAt: String(plan.rewardsEligibleAt) } : {})
        }
    if (plan.type === 'search' || plan.type === 'warmup') {
        if (
            plan.type === 'warmup' &&
            plan.newAccountPolicy != null &&
            !['standard168h', 'search72h'].includes(String(plan.newAccountPolicy))
        )
            throw new Error('Invalid new account policy')
        if (
            plan.type === 'warmup' &&
            plan.newAccountPolicy === 'search72h' &&
            ((Array.isArray(plan.services) && plan.services.length) ||
                (Array.isArray(plan.artifacts) && plan.artifacts.length))
        )
            throw new Error('Search-only warmup cannot access services')
        if (plan.type === 'warmup' && (plan.warmupStartedAt != null || plan.warmupReadyAt != null)) {
            const duration = (plan.newAccountPolicy === 'search72h' ? 72 : 168) * 3600000
            if (
                typeof plan.warmupStartedAt !== 'string' ||
                typeof plan.warmupReadyAt !== 'string' ||
                !Number.isFinite(Date.parse(plan.warmupStartedAt)) ||
                Date.parse(plan.warmupReadyAt) - Date.parse(plan.warmupStartedAt) !== duration
            )
                throw new Error('Invalid warmup lifecycle')
        }
        if (plan.type === 'warmup' && (plan.urgent === true || Number(plan.searchBudget) > 5))
            throw new Error('New account sessions use ordinary pacing and at most five queries')
        if (
            plan.type === 'warmup' &&
            (!Array.isArray(plan.services) ||
                plan.services.some(s => !['onedrive', 'todo', 'outlook', 'calendar'].includes(String(s))))
        )
            throw new Error('Invalid new account service list')
        if (
            plan.type === 'warmup' &&
            plan.artifacts != null &&
            (!Array.isArray(plan.artifacts) || plan.artifacts.some(s => !['onedrive', 'todo'].includes(String(s))))
        )
            throw new Error('Invalid new account artifacts')
        if (!['mobile', 'desktop'].includes(String(plan.platform))) throw new Error('Invalid smart search platform')
        if (
            !Number.isSafeInteger(plan.searchBudget) ||
            Number(plan.searchBudget) < (plan.type === 'warmup' ? 0 : 1) ||
            Number(plan.searchBudget) > 100
        ) {
            throw new Error('Smart search budget must be an integer from 1 to 100')
        }
        return plan as ExecutionPlan
    }
    if (plan.type === 'workers') {
        if (
            !Array.isArray(plan.workers) ||
            plan.workers.length < 1 ||
            plan.workers.length > (plan.urgent ? SMART_WORKERS.length : 2)
        ) {
            throw new Error('Smart worker sessions require one or two workers')
        }
        if (plan.workers.some(worker => !SMART_WORKERS.includes(worker as SmartWorker))) {
            throw new Error('Smart execution plan contains an unknown worker')
        }
        return {
            version: 1,
            jobId: plan.jobId,
            type: 'workers',
            workers: [...new Set(plan.workers)] as SmartWorker[],
            ...(plan.rewardsEligibleAt ? { rewardsEligibleAt: String(plan.rewardsEligibleAt) } : {}),
            ...(plan.urgent === true ? { urgent: true } : {})
        }
    }
    throw new Error('Smart execution plan has an invalid type')
}
