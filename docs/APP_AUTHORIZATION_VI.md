# Ba tác vụ ứng dụng cùng báo Needs attention

`readToEarn`, `dailyCheckIn`, `appPromotions` dùng chung quyền OAuth của ứng dụng Bing/Rewards. Session web Rewards hợp lệ không chứng minh đã có quyền ứng dụng. Vì vậy search/Daily Set có thể vẫn chạy trong khi cả ba mục này lỗi.

## Chẩn đoán đã xác minh

Ngày 12/11/2026, log Win10 các ngày 10–11/11 cho thấy nhiều lượt OAuth kết thúc ở `login.live.com/oauth20_authorize.srf` mà không có code. Những lượt lấy được token vẫn hoàn thành Read to Earn và Daily Check-In. Kiểm tra trực tiếp acc 13/mobile và acc 10/mobile + desktop thấy trang **Get a code to sign in**, nút **Send code**. Acc 10 không có mật khẩu cấu hình. Đây là yêu cầu xác thực bổ sung, không phải bằng chứng tài khoản bị khóa hay lỗi parser điểm.

## Hành vi của bản sửa

- `MobileAccessLogin` nhận diện yêu cầu mã, mật khẩu, account review và OAuth access denied. Khi thấy bước cần người dùng, đóng riêng tab OAuth ngay; không tự gửi mã, thử mật khẩu hay chờ redirect vô ích.
- Log ổn định: `[LOGIN-APP] App authorization needs user action | reason=email-code-required` (hoặc `password-required`, `account-review`, `access-denied`). Không ghi mã, token, địa chỉ nhận mã hoặc nội dung trang.
- Smart lưu `state.accounts[index].appAuthorization`, giữ nguyên dữ liệu điểm/session; các tác vụ ứng dụng chưa xong ngừng retry trong ngày. Web/search và các tài khoản khác vẫn dùng quy tắc hiện có. Retry chủ động hoặc ngày mới cho phép thử lại; lỗi mạng/OAuth chưa rõ nguyên nhân vẫn theo retry thông thường.
- Dashboard giải thích nguyên nhân trong chi tiết tài khoản. Nhận được token sẽ xóa cảnh báo xác thực; chỉ marker hoàn thành tác vụ mới xác nhận nhiệm vụ xong.

## Hoàn tất xác thực

1. Mở **Mobile** thủ công của đúng acc từ dashboard; chờ riêng acc đó nếu nó đang chạy. Giữ nguyên proxy/session được chuyển về.
2. Trong chính cửa sổ đó, mở URL cấp quyền dưới đây. Không mở URL ở trình duyệt cá nhân ngoài tool.
3. Nếu Microsoft yêu cầu mã, tự nhận và nhập mã. Nếu hiện account review, hoàn tất bước Microsoft yêu cầu. Việc này không thể được xác nhận chỉ bằng việc trang Rewards mở được.
4. Khi đến `login.live.com/oauth20_desktop.srf`, đóng cửa sổ bằng luồng lưu session của tool, chờ trả session về Worker rồi **Retry** acc. Xác nhận log có `Mobile access token received`, sau đó kiểm tra marker từng tác vụ.

```text
https://login.live.com/oauth20_authorize.srf?response_type=code&client_id=0000000040170455&redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf&scope=service%3A%3Aprod.rewardsplatform.microsoft.com%3A%3AMBI_SSL
```

Không chia sẻ URL kết quả có `code`, token hoặc session. Không xóa database/session hay đánh dấu hoàn thành thủ công để xóa cảnh báo. Microsoft có thể yêu cầu xác thực lại; bản sửa giúp nhận diện và dừng retry không có ích, không bảo đảm loại bỏ yêu cầu phía Microsoft.

## Mã và kiểm tra

- Runtime: `src/browser/auth/methods/MobileAccessLogin.ts`.
- Smart: `scripts/api/appAuthorization.js`, tích hợp ở log listener và kết thúc lượt chạy của `scripts/api/smartScheduler.js`.
- UI: `rewards-dashboard/public/views/smart.js` trong repo Manager.
- Kiểm thử: `scripts/api/appAuthorization.test.js`, nhóm OAuth trong `mobileAuthorization.test.js`; browser UI với `SMART_QA_FOCUS=app-auth`.

Trạng thái source và runtime phải kiểm tra riêng khi triển khai. Không thay toàn bộ scheduler trên máy đang chạy chỉ để áp dụng bản sửa này; giữ chính sách đang vận hành, sao lưu và chỉ vá các điểm tích hợp cần thiết.
