-- =============================================================================
-- Seed: skills_registry — Built-in skills của hệ thống
-- Chạy một lần sau khi migration đã được áp dụng.
-- Dùng ON CONFLICT DO UPDATE để chạy lại an toàn.
--
-- is_display = true  → hiển thị trong catalog, dùng được làm skill_code cho task_steps
-- is_display = false → skill nội bộ/hệ thống (vẫn chạy được, chỉ ẩn khỏi danh sách gợi ý)
-- =============================================================================

INSERT INTO skills_registry
  (skill_code, skill_name, display_name, description, file_path,
   category, min_model_tier, owner_only, is_active, skill_type, is_display)
VALUES

-- ─── WEB ──────────────────────────────────────────────────────────────────────
(
  'web_search',
  'Web Search',
  'Tìm kiếm web',
  'Tìm kiếm thông tin trên internet qua Brave Search hoặc Perplexity. Trả về danh sách kết quả (tiêu đề, URL, đoạn trích). Dùng khi cần thông tin mới nhất, tin tức, giá cả hoặc bất kỳ dữ liệu thời gian thực nào.',
  'src/agent/skills/built-in/web/web-search.skill.ts',
  'web', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: tìm kiếm thông tin đầu vào
),
(
  'web_fetch',
  'Web Fetch',
  'Đọc nội dung trang web',
  'Tải và trích xuất nội dung có thể đọc từ một URL (markdown/text sạch). Dùng để đọc bài viết, tài liệu, trang web cụ thể khi đã biết URL.',
  'src/agent/skills/built-in/web/web-fetch.skill.ts',
  'web', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: thu thập nội dung từ URL
),
(
  'http_request',
  'HTTP Request',
  'Gọi REST API',
  'Gửi HTTP request (GET/POST/PUT/PATCH/DELETE) đến REST API và trả về kết quả. Tự động gắn token xác thực theo domain từ bảng http_tokens. Dùng cho WordPress API, webhook, và các REST API khác.',
  'src/agent/skills/built-in/web/http-request.skill.ts',
  'web', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: gọi API ngoài (WordPress, webhook, CRM…)
),

-- ─── BROWSER ──────────────────────────────────────────────────────────────────
(
  'browser',
  'Browser Automation',
  'Tự động hóa trình duyệt',
  'Điều khiển trình duyệt không giao diện (headless Playwright): điều hướng URL, click, nhập liệu, chụp ảnh màn hình, đọc HTML, chạy JavaScript. Hỗ trợ cookie và mobile emulation. Dùng để tự động hóa tác vụ web cần tương tác thật.',
  'src/agent/skills/built-in/browser/browser.skill.ts',
  'browser', 'skill', true, true, 'built_in',
  true   -- ✅ workflow: đăng bài, đăng nhập, scrape trang cần JS
),
(
  'browser_debug_cleanup',
  'Browser Debug Cleanup',
  'Dọn file debug trình duyệt',
  'Xóa file nháp và debug của browser (HTML snapshot, ảnh chụp màn hình, skill_draft) trong thư mục $BRAIN_DIR/<identifier>/browser_debug. Dùng sau khi đã xong việc để giải phóng dung lượng.',
  'src/agent/skills/built-in/browser/browser-debug-cleanup.skill.ts',
  'browser', 'cheap', true, true, 'built_in',
  false  -- ❌ ẩn: công cụ bảo trì nội bộ, không phải bước xử lý tự động
),

-- ─── GOOGLE ───────────────────────────────────────────────────────────────────
(
  'google_workspace',
  'Google Workspace',
  'Google Workspace (Drive/Sheets/Gmail…)',
  'Tích hợp toàn diện Google Workspace: Gmail (đọc/gửi), Google Drive (tạo/tải/xóa file), Google Sheets (đọc/ghi dữ liệu), Google Docs, Google Calendar. Yêu cầu xác thực OAuth2 qua google_auth_setup.',
  'src/agent/skills/built-in/google/google-workspace.skill.ts',
  'google', 'skill', false, true, 'built_in',
  true   -- ✅ workflow: đọc/ghi Sheets, gửi Gmail, lưu Drive
),
(
  'google_auth_setup',
  'Google Auth Setup',
  'Kết nối Google (xác thực OAuth2)',
  'Thiết lập và quản lý xác thực OAuth2 với Google. Bước đầu tiên bắt buộc để dùng google_workspace. Tạo URL xác thực, lưu token, kiểm tra trạng thái kết nối.',
  'src/agent/skills/built-in/google/google-auth-setup.skill.ts',
  'google', 'skill', false, true, 'built_in',
  false  -- ❌ ẩn: bước setup một lần, không phải bước trong workflow tự động
),

-- ─── MEDIA ────────────────────────────────────────────────────────────────────
(
  'image_understand',
  'Image Understanding',
  'Phân tích hình ảnh (Vision AI)',
  'Phân tích và mô tả nội dung hình ảnh sử dụng mô hình Vision AI. Nhận dạng văn bản trong ảnh (OCR), mô tả cảnh vật, phân tích biểu đồ. Yêu cầu model hỗ trợ vision.',
  'src/agent/skills/built-in/media/image-understand.skill.ts',
  'media', 'skill', false, true, 'built_in',
  true   -- ✅ workflow: trích xuất text từ ảnh, phân tích screenshot
),
(
  'pdf_read',
  'PDF Reader',
  'Đọc file PDF',
  'Đọc và trích xuất nội dung văn bản từ file PDF trên server. Trả về text thuần có thể xử lý tiếp. Hỗ trợ giới hạn số trang và ký tự trả về.',
  'src/agent/skills/built-in/media/pdf-read.skill.ts',
  'media', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: đọc báo cáo, hợp đồng, tài liệu PDF
),
(
  'tts',
  'Text to Speech',
  'Chuyển văn bản thành giọng nói',
  'Chuyển đổi văn bản thành file âm thanh (Text-to-Speech). Hỗ trợ nhiều ngôn ngữ và giọng đọc. Lưu file audio vào workspace của user.',
  'src/agent/skills/built-in/media/tts.skill.ts',
  'media', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: tạo audio từ nội dung (podcast, thông báo tự động)
),

-- ─── MEMORY ───────────────────────────────────────────────────────────────────
(
  'memory_write',
  'Memory Write',
  'Ghi ghi chú / bộ nhớ',
  'Ghi hoặc nối thêm nội dung vào các file bộ nhớ trong workspace (MEMORY.md, NOTES.md, v.v.) hoặc các file chia sẻ trong _shared/. Dùng để lưu kết quả trung gian, ghi chú quan trọng giữa các bước workflow.',
  'src/agent/skills/built-in/memory/memory-write.skill.ts',
  'memory', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: lưu kết quả bước trước để bước sau sử dụng
),
(
  'memory_get',
  'Memory Get',
  'Đọc ghi chú / bộ nhớ',
  'Đọc nội dung file bộ nhớ cụ thể (MEMORY.md, NOTES.md, v.v.) từ workspace của user. Dùng để đọc lại thông tin đã lưu từ bước trước trong workflow.',
  'src/agent/skills/built-in/memory/memory-get.skill.ts',
  'memory', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: lấy dữ liệu trung gian giữa các task step
),
(
  'memory_search',
  'Memory Search',
  'Tìm kiếm trong bộ nhớ (semantic)',
  'Tìm kiếm ngữ nghĩa (vector search) trong lịch sử hội thoại và bộ nhớ đã được vector hóa. Trả về các đoạn liên quan nhất theo độ tương đồng ý nghĩa.',
  'src/agent/skills/built-in/memory/memory-search.skill.ts',
  'memory', 'cheap', false, true, 'built_in',
  true   -- ✅ workflow: tra cứu ngữ nghĩa trước khi xử lý
),
(
  'task_memory',
  'Task Memory',
  'Bộ nhớ tác vụ (task context)',
  'Quản lý bộ nhớ ngắn hạn cho tác vụ đang thực hiện: lưu tiến trình, kết quả từng bước, trạng thái. Giúp agent duy trì context qua nhiều lượt hội thoại trong cùng một tác vụ.',
  'src/agent/skills/built-in/memory/task-memory.skill.ts',
  'memory', 'cheap', false, true, 'built_in',
  false  -- ❌ ẩn: quản lý context nội bộ, pipeline tự gọi khi cần
),

-- ─── MESSAGING ────────────────────────────────────────────────────────────────
(
  'message_send',
  'Message Send',
  'Gửi tin nhắn / thông báo',
  'Gửi tin nhắn chủ động đến user qua các kênh đã kết nối (Telegram, Discord, Zalo, v.v.). Dùng để thông báo kết quả, nhắc nhở hoặc gửi báo cáo tự động sau khi workflow hoàn thành.',
  'src/agent/skills/built-in/messaging/message-send.skill.ts',
  'messaging', 'skill', false, true, 'built_in',
  true   -- ✅ workflow: gửi thông báo kết quả (bước cuối pipeline)
),
(
  'bot_access_manage',
  'Bot Access Manager',
  'Quản lý quyền truy cập bot',
  'Cấp hoặc thu hồi quyền truy cập bot cho người dùng trên các nền tảng (Telegram, Discord, v.v.). Quản lý danh sách bot_access_grants và mã xác minh.',
  'src/agent/skills/built-in/messaging/bot-access-manage.skill.ts',
  'messaging', 'skill', false, true, 'built_in',
  false  -- ❌ ẩn: admin tool quản lý quyền, không phải bước automation
),

-- ─── SESSIONS ─────────────────────────────────────────────────────────────────
(
  'threads_list',
  'Sessions List',
  'Danh sách phiên chat',
  'Liệt kê các phiên hội thoại (thread) của user: tiêu đề, nền tảng, thời gian tạo, trạng thái.',
  'src/agent/skills/built-in/sessions/sessions-list.skill.ts',
  'sessions', 'cheap', false, true, 'built_in',
  false  -- ❌ ẩn: quản lý session nội bộ, không liên quan automation
),
(
  'thread_history',
  'Thread History',
  'Lịch sử hội thoại',
  'Đọc lịch sử tin nhắn trong một phiên hội thoại cụ thể. Trả về các tin nhắn theo thứ tự thời gian.',
  'src/agent/skills/built-in/sessions/sessions-history.skill.ts',
  'sessions', 'cheap', false, true, 'built_in',
  false  -- ❌ ẩn: tra cứu session nội bộ, không phải bước xử lý dữ liệu
),

-- ─── FILESYSTEM ───────────────────────────────────────────────────────────────
(
  'file_read',
  'File Read',
  'Đọc file trên server',
  'Đọc nội dung file text/JSON từ filesystem theo đường dẫn tuyệt đối. Có kiểm soát quyền truy cập theo vai trò.',
  'src/agent/skills/built-in/filesystem/file-read.skill.ts',
  'filesystem', 'cheap', false, true, 'built_in',
  false  -- ❌ ẩn: truy cập filesystem nội bộ, dễ bị lạm dụng nếu expose làm task step
),

-- ─── RUNTIME ──────────────────────────────────────────────────────────────────
(
  'exec',
  'Execute Command',
  'Chạy lệnh shell',
  'Chạy lệnh shell và trả về output. Chỉ dành cho owner. Sandbox nghiêm ngặt: chỉ cho phép binary được cấu hình (mặc định: git), workdir trong thư mục skills.',
  'src/agent/skills/built-in/runtime/exec.skill.ts',
  'runtime', 'skill', true, true, 'built_in',
  false  -- ❌ ẩn: nguy hiểm nếu expose, chỉ dùng qua skill package (skills_registry_manage)
),
(
  'cron_manage',
  'Cron Job Manager',
  'Quản lý lịch tác vụ cũ (legacy)',
  'Tạo, xem, tạm dừng và xóa các scheduled_tasks legacy. Đã được thay thế bởi hệ thống cron_jobs mới qua API /cron-jobs.',
  'src/agent/skills/built-in/runtime/cron-manage.skill.ts',
  'runtime', 'skill', true, true, 'built_in',
  false  -- ❌ ẩn: legacy, thay thế bởi /cron-jobs API
),
(
  'skills_registry_manage',
  'Skills Registry Manager',
  'Quản lý skill package',
  'Tạo, chạy, cập nhật và xóa các skill package trong $BRAIN_DIR/_shared/skills/. Hỗ trợ bootstrap skill mới từ mô tả tự nhiên và chạy skill đã có. Chỉ dành cho owner.',
  'src/agent/skills/built-in/runtime/skills-registry-manage.skill.ts',
  'runtime', 'skill', true, true, 'built_in',
  false  -- ❌ ẩn: công cụ phát triển/quản lý skill, không phải bước trong workflow
)

ON CONFLICT (skill_code) DO UPDATE SET
  skill_name    = EXCLUDED.skill_name,
  display_name  = EXCLUDED.display_name,
  description   = EXCLUDED.description,
  file_path     = EXCLUDED.file_path,
  category      = EXCLUDED.category,
  min_model_tier= EXCLUDED.min_model_tier,
  owner_only    = EXCLUDED.owner_only,
  is_active     = EXCLUDED.is_active,
  skill_type    = EXCLUDED.skill_type,
  is_display    = EXCLUDED.is_display,
  updated_at    = NOW();
