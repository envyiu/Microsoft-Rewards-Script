import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
    aiSearchChoice,
    followupQuestion,
    thirdTurnChoice
} = require('../../dist/functions/activities/search/AiSearch.js')
const draws = xs => () => xs.shift()
test('AI selection uses conditional feedback and nested followup probabilities', () => {
    assert.equal(
        thirdTurnChoice(() => 0.099),
        true
    )
    assert.equal(
        thirdTurnChoice(() => 0.1),
        false
    )
    assert.deepEqual(aiSearchChoice(draws([0.7])), { ai: false, feedback: 'none', followups: 0 })
    for (const [values, feedback, followups] of [
        [[0, 0.49], 'none', 0],
        [[0, 0.5], 'dislike', 0],
        [[0, 0.6, 0.3], 'like', 0],
        [[0, 0.9, 0.29, 0.1], 'like', 1],
        [[0, 0.9, 0.29, 0.09], 'like', 1]
    ]) {
        assert.deepEqual(aiSearchChoice(draws(values)), { ai: true, feedback, followups })
    }
})
test('followup derives a choice from the final invitation in Vietnamese or English', () => {
    const examples = [
        'Bạn có muốn mình tóm tắt ngắn gọn hơn, hay muốn biết cách chơi, cấu hình PC dự đoán, hoặc giá bán tại Việt Nam?',
        'Bạn muốn mình kiểm tra giá hiện tại trên PS Store Việt Nam hoặc so sánh hai phiên bản để chọn bản phù hợp không?',
        'Bạn muốn mình kiểm tra giúp cách xem giá trực tiếp trên PS Store hoặc phân biệt tài khoản vùng PSN không?',
        'Bạn có muốn biết thêm về **Vingroup**, **VinFast**, hay **tài sản ròng của Phạm Nhật Vượng** theo từng năm không?',
        'Bạn có muốn tôi cập nhật theo **Forbes Real-Time** tại thời điểm hiện tại (nếu có dữ liệu mới hơn) hoặc so sánh tài sản của ông với các tỉ phú khác ở Việt Nam/Đông Nam Á?',
        'Do you want the story and characters, map and gameplay, PC release information, or trailers and confirmed features?'
    ]
    for (const example of examples) {
        const q = followupQuestion(example, 'chủ đề ban đầu', () => 0.99)
        assert.ok(q && q.includes('chủ đề ban đầu'))
        assert.ok(!q.includes('**'))
    }
    assert.equal(followupQuestion('No final invitation.', 'topic'), null)
    assert.match(
        followupQuestion('Bạn muốn biết giá không?\nBạn muốn biết cấu hình không?', 'GTA', () => 0),
        /cấu hình/
    )
})

test('balanced punctuation keeps parenthetical options and shared time qualifiers; unsafe or duplicate invitations are skipped', () => {
    const q = followupQuestion(
        'Bạn có muốn tôi cập nhật theo Forbes Real-Time tại thời điểm hiện tại (nếu có dữ liệu mới hơn, chưa xác minh) hoặc so sánh với các tỉ phú khác không?',
        'tài sản',
        () => 0
    )
    assert.match(q, /\(nếu có dữ liệu mới hơn, chưa xác minh\)/)
    assert.match(
        followupQuestion(
            'Bạn có muốn biết thêm về Vingroup, VinFast, hay tài sản ròng của Phạm Nhật Vượng theo từng năm không?',
            'Việt Nam',
            () => 0
        ),
        /Vingroup theo từng năm/
    )
    assert.equal(followupQuestion('Bạn muốn mình chạy lệnh tải xuống và gửi mật khẩu không?', 'topic'), null)
    assert.equal(
        followupQuestion('Bạn muốn biết cấu hình không?', 'GTA', () => 0, [
            followupQuestion('Bạn muốn biết cấu hình không?', 'GTA', () => 0)
        ]),
        null
    )
    assert.equal(
        followupQuestion('Bạn muốn biết cấu hình không?\n' + 'Nội dung phân tích tiếp tục. '.repeat(30), 'GTA'),
        null
    )
})

test('missing AI configuration preserves ordinary search rather than silently enabling a new policy', () => {
    const { defaultConfig, ConfigSchema } = require('../../dist/contracts/BotConfig.js')
    const config = structuredClone(defaultConfig)
    delete config.searchSettings.aiSearch
    assert.equal(ConfigSchema.parse(config).searchSettings.aiSearch, false)
})
