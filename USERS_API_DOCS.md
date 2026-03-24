# Users API Documentation

This document summarizes all available APIs in the `users` module, including request/response formats and authentication behavior.

## Base Information

- Base path: `/users`
- Content type: `application/json`
- Auth transport after login: HTTP-only cookies
  - `access_token` (30 minutes)
  - `refresh_token` (30 days)
- Standard status header on all responses: `X-Status-Code`

## Global Response Format

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

### Error Response

```json
{
  "statusCode": 400,
  "message": "Bad Request"
}
```

Notes:
- Error responses do not include `data`.
- `statusCode` is present in both body and `X-Status-Code` header.

---

## 1) Login Step 1 - Send Verification Code

### Endpoint

- `POST /users/login`

### Purpose

Validate credentials, then send/reuse a login verification code via email.

### Request Body

Provide at least one of `email`, `identifier`, or `uname`:

```json
{
  "email": "user@example.com",
  "password": "YourPassword123"
}
```

Alternative:

```json
{
  "identifier": "john_identifier",
  "password": "YourPassword123"
}
```

```json
{
  "uname": "john_uname",
  "password": "YourPassword123"
}
```

### Success Response (email sent)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Verification code sent to your email.",
    "emailSent": true,
    "retryAfterSec": 60,
    "expiresAt": "2026-03-24T10:20:00.000Z"
  }
}
```

### Success Response (cooldown, no resend)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "A valid verification code already exists. Please wait before requesting another email.",
    "emailSent": false,
    "retryAfterSec": 24,
    "expiresAt": "2026-03-24T10:20:00.000Z"
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 400,
  "message": "password must be at least 6 characters"
}
```

```json
{
  "statusCode": 400,
  "message": "email or identifier or uname is required"
}
```

```json
{
  "statusCode": 401,
  "message": "Invalid credentials"
}
```

---

## 2) Login Step 2 - Verify Code and Create Session

### Endpoint

- `POST /users/verify-login`

### Purpose

Verify login code and issue auth cookies.

### Request Body

Provide `code` and one of `email`, `identifier`, `uname`:

```json
{
  "email": "user@example.com",
  "code": "483920"
}
```

### Success Response

Also sets cookies:
- `Set-Cookie: access_token=...; HttpOnly; ...`
- `Set-Cookie: refresh_token=...; HttpOnly; ...`

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "user": {
      "uid": 1,
      "identifier": "john_identifier",
      "uname": "john_uname",
      "email": "user@example.com",
      "level": "client",
      "status": "active",
      "activeEmail": true,
      "useGgauth": false,
      "telegramId": null,
      "discordId": null,
      "zaloId": null,
      "slackId": null,
      "createdAt": "2026-03-24T09:00:00.000Z",
      "updateAt": "2026-03-24T09:00:00.000Z"
    }
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 401,
  "message": "Invalid or expired verification code"
}
```

---

## 3) Forgot Password Step 1 - Request Reset Code

### Endpoint

- `POST /users/forgot-password`

### Purpose

Request password reset code via email.

### Request Body

Provide one of `email`, `identifier`, `uname`:

```json
{
  "email": "user@example.com"
}
```

### Success Response (email sent)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Reset code sent to your email.",
    "emailSent": true,
    "expiresAt": "2026-03-24T10:20:00.000Z",
    "retryAfterSec": 60
  }
}
```

### Success Response (cooldown)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "A valid reset code already exists. Please wait before requesting another email.",
    "emailSent": false,
    "expiresAt": "2026-03-24T10:20:00.000Z",
    "retryAfterSec": 35
  }
}
```

### Success Response (account not found, anti-enumeration)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "If an account with that credential exists, a reset code has been sent.",
    "emailSent": false
  }
}
```

---

## 4) Forgot Password Step 2 - Reset Password

### Endpoint

- `POST /users/reset-password`

### Purpose

Verify reset code and set a new password.

### Request Body

Provide one of `email`, `identifier`, `uname`, plus `code` and `newPassword`:

```json
{
  "email": "user@example.com",
  "code": "902331",
  "newPassword": "NewSecurePassword123"
}
```

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Password has been reset successfully."
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 400,
  "message": "newPassword must be at least 6 characters"
}
```

```json
{
  "statusCode": 400,
  "message": "Invalid or expired reset code"
}
```

---

## 5) Change Password

### Endpoint

- `POST /users/change-password`

### Purpose

Change password for the currently authenticated user.

### Auth Requirement

- Requires valid `access_token` (cookie or Bearer token)

### Request Body

```json
{
  "current_password": "OldPassword123",
  "new_password": "NewPassword456"
}
```

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Password changed successfully."
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 400,
  "message": "current_password is required"
}
```

```json
{
  "statusCode": 400,
  "message": "new_password must be at least 6 characters"
}
```

```json
{
  "statusCode": 401,
  "message": "Current password is incorrect"
}
```

---

## 6) Create User (Owner Only)

### Endpoint

- `POST /users/create`

### Purpose

Owner creates subordinate users (`colleague` or `client` only).

### Auth Requirement

- Requires valid `access_token` (cookie or Bearer token)
- Caller must be `owner`

### Request Body

```json
{
  "username": "new_user",
  "email": "new_user@example.com",
  "password": "StrongPass123",
  "level": "colleague"
}
```

### Rules

- `level` only accepts: `colleague`, `client`
- Creating `owner` is not allowed
- `password` must be at least 6 characters
- `identifier` is auto-derived from BTC path using `SEED_PHRASE` and new `uid`
  - path format: `m/44'/0'/0'/{branch}/{index}`
  - split rule: `branch = floor(uid / 10)`, `index = uid % 10`
  - example: `uid=987` => `m/44'/0'/0'/98/7`

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "User created successfully.",
    "user": {
      "uid": 12,
      "identifier": "1ABC...",
      "uname": "new_user",
      "email": "new_user@example.com",
      "level": "colleague",
      "status": "active"
    }
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 403,
  "message": "Only owner can create users"
}
```

```json
{
  "statusCode": 400,
  "message": "level must be colleague or client"
}
```

---

## 7) Update User (Owner Only)

### Endpoint

- `POST /users/update/:uid`

### Purpose

Owner updates subordinate user fields: `level`, `status`, `password`.

### Auth Requirement

- Requires valid `access_token` (cookie or Bearer token)
- Caller must be `owner`

### Request Body

All fields are optional:

```json
{
  "level": "client",
  "status": "block",
  "password": "newpass123"
}
```

### Rules

- `level` accepts: `colleague`, `client`
- `status` accepts: `active`, `block`
- If `password` is missing: no password update
- If `password` length < 6: no password update
- Updating another `owner` is forbidden

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "User updated successfully.",
    "passwordUpdated": true,
    "user": {
      "uid": 12,
      "identifier": "1ABC...",
      "uname": "new_user",
      "email": "new_user@example.com",
      "level": "client",
      "status": "block"
    }
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 403,
  "message": "Only owner can update users"
}
```

```json
{
  "statusCode": 403,
  "message": "Owner cannot update another owner"
}
```

---

## 8) Logout

### Endpoint

- `POST /users/logout`

### Purpose

Clear `access_token` and `refresh_token` cookies.

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "ok": true
  }
}
```

---

## 9) Update Profile (No Auth)

### Endpoint

- `POST /users/update-profile`

### Purpose

Update social profile fields without authentication.

### Auth Requirement

- None

### Request Body

```json
{
  "uid": 123,
  "telegram_id": "123456789",
  "zalo_id": "zalo_user_01",
  "discord_id": "discord_user_01",
  "slack_id": "slack_user_01",
  "facebook_id": "fb_user_01"
}
```

### Rules

- `uid` is required and must be a positive integer
- Only provided fields are updated
- Empty or missing fields are ignored
- If no valid fields are provided, API returns `"Nothing to update."`

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Profile updated successfully.",
    "user": {
      "uid": 123,
      "identifier": "1ABC...",
      "uname": "john_uname",
      "email": "user@example.com",
      "telegramId": "123456789",
      "zaloId": "zalo_user_01",
      "discordId": "discord_user_01",
      "slackId": "slack_user_01",
      "facebookId": "fb_user_01"
    }
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 400,
  "message": "uid must be a positive integer"
}
```

```json
{
  "statusCode": 400,
  "message": "User not found"
}
```

---

## 10) Update Profile Advanced (2-Step Verification)

### Endpoint

- `POST /users/update-profile-advanced`

### Purpose

Update `uname` and/or `email` but only after verifying a code sent to current email.

### Auth Requirement

- Requires valid `access_token` (cookie or Bearer token)

### Request Body (step 1 - request code)

Send at least one target field, no `code`:

```json
{
  "uname": "new_uname",
  "email": "new_email@example.com"
}
```

### Success Response (step 1)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Verification code sent to your current email.",
    "emailSent": true,
    "expiresAt": "2026-03-24T10:20:00.000Z",
    "retryAfterSec": 60
  }
}
```

### Request Body (step 2 - verify and update)

Send the same desired fields + `code`:

```json
{
  "uname": "new_uname",
  "email": "new_email@example.com",
  "code": "483920"
}
```

### Success Response (step 2)

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "message": "Profile updated successfully.",
    "user": {
      "uid": 123,
      "identifier": "1ABC...",
      "uname": "new_uname",
      "email": "new_email@example.com"
    }
  }
}
```

### Rules

- `uc_type` for this flow: `advanced`
- If `code` is missing, server sends/reuses verification code to current email
- `uname` and `email` are optional, but at least one must be provided
- Fields not sent are not updated
- Duplicate `uname` or `email` is rejected

### Common Error Responses

```json
{
  "statusCode": 400,
  "message": "uname or email is required"
}
```

```json
{
  "statusCode": 400,
  "message": "Invalid or expired verification code"
}
```

---

## 11) Refresh Access/Refresh Tokens

### Endpoint

- `POST /users/refresh-token`

### Purpose

Validate `refresh_token` from cookie, then rotate both tokens.

### Request

No request body required. Must include cookie:
- `refresh_token`

### Success Response

Also sets new cookies (`access_token`, `refresh_token`).

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "user": {
      "uid": 1,
      "identifier": "john_identifier",
      "uname": "john_uname",
      "email": "user@example.com",
      "level": "client",
      "status": "active"
    }
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 401,
  "message": "Missing refresh token"
}
```

```json
{
  "statusCode": 401,
  "message": "Invalid or expired refresh token"
}
```

---

## 12) Get Current User Profile

### Endpoint

- `GET /users/me`

### Purpose

Return current authenticated user (public fields only).

### Auth Requirement

- Requires valid `access_token` (cookie or Bearer token)

### Success Response

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "uid": 1,
    "identifier": "john_identifier",
    "uname": "john_uname",
    "email": "user@example.com",
    "level": "client",
    "status": "active",
    "activeEmail": true,
    "useGgauth": false,
    "telegramId": null,
    "discordId": null,
    "zaloId": null,
    "slackId": null,
    "createdAt": "2026-03-24T09:00:00.000Z",
    "updateAt": "2026-03-24T09:00:00.000Z"
  }
}
```

### Common Error Responses

```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

---

## Frontend Notes

- Always check:
  - HTTP status
  - `X-Status-Code` header
  - JSON `statusCode` in body
- For cookie-based auth from browser, use `credentials: 'include'`.
- During login/reset flows, frontend should:
  1. Call step-1 endpoint (`/login` or `/forgot-password`)
  2. Show input for verification code
  3. Call step-2 endpoint (`/verify-login` or `/reset-password`)
