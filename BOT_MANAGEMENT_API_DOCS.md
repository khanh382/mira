# Bot Management API Docs

Tai lieu mo ta API module quan ly bot user (`bot-users`).

## Tong quan

- Base route: `/bot-users`
- Auth: bat buoc JWT
- Phan quyen: chi `owner` va `colleague`

## Format response

Thanh cong:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

Loi:

```json
{
  "statusCode": 403,
  "message": "Only owner or colleague can access this API"
}
```

## Model

Du lieu luu trong bang `bot_users` voi cac field:

- `telegramBotToken`
- `discordBotToken`
- `slackBotToken`
- `zaloBotToken`
- `googleConsoleCloudJsonPath`
- `createdAt`
- `updateAt`

---

## 1) Xem cau hinh bot cua user hien tai

`GET /bot-users/view`

### Quyen

- `owner`, `colleague`

### Hanh vi

- Lay record theo `req.user.uid`.
- Neu chua co record => tra `null`.

### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "id": 5,
    "userId": 12,
    "telegramBotToken": "123:abc",
    "discordBotToken": null,
    "slackBotToken": null,
    "zaloBotToken": null,
    "googleConsoleCloudJsonPath": "/secrets/google.json",
    "createdAt": "2026-03-24T10:00:00.000Z",
    "updateAt": "2026-03-24T10:00:00.000Z"
  }
}
```

### Loi thuong gap

- `403`: khong du quyen

---

## 2) Tao/cap nhat cau hinh bot (upsert)

`POST /bot-users/set`

### Quyen

- `owner`, `colleague`

### Body DTO

```json
{
  "telegram_bot_token": "optional",
  "discord_bot_token": "optional",
  "slack_bot_token": "optional",
  "zalo_bot_token": "optional",
  "google_console_cloud_json_path": "optional"
}
```

Tat ca field deu optional, nhung:

- Backend chi nhan cac field co gia tri sau khi `trim()`.
- Neu khong co field hop le nao => `400` (`No valid fields to set`).

### Hanh vi

- Neu user da co record `bot_users` => update.
- Neu chua co => create moi.

### Response

- `200` + ban ghi sau upsert.

### Loi thuong gap

- `400`: body khong co field hop le
- `403`: khong du quyen

---

## Ghi chu frontend

- Man hinh settings bot:
  - Goi `GET /bot-users/view` luc load.
  - Submit bang `POST /bot-users/set`.
- Neu muon xoa token, module hien tai chua ho tro clear bang string rong; can endpoint/logic clear rieng neu can.

