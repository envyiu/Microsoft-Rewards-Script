# MSRW Worker

Worker hỗ trợ chế độ acc mới: chưa vào Rewards trong 168 giờ từ buổi đăng nhập/search thành công đầu tiên, ghé OneDrive/To Do/Outlook/Calendar và search Bing theo số query (20 mobile, 30 desktop mỗi ngày). Tiến độ và thời hạn được lưu cùng planner/session khi chuyển máy. Sau hạn, worker tự dùng luồng Rewards và xử lý onboarding lần đầu; không đổi quà hoặc bật auto-redeem. Manager kiểm tra capability `preRewardsV1` trước khi giao các acc này. Giữ các acc mới tạm dừng nếu cần quay lại worker phiên bản cũ.

Worker chỉ chạy tài khoản được Manager giao. Worker không có dashboard quản lý,
không tự thêm tài khoản và không cần bản cài Manager trên cùng máy.

## Cài trên máy cá nhân Linux

Hỗ trợ máy local Ubuntu/Debian và Arch/CachyOS có systemd. Bộ cài dùng
Node.js 24+ sẵn có hoặc cài Node khi thiếu. Chromium được kiểm tra trước;
chỉ dùng sudo để cài thư viện hệ thống khi cần. VPS qua SSH dùng Ubuntu 24.04 x86_64.
Giải nén `msrw-worker.tgz`, đứng trong thư mục đã giải nén:

```bash
bash install.sh --kind local
```

Worker local chạy bằng user của phiên desktop. Các lệnh thường dùng:

```bash
systemctl --user status msrw-worker
systemctl --user restart msrw-worker
journalctl --user -u msrw-worker -f
```

Cấu hình duy nhất: `~/.local/share/msrw-worker/worker.env`. Trong Manager mở
Settings → Machines → Connect installed worker, chọn Local, nhập URL
`http://127.0.0.1:3010` và API token trong file cấu hình worker. Token không
được in tự động vào log hay giao diện trạng thái.

## Cài trên VPS

Cách ưu tiên: từ Manager chọn **Install worker over SSH**. VPS Ubuntu 24.04
x86_64 cần SSH key và passwordless sudo. Manager kiểm tra fingerprint SSH,
gửi cùng gói worker này và cài dịch vụ systemd. Worker mới luôn tạm dừng,
chưa có tài khoản.

Cũng có thể giải nén và cài thủ công:

```bash
bash install.sh --kind remote
sudo systemctl status msrw-worker
```

Sau đó chọn **Connect installed worker → Remote worker over SSH** trên Manager.
Nhập thông tin SSH và token worker; Manager tạo tunnel riêng. Không mở cổng
3010 ra Internet. Worker đã có tài khoản cần được chuyển qua công cụ migration.

## Android và trình duyệt thủ công

Chỉ worker local hỗ trợ tài khoản không proxy và trình duyệt có giao diện.
Damru là thành phần tùy chọn trên máy worker, không nằm trong Manager.
Cài Damru/bridge theo hướng dẫn hiện tại, sau đó đặt
`MRS_ANDROID_ENABLED="true"` và `DAMRU_BRIDGE_SOCKET` trong `worker.env`, rồi
restart worker. `--android` bật khả năng này khi cài mới; nó không tự cài Damru.

Desktop/Mobile/Android chỉ giữ tài khoản được chọn, không giữ cả nhóm proxy.
Chỉ chờ khi chính tài khoản đó đang chạy; các acc khác, kể cả cùng proxy, vẫn
tiếp tục job. Tài khoản VPS được chuyển tạm về local với session hiện tại và
trả về VPS sau khi đóng browser sạch sẽ hoặc tắt thiết bị Android. Android dùng
lại phiên Damru riêng của tài khoản; đóng viewer không đồng nghĩa tắt thiết bị.
Job tự động của tài khoản đang mở thủ công vẫn bị khóa trong thời gian này.

## Dữ liệu và cập nhật

Mã chương trình nằm riêng trong `~/.local/lib/msrw-worker/releases`.
Session, cấu hình đã nhận, tiến độ Smart và journal nằm trong thư mục dữ liệu.
Không chỉnh tài khoản hoặc lịch trực tiếp trên VPS: thực hiện trên Manager.

Worker giữ lịch đã xác nhận khi Manager offline. Nó không tự nhận tài khoản
từ worker khác. Handoff chờ đúng tài khoản được chọn và giữ session/progress.
Thay đổi danh sách tài khoản không ảnh hưởng job khác có thể áp dụng ngay; đổi
cấu hình runtime vẫn cần drain. Chi tiết ở `scripts/api/README.md` trong repo
và trong gói phát hành Worker.
Pause và đợi tác vụ hoàn tất trước khi chạy lại bộ cài để nâng cấp.

Có thể xem trước đường dẫn cài đặt mà không thay đổi hệ thống:

```bash
bash install.sh --kind local --dry-run
```

## Dựng gói từ mã nguồn

```bash
npm ci
npm run build
npm run build:contracts
npm run release:worker
```

Kết quả `releases/msrw-worker.tgz` cài được độc lập, không cần checkout repo
dashboard. Chế độ Control API/Hybrid/cron cũ chỉ dành cho tương thích và rollback;
bộ cài worker mới luôn dùng Smart Scheduler.
