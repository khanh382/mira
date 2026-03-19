# Security Baseline Checklist (Internal Agent Backend)

> Muc tieu: backend noi bo, tap trung, an toan cao cho AI agent.  
> Pham vi channel uu tien: Telegram, Discord, Zalo.

---

## Cach dung tai lieu nay

- Danh dau `[x]` khi da hoan thanh.
- Trien khai theo thu tu: `P0 -> P1 -> P2`.
- Moi muc deu co mapping file/module de implement nhanh.

---

## P0 - Bat buoc truoc khi mo rong user noi bo

### 1) Provider runtime hardening

- [ ] Implement day du provider call that (`openai`, `gemini`, `anthropic`, `openrouter`, `deepseek`)
- [ ] Bat buoc timeout cho moi request model
- [ ] Retry co gioi han + exponential backoff + jitter
- [ ] Circuit breaker khi provider loi lien tuc
- [ ] Fallback provider/model theo policy da dinh nghia
- [ ] Ghi audit metadata: model, latency, tokens, error class

**Files lien quan**
- `src/agent/providers/openai/openai.provider.ts`
- `src/agent/providers/gemini/gemini.provider.ts`
- `src/agent/providers/anthropic/anthropic.provider.ts`
- `src/agent/providers/openrouter/openrouter.provider.ts`
- `src/agent/providers/deepseek/deepseek.provider.ts`
- `src/agent/providers/providers.service.ts`

### 2) Ingress security cho Telegram/Discord/Zalo

- [ ] Verify chu ky webhook/token dung chuan tung nen tang
- [ ] Anti-replay (timestamp + nonce cache)
- [ ] Idempotency key cho request co side-effect
- [ ] Rate limit theo `uid`, `platform_user_id`, `IP`
- [ ] Hard deny khi mapping user khong hop le
- [ ] Structured audit log cho moi webhook event bi tu choi

**Files lien quan**
- `src/gateway/webhooks/telegram-webhook.controller.ts`
- `src/gateway/webhooks/discord-webhook.controller.ts`
- `src/gateway/webhooks/zalo-webhook.controller.ts`
- `src/modules/bot-users/bot-access.service.ts`

### 3) AuthN/AuthZ + policy enforcement

- [ ] JWT validation bat buoc cho REST/WS
- [ ] Role policy (`owner`, `colleague`, `client`) o 1 policy layer trung tam
- [ ] Skill allowlist theo role
- [ ] Model tier allowlist theo role
- [ ] Token/cost quota theo user
- [ ] Chan skill nguy hiem (`exec`, browser side-effect) voi role khong du quyen

**Files lien quan**
- `src/common/guards/*`
- `src/gateway/gateway.controller.ts`
- `src/agent/pipeline/model-router/model-router.service.ts`
- `src/agent/skills/skills.service.ts`
- `src/agent/skills/built-in/runtime/exec.skill.ts`

### 4) Secret management va data protection

- [ ] Khong log plain API keys, token, cookie, OAuth secrets
- [ ] Redaction middleware cho log va skill result
- [ ] Ma hoa truong nhay cam trong DB (at-rest)
- [ ] Restrict file permission cho `BRAIN_DIR` va credentials path
- [ ] Rotate key dinh ky (owner runbook)

**Files lien quan**
- `src/modules/global-config/entities/config.entity.ts`
- `src/modules/global-config/global-config.service.ts`
- `src/agent/skills/built-in/google/gog-cli.service.ts`
- `src/gateway/workspace/workspace.service.ts`

### 5) Audit logging bat bien

- [ ] Tao bang audit log rieng (append-only)
- [ ] Log day du ai-goi-gi-khi-nao-ket-qua-ra-sao
- [ ] Luu request id / run id / thread id de trace
- [ ] Redact thong tin nhay cam trong payload
- [ ] Alert neu co hanh vi bat thuong (spam tool calls, auth fails)

**De xuat table moi**
- `security_audit_logs`
  - `id`, `uid`, `thread_id`, `channel`, `action`, `status`, `severity`, `metadata`, `created_at`

---

## P1 - Nen lam de van hanh on dinh va an toan hon

### 6) Sandboxing cho tool runtime

- [ ] Tach runtime context cho tool side-effect (exec/browser)
- [ ] Allowlist command/binary, chan shell injection vectors
- [ ] Gioi han CPU/memory/runtime cho command dai
- [ ] File system boundary: khong cho truy cap ngoai workspace cho phep

**Files lien quan**
- `src/agent/skills/built-in/runtime/exec.skill.ts`
- `src/agent/skills/built-in/browser/browser.skill.ts`

### 7) Human-in-the-loop cho hanh dong nguy hiem

- [ ] Yeu cau confirm voi hanh dong xoa/sua lon (delete folder, mass update sheet, send external message)
- [ ] Muc approval theo role (owner auto, colleague limited, client bat buoc confirm)
- [ ] Timeout approval + audit decision

**Files lien quan**
- `src/agent/pipeline/steps/agent-run.step.ts`
- `src/agent/skills/*` (nhat la runtime/browser/google/messaging)

### 8) Data retention va privacy

- [ ] Chinh sach TTL cho `chat_messages`, vectors, exports
- [ ] Co che purge theo user/thread
- [ ] Chinh sach xoa du lieu theo yeu cau owner
- [ ] Mask PII o export pipeline neu dung cho train

**Files lien quan**
- `src/agent/learning/vectorization.service.ts`
- `src/agent/learning/export.service.ts`
- `src/modules/chat/chat.service.ts`

### 9) Observability va incident response

- [ ] Metric dashboard (latency, error rate, token usage, cost per user)
- [ ] Alert khi: provider fail spike, webhook reject spike, retry loop spike
- [ ] Log correlation id xuyen suot tu gateway -> pipeline -> skills
- [ ] Runbook xu ly su co (provider down, webhook abuse, cron stuck)

**Files lien quan**
- `src/gateway/gateway.service.ts`
- `src/agent/pipeline/*`
- `src/agent/scheduler/*`

---

## P2 - Hardening va compliance nang cao

### 10) Security self-check command

- [ ] Tao endpoint/command `security check` de scan config nguy hiem
- [ ] Verify bind host, auth mode, webhook secret, rate limit, dangerous skills
- [ ] In ra severity score va remediation guidance

### 11) Disaster recovery

- [ ] Backup DB dinh ky
- [ ] Backup `backend/heart` dinh ky
- [ ] Test restore dinh ky (khong chi backup suong)
- [ ] RTO/RPO muc tieu ro rang

### 12) Secure SDLC

- [ ] Mandatory code review cho file auth/security/skills runtime
- [ ] Secret scan trong CI
- [ ] Dependency vulnerability scan
- [ ] Test suite bat buoc cho access-control va policy

---

## Checklist rieng cho 3 channel muc tieu

### Telegram
- [ ] Verify bot token + webhook secret
- [ ] Enforce `telegram_id -> uid` mapping + grants
- [ ] Rate limit theo sender + chat

### Discord
- [ ] Verify signature request
- [ ] Enforce `discord_id -> uid` mapping + grants
- [ ] Ignore unknown event types by default

### Zalo
- [ ] Verify request signature
- [ ] Enforce `zalo_id -> uid` mapping + grants
- [ ] Replay protection bang timestamp window

---

## Acceptance criteria (Go-Live noi bo)

- [ ] Tat ca muc P0 hoan tat
- [ ] Pen-test noi bo pass (khong co critical/high)
- [ ] Co runbook su co + owner on-call policy
- [ ] Audit log truy vet duoc 100% request den hanh dong skill
- [ ] Cost guardrails hoat dong dung (khong vuot quota da dat)

---

## Ghi chu cho team

- Uu tien "deny by default", sau do mo quyen tung buoc.
- "Safe failure" quan trong hon "always available".
- Bat ky tool nao co side-effect phai co audit + quota + policy gate.
