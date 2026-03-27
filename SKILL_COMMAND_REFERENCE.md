# Skill Command Reference

Tai lieu nay la "mau lenh thuc thi" de dung truc tiep cho:

- Workflow Node (`toolCode` + `commandCode`)
- Chat quick-call (gui tham so JSON cho skill)

Muc tieu: giam phu thuoc vao prompt tu do, uu tien payload co cau truc.

---

## 1) Quy uoc chung

### 1.1 Dung trong Workflow Node

- `toolCode`: ma skill (vd: `google_docs`, `http_request`, `web_fetch`)
- `commandCode`: JSON object (string) chua tham so skill

Vi du:

```json
{
  "service": "docs",
  "action": "write {input.fileId} --text \"{input.content}\" --append"
}
```

Giai thich nhanh:

- `service`: module Google se dung (`docs`).
- `action`: lenh gogcli.
- `{input.fileId}`: id Google Docs can ghi.
- `{input.content}`: noi dung dong lay tu input runtime.
- `--append`: noi vao cuoi file (khong ghi de toan bo).

> Luu y: He thong se render placeholder `{...}` truoc khi goi skill.

### 1.2 Placeholder duoc ho tro

- `{input.someKey}`
- `{nodes.<nodeId>.content}`
- `{nodes.<nodeName>.content}`

Khuyen nghi:

- Uu tien theo `nodeId` de tranh loi do doi ten node.

---

## 2) Google aliases (khuyen nghi)

He thong da map cac alias nay ve `google_workspace` + inject `service` tuong ung:

- `google_gmail`
- `google_drive`
- `google_docs`
- `google_sheets`
- `google_slides`
- `google_calendar`
- `google_contacts`
- `google_tasks`
- `google_forms`
- `google_chat`
- `google_keep`
- `google_pdf_read`

### 2.1 `google_docs`

Write + append:

```json
{
  "service": "docs",
  "action": "write {input.fileId} --text \"{input.content}\" --append"
}
```

Read:

```json
{
  "service": "docs",
  "action": "cat {input.fileId}"
}
```

Giai thich nhanh:

- Dung de doc noi dung file Docs theo `fileId`.
- Thuong dung truoc khi edit de kiem tra noi dung hien tai.

Clear:

```json
{
  "service": "docs",
  "action": "clear {input.fileId}"
}
```

Giai thich nhanh:

- Xoa toan bo noi dung trong file Docs (giu lai file).
- Nen dung can than vi khong co buoc undo trong workflow.

### 2.2 `google_drive`

Search:

```json
{
  "service": "drive",
  "action": "search \"name contains '{input.keyword}'\""
}
```

Giai thich nhanh:

- Tim file trong Drive theo tu khoa ten.
- `{input.keyword}` nen la chuoi ngan, ro rang de loc nhanh.

Download:

```json
{
  "service": "drive",
  "action": "download {input.fileId}"
}
```

Giai thich nhanh:

- Tai file tu Drive theo `fileId`.
- Hop cho truong hop "doc PDF" hoac xu ly tiep file tren server.

Delete (vao trash):

```json
{
  "service": "drive",
  "action": "delete {input.fileId}"
}
```

Giai thich nhanh:

- Xoa file theo che do thuong (chuyen vao Trash).
- An toan hon so voi xoa vinh vien.

Delete vinh vien:

```json
{
  "service": "drive",
  "action": "delete {input.fileId} --permanent"
}
```

Giai thich nhanh:

- Xoa vinh vien file khoi Drive.
- Chi dung khi da chac chan, vi khong khoi phuc duoc.

### 2.3 `google_sheets`

Read range:

```json
{
  "service": "sheets",
  "action": "get {input.sheetId} A1:C10"
}
```

Giai thich nhanh:

- Doc du lieu vung `A1:C10` tu Google Sheets.
- Thay range theo nhu cau (`Sheet1!A1:C10` neu can ro ten sheet).

Update range:

```json
{
  "service": "sheets",
  "action": "update {input.sheetId} A2:C2 1|Task|20%"
}
```

Giai thich nhanh:

- Ghi du lieu vao range.
- Dinh dang cell trong 1 dong dung `|`.
- Nhieu dong co the tach boi dau `,` (tuy theo action cu the).

### 2.4 `google_gmail`

Search:

```json
{
  "service": "gmail",
  "action": "search 'newer_than:7d'"
}
```

Giai thich nhanh:

- Tim email trong 7 ngay gan day.
- Co the doi query thanh `from:abc@x.com subject:bao cao`.

Send:

```json
{
  "service": "gmail",
  "action": "send --to {input.to} --subject \"{input.subject}\" --body \"{input.content}\""
}
```

Giai thich nhanh:

- Gui email moi.
- `{input.to}`: nguoi nhan.
- `{input.subject}`: tieu de.
- `{input.content}`: noi dung thu.

### 2.5 `google_calendar`

Events today:

```json
{
  "service": "calendar",
  "action": "events --today"
}
```

Giai thich nhanh:

- Lay danh sach lich trong ngay hom nay.

Create event:

```json
{
  "service": "calendar",
  "action": "create primary --summary \"{input.title}\" --from \"{input.fromIso}\" --to \"{input.toIso}\""
}
```

Giai thich nhanh:

- Tao su kien lich moi.
- `fromIso` / `toIso` nen theo ISO datetime (vd `2026-03-27T09:00:00+07:00`).

### 2.6 `google_pdf_read`

```json
{
  "service": "drive",
  "action": "download {input.fileId}"
}
```

Giai thich nhanh:

- Mau don gian cho flow doc PDF tu Drive.
- Thuong ket hop voi skill doc PDF o buoc tiep theo.

---

## 3) Web skills thong dung

### 3.1 `http_request`

GET:

```json
{
  "url": "https://example.com/api/posts",
  "method": "GET",
  "query": {
    "limit": 10
  }
}
```

Giai thich nhanh:

- `url`: endpoint can goi.
- `method`: GET.
- `query`: tham so query string.

POST:

```json
{
  "url": "https://example.com/api/posts",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": {
    "title": "{input.title}",
    "content": "{input.content}"
  }
}
```

Giai thich nhanh:

- `headers`: header bo sung.
- `body`: payload JSON gui len API.
- Placeholder trong body se duoc render tu `input`.

Dung token tu DB (khong hardcode token trong JSON):

Theo `authCode` (uu tien):

```json
{
  "url": "https://example.com/wp-json/wp/v2/posts",
  "method": "GET",
  "authCode": "wp_prod_main"
}
```

POST + `authCode`:

```json
{
  "url": "https://example.com/wp-json/wp/v2/posts",
  "method": "POST",
  "authCode": "wp_prod_main",
  "body": {
    "title": "{input.title}",
    "content": "{input.content}",
    "status": "publish"
  }
}
```

Theo `authDomain`:

```json
{
  "url": "https://example.com/wp-json/wp/v2/posts",
  "method": "POST",
  "authDomain": "example.com",
  "body": {
    "title": "{input.title}",
    "content": "{input.content}"
  }
}
```

Giai thich nhanh:

- Skill `http_request` se tu lay token trong bang `http_tokens`.
- Khong can truyen token truc tiep trong `headers`.
- Neu truyen ca `authCode` va `authDomain`, he thong uu tien `authCode`.

### 3.2 `web_fetch`

```json
{
  "url": "https://example.com/article",
  "mode": "markdown",
  "maxChars": 20000
}
```

Giai thich nhanh:

- `mode`: dinh dang ket qua (`markdown`/`text`/`html`).
- `maxChars`: gioi han do dai noi dung tra ve.

---

## 4) Khi goi nhanh trong chat

Neu UI chat ho tro goi skill truc tiep, nen gui payload theo mau:

```json
{
  "skillCode": "google_docs",
  "parameters": {
    "service": "docs",
    "action": "cat 1AbCdEfGhIj..."
  }
}
```

Hoac voi `http_request`:

```json
{
  "skillCode": "http_request",
  "parameters": {
    "url": "https://example.com/api/status",
    "method": "GET"
  }
}
```

---

## 5) Checklist tranh loi thuong gap

- `toolCode` phai la skill code hop le (`google_docs`, `http_request`, ...)
- `commandCode` nen la JSON object hop le
- Placeholder dung key ton tai (`{nodes.<nodeId>.content}`)
- Voi Google:
  - User da auth OAuth2 (`google_auth_setup`)
  - `fileId`/`sheetId` dung va co quyen truy cap

