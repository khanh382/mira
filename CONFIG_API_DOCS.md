# Config API Docs

Tai lieu mo ta API module `config`.

## Tong quan

- Base route: `/config`
- Auth: bat buoc JWT
- Phan quyen: chi `owner` duoc truy cap (`Only owner can manage config`)

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
  "message": "Only owner can manage config"
}
```

## Data model (Config)

Truong chinh:

- API keys:
  - `openaiApiKey`
  - `geminiApiKey`
  - `anthropicApiKey`
  - `openrouterApiKey`
  - `deepseekApiKey`
  - `kimiApiKey`
  - `zaiApiKey`
  - `perplexityApiKey`
  - `braveApiKey`
  - `firecrawlApiKey`
- Local providers:
  - `ollama` (jsonb): `{ baseUrl, apiKey? }`
  - `lmStudio` (jsonb): `{ baseUrl, apiKey? }`
- Scheduler:
  - `schedulerMaxRetriesPerTick`
  - `schedulerMaxConsecutiveFailedTicks`

---

## 1) Xem config

`GET /config/view`

### Quyen

- Chi `owner`.

### Hanh vi

- Tra config hien tai.
- Cac API key se duoc mask thanh chuoi `*************`.
- `ollama.apiKey` va `lmStudio.apiKey` neu co cung bi mask.

### Response example

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {
    "id": 1,
    "openaiApiKey": "*************",
    "geminiApiKey": null,
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "apiKey": "*************"
    },
    "lmStudio": null,
    "schedulerMaxRetriesPerTick": 3,
    "schedulerMaxConsecutiveFailedTicks": 3
  }
}
```

### Loi thuong gap

- `403`: khong phai owner

---

## 2) Cap nhat config

`POST /config/set`

### Quyen

- Chi `owner`.

### Body

- Body la `Partial<Config>`, co the gui 1 hoac nhieu field.
- Neu chua co ban ghi config thi se tao moi.
- Neu da co ban ghi thi se merge va save.

### Request example

```json
{
  "openaiApiKey": "sk-xxx",
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "apiKey": null
  },
  "schedulerMaxRetriesPerTick": 5
}
```

### Response

- `200` + config da luu (khong mask o endpoint set).

### Loi thuong gap

- `403`: khong phai owner

---

## Ghi chu frontend

- Neu can hien thi form config, nen:
  1. Goi `GET /config/view` de lay ban mask.
  2. Khi submit, chi gui field thay doi den `POST /config/set`.
- Khong nen overwrite toan bo object neu form chi sua 1 phan.

