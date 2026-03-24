# Websites API Docs (HTTP Tokens)

Tai lieu mo ta API quan ly cac website/token trong module `http-tokens`.

## Tong quan

- Base route: `/http-tokens`
- Auth: bat buoc JWT
- Co 2 nhom API:
  - **My websites** (self-service): `/http-tokens/my...`
  - **Owner admin** (legacy): `/http-tokens...` (chi owner)

## Bao mat token

- Nhom **my websites** KHONG tra token:
  - khong co `token`
  - khong co `tokenMasked`
  - chi co `hasToken: boolean`
- Nhom owner admin tra `tokenMasked`.

## Enum authType

- `api_key`
- `bearer`
- `basic`

Validation:

- `token` la bat buoc khi tao, va khong duoc rong neu patch `token`.
- Neu `authType=api_key` => `headerName` bat buoc.
- Neu `authType=basic` => `username` bat buoc.

---

## A. My websites APIs (khuyen nghi cho frontend user)

### 1) Danh sach website cua toi

`GET /http-tokens/my`

Tra ve record voi scope `createdByUid = req.user.uid`.

Response item:

```json
{
  "id": 1,
  "domain": "api.example.com",
  "authType": "bearer",
  "headerName": null,
  "username": null,
  "note": "CRM API",
  "createdByUid": 12,
  "createdAt": "2026-03-24T10:00:00.000Z",
  "updatedAt": "2026-03-24T10:00:00.000Z",
  "hasToken": true
}
```

---

### 2) Xem chi tiet 1 website cua toi

`GET /http-tokens/my/:id`

Loi:
- `404`: `Website token not found` (khong ton tai hoac khong thuoc user)

---

### 3) Tao website cua toi

`POST /http-tokens/my`

Body:

```json
{
  "domain": "api.example.com",
  "authType": "api_key",
  "headerName": "x-api-key",
  "token": "secret",
  "username": null,
  "note": "My integration"
}
```

Rule domain:
- Backend normalize domain:
  - lower-case
  - bo `www.`
  - chap nhan input co/khong co protocol

Loi:
- `400`: invalid input / domain trung voi website cua chinh user
- `403`: domain da thuoc user khac

---

### 4) Cap nhat website cua toi

`PATCH /http-tokens/my/:id`

Body la patch, tat ca optional:

```json
{
  "domain": "new.example.com",
  "authType": "basic",
  "username": "admin",
  "token": "new-secret",
  "note": "updated"
}
```

Loi:
- `400`: token rong, validate authType sai, domain trung trong cung user
- `403`: domain da thuoc user khac
- `404`: website khong ton tai hoac khong thuoc user

---

### 5) Xoa website cua toi

`DELETE /http-tokens/my/:id`

Response:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": { "success": true }
}
```

Loi:
- `404`: website khong ton tai hoac khong thuoc user

---

## B. Owner admin APIs (giu lai de tuong thich)

> Nhom nay yeu cau role owner (`Only owner can manage HTTP tokens`).

### 1) List all

`GET /http-tokens`

- Tra toan bo records.
- Co `tokenMasked`.

### 2) Get by id

`GET /http-tokens/:id`

- Co `tokenMasked`.

### 3) Upsert by domain

`POST /http-tokens`

- Neu domain da ton tai: update.
- Neu chua ton tai: create.

### 4) Delete by id

`DELETE /http-tokens/:id`

- Xoa record theo id.

---

## Ghi chu frontend

- Frontend user thuong chi nen dung nhom `/http-tokens/my...`.
- UI hien thi website:
  - dung `hasToken` de biet token da duoc luu.
  - khong ky vong backend tra token plain-text khi view.
- Neu can doi token, gui token moi qua `PATCH /http-tokens/my/:id`.

