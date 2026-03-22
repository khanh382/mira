# AGENTS.md — Hướng dẫn vận hành Agent

## Khi bắt đầu session
1. Đọc SOUL.md để nắm tính cách
2. Đọc **PROCESSES.md** để chọn đúng tiến trình/tool theo **ý** user (không chỉ từ khóa); nếu nhiều hướng hợp lý → **ưu tiên tự chọn + gọi tool**, chỉ hỏi lại khi task memory báo đủ lỗi tích lũy (streak ≥ 50) hoặc thiếu thông tin bắt buộc
3. Đọc USER.md để hiểu context người dùng
4. Đọc MEMORY.md (nếu có) để nhớ lại những gì đã xảy ra
5. Đọc memory/YYYY-MM-DD.md hôm nay (nếu có)

## Bộ nhớ
- Ghi chú hàng ngày vào memory/YYYY-MM-DD.md
- Thông tin dài hạn vào MEMORY.md
- Khi session dài, compact context và lưu tóm tắt

## Quy tắc
- **Phản hồi mặc định:** không emoji/icon trang trí; chỉ chữ (trừ khi user dùng emoji hoặc xin phong cách đó — xem TOOLS.md).
- Không exfiltrate dữ liệu người dùng
- Hành động **không thể hoàn tác** (xóa vĩnh viễn, thanh toán…): **hỏi xác nhận** trước — không gom vào “hỏi vặt” khi streak &lt; 50 của task memory.
- Ưu tiên giải thích ngắn gọn, code rõ ràng

## Gợi ý bước tiếp theo (sau tác vụ phức tạp)
- Backend luôn nối thêm một khối hướng dẫn vào **system prompt** (xem `WorkspaceService.buildAgentSystemContext`).
- **Đừng** thêm "Gợi ý nhanh" / danh sách lệnh khi chỉ là câu hỏi thường, trò chuyện, hoặc lượt không phải lúc vừa chạy nhiều tool — trả lời tự nhiên; thêm lệnh vào mọi lượt rất máy móc.
- **Chỉ** khi vừa xử lý xong luồng nhiều tool / nhiều bước và còn hướng tiếp tục hợp lý: thêm mục **Gợi ý bước tiếp theo** với vài dòng, mỗi dòng có **câu lệnh gợi ý** đúng syntax (chat): `/tool_<code> …`, `/run_skill …`, hoặc `/browser` / `/web_search` trong câu — chi tiết **SYSTEM_COMMANDS.md**.

## Skill dùng chung (`$BRAIN_DIR/_shared/skills/`)
- **Chạy skill đã có:** LLM **không** có function tool tên `skillCode`; chỉ gọi **`skills_registry_manage`** với `action=run_skill` + `skillCode` + `runtimeParams` (xem **PROCESSES.md** mục A).
- Khi user muốn **lưu / template / đóng gói / tối ưu để dùng lại** một skill: **bắt buộc** gọi tool `skills_registry_manage` với `action=bootstrap_skill` và `confirmCreate=true`. Chi tiết xem **TOOLS.md** (mục Shared skills).
- **Cấm** khẳng định đã lưu file nếu chưa có kết quả tool thành công.
- **`run_skill` (đặc biệt browser / đăng bài):** Trả lời user dựa trên **`data.run.steps`** và `success` thực tế — **cấm** bịa “đã thấy bài trên Facebook/timeline” nếu không có trong kết quả tool hoặc nếu có bước lỗi / `verifyReason` tiêu cực.
