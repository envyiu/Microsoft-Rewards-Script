# Microsoft Rewards tool

Đây là repo **Worker**: runtime đăng nhập và chạy các phiên được giao. Với bộ cài hiện hành, hãy bắt đầu ở [hướng dẫn Manager](../rewards-dashboard/manager/README.md), không chạy bot từ repo như một dashboard.

## Hệ thống gồm những gì?

```text
Manager + dashboard (repo rewards-dashboard)
  ├─ tài khoản gốc, proxy, cấu hình mong muốn, phân công máy
  ├─ lịch sử tổng hợp và các lệnh quản lý
  └─ kết nối Worker đã cài qua API loopback/SSH
             │ snapshot có revision, ACK và journal đồng bộ ngược
             ▼
Worker (repo này, cài riêng trên từng máy chạy)
  ├─ Smart Scheduler và tiến trình bot
  ├─ browser, proxy, session, tiến độ và nhật ký bền vững
  └─ chỉ chạy các tài khoản đã được Manager giao
```

Manager không mở browser hay chạy bot. Worker không phải nơi quản lý danh sách tài khoản. Nếu Manager tắt hoặc mất kết nối, Worker tiếp tục lịch cuối cùng đã nhận và gửi sự kiện bù khi kết nối lại. Worker offline không tự làm phát sinh chuyển máy.

## Bắt đầu theo mục đích

- **Cài dashboard và API quản lý:** [Manager README](../rewards-dashboard/manager/README.md).
- **Cài một máy Worker Linux:** [Worker quick start](scripts/worker/README.md).
- **Hiểu Smart Mode, số luồng, giới hạn và lịch:** [Cơ chế Smart Mode](docs/SMART_MODE_VI.md).
- **Cài/vận hành Windows:** [Windows Worker runbook](scripts/worker/windows/README.md).
- **Vận hành Docker Sandbox:** [Sandbox runbook](scripts/worker/sandbox-cloud/README.md).
- **Chuẩn bị dữ liệu học scheduler:** [Learning collection](scripts/learning/README.md). Đây là thu thập/đánh giá dữ liệu, chưa bật AI điều khiển.
- **Tài liệu giao thức nội bộ Manager/Worker:** [Manager architecture](../rewards-dashboard/manager/ARCHITECTURE.md).

## Các repo trong workspace

| Repo                       | Trách nhiệm                                                               |
| -------------------------- | ------------------------------------------------------------------------- |
| `rewards-dashboard`        | Manager API, giao diện dashboard, Fleet và provisioning SSH.              |
| `Microsoft-Rewards-Script` | Worker runtime, Smart Scheduler, browser, session và hợp đồng dùng chung. |
| `damru`                    | Thành phần Android tùy chọn trên Worker local; cài và vận hành riêng.     |

## Mốc kỹ thuật cần nhớ

- Manager API mặc định `127.0.0.1:3012`; dashboard `127.0.0.1:8890`; Worker API `127.0.0.1:3010`.
- API chỉ bind loopback. Máy khác kết nối qua tunnel do Manager thiết lập; không mở Worker API trực tiếp ra Internet.
- Manager là nguồn gốc tài khoản và cấu hình mong muốn. Worker chỉ giữ snapshot tài khoản được giao, session, tiến độ Smart, journal và diagnostics của chính nó.
- `Chờ đồng bộ` nghĩa là Worker chưa xác nhận revision mới. `Đã áp dụng` chỉ hiện sau ACK/trạng thái mới khớp revision.
- Mở Desktop/Mobile/Android thủ công giữ đúng tài khoản đang mở. Chỉ tài khoản đó phải chờ job của chính nó; tài khoản khác có cùng proxy vẫn được lập lịch bình thường.
- Tài liệu Control API cũ, `.env` và cron/Docker legacy được giữ tại [LEGACY_CLI.md](LEGACY_CLI.md). Chỉ dùng chúng khi đang bảo trì hệ thống tương thích cũ hoặc rollback.

## Tài liệu kỹ thuật

Agent skill nằm trong [`.cursor/skills/microsoft-rewards-script/`](.cursor/skills/microsoft-rewards-script/SKILL.md):

- [Kiến trúc runtime](.cursor/skills/microsoft-rewards-script/ARCHITECTURE.md)
- [Vận hành và khắc phục sự cố](.cursor/skills/microsoft-rewards-script/OPERATIONS.md)
- [Phát triển và kiểm tra thay đổi](.cursor/skills/microsoft-rewards-script/DEVELOPMENT.md)
- [Control API cũ và các endpoint tương thích](scripts/api/README.md)

Tổng quan chi tiết và luồng dữ liệu ở [PROJECT_OVERVIEW_VI.md](docs/PROJECT_OVERVIEW_VI.md).

### Search-only warmup for new external-domain accounts

Manager imports of new accounts outside `@hotmail.com`/`@outlook.com` automatically use `NEW_ACCOUNT_MODE=true` and `NEW_ACCOUNT_POLICY=search72h`. Smart performs Bing searches only, with no Rewards or Outlook/OneDrive/To Do/Calendar visits, for 72 hours after the first verified query and saved session. Normal pacing and 30 desktop/20 mobile daily budgets remain unchanged. New Hotmail/Outlook imports use the existing `standard168h` policy; existing accounts and stored deadlines are unchanged. Restart and handoff preserve the timer. Upgrade destination workers to advertise `preRewardsSearch72hV1` before assigning these accounts.
