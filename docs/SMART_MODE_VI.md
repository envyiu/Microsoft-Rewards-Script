# Cơ chế chạy Smart Mode

Tài liệu mô tả **mã nguồn hiện tại trong workspace**, đối chiếu ngày 07/11/2026. Đây là cơ chế đang được triển khai, không phải bản thiết kế AI trong tương lai. Những hạn chế đã biết được ghi riêng ở cuối. Chính sách `normalPolicy` mặc định bật cho acc Rewards. Có thể đặt giới hạn nghiêm hơn, nhưng schema không nhận quá 4 phiên, quá 5 query, quá 4 task, cửa sổ dưới 24 giờ hoặc nghỉ dưới 90 phút.

## 1. Hiểu nhanh bằng một ví dụ

Giả sử một worker có 8 acc, được cấu hình 3 luồng. Acc A và B dùng chung proxy; C và D dùng hai proxy khác.

1. Scheduler xem từng acc còn thiếu Daily Set, nhiệm vụ khác hoặc search nào.
2. Mỗi phần việc được chuyển thành một **job**, có thời điểm được chạy sớm nhất.
3. Khi có chỗ trống, scheduler chọn tối đa 3 job đủ điều kiện, ưu tiên việc quan trọng trước.
4. A đang chạy thì B phải chờ vì cùng nhóm proxy. Sau khi A kết thúc, nhóm proxy nghỉ ngẫu nhiên 5–20 phút trước khi acc khác chạy. C và D vẫn có thể chạy.
5. Một job kết thúc thì ghi kết quả, giải phóng chỗ, cập nhật hàng đợi và chọn việc tiếp theo.
6. Acc chưa xong mục tiêu chỉ quay lại sau ít nhất 90 phút từ lúc phiên trước kết thúc và khi còn lượt trong trần 4 phiên/24 giờ trượt. Chấp nhận acc chưa hoàn tất ngày.

Vì vậy Smart không đơn giản là “chạy hết acc 1, rồi acc 2”. Nó xen kẽ các phiên nhỏ giữa nhiều acc. Nhưng hiện tại đây vẫn là **bộ quy tắc**, chưa phải mô hình AI tự tối ưu.

## 2. Manager, Worker và dashboard chịu trách nhiệm gì?

**Manager** giữ danh sách acc gốc, máy sở hữu acc, cấu hình mong muốn và lịch sử tổng hợp. Dashboard là giao diện gửi lệnh và xem trạng thái của Manager.

**Worker** nhận đúng tập acc được giao, lưu session, lập lịch Smart và chạy tiến trình bot trên máy đó. Mỗi worker có scheduler riêng; Manager không ngồi điều khiển từng truy vấn search.

Luồng điều khiển:

```text
Dashboard → Manager → snapshot cấu hình/tài khoản → Worker
                                                    ↓
                                             Smart Scheduler
                                                    ↓
                                            ProcessManager
                                                    ↓
                                       tiến trình bot cho một acc
                                                    ↓
                                        kết quả + checkpoint + log
                                                    ↓
Worker lưu bền vững → Manager đồng bộ → Dashboard hiển thị
```

Manager tắt thì worker tiếp tục lịch **đã nhận và áp dụng**. Thay đổi mới trên Manager không có tác dụng tại worker cho đến khi worker nhận được và xác nhận revision tương ứng. `Pending` không có nghĩa là cấu hình mới đã có hiệu lực.

Không tự chuyển acc sang máy khác khi một worker offline. Chuyển máy là giao thức thu hồi quyền chạy, checkpoint và chuyển session riêng.

## 3. “Một luồng” thực sự là gì?

`maxParallel` giới hạn số **job đang chạy đồng thời trên một worker**. Một job được chạy bằng một tiến trình bot riêng, chỉ nhận môi trường của acc đó và execution plan của phiên đó.

Một job có thể tạo nhiều tiến trình con Chromium hoặc hơn một browser context. Vì vậy 3 luồng không đồng nghĩa 3 tab, 3 tiến trình Windows hay 3 CPU core.

Số job chạy thực tế còn bị giới hạn bởi:

- Trần `hardParallel` worker nhận từ snapshot.
- Số nhóm proxy rảnh và số acc không bị giữ.
- Job đã đến giờ hay chưa, khung giờ cho phép và khoảng nghỉ.
- Task đã hoàn thành hoặc đã hết retry chưa.
- Giảm capacity trong thử nghiệm thu dữ liệu, nếu được cấp phép.

Ví dụ: có 3 chỗ nhưng tất cả acc còn lại cùng proxy với acc đang chạy thì vẫn chỉ chạy 1 job. Hiện không có cơ chế AI tự tăng luồng chỉ vì CPU còn rảnh.

`clusters` của bot là lớp khác. Trong bộ cài standalone, Manager đặt `clusters=1`; việc chạy nhiều acc song song do Smart tạo nhiều job đảm nhiệm.

## 4. Cấu hình nào quyết định hành vi?

Manager gửi chính sách dùng chung trong `schedule.normalPolicy`:

```json
{ "enabled": true, "maxSessions": 4, "windowHours": 24, "restMinutes": 90, "maxQueries": 5, "maxTasks": 4 }
```

`enabled` ở cấp schedule vẫn mặc định false; nâng mã nguồn không tự bật lịch đang pause. `maxParallel` mặc định 2 và không tăng khi Urgent. Profile giữ timezone, windows, quietHours, deadline và allowedWorkers. Task phải đồng thời được bật trong cấu hình bot. Deadline chỉ là thông tin, không nới budget hoặc tăng tốc. Run next/Urgent chỉ ưu tiên các phiên đủ điều kiện.

`cooldownMinutes`, `searchTarget`, `searchNoise`, `searchSafetyCap` và retry cũ còn dùng cho warmup/compatibility (`normalPolicy.enabled=false`). Với chính sách mới, query tối đa lấy từ `normalPolicy.maxQueries`; thời gian nghỉ và guard acc luôn có quyền chặn trước dispatch.

## 5. Scheduler lưu gì cho mỗi acc?

State của acc được chia theo **ngày trong múi giờ profile**, không mặc định theo ngày UTC hoặc đồng hồ Manager.

Phần nhiệm vụ lưu: `workersCompleted`, `workersFailed`, số lần lỗi từng task, thời điểm retry từng task và lần quét Earn gần nhất.

Phần search lưu riêng cho `mobile` và `desktop`:

- Quota có đọc được không (`quotaKnown`), còn bao nhiêu điểm (`remaining`).
- Đã xác nhận bao nhiêu truy vấn (`queries`).
- Ước lượng điểm/truy vấn (`ewmaPointsPerQuery`).
- Lần chạy trước, thời điểm hết cooldown, số lỗi.
- Đã hoàn tất (`complete`) hoặc đã hết lượt thử (`failed`) chưa.

`complete` và `failed` khác nhau: “không lập search tiếp” chưa chắc là “đã search đủ”. Điểm/quota không đọc được phải là chưa xác định, không được đổi thành 0 để đánh dấu hoàn thành.

State bảo vệ nằm riêng tại `protection`: lịch sử bắt đầu/kết thúc phiên, reservation query, lỗi liên tiếp và hold toàn acc. Nó không phải retry task hoặc telemetry learning.

Sang ngày mới, `protection` vẫn được giữ; trạng thái công việc trong ngày được tạo lại; mốc vòng đời 168 giờ của acc mới được giữ. Job chạy qua nửa đêm vẫn vào lịch sử ngày cũ, không được ghi đè tiến độ ngày mới.

## 6. Loại phiên

### 6.1. `accountSession`: phiên Rewards mặc định

Một tiến trình mở một browser/login theo môi trường desktop hoặc mobile và chạy tuần tự tối đa 4 task tương thích, kèm search nếu còn budget. Daily Set và phụ thuộc Search Perk được ưu tiên; tiếp theo Read to Earn. Các task app ghép chung phiên mobile; task browser dùng desktop. Search chỉ chạy trên platform của phiên. Khi không còn task, chọn platform còn việc, ưu tiên quota hợp lệ còn điểm và platform lâu chưa phục vụ nhất; hòa chọn desktop.

Một task chỉ Done khi phát marker hoàn thành đã xác minh. Task không hỗ trợ hoặc thiếu xác nhận vẫn pending. Bonus searches không được tự bật. Earn/quota được đọc trong phiên hợp lệ; không có job định kỳ mở browser chỉ để kiểm tra. Đóng browser và checkpoint khi hết phiên, không giữ browser trong 90 phút nghỉ.

### 6.2. `workers` và `search`: compatibility

Các execution plan cũ vẫn được đọc khi chính sách mới tắt. Chúng không được dispatch khi `normalPolicy` đang bật. Smart không ép `runOnZeroPoints=true`; Urgent không đặt budget 100 hoặc giảm search delay xuống 5–8 giây.

### 6.3. `quota`: compatibility

Quota-only jobs cũ không được lập trong chính sách mới. Task/Earn đã xong không được mở lại bằng một phiên kiểm tra riêng.

### 6.4. `warmup`: acc mới chưa vào Rewards

Acc có `newAccountMode=true` và chưa đến `readyAt` đi vào nhánh này trước các task Rewards:

- Chỉ ghé OneDrive, To Do, Outlook, Calendar và search Bing theo luồng acc mới.
- Không chạy task Rewards hoặc dùng quota điểm Rewards để quyết định search.
- Mỗi phiên tối đa 5 truy vấn.
- Trần riêng hiện tại: 30 desktop và 20 mobile mỗi ngày.
- Lượt đã gửi nhưng chưa xác minh kết quả vẫn tiêu tốn reservation; không được gửi lại vượt trần chỉ vì bộ đếm hoàn tất thấp hơn.
- Các dịch vụ được đưa vào job desktop; tối đa 3 lượt thử dịch vụ trong ngày theo state hiện tại.
- Bộ đếm 168 giờ bắt đầu khi checkpoint xác nhận có truy vấn thành công đầu tiên, không phải lúc thêm acc vào Manager.
- Hết 168 giờ thì chuyển sang nhánh Rewards và khởi tạo lại tiến độ search cho bước chuyển này.

Urgent bỏ qua acc đang warmup. Các trần 30/20 không phải trần ngày áp dụng chung cho acc Rewards.

## 7. Tạo và sắp xếp hàng đợi

`replan()` kiểm tra ownership, profile, warmup/Rewards và các task chưa hoàn tất. Mỗi acc Rewards có tối đa một `accountSession` được đề xuất. Một job chỉ chạy khi đủ guard phiên, hết thời gian nghỉ, còn lượt 24 giờ và acc/proxy không bận. Run next/Urgent không bỏ qua những kiểm tra này, kể cả force drain.

Trong các acc đủ điều kiện, ưu tiên yêu cầu Run next/Urgent; lượt đã chờ đủ hai giờ được ưu tiên chống đói lịch, sau đó xét task ngày quan trọng, nguy cơ deadline và lịch sử phiên. Deadline là mốc ưu tiên mềm, không phải giờ cấm chạy; dùng quiet hours khi cần cấm. Timer 30 giây chỉ lập kế hoạch, không phải mỗi tick tạo một lần đăng nhập. Không tạo job quota/Earn kiểm tra riêng ở gần deadline.

## 8. Khóa acc, proxy và phiên thủ công

Trước khi chọn job, scheduler tạo tập acc và nhóm mạng đang bận. Sau khi chọn một job, nó thêm ngay acc/nhóm đó vào tập bận để những job tiếp theo trong cùng lượt chọn không trùng.

Quy tắc chạy tự động:

- Không chọn hai job cho cùng acc.
- Không chọn hai job cùng nhóm mạng trên scheduler đó.
- Mặc định nhóm có proxy là `PROXY:<host>:<port>`; acc không proxy thuộc `DIRECT`.
- `networkGroupOverride` có thể thay tên nhóm theo cấu hình.

**Giới hạn quan trọng:** nhóm host/port không phải IP thoát được đo thực tế. Hai port trả cùng IP không tự được gộp. Mỗi worker giữ khóa riêng; không có khóa IP thực tế toàn Fleet trong scheduler này. Phân công thông thường theo nhóm proxy giúp giữ nhóm trên một worker, nhưng không thay thế việc xác minh IP.

Phiên mở thủ công Desktop/Mobile/Android dùng khóa **chỉ acc được chọn**: chờ khi chính acc đó đang chạy, không chặn acc khác cùng proxy. Chuyển máy thông thường vẫn có thể giữ cả nhóm proxy.

Hold không tự hết hạn chỉ vì worker mất mạng hoặc UI đóng. Phải có xác nhận đóng/lưu session hoặc thao tác giải phóng hợp lệ. Lỗi checkpoint không được coi là đã lưu xong.

## 9. Search budget và thời gian nghỉ

Trước mỗi lần gửi Bing query, cổng dùng chung kiểm tra đúng platform của phiên, quota đọc trong chính phiên hiện tại và còn điểm. Snapshot quá 10 phút, thiếu/malformed, đã hoàn tất hoặc mất dữ liệu đều không được search thăm dò. Query phát sinh từ Daily Set, SearchOnBing, card visit, Visual Search và API opt-in đều dùng chung trần 5.

Reservation query được fsync trước send; gửi xong nhưng kết quả không rõ vẫn tính lượt. Search ngoài đường đã cấp phép bị browser guard chặn. Không tự bật API, bonus searches, đổi proxy hay fingerprint để tiếp tục. Giữ search delay cấu hình và chờ DOM/phản hồi thực tế. Sau hai query liên tiếp chưa xác nhận tiến triển, dừng gửi, chờ 60 giây và đối soát một lần; nếu vẫn không xác minh tiến triển thì dừng phần search.

Lượt phiên được lưu trước tạo ChildProcess. Chỉ hoàn lại khi xác nhận chưa tạo được tiến trình; thiếu ACK hoặc không biết có spawn hay chưa vẫn tính lượt và giữ trạng thái chưa xác minh. Nghỉ tối thiểu 90 phút tính từ thời điểm kết thúc phiên, kể cả lỗi hoặc stop, không tính từ lúc bắt đầu. Ngày mới không cấp lại 4 lượt: lượt chỉ rời budget khi đủ 24 giờ trượt.

## 10. Runtime và kết quả từng phần

Execution plan `accountSession` giới hạn worker/platform/query budget ngay khi khởi tạo. Một context đăng nhập được dùng cho cả batch; không thực hiện recovery đăng nhập lại giữa task. Mỗi task phát `SMART-WORKER-END` riêng sau kiểm chứng. Thiếu marker không được coi là hoàn thành dù tiến trình exit 0. Lỗi chung của account dừng trước task tiếp theo.

`SMART-QUOTA` là quan sát có timestamp, `SMART-SEARCH-END` là kết quả search. Điểm/quota không đọc được vẫn unknown; query reservation có thể lớn hơn số query có kết quả rõ. Kết quả trước nửa đêm không được ghi vào task state ngày mới; lịch sử phiên và hold toàn acc vẫn giữ.

## 11. Lỗi và phục hồi

Phân biệt mạng/proxy, dữ liệu Rewards chưa rõ, lỗi xác thực, yêu cầu xác minh, khóa account và task không hỗ trợ. Flyout code 9 chỉ là dữ liệu chưa rõ, không chứng minh acc bị banned.

Lỗi mạng/dữ liệu tạm thời dừng việc phụ thuộc và vẫn phải nghỉ 90 phút. Hai phiên liên tiếp cùng lỗi authentication hoặc data giữ toàn acc 24 giờ. Hết hold chỉ một phiên phục hồi trong budget thường được phép; nếu vẫn lỗi, tiếp tục giữ 24 giờ. Challenge/locked giữ vô thời hạn đến khi người dùng xử lý rồi chọn cho phép phục hồi. Retry/Urgent không xóa hold.

Riêng với các tài khoản cấu hình `recoveryEmail` đúng đuôi `@fviainboxes.com`, `NormalSession` cho phép luồng đăng nhập tự động đi qua các bước `EMAIL_VERIFICATION_INPUT`, `RECOVERY_EMAIL_INPUT` và `OTP_CODE_ENTRY` (ưu tiên lấy mã qua email từ `fviainboxes.com` trước khi dùng mật khẩu, không ghi email/OTP ra log). Nếu lấy mã thất bại hoặc không khớp gợi ý, hệ thống fallback sang mật khẩu (nếu có) hoặc ghi nhận `verification` và đặt hold `VERIFICATION_REQUIRED` như bình thường. Tài khoản dùng đuôi khác vẫn dừng ngay khi gặp thử thách xác minh.

API status có `normalPolicyStatus.sessionsUsed`, `sessionLimit`, `nextEligibleAt`, `blockedReason`, `blockers` và `recovery`; dashboard hiển thị chi tiết từng lý do. Request run chạy một lượt ngay khi có slot: bỏ thời gian nghỉ giữa phiên, thời gian nghỉ sau Stop và khung giờ chạy của lượt đó; không xóa hold, retry backoff hay quota. Yêu cầu được lưu bền khi phải chờ slot/khóa mạng và được tiêu thụ trước khi mở phiên. Lịch thường đang pause vẫn giữ pause. Run next chỉ bỏ nghỉ giữa phiên cho dispatch có slot; Retry chỉ mở lại task đã chọn. Pause account ngăn lượt mới nhưng không dừng phiên hiện tại; Stop yêu cầu lưu checkpoint có ACK trước khi buộc dừng.

Sau khi xử lý, nút “I resolved verification · allow recovery” gọi `POST /smart-schedule/accounts/:index/release-protection` với `acknowledge:true`. Trường hợp spawn/exit chưa rõ cần xác nhận tiến trình cũ đã dừng (`confirmedStopped:true`); PID còn sống vẫn bị từ chối. Giải phóng hold không hoàn lượt đã dùng và không rút ngắn khoảng nghỉ.

## 12. Pause, Run next, Retry và Urgent

Pause dừng lịch thường và giữ dữ liệu. Run next chỉ ưu tiên phiên đủ điều kiện; targeted Run có thể chạy một phiên khi lịch pause nhưng không bật lịch thường. Urgent chỉ thay ưu tiên, không giảm delay, nới trần hoặc xóa lỗi chung. Retry không xóa protection. Stop ghi kết thúc phiên và áp dụng nghỉ tối thiểu 90 phút.

Các nút mở Desktop/Mobile/Android thủ công giữ luồng ownership/hold riêng như mục 8. Warmup tiếp tục cơ chế 168 giờ và 30 desktop/20 mobile riêng.

## 13. Lưu state, restart và đồng bộ

Lịch sử phiên và hold nằm trong account planner được chuyển qua giao thức checkpoint/hold → revoke nguồn → activate đích → ACK → release. Query journal riêng được ghi bền trước send và nhập vào planner khi phiên kết thúc; không dùng learning để cấp lại budget. Thiếu ACK không cho phép cấp quyền chạy đồng thời. Restart đối soát PID đã chết, giữ reservation và lấy thời điểm restart làm mốc kết thúc bảo thủ; PID chưa xác minh giữ `SESSION_UNCERTAIN`.

Worker quảng bá `conservativeSessionsV1`. Manager/coordinator không gửi chính sách mới cho worker thiếu capability; hiển thị `UPGRADE_REQUIRED`. Các profile, session, fingerprint, proxy và pause hiện có phải được giữ khi nâng cấp.

Triển khai: pause/drain và backup riêng tư trước thay release; chỉ triển khai khi jobs đã dừng, giữ pause. Sau khi người dùng bật lại, canary một acc hiện có không có dấu hiệu khóa, rồi mới mở rộng. Theo dõi 7 ngày: số starts/login mỗi acc, query chưa tiến triển, lỗi xác thực, task hoàn tất và tài nguyên. Không coi vài ngày chưa khóa là bằng chứng chống ban.

Rollback dùng code cũ nhưng giữ planner/protection/query journal mới nhất và đưa lịch về pause để tránh chạy bù. Không khôi phục cookie/fingerprint cũ đè checkpoint mới.

## 14. Thu dữ liệu và AI hiện tại

Có tầng learning quan sát lựa chọn job, tài nguyên, pha thực thi, query, kết quả và revision. Nó chưa phải một mô hình đã train có toàn quyền điều khiển scheduler.

Trong normal mode tầng thu dữ liệu chỉ quan sát và không giảm concurrency hoặc cấp thêm quota. Các trial compatibility vẫn phải qua gate riêng. Bộ đếm warmup giữ reservation chưa chắc chắn đến hết ngày; restart hoặc chuyển worker không cấp lại lượt đã đặt trước.

Lộ trình thu dữ liệu hiện mô tả baseline ngày 1–7, quan sát thử nghiệm đủ điều kiện ngày 8–28 và held-out ngày 29–35. Đủ ngày không có nghĩa đủ chất lượng dữ liệu hay tự bật AI. Xem [runbook learning](../scripts/learning/README.md) để biết gate và giới hạn chính xác.

## 15. Các giới hạn đang có, không được hiểu nhầm là đã giải quyết

- Chưa có AI tối ưu toàn Fleet theo mục tiêu “nhiều acc hoàn thành nhất rồi giảm tài nguyên”.
- Khóa proxy chưa phải khóa IP thoát thực tế toàn Fleet.
- Hold toàn acc thuộc chính sách mới; code compatibility không thay thế guard này. Nâng/rollback phải giữ state và pause.
- Lỗi `Flyout response is missing Rewards account data` chỉ chứng minh không lấy được dữ liệu hợp lệ từ Flyout; không tự chứng minh acc bị ban.
- Search budget mỗi phiên không phải trần số truy vấn/ngày của acc Rewards.
- Nhãn Done/Failed/Paused cần đọc cùng trạng thái từng task, quota và revision thực tế; không suy ra tất cả chỉ từ một icon.
- Handoff/checkpoint trên Windows còn có đường dùng signal POSIX cần được xử lý riêng.

## 16. Mã nguồn để đối chiếu

- [SmartScheduler](../scripts/api/smartScheduler.js): replan, ghép task, queue, dispatch, retry, kết quả, Urgent.
- [Smart config dùng chung](../packages/contracts/smartConfig.js): mặc định, validator, profile và nhóm mạng.
- [Execution plan](../src/interface/ExecutionPlan.ts): loại job, schema và giới hạn budget.
- [ProcessManager](../scripts/api/processManager.js): tiến trình bot, log, timeout/dừng.
- [Hybrid](../scripts/api/hybrid.js): snapshot, hold, session, áp dụng roster khi đang chạy.
- [Acc mới](../packages/contracts/newAccount.js): 168 giờ, dịch vụ và trần 30/20.
- [Browser](../src/browser/Browser.ts) và [HTTP](../src/util/Http.ts): áp dụng proxy cho hai đường thực thi.
- [BrowserFunc](../src/browser/BrowserFunc.ts): dashboard/Flyout, quota, checkpoint và độ tin cậy điểm.
- [Collector](../scripts/learning/collector.js): quan sát và thử nghiệm thu dữ liệu.
- [Manager core](../../rewards-dashboard/manager/core.js): ownership, snapshot, route lệnh, cấu hình và đồng bộ.
- [Kiến trúc Manager](../../rewards-dashboard/manager/ARCHITECTURE.md): hợp đồng Manager–Worker và chuyển session.

Tài liệu này chỉ mô tả cơ chế. Việc tạo tài liệu không thay đổi cấu hình, bật lịch hay triển khai mã mới lên worker.

## Search theo daily Rewards streak

Khi `streakSearchV1` bật, quota search thường mỗi ngày tính theo `30 + 2 × min(streak, 30)` phần trăm; desktop tối đa cơ sở 30 query và mobile 20, làm tròn xuống. Streak 0 cho 9/6, streak 10 cho 15/10, streak từ 30 cho 27/18. Dùng lần đọc Rewards thành công gần nhất, chưa có thì tạm dùng 0; đọc mới cập nhật các lượt tiếp theo. Số đã sử dụng và reservation chưa chắc chắn được giữ khi thay mục tiêu, restart hay handoff. Search và query từ quest vẫn dùng chung trần mỗi phiên, tối đa 5. Các khoảng search cũ chỉ còn để đọc cấu hình tương thích, không quyết định quota khi chính sách này bật. Worker phải công bố capability `streakSearchV1` trước khi Manager gửi chính sách mới.

## Nghỉ khi đổi acc cùng proxy

Sau mỗi phiên Smart đã mở tiến trình (Rewards, warmup hoặc nhánh tương thích), Worker chọn một lần thời gian nghỉ nguyên phút trong khoảng 5–20 và lưu `proxyCooldown` vào planner của acc vừa kết thúc. Mốc tuyệt đối giữ qua restart, đổi ngày và handoff planner; không bốc lại khi replan/Retry. Tiến trình cũ được xác nhận đã chết khi recovery sẽ bắt đầu khoảng nghỉ từ lúc recovery. Lỗi chưa tạo được tiến trình không tạo khoảng nghỉ.

Acc khác có cùng nhóm proxy phải chờ tới `retryAt`; Request run, Run next và Urgent không bỏ qua khóa này. Acc cùng proxy vẫn không được chạy song song. Direct không nhận khoảng nghỉ proxy; thời gian nghỉ 90 phút của chính acc, quota và khóa đăng nhập vẫn giữ nguyên. Phiên thủ công tiếp tục dùng khóa acc hiện có và không tự bị đóng. API hiển thị `PROXY_COOLDOWN` và thời điểm được chạy tiếp. Các worker vận hành độc lập; quy tắc này không tạo bộ khóa proxy phân tán giữa các node nếu quản trị viên cố tình chia cùng proxy sang nhiều máy.
