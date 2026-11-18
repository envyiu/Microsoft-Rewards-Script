# Tổng quan dự án MS Rewards

> Cập nhật: 11/11/2026. Trang này mô tả bộ cài Manager/Worker giao thức 3 trong workspace. CLI, cron, Control API và Dashboard cũ là đường tương thích hoặc migration.

## 1. Mục tiêu thiết kế

Hệ thống tách máy **quản lý** khỏi các máy **thực thi**. Dashboard là giao diện của Manager; nó không điều khiển trình duyệt trực tiếp. Mỗi Worker chạy độc lập, chỉ nhận tài khoản được giao và giữ dữ liệu vận hành cần để tiếp tục khi Manager tạm mất kết nối.

    Dashboard :8890 → Manager API :3012 → snapshot + revision → Worker API :3010
                                                         ↓
                                                 Smart Scheduler
                                                         ↓
                                             bot + browser + session
                                                         ↓
                                        journal + checkpoint + kết quả
                                                         ↓
                                                 Manager/dashboard

Các port mặc định chỉ lắng nghe trên loopback. Truy cập từ máy khác cần tunnel được quản lý; không expose API Worker ra Internet.

## 2. Phân định dữ liệu và quyền sở hữu

| Dữ liệu hoặc trách nhiệm                                   | Manager                                    | Worker                                          |
| ---------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Tài khoản gốc, mật khẩu, proxy và cấu hình mong muốn       | Nguồn chính                                | Chỉ nhận phần tài khoản được giao               |
| Máy sở hữu tài khoản, cấu hình máy và lịch Smart mong muốn | Nguồn chính                                | Báo khả năng, trạng thái và revision đã áp dụng |
| Tiến trình bot, browser, đăng nhập, cookie/session         | Không chạy                                 | Nguồn chính trên máy đang sở hữu tài khoản      |
| Tiến độ Smart và reservation query                         | Quan sát/tổng hợp                          | Nguồn chính cho phần tài khoản được giao        |
| Nhật ký sự kiện thực thi                                   | Lưu bản tổng hợp, chống trùng khi nhận lại | Journal bền vững, gửi lại sau khi nối mạng      |
| Provisioning SSH, gán/chuyển máy                           | Thực hiện và lưu operation bền vững        | Xác nhận thu hồi, checkpoint và nhận quyền      |

Worker chỉ chạy snapshot đã xác thực và áp dụng. Tài khoản không tự chuyển sang máy khác khi Worker offline. Một lần chuyển máy phải checkpoint session/progress và được hai phía xác nhận; nếu thất bại thì giữ trạng thái chờ/hold để xử lý.

Manager tắt không dừng lịch đã được Worker chấp nhận. Khi Manager hoạt động lại, Worker đồng bộ event journal; mã sự kiện/cursor ngăn lịch sử hoặc điểm bị cộng lặp. Thay đổi trên Manager ở trạng thái **Chờ đồng bộ** cho đến khi Worker xác nhận đúng revision. Chỉ revision đã được xác nhận mới là **Đã áp dụng**.

## 3. Các tiến trình và nơi lưu dữ liệu

| Thành phần  | Mặc định       | Lưu gì                                                                    |
| ----------- | -------------- | ------------------------------------------------------------------------- |
| Dashboard   | 127.0.0.1:8890 | Giao diện; lịch sử dashboard ở thư mục dữ liệu Manager                    |
| Manager API | 127.0.0.1:3012 | Fleet, account config, desired state, assignment, operation, event cursor |
| Worker API  | 127.0.0.1:3010 | Trạng thái Worker và endpoint nội bộ đã xác thực                          |

Đường dẫn Linux mặc định:

- Manager code: ~/.local/lib/msrw-manager/releases/; current trỏ tới bản đang chạy.
- Manager config: ~/.local/share/msrw-manager/manager.env; dữ liệu điều phối ở control/, lịch sử dashboard ở dashboard/.
- Worker code: ~/.local/lib/msrw-worker/releases/; current trỏ tới bản đang chạy.
- Worker machine config/token: ~/.local/share/msrw-worker/worker.env.
- Worker data: config.json, smart-schedule.json, journal/node.sqlite, sessions/sessions.db, learning/ và diagnostics/ bên trong data directory.

Đường dẫn đã nâng cấp hoặc Windows/Sandbox có thể khác. Khi bảo trì hãy kiểm tra đường dẫn thực tế mà service đang dùng; không giả định đường dẫn mặc định và không xóa data để sửa lỗi kết nối.

## 4. Luồng một phiên Smart

1. Manager gửi danh sách tài khoản được giao, cấu hình bot, profile Smart, revision và giới hạn Worker trong snapshot có generation tăng đơn điệu.
2. Worker kiểm tra giao thức, authority, generation và schema; lưu cấu hình nhận được rồi báo ACK/trạng thái.
3. Smart Scheduler tại Worker tạo các job hợp lệ từ tiến độ hiện có. Nó không nhận lệnh từ scheduler legacy trong dashboard.
4. ProcessManager chạy bot trong tiến trình con, chỉ với môi trường của tài khoản đó. Bot đăng nhập bằng session đã lưu, kiểm tra Rewards/quota, thực hiện task và search trong execution plan.
5. Kết quả, checkpoint và journal được ghi tại Worker. Manager nhận event khi có kết nối và gộp vào lịch sử.

### Giới hạn hiện có

maxParallel là trần job đồng thời trên **một Worker**; số job thực tế còn phụ thuộc capacity được Manager gửi, tài khoản đủ điều kiện, proxy/network lock, lịch nghỉ, quiet hours, task pending và job đang chạy. Một job có thể tạo nhiều tiến trình Chromium. Vì vậy “2 luồng” không đồng nghĩa chỉ có hai tiến trình hệ điều hành.

Rewards dùng chính sách normalPolicy trong Smart. Mặc định hiện ghi nhận tối đa 4 phiên/24 giờ trượt cho mỗi tài khoản, nghỉ ít nhất 90 phút giữa phiên, tối đa 5 query và 4 task trong một phiên; cấu hình chỉ được siết chặt hơn. Giới hạn search 30 desktop/20 mobile thuộc giai đoạn warmup acc mới, không phải quota Rewards hàng ngày. Trần query Rewards theo ngày chưa được xác lập trong cấu hình thu thập; không suy ra nó từ điểm hoặc giới hạn mỗi phiên.

Đây hiện là scheduler theo luật và guardrails. Telemetry learning giúp đánh giá tải và chất lượng dữ liệu; không có mô hình AI được phép tự chọn luồng, tài khoản, thời gian nghỉ hay số query trong production.

## 5. Khóa tài khoản và mở thủ công

Desktop, Mobile và Android thủ công chỉ giữ đúng tài khoản đang mở. Nếu chính tài khoản đó đang chạy, thao tác chờ nó dừng/checkpoint; tài khoản khác vẫn có thể chạy kể cả dùng chung proxy. Khóa thao tác thủ công là khóa theo tài khoản; lịch tự động vẫn dùng các network/proxy lock hiện hành.

Nếu tài khoản thuộc Worker từ xa, Manager tạm chuyển session/progress sang Worker local có capability phù hợp. Khi browser đóng và session được lưu xác nhận, hoặc thiết bị Android được dừng, quyền chạy trả lại máy ban đầu. Viewer Android đóng không đồng nghĩa thiết bị đã tắt. Lỗi checkpoint/không xác định giữ account hold; không tự timeout để mở khóa.

Worker Linux local mới hỗ trợ browser có giao diện. Android là capability tùy chọn cần Damru/bridge được cài riêng trên Worker local; Manager không nói chuyện trực tiếp với Damru. Cookie browser và phiên đăng nhập ứng dụng Android là hai dữ liệu riêng.

## 6. Chế độ acc Outlook/Hotmail mới

newAccountMode là tùy chọn theo từng tài khoản. Acc bật chế độ này chạy pha trước Rewards trong 168 giờ tính từ checkpoint đăng nhập/search hợp lệ đầu tiên. Worker dùng browser/session/proxy thường lệ, ghé các dịch vụ Microsoft đã hỗ trợ và có thể search Bing theo budget warmup. Trong pha này không vào luồng Rewards và query không được ghi nhận thành điểm Rewards.

Mốc bắt đầu, kết thúc, query reservation và xác nhận dịch vụ nằm trong planner/checkpoint để giữ qua restart và chuyển Worker. Thiếu marker không được suy luận từ log cũ đã bị pruning. Khi hết hạn, Rewards quota được đọc lại từ trang; query warmup không được tính là quota Rewards đã làm. Chỉ nhập/bật trên Worker có capability preRewardsV1.

## 7. Nền tảng triển khai

| Nơi chạy               | Cách cài/vận hành                                  | Ghi chú                                                  |
| ---------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Manager Linux          | Gói Manager; systemd user services                 | Không cài Chromium/Patchright/bot runtime                |
| Worker local Linux     | Gói Worker kind local; systemd user service        | Có thể dùng GUI; Android cần Damru riêng                 |
| Worker VPS Linux       | Gói Worker kind remote; systemd system service     | Chạy bằng tài khoản thường; SSH tunnel từ Manager        |
| Windows 10/Server 2016 | Cài đặt native/watchdog riêng theo Windows runbook | Không dùng installer systemd hoặc provisioning SSH Linux |
| Docker cloud Sandbox   | Container + gateway/tunnel theo Sandbox runbook    | Không có systemd; không dùng provisioning Linux mặc định |

Manager/Worker mới cần Node.js 24 trở lên. Provisioning SSH Linux hiện hỗ trợ Ubuntu 24.04 hoặc Debian 13 x86_64; các triển khai Windows/Sandbox đang có cơ chế riêng, không suy ra từ hỗ trợ Linux.

## 8. Dữ liệu học scheduler

Learning collection ghi telemetry tách khỏi journal sự kiện nghiệp vụ. Dữ liệu pseudonymous không gồm email, mật khẩu, URL proxy, query text hay browser payload. Thu thập không thay đổi lịch mặc định. Chia ngày thu thập/holdout và quality gate phải đạt; thiếu cap ngày cho search sẽ khóa thử nghiệm liên quan. Xem quy trình tại scripts/learning/README.md. Không dùng ngày thu thập đơn thuần làm bằng chứng rằng mô hình đã sẵn sàng.

## 9. Khi cần xử lý sự cố

1. Xem trạng thái Manager, Worker online/offline, revision, pending, Smart enabled và job đang chạy.
2. Nếu Manager báo **Chờ đồng bộ**, kiểm tra tunnel/API và worker ACK; đừng coi nó đã áp dụng.
3. Nếu Worker offline, không gán lại tài khoản chỉ để làm dashboard hết cảnh báo.
4. Nếu tiến độ cũ hoặc service vừa crash, tạo consistent backup khi Worker dừng, giữ identity/session/journal/cursors, rồi phục hồi có kiểm chứng. Không thay cả data directory bằng thư mục trống.
5. Nếu thao tác thủ công đang hold, xác nhận browser/device đã tắt và checkpoint đã hoàn tất trước khi trả ownership.

Runbook theo nền tảng: scripts/worker/README.md, scripts/worker/windows/README.md, scripts/worker/sandbox-cloud/README.md và SMART_MODE_VI.md.
