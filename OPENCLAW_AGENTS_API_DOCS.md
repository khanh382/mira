# OpenClaw Agents API

Tai lieu mo ta cac API quan ly OpenClaw agents trong module `openclaw-agents`.

## Auth va phan quyen

- Tat ca API deu yeu cau JWT (`JwtAuthGuard`).
- Chi role `owner` va `colleague` duoc phep goi.
- `client` se bi tu choi voi `403 Forbidden`.

## Luu y bao mat

- API khong bao gio tra ve `gatewayToken` va `gatewayPassword`.
- Response chi tra:
  - `hasGatewayToken: boolean`
  - `hasGatewayPassword: boolean`
- Nghia la frontend biet co secret hay khong, nhung khong doc duoc gia tri.

## Response format

Thanh cong duoc wrap boi interceptor:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

Loi theo `HttpExceptionFilter`:

```json
{
  "statusCode": 400,
  "message": "Error message"
}
```

## Model tra ve (PublicOpenclawAgent)

```json
{
  "id": 1,
  "name": "Support Agent",
  "ownerUserId": 12,
  "domain": "oa.example.com",
  "port": "18789",
  "useTls": true,
  "chatPath": "/openclaw/relay",
  "expertise": "Sales support",
  "status": "active",
  "lastHealthAt": "2026-03-24T12:00:00.000Z",
  "lastError": null,
  "createdAt": "2026-03-24T11:00:00.000Z",
  "updatedAt": "2026-03-24T12:00:00.000Z",
  "hasGatewayToken": true,
  "hasGatewayPassword": false
}
```

Enums:
- `status`: `active | disabled`

---

## 1) Tao agent

`POST /openclaw-agents`

### Body

```json
{
  "name": "Agent A",
  "domain": "oa.example.com",
  "port": "18789",
  "useTls": true,
  "chatPath": "/openclaw/relay",
  "gatewayToken": "optional-token",
  "gatewayPassword": "optional-password",
  "expertise": "Support and CRM"
}
```

### Rule

- Bat buoc: `name`, `domain`, `port`.
- `useTls` mac dinh `false`.
- `status` tao moi mac dinh `active`.

### Response

- `200` + `PublicOpenclawAgent`

### Loi thuong gap

- `400`: thieu `name`/`domain`/`port`
- `403`: khong du quyen

---

## 2) Danh sach agent cua user

`GET /openclaw-agents`

### Response

- `200` + `PublicOpenclawAgent[]` (sap xep theo `id ASC`)

### Loi thuong gap

- `403`: khong du quyen

---

## 3) Lay chi tiet 1 agent

`GET /openclaw-agents/:id`

### Params

- `id` (number)

### Response

- `200` + `PublicOpenclawAgent`

### Loi thuong gap

- `404`: khong tim thay agent cua user
- `403`: khong du quyen

---

## 4) Cap nhat agent

`PATCH /openclaw-agents/:id`

### Params

- `id` (number)

### Body (tat ca optional)

```json
{
  "name": "Agent A v2",
  "domain": "new.example.com",
  "port": "18790",
  "useTls": false,
  "chatPath": "/relay-v2",
  "gatewayToken": "",
  "gatewayPassword": null,
  "expertise": "Updated scope",
  "status": "disabled"
}
```

### Rule

- Co the update tung truong rieng le.
- `gatewayToken`:
  - gui `""` hoac `null` de xoa
- `gatewayPassword`:
  - gui `""` hoac `null` de xoa

### Response

- `200` + `PublicOpenclawAgent` sau cap nhat

### Loi thuong gap

- `404`: agent khong ton tai hoac khong thuoc user
- `403`: khong du quyen

---

## 5) Xoa mem (disable) agent

`DELETE /openclaw-agents/:id`

### Params

- `id` (number)

### Hanh vi

- Khong xoa record khoi DB.
- Set `status = disabled`.

### Response

- `204 No Content`

### Loi thuong gap

- `404`: agent khong ton tai hoac khong thuoc user
- `403`: khong du quyen

---

## 6) Test connection va cap nhat health

`POST /openclaw-agents/:id/test-connection`

### Params

- `id` (number)

### Hanh vi

- Backend ping `scheme://domain:port`:
  - `scheme = https` neu `useTls=true`, nguoc lai `http`
- Timeout hien tai: `8000ms`
- Sau test:
  - Neu thanh cong: cap nhat `lastHealthAt = now`, `lastError = null`
  - Neu that bai: cap nhat `lastError` theo noi dung loi

### Response

> API nay luon tra `200`, ket qua that bai/than cong nam o field `ok`.

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "ok": true,
    "latencyMs": 45,
    "error": null,
    "agent": {
      "id": 1,
      "name": "Agent A",
      "ownerUserId": 12,
      "domain": "oa.example.com",
      "port": "18789",
      "useTls": true,
      "chatPath": "/openclaw/relay",
      "expertise": null,
      "status": "active",
      "lastHealthAt": "2026-03-24T12:34:56.000Z",
      "lastError": null,
      "createdAt": "2026-03-24T10:00:00.000Z",
      "updatedAt": "2026-03-24T12:34:56.000Z",
      "hasGatewayToken": true,
      "hasGatewayPassword": true
    }
  }
}
```

Vi du that bai:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "ok": false,
    "latencyMs": 8003,
    "error": "Het thoi gian cho (8000ms). Kiem tra domain/port va firewall.",
    "agent": {
      "...": "PublicOpenclawAgent da duoc cap nhat lastError"
    }
  }
}
```

### Loi thuong gap

- `404`: agent khong ton tai hoac khong thuoc user
- `403`: khong du quyen

---

## 7) Danh sach OpenClaw sessions (frontend picker)

`GET /openclaw-agents/sessions`

### Query params

- `agentId?` (number): loc theo agent
- `chatThreadId?` (uuid): loc theo thread web

### Response

- `200` + mang sessions (toi da 200 ban ghi), sap xep `updatedAt DESC`
- moi session gom:
  - `id`, `agentId`, `chatThreadId`, `openclawSessionKey`, `platform`, `title`, `createdAt`, `updatedAt`
  - `agent`: `{ id, name }`

---

## 8) Chi tiet 1 OpenClaw session + messages

`GET /openclaw-agents/sessions/:sessionId`

### Query params

- `limit?` (number, mac dinh 50, toi da 200)

### Response

- `200`:
  - `session`: thong tin session OpenClaw
  - `messages`: danh sach message trong session (thu tu thoi gian tang dan)

### Loi thuong gap

- `404`: khong tim thay session cua user

---

## 9) Switch session vao thread WEB

`POST /openclaw-agents/sessions/:sessionId/switch`

### Body

```json
{
  "chatThreadId": "uuid-thread-web"
}
```

### Hanh vi

- Chi cho `chatThreadId` cua user hien tai va `platform=web`
- Gan `activeOpenclawAgentId` cua chat thread theo agent cua session
- Cap nhat session de lien ket voi `chatThreadId` do

### Response

```json
{
  "ok": true,
  "sessionId": "uuid-session",
  "chatThreadId": "uuid-thread-web",
  "agentId": 3
}
```

### Loi thuong gap

- `404`: khong tim thay session hoac chat thread
- `400`: chat thread khong phai WEB

---

## 10) Tao session OpenClaw moi cho thread WEB

`POST /openclaw-agents/sessions/new`

### Body

```json
{
  "chatThreadId": "uuid-thread-web",
  "agentId": 3
}
```

`agentId` la optional:
- Neu co -> dung agent do
- Neu khong -> dung `activeOpenclawAgentId` cua chat thread

### Hanh vi

- Neu da co session cua `(ownerUid, agentId, chatThreadId)` -> reset `openclawSessionKey = null` (bat dau session moi)
- Neu chua co -> tao `openclaw_thread` moi
- Luon set `activeOpenclawAgentId` cua chat thread theo agent da chon

### Response

- `200` + thong tin session moi/da reset

### Loi thuong gap

- `404`: khong tim thay chat thread hoac agent
- `400`: thread khong phai WEB, hoac khong xac dinh duoc agent

---

## Goi y frontend

- Trang list: goi `GET /openclaw-agents`.
- Form tao/sua:
  - neu muon xoa secret, gui `""` hoac `null`.
- Nut "Test connection":
  - goi `POST /openclaw-agents/:id/test-connection`
  - hien thi `ok`, `latencyMs`, `error`
  - cap nhat UI bang `data.agent` tra ve tu response.

---

## Realtime OpenClaw (WebSocket)

Backend da ho tro stream realtime khi chat OpenClaw qua `/webchat` websocket.

### Event websocket (client side)

- Client gui: `message`
  - payload co the gom: `content`, `threadId`, `model`, ...
- Server emit:
  - `message:processing`
  - `message:delta` (nhieu lan, moi lan 1 chunk text)
  - `message:response` (ban full cuoi cung)
  - `message:done`

Luu y:
- Realtime chunk chi ap dung khi thread hien tai dang route sang OpenClaw agent.
- Neu relay khong stream duoc, backend fallback ve response 1 lan nhu cu.

### ENV can bat o backend

```env
OPENCLAW_ENABLE_STREAM=true
OPENCLAW_STREAM_PATH=/openclaw/stream
OPENCLAW_RELAY_TIMEOUT_MS=120000
```

`OPENCLAW_STREAM_PATH` la endpoint stream tren relay OpenClaw (shim), khong phai endpoint API thuong.

### Yeu cau can cau hinh o OpenClaw relay/shim

Relay truoc OpenClaw can ho tro **SSE streaming**:

- Method: `POST`
- Path: theo `OPENCLAW_STREAM_PATH` (vd `/openclaw/stream`)
- Request JSON:

```json
{
  "message": "user input",
  "sessionKey": "nullable"
}
```

- Response headers:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`

- SSE payload de nghi:
  - `event: token`, `data: {"delta":"..."}`
  - `event: done`, `data: {"reply":"...","sessionKey":"..."}`

Backend cung chap nhan fallback `data: {"delta":"..."}` / `data: {"reply":"...","sessionKey":"..."}` khong can event name.

### Auth header relay nhan duoc

Neu agent co secret:
- `Authorization: Bearer <oa_token_gateway>`
- `X-OpenClaw-Gateway-Password: <oa_password_gateway>`

Relay shim can doc va verify 2 header nay (neu ban bat auth).

