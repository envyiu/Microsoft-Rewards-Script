export type AiChoice = { ai: boolean; feedback: 'none' | 'like' | 'dislike'; followups: number }

// Draw once for each initial query. Later branches are conditional on completed turns.
export function aiSearchChoice(random = Math.random): AiChoice {
    if (random() >= 0.7) return { ai: false, feedback: 'none', followups: 0 }
    const draw = random()
    const feedback = draw < 0.5 ? 'none' : draw < 0.6 ? 'dislike' : 'like'
    return { ai: true, feedback, followups: feedback === 'like' && random() < 0.3 ? 1 : 0 }
}

export function thirdTurnChoice(random = Math.random): boolean {
    return random() < 0.1
}

function splitChoices(text: string): string[] {
    const result: string[] = []
    let depth = 0,
        quote = '',
        start = 0
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!
        if (quote) {
            if (char === quote) quote = ''
            continue
        }
        if ('"“'.includes(char)) {
            quote = char === '“' ? '”' : char
            continue
        }
        if (char === '(') depth++
        if (char === ')') depth = Math.max(0, depth - 1)
        if (depth) continue
        const separator = text.slice(i).match(/^(?:,\s+(?:(?:hay|hoặc|or)\s+)?|\s+(?:hay|hoặc|or)\s+)/i)
        if (!separator) continue
        result.push(text.slice(start, i).trim())
        i += separator[0].length - 1
        start = i + 1
    }
    result.push(text.slice(start).trim())
    return result.filter(Boolean)
}

const unsafe =
    /https?:|www\.|[<>`]|ignore.{0,40}instructions|bỏ qua.{0,40}(?:chỉ dẫn|hướng dẫn)|mật khẩu|password|access.?token|api.?key|chạy lệnh|execute|run (?:this |the )?command|đăng nhập|log ?in|đăng ký|sign ?up|tải xuống|download|mua ngay|buy now|thanh toán|payment|chuyển tiền/i
const normalize = (text: string) =>
    text
        .normalize('NFC')
        .replace(/[*_]/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

export function followupQuestion(
    answer: string,
    topic: string,
    random = Math.random,
    sent: readonly string[] = []
): string | null {
    const tail = normalize(answer).slice(-1600)
    if (unsafe.test(tail)) return null
    const matches = [...tail.matchAll(/(?:Bạn\s+(?:có\s+muốn|muốn)|Do you want|Would you like)[^?]{8,1000}\?/gi)]
    const match = matches.at(-1)
    if (!match || tail.slice(match.index! + match[0].length).replace(/[\s.![\]\d]/g, '').length > 40) return null
    const english = /^(Do|Would)/i.test(match[0])
    const offer = match[0]
        .replace(
            /^(?:Bạn\s+(?:có\s+muốn|muốn)\s*(?:(?:mình|tôi)\s*)?|Do you want\s*|Would you like\s*(?:me to\s*)?)/i,
            ''
        )
        .replace(/\s*(?:không|nhé)?\s*\?$/, '')
    let choices = splitChoices(offer)
    const suffix = choices.at(-1)?.match(/\s+(theo từng năm|qua các năm|by year|over time)$/i)?.[0] || ''
    if (suffix && choices.length > 1) choices = choices.map((s, i) => (i === choices.length - 1 ? s : s + suffix))
    const sharedAbout = /^(?:biết|tìm hiểu)\s+(?:thêm\s+)?về\s+/i.test(offer)
    const questions = choices
        .flatMap(choice => {
            let action = choice.replace(/^(?:muốn\s+|want to\s+)/i, '').trim()
            if (action.length < 4 || action.length > 350 || unsafe.test(action)) return []
            if (english) return [`Regarding ${normalize(topic).slice(0, 160)}, please explain more about ${action}.`]
            action = action
                .replace(/^biết\s+(?:thêm\s+)?về\s+/i, 'tìm hiểu về ')
                .replace(/^biết\s+/i, 'cho biết ')
                .replace(/^kiểm tra giúp cách\s+/i, 'hướng dẫn cách ')
            if (
                !/^(?:tìm hiểu|cho biết|tóm tắt|kiểm tra|so sánh|cập nhật|hướng dẫn|phân biệt|giải thích|trình bày|phân tích)\b/i.test(
                    action
                )
            )
                action = `${sharedAbout ? 'tìm hiểu về' : 'cho biết'} ${action}`
            return [`Về ${normalize(topic).slice(0, 160)}, hãy ${action.replace(/\bmình\b/gi, 'tôi')}.`]
        })
        .filter(
            q =>
                !sent.some(s => {
                    const intent = (value: string) =>
                        normalize(value)
                            .toLowerCase()
                            .split(/, hãy |, please explain more about /)
                            .at(-1)
                    return intent(s) === intent(q)
                })
        )
    if (!questions.length) return null
    return questions[Math.min(questions.length - 1, Math.floor(random() * questions.length))]!
}
