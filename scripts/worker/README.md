# MSRW Worker

Worker là máy **thực thi** của hệ thống. Nó nhận tài khoản và cấu hình đã được Manager giao, chạy Smart Scheduler cùng bot/browser, rồi lưu session, tiến độ và event journal. Worker không phải dashboard và không tự quản lý tài khoản gốc.

Tài liệu này được đóng cùng gói phát hành Worker. Hướng dẫn cài Manager nằm tại `manager/README.md` trong repo `rewards-dashboard`.

## Cài Worker Linux local

Yêu cầu: Linux có systemd và Node.js 24 trở lên. Worker local chạy dưới tài khoản desktop hiện tại để có thể mở cửa sổ trình duyệt. Bộ cài kiểm tra Chromium và thư viện cần thiết.

```sh
mkdir -p msrw-worker
tar -xzf msrw-worker.tgz -C msrw-worker
cd msrw-worker
bash install.sh --kind local
```

Sau khi cài:

```sh
systemctl --user status msrw-worker
journalctl --user -u msrw-worker -f
```

Cấu hình máy và token riêng nằm ở `~/.local/share/msrw-worker/worker.env`; dữ liệu bền vững nằm trong cùng data directory. Trong Manager mở **Settings → Machines → Connect installed worker**, chọn worker local và địa chỉ `http://127.0.0.1:3010`. Worker mới đăng ký sẽ ở trạng thái tạm dừng, chưa có tài khoản. Giao tài khoản từ Manager, đợi **Đã áp dụng**, rồi mới bật lịch.

## Cài Worker VPS Linux

Cách đơn giản nhất là vào **Settings → Machines → Install worker over SSH** trong Manager. Manager kiểm tra SSH host key, chuyển gói và tạo tunnel loopback. Môi trường provisioning hiện hỗ trợ Ubuntu 24.04 hoặc Debian 13 x86_64, tài khoản thường có sudo không cần hỏi mật khẩu và đăng nhập SSH bằng key.

Có thể tự giải nén gói trên VPS rồi cài:

```sh
bash install.sh --kind remote
sudo systemctl status msrw-worker
sudo journalctl -u msrw-worker -f
```

Sau đó dùng **Connect installed worker → Remote worker over SSH** trong Manager. Worker chỉ bind loopback; Manager đi qua SSH tunnel riêng. Nếu Worker đã có dữ liệu hoặc tài khoản từ hệ thống cũ, dùng quy trình migration trước khi kết nối hoặc giao tài khoản.

## Cấu hình và dữ liệu

Manager là nguồn gốc của email, thông tin tài khoản, proxy, phân công và cấu hình mong muốn. File `worker.env` chỉ có danh tính máy, token API, đường dẫn data và các tùy chọn môi trường. Không nhập một danh sách tài khoản thứ hai trực tiếp lên VPS.

Data directory chứa cấu hình đã nhận, Smart progress, journal, session browser, learning telemetry và diagnostics. Không xóa thư mục này để sửa lỗi worker offline, login, tunnel hoặc trạng thái cũ. Khi cần sao lưu SQLite đang chạy, dùng online backup API; đừng chỉ copy file database chính bỏ qua WAL.

Worker tiếp tục lịch **đã nhận và áp dụng** khi Manager mất kết nối. Những thay đổi mới trên dashboard ở trạng thái **Chờ đồng bộ** cho đến khi Worker xác nhận revision. Worker offline không tự nhường tài khoản cho máy khác.

## Desktop, Mobile và Android thủ công

Mở thủ công chỉ giữ đúng tài khoản đang được yêu cầu. Nếu chính tài khoản đó đang chạy, thao tác chờ job của nó checkpoint xong; tài khoản khác, kể cả dùng chung proxy, vẫn được chạy. Khi tài khoản vốn thuộc VPS, Manager tạm chuyển session/progress sang Worker local rồi trả ownership về máy cũ khi browser đóng và session đã lưu.

Android cần Damru/bridge riêng trên Worker local; cài Worker không tự cài Damru. Trình xem Android đóng chưa chắc đã tắt thiết bị. Chỉ trả ownership sau khi Worker xác nhận thiết bị đã dừng. Lỗi checkpoint hoặc trạng thái không xác định giữ hold để xử lý.

## Nền tảng đặc biệt

- Windows Worker dùng bộ cài native/watchdog riêng; xem `scripts/worker/windows/README.md` trong gói. Installer Linux và nút upgrade SSH của Manager không áp dụng.
- Docker cloud Sandbox dùng container, tunnel, backup và recovery riêng; xem `scripts/worker/sandbox-cloud/README.md`. Máy này không có systemd.
- Tài liệu cơ chế sắp lịch trong repo nguồn là `docs/SMART_MODE_VI.md`.

## Cập nhật và gỡ lỗi

Trước khi thay Worker đang sử dụng, pause lịch từ Manager, đợi job hoàn tất, đóng mọi phiên Desktop/Mobile/Android và xác nhận không còn operation/handoff pending. Tạo backup nhất quán, giữ nguyên data directory và worker identity.

Với Linux local:

```sh
systemctl --user status msrw-worker
systemctl --user restart msrw-worker
journalctl --user -u msrw-worker -n 200 --no-pager
```

Với VPS:

```sh
sudo systemctl status msrw-worker
sudo systemctl restart msrw-worker
sudo journalctl -u msrw-worker -n 200 --no-pager
```

Khi báo lỗi, ghi lại node ID, trạng thái Online/Offline, revision mong muốn/đã áp dụng, thời điểm lỗi và mã lỗi. Không gửi token, mật khẩu, cookie, file session, proxy credentials hay nguyên file diagnostics công khai.

## Tùy chọn bộ cài

`--kind local` tạo user service; `--kind remote` tạo system service chạy dưới tài khoản thường. `--dry-run` chỉ in đường dẫn dự kiến; `--no-start` cài bản mới nhưng không bật service. `--android` bật capability bridge; Damru vẫn cần cài và cấu hình riêng. Đổi thư mục cài/data dùng `--install-dir` và `--data-dir`; dùng đường dẫn tuyệt đối.

## Dựng gói

Tại repo Worker:

```sh
npm ci
npm run build
npm run build:contracts
npm run release:worker
```

Gói phát hành nằm ở `releases/msrw-worker.tgz`. Đây là gói độc lập, không cần checkout repo Manager để cài Worker. Manager cũng được phát hành thành gói riêng.
