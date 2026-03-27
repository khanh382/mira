# Agent System Chat API Docs

Tai lieu mo ta chi tiet API va WebSocket khi frontend chat voi **agent system** (khong qua OpenClaw).

## Tong quan

- REST base: `/gateway`
- WebSocket namespace: `/webchat` (Socket.IO)
- Tat ca luong chat tu web deu route voi `platform=web`
- Explicit `threadId` chi duoc dung cho thread web, khong duoc dung thread Telegram/Zalo/Discord

## Auth va bao mat

- REST chat APIs: can JWT (`JwtAuthGuard`)
- WebSocket:
  - token qua `handshake.auth.token` hoac `query.token`
  - check CORS origin theo `WS_ALLOWED_ORIGINS` hoac `FRONTEND_URLS`
- Response REST thanh cong duoc wrap:
  - `{ statusCode, message, data }`

## Data model chinh trong chat web

- `threadId` (uuid): id phien chat
- Message roles: `user`, `assistant`, ...
- Moi request chat tra:
  - `response` (text)
  - `threadId`
  - `tokensUsed`
  - `runId`

---

## REST APIs (agent system chat)

### 1) Send message

`POST /gateway/message`

#### Auth

- JWT bat buoc

#### Body

```json
{
  "content": "Xin chao agent system",
  "channelId": "webchat",
  "model": "optional-model-id",
  "mediaUrl": "optional-public-url",
  "mediaPath": "optional-server-path",
  "threadId": "optional-web-thread-uuid"
}
```

#### Field notes

- `content` bat buoc
- `threadId` optional:
  - neu co va hop le => tiep tuc dung thread do
  - neu khong co => backend resolve thread active web cho user
- `mediaUrl` / `mediaPath` phuc vu multimodal flow (neu provider ho tro)

#### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "response": "Xin chao, toi la agent system.",
    "threadId": "a1b2c3d4-....",
    "tokensUsed": 123,
    "runId": "run-..."
  }
}
```

#### Loi thuong gap

- `401`: token khong hop le / het han
- `400`/`403`: threadId khong hop le cho kenh hien tai (cross-platform)

---

### 2) Reset thread

`POST /gateway/reset`

#### Auth

- JWT bat buoc

#### Body

```json
{
  "reason": "optional"
}
```

#### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "threadId": "new-thread-uuid",
    "message": "Thread reset for <user>. New thread: <uuid>"
  }
}
```

---

### 3) Lay history thread hien tai

`GET /gateway/history?limit=50`

#### Auth

- JWT bat buoc

#### Query

- `limit` optional, mac dinh 50

#### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "threadId": "current-thread-uuid",
    "messages": [
      {
        "id": "msg-uuid",
        "role": "user",
        "content": "hello",
        "tokensUsed": 0,
        "createdAt": "2026-03-24T00:00:00.000Z"
      }
    ]
  }
}
```

---

### 4) Lay danh sach thread web (session picker)

`GET /gateway/threads`

#### Auth

- JWT bat buoc

#### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "items": [
      {
        "threadId": "8c5f2d6b-...",
        "title": null,
        "isActive": true,
        "activeOpenclawAgentId": null,
        "createdAt": "2026-03-24T11:00:00.000Z",
        "updatedAt": "2026-03-24T11:10:00.000Z"
      }
    ]
  }
}
```

---

### 5) Chuyen thread active (switch session)

`POST /gateway/threads/switch`

#### Auth

- JWT bat buoc

#### Body

```json
{
  "threadId": "8c5f2d6b-..."
}
```

#### Rules

- Chi switch thread `platform=web`
- Thread phai thuoc user dang login
- Sau khi switch, `POST /gateway/message` (khong truyen `threadId`) se mac dinh vao thread moi

#### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "threadId": "8c5f2d6b-...",
    "isActive": true,
    "activeOpenclawAgentId": null,
    "message": "Switched active thread to 8c5f2d6b-..."
  }
}
```

#### Loi thuong gap

- `404`: thread khong ton tai hoac khong thuoc user
- `400`: thread khong phai web

---

### 6) Skills va status (ho tro UI)

- `GET /gateway/skills` (public)
- `GET /gateway/skill-catalog` (JWT)
  - query:
    - `category`
    - `all=true` de lay ca skill noi bo
- `GET /gateway/status` (public)

---

## WebSocket APIs (agent system chat realtime)

Namespace: `/webchat`

### Connect

Client connect voi token:

```ts
io("/webchat", {
  auth: { token: "<jwt>" }
});
```

Server emit sau khi connect thanh cong:

- `connected`:

```json
{
  "userId": 12,
  "identifier": "user_identifier"
}
```

Neu fail:

- `error`: `{ "message": "Authentication failed" }` hoac `"Origin not allowed"`

---

### 1) Event gui message

Client emit: `message`

Payload:

```json
{
  "content": "Xin chao",
  "model": "optional",
  "threadId": "optional-web-thread-uuid",
  "mediaUrl": "optional",
  "mediaPath": "optional",
  "mediaPaths": ["optional", "optional"]
}
```

#### Server emits

- `message:processing`
- `message:delta` (chunk stream; xuat hien khi luong OpenClaw stream)
- `message:response` (ban response cuoi)
- `message:done`
- `message:error` neu loi

Ngoai ra event return ACK:

- `message:ack`:
  - `{ success: true }` hoac `{ success: false }`

---

### 2) Event reset

Client emit: `reset`

Server emit:

- `thread:reset` (payload tu `/gateway/reset`)
- ACK event: `reset:ack`

---

## Rule thread isolation (quan trong)

Backend da enforce:

- Web request chi duoc dung thread `platform=web`
- Telegram/Zalo/Discord thread khong duoc dung chung voi web
- Thread explicit sai kenh/actor se bi tu choi

Dieu nay dam bao:

- frontend web doi session khong anh huong session Telegram/Zalo/Discord
- moi kenh giu ngu canh rieng

---

## Frontend integration goi y

1) REST-first (de lam):
- goi `POST /gateway/message`
- luu `threadId` theo tab/session
- goi `POST /gateway/reset` khi tao phien moi

2) WebSocket-first (chat UX tot hon):
- connect `/webchat`
- emit `message`
- render typing theo `message:processing`
- append chunk neu co `message:delta`
- finalize theo `message:response` + `message:done`

3) Multi-session tren web:
- moi tab luu 1 `threadId`
- moi lan gui ke tiep, truyen lai `threadId`

