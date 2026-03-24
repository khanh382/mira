# Task Workflows API

Module quản lý **workflow tự động** — tập hợp các task chạy tuần tự với logic xử lý lỗi linh hoạt.
Thiết kế để hỗ trợ frontend drag-and-drop tùy biến quy trình (tương tự n8n).

---

## Xác thực & phân quyền

Tất cả API đều yêu cầu:

- **JWT** hợp lệ — truyền qua cookie `access_token` hoặc header `Authorization: Bearer <token>`
- **Role** — chỉ `owner` và `colleague` được phép; `client` nhận `403 Forbidden`

---

## Cấu trúc response

Mọi response thành công được bọc bởi `ResponseInterceptor`:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": { ... }
}
```

Lỗi trả về dạng:

```json
{
  "statusCode": 400,
  "message": "Mô tả lỗi"
}
```

---

## Data models

### Workflow

| Field           | Type                    | Mô tả                              |
|-----------------|-------------------------|------------------------------------|
| `id`            | `number`                | ID workflow                        |
| `userId`        | `number`                | UID chủ sở hữu                     |
| `name`          | `string`                | Tên workflow                       |
| `description`   | `string \| null`        | Mô tả                              |
| `enabled`       | `boolean`               | Có đang bật hay không              |
| `createdAt`     | `string` (ISO 8601)     | Thời điểm tạo                      |
| `updatedAt`     | `string` (ISO 8601)     | Thời điểm cập nhật cuối            |
| `workflowTasks` | `WorkflowTask[]`        | Danh sách task (đã sắp xếp theo `taskOrder`) |

### WorkflowTask

| Field         | Type             | Mô tả                                                   |
|---------------|------------------|---------------------------------------------------------|
| `id`          | `number`         | **wtId** — dùng để thao tác fine-grained (thêm/sửa/xoá) |
| `workflowId`  | `number`         | Thuộc workflow nào                                      |
| `taskId`      | `number`         | ID task được liên kết                                   |
| `taskOrder`   | `number`         | Thứ tự thực thi (0-based, liên tục)                     |
| `onFailure`   | `OnFailure`      | Hành vi khi task thất bại                               |
| `task`        | `Task` (object)  | Chi tiết task (chỉ có trong `GET :id`, không có `GET /`) |

### OnFailure (enum)

| Giá trị      | Hành vi                                        |
|--------------|------------------------------------------------|
| `"stop"`     | Dừng toàn bộ workflow (mặc định)               |
| `"skip"`     | Bỏ qua task lỗi, tiếp tục task tiếp theo       |
| `"continue"` | Coi như thành công, tiếp tục task tiếp theo    |

### WorkflowRun

| Field              | Type                          | Mô tả                          |
|--------------------|-------------------------------|--------------------------------|
| `id`               | `string` (UUID)               | Run ID                         |
| `workflowId`       | `number`                      | Workflow được chạy             |
| `userId`           | `number`                      | Người trigger                  |
| `status`           | `RunStatus`                   | Trạng thái run                 |
| `trigger`          | `RunTrigger`                  | Nguồn trigger                  |
| `currentTaskOrder` | `number`                      | Task đang thực thi             |
| `error`            | `string \| null`              | Lỗi tổng nếu workflow thất bại |
| `summary`          | `string \| null`              | Tóm tắt kết quả                |
| `context`          | `object \| null`              | Dữ liệu context dùng chung giữa các task |
| `startedAt`        | `string \| null` (ISO 8601)   | Thời điểm bắt đầu              |
| `finishedAt`       | `string \| null` (ISO 8601)   | Thời điểm kết thúc             |
| `createdAt`        | `string` (ISO 8601)           | Thời điểm tạo                  |
| `runTasks`         | `WorkflowRunTask[]`           | Chi tiết từng task (chỉ có trong `GET runs/:runId`) |

### RunStatus (enum)

`"pending"` | `"running"` | `"completed"` | `"failed"` | `"cancelled"`

### RunTrigger (enum)

`"manual"` | `"cron"` | `"chat"`

### WorkflowRunTask

| Field            | Type                    | Mô tả                          |
|------------------|-------------------------|--------------------------------|
| `id`             | `string` (UUID)         | Run-task ID                    |
| `workflowRunId`  | `string` (UUID)         | Thuộc run nào                  |
| `taskId`         | `number`                | Task được thực thi             |
| `taskOrder`      | `number`                | Thứ tự trong run               |
| `taskRunId`      | `string \| null` (UUID) | ID task-run tương ứng (sau khi enqueue) |
| `status`         | `RunTaskStatus`         | Trạng thái bước này            |
| `error`          | `string \| null`        | Lỗi nếu thất bại               |
| `startedAt`      | `string \| null`        | Thời điểm bắt đầu              |
| `finishedAt`     | `string \| null`        | Thời điểm kết thúc             |

### RunTaskStatus (enum)

`"pending"` | `"running"` | `"completed"` | `"failed"` | `"skipped"`

---

## API — Quản lý Workflow

### `POST /task-workflows`

Tạo workflow mới kèm danh sách task ban đầu.

**Request body:**

```json
{
  "name": "Workflow xử lý lead",
  "description": "Gửi email → lưu CRM → thông báo Slack",
  "enabled": true,
  "tasks": [
    { "taskId": 1, "taskOrder": 0, "onFailure": "stop" },
    { "taskId": 2, "taskOrder": 1, "onFailure": "skip" },
    { "taskId": 3, "taskOrder": 2 }
  ]
}
```

| Field              | Bắt buộc | Mô tả                                          |
|--------------------|----------|------------------------------------------------|
| `name`             | ✅       | Tên workflow, không được rỗng                  |
| `description`      | ❌       | Mô tả                                          |
| `enabled`          | ❌       | Mặc định `true`                                |
| `tasks`            | ✅       | Ít nhất 1 task; tất cả phải thuộc tài khoản hiện tại |
| `tasks[].taskId`   | ✅       | ID task (phải thuộc user)                      |
| `tasks[].taskOrder`| ✅       | Thứ tự — tự normalize lại thành 0, 1, 2, ...  |
| `tasks[].onFailure`| ❌       | Mặc định `"stop"`                              |

**Response `200`:** Object `Workflow` đầy đủ kèm `workflowTasks`.

**Lỗi:**

| Code | Trường hợp                                    |
|------|-----------------------------------------------|
| 400  | `name` rỗng, `tasks` rỗng, task không tồn tại hoặc không thuộc user |
| 403  | Không đủ quyền (client hoặc token không hợp lệ) |

---

### `GET /task-workflows`

Lấy danh sách tất cả workflow của user hiện tại.

**Response `200`:** Mảng `Workflow[]` — **không** kèm `task` detail trong `workflowTasks` (chỉ có `taskId`, `taskOrder`, `onFailure`).

---

### `GET /task-workflows/:id`

Lấy chi tiết 1 workflow, kèm đầy đủ thông tin task trong từng bước.

**Params:** `id` — ID workflow (số nguyên)

**Response `200`:** Object `Workflow` kèm `workflowTasks[].task` (full task detail), sắp xếp theo `taskOrder`.

**Lỗi:**

| Code | Trường hợp                   |
|------|------------------------------|
| 404  | Workflow không tồn tại hoặc không thuộc user |

---

### `PATCH /task-workflows/:id`

Cập nhật thông tin cơ bản của workflow (tên, mô tả, bật/tắt). Không ảnh hưởng đến danh sách task.

**Params:** `id` — ID workflow

**Request body** (tất cả optional):

```json
{
  "name": "Tên mới",
  "description": "Mô tả mới",
  "enabled": false
}
```

**Response `200`:** Object `Workflow` đã cập nhật.

**Lỗi:**

| Code | Trường hợp       |
|------|------------------|
| 404  | Workflow không tồn tại |

---

### `DELETE /task-workflows/:id`

Vô hiệu hoá workflow (soft delete — set `enabled = false`).

**Params:** `id` — ID workflow

**Response `204`:** Không có body.

**Lỗi:**

| Code | Trường hợp       |
|------|------------------|
| 404  | Workflow không tồn tại |

---

## API — Quản lý Task trong Workflow

> Các endpoint này phục vụ frontend **drag-and-drop** tùy biến quy trình theo thời gian thực.
> Mỗi thao tác trả về toàn bộ `Workflow` đã cập nhật để frontend sync state dễ dàng.
>
> `wtId` = field `id` trong mỗi phần tử của `workflowTasks[]`.

---

### `PUT /task-workflows/:id/tasks`

**Thay thế toàn bộ** danh sách task của workflow (atomic replace). Dùng cho tính năng "Save" batch.

**Params:** `id` — ID workflow

**Request body:**

```json
{
  "tasks": [
    { "taskId": 3, "taskOrder": 0, "onFailure": "stop" },
    { "taskId": 1, "taskOrder": 1, "onFailure": "skip" },
    { "taskId": 5, "taskOrder": 2 }
  ]
}
```

**Response `200`:** Object `Workflow` với `workflowTasks` mới.

**Lỗi:**

| Code | Trường hợp                           |
|------|--------------------------------------|
| 400  | `tasks` rỗng, task không thuộc user  |
| 404  | Workflow không tồn tại               |

---

### `POST /task-workflows/:id/tasks`

**Thêm 1 task** vào vị trí tùy chọn. Tự động shift order các task sau lên 1.

**Params:** `id` — ID workflow

**Request body:**

```json
{
  "taskId": 7,
  "insertAfterOrder": 1,
  "onFailure": "skip"
}
```

| Field              | Bắt buộc | Mô tả                                                          |
|--------------------|----------|----------------------------------------------------------------|
| `taskId`           | ✅       | Task cần thêm (phải thuộc user)                                |
| `insertAfterOrder` | ❌       | Chèn sau vị trí `taskOrder` này. Không truyền = thêm vào cuối |
| `onFailure`        | ❌       | Mặc định `"stop"`                                              |

**Ví dụ:** Workflow hiện có 3 task (order 0, 1, 2). Gọi với `insertAfterOrder: 1`:
- Task mới được chèn tại order `2`
- Task cũ ở order 2 tự động lên thành order `3`

**Response `200`:** Object `Workflow` với danh sách task đã cập nhật.

**Lỗi:**

| Code | Trường hợp                     |
|------|--------------------------------|
| 400  | Task không thuộc user          |
| 404  | Workflow không tồn tại         |

---

### `PATCH /task-workflows/:id/tasks/:wtId`

**Sửa 1 workflow-task entry** — hỗ trợ swap task, drag-drop reorder, thay đổi onFailure.
Có thể truyền 1 hoặc nhiều field cùng lúc.

**Params:**
- `id` — ID workflow
- `wtId` — ID của workflow-task entry (field `id` trong `workflowTasks[]`)

**Request body** (tất cả optional, phải truyền ít nhất 1):

```json
{
  "taskId": 9,
  "taskOrder": 0,
  "onFailure": "continue"
}
```

| Field        | Mô tả                                                                      |
|--------------|----------------------------------------------------------------------------|
| `taskId`     | Đổi sang task khác tại cùng vị trí (swap). Task mới phải thuộc user.      |
| `taskOrder`  | Di chuyển đến vị trí mới. Tự shift tất cả task ở giữa lên/xuống 1.       |
| `onFailure`  | Thay đổi hành vi xử lý lỗi cho bước này.                                  |

**Use cases thường gặp:**

```jsonc
// Drag-drop: di chuyển task từ vị trí 3 xuống vị trí 1
{ "taskOrder": 1 }

// Swap: thay task hiện tại bằng task khác
{ "taskId": 12 }

// Đổi logic lỗi
{ "onFailure": "skip" }

// Kết hợp: swap task và đổi onFailure cùng lúc
{ "taskId": 12, "onFailure": "continue" }
```

**Response `200`:** Object `Workflow` với danh sách task đã cập nhật.

**Lỗi:**

| Code | Trường hợp                          |
|------|-------------------------------------|
| 400  | Task mới không thuộc user           |
| 404  | Workflow hoặc workflow-task không tồn tại |

---

### `DELETE /task-workflows/:id/tasks/:wtId`

**Xoá 1 task** khỏi workflow. Tự động compact lại `taskOrder` (0, 1, 2, ...).

**Params:**
- `id` — ID workflow
- `wtId` — ID của workflow-task entry

**Response `200`:** Object `Workflow` sau khi xoá.

**Lỗi:**

| Code | Trường hợp                                          |
|------|-----------------------------------------------------|
| 400  | Workflow đang chỉ có 1 task (bắt buộc giữ ít nhất 1) |
| 404  | Workflow hoặc workflow-task không tồn tại           |

---

## API — Chạy Workflow

### `POST /task-workflows/:id/run`

Enqueue workflow vào hàng đợi để chạy ngay (trigger: `manual`).

**Params:** `id` — ID workflow

**Response `202`:**

```json
{
  "statusCode": 202,
  "message": "Success",
  "data": {
    "runId": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

**Lỗi:**

| Code | Trường hợp                                |
|------|-------------------------------------------|
| 400  | Workflow đang tắt (`enabled = false`) hoặc chưa có task |
| 404  | Workflow không tồn tại                    |
| 503  | Không kết nối được Redis / queue          |

---

## API — Lịch sử chạy (Runs)

### `GET /task-workflows/runs`

Lấy lịch sử tất cả lần chạy của user (tối đa 200, mới nhất trước).

**Query params:**

| Param        | Bắt buộc | Mô tả                                          |
|--------------|----------|------------------------------------------------|
| `workflowId` | ❌       | Lọc theo workflow cụ thể (số nguyên dạng string) |

**Ví dụ:**

```
GET /task-workflows/runs
GET /task-workflows/runs?workflowId=5
```

**Response `200`:** Mảng `WorkflowRun[]` (không kèm `runTasks`).

---

### `GET /task-workflows/runs/:runId`

Lấy chi tiết 1 lần chạy, kèm trạng thái từng task trong run.

**Params:** `runId` — UUID của run

**Response `200`:** Object `WorkflowRun` kèm:
- `workflow` — thông tin workflow
- `runTasks[]` — chi tiết từng bước, sắp xếp theo `taskOrder`

**Lỗi:**

| Code | Trường hợp                                         |
|------|----------------------------------------------------|
| 400  | `runId` không phải UUID hợp lệ                     |
| 404  | Run không tồn tại hoặc không thuộc user hiện tại  |

---

## Hướng dẫn tích hợp frontend (drag-and-drop)

### Khởi tạo canvas

```
GET /task-workflows/:id        → load workflow + toàn bộ workflowTasks
GET /tasks                     → load danh sách task có thể dùng (từ module tasks)
```

### Các thao tác drag-and-drop

| Hành động người dùng              | API gọi                                                      |
|-----------------------------------|--------------------------------------------------------------|
| Kéo task sang vị trí mới          | `PATCH /task-workflows/:id/tasks/:wtId` `{ taskOrder: N }`  |
| Thêm task từ panel vào cuối       | `POST /task-workflows/:id/tasks` `{ taskId }`               |
| Thêm task vào giữa quy trình      | `POST /task-workflows/:id/tasks` `{ taskId, insertAfterOrder: N }` |
| Xoá task khỏi quy trình           | `DELETE /task-workflows/:id/tasks/:wtId`                    |
| Thay bằng task khác               | `PATCH /task-workflows/:id/tasks/:wtId` `{ taskId: newId }` |
| Đổi onFailure                     | `PATCH /task-workflows/:id/tasks/:wtId` `{ onFailure: "..." }` |
| Save batch (undo/redo/reset)      | `PUT /task-workflows/:id/tasks` `{ tasks: [...] }`          |

> Mỗi API trên đều trả về `Workflow` đầy đủ → frontend chỉ cần sync lại state từ response, không cần gọi thêm `GET`.

### Theo dõi tiến trình chạy

```
POST /task-workflows/:id/run           → nhận runId
GET  /task-workflows/runs/:runId       → poll để theo dõi status
```

`WorkflowRun.status` chuyển qua: `pending` → `running` → `completed` | `failed` | `cancelled`

`WorkflowRunTask.status` của từng bước: `pending` → `running` → `completed` | `failed` | `skipped`
