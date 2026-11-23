# Thử nghiệm xếp lịch Smart bằng Gradient Boosting và CP-SAT

Thử nghiệm chạy offline trên LearningStore. Gradient Boosting dự báo P50 cho tải theo giờ và P80 cho thời gian dự trù trước hạn. CP-SAT xếp phần việc còn lại mỗi giờ. Replay dùng thời điểm đủ điều kiện đã ghi nhận, khóa proxy, giới hạn song song và thời lượng thực tế để kiểm tra lịch.

## Chạy lại benchmark

Từ thư mục gốc repo, tạo virtualenv Python và cài `experiments/smart-duration/requirements.txt`. Dùng bản sao LearningStore hoặc truyền đường dẫn SQLite chỉ đọc. Chọn `--before-day` theo giờ Việt Nam. Script giữ bốn ngày gần nhất trước mốc này làm tập test.

```bash
python experiments/smart-duration/evaluate.py \
  --database /path/to/learning.sqlite --before-day 2026-11-24 \
  --output /tmp/duration-metrics.json --replay-input /tmp/duration-replay.json
node experiments/smart-duration/replay.mjs /tmp/duration-replay.json /tmp/duration-baseline.json
python experiments/smart-duration/replay_cp_sat.py \
  /tmp/duration-replay.json /tmp/duration-baseline.json /tmp/duration-cpsat.json \
  --rolling --rescue --smooth --pace --seconds .35
```

Giữ tệp replay ở máy phân tích. Tệp này chứa lịch sử phiên đã thay định danh nội bộ và không thuộc gói phát hành. Có thể thấy chênh lệch nhỏ giữa các lần chạy vì solver dùng nhiều luồng và giới hạn thời gian.

## Kết quả và giới hạn

Trên Win10 và Win2019, bốn ngày 20–23/11/2026, bản thử giữ 235 task và 1.200 lượt search của lịch đối chứng. Tải 06:00–09:00 giảm 4,2% và đỉnh tải trung bình ngày tăng 5,6%. Replay đã dùng danh sách phiên lịch sử nên kết quả chỉ áp dụng cho tập phiên đó.

Bộ tối ưu nằm trong thư mục thử nghiệm và chưa được Manager hay Worker gọi. Triển khai cần dự báo các phiên tương lai từ trạng thái thật, truyền kế hoạch có hạn dùng, đối chiếu khóa tại dispatch và chuyển về lịch hiện hành nếu kế hoạch hết hạn hoặc solver không có kết quả.
