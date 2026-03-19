# HEARTBEAT.md
#
# Định nghĩa các tác vụ tự động (heartbeat) chạy định kỳ.
# Service sẽ đọc file này mỗi 5 phút và tự tạo/cập nhật scheduled tasks.
#
# Format: Mỗi ## heading = 1 task. Các trường:
#   - cron:     Biểu thức cron (bắt buộc)
#   - prompt:   Lệnh cho agent thực thi (bắt buộc)
#   - skills:   Danh sách skills được phép dùng (tùy chọn, phẩy phân cách)
#   - retries:  Số lần thử lại khi lỗi (mặc định: 3)
#   - tier:     Giới hạn model tier: cheap / skill / processor / expert (tùy chọn)
#   - timeout:  Timeout mỗi lần chạy, ms (mặc định: 120000)
#
# Ví dụ:
#
# ## Kiểm tra email mới
# - cron: 0 */1 * * *
# - prompt: Kiểm tra Gmail, nếu có email quan trọng thì tóm tắt và thông báo qua Telegram
# - skills: google_workspace, message_send
# - retries: 3
# - tier: skill
#
# ## Báo cáo hàng ngày
# - cron: 0 7 * * *
# - prompt: Tạo báo cáo tổng hợp email + calendar hôm nay, ghi vào Google Sheet "Daily Report"
# - skills: google_workspace
# - retries: 2
# - tier: skill
# - timeout: 180000
#
# Để trống file này (hoặc chỉ có comments) để bỏ qua heartbeat.
