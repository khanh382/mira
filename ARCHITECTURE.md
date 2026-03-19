# Mira Backend — Kiến trúc Agent System

> NestJS backend kế thừa hooks & tools từ OpenClaw, thiết kế cho hệ thống multi-channel AI agent.

---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Bot Access Control](#bot-access-control)
- [Gateway Layer](#gateway-layer)
- [Heart — Per-User Workspace](#heart--per-user-workspace)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Luồng xử lý chính (Pipeline)](#luồng-xử-lý-chính-pipeline)
- [Smart Model Router](#smart-model-router)
- [Hệ thống Hooks](#hệ-thống-hooks)
  - [Internal Hooks](#1-internal-hooks)
  - [Plugin Hooks](#2-plugin-hooks)
  - [Bảng tổng hợp Hook Events](#bảng-tổng-hợp-hook-events)
  - [Cách đăng ký Hook Handler](#cách-đăng-ký-hook-handler)
- [Hệ thống Skills / Tools](#hệ-thống-skills--tools)
  - [Code Skills (Function Calling)](#1-code-skills-function-calling)
  - [Prompt Skills (ClawhHub)](#2-prompt-skills-clawhub)
  - [Bảng tổng hợp Built-in Skills](#bảng-tổng-hợp-built-in-skills)
  - [Cách tạo Skill mới](#cách-tạo-skill-mới)
- [Channels (Kênh giao tiếp)](#channels-kênh-giao-tiếp)
- [LLM Providers](#llm-providers)
- [Database Schema](#database-schema)
- [Scheduler & Heartbeat](#scheduler--heartbeat)
- [Learning — Vectorization & Fine-Tune Export](#learning--vectorization--fine-tune-export)
- [Mở rộng](#mở-rộng)

---

## Tổng quan

```
┌──────────────────────────────────────────────────────────────────┐
│                        Mira Backend                              │
│                                                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │Telegram │  │ Discord │  │  Zalo   │  │  Slack  │  WebChat   │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  (WS)     │
│       │            │            │            │        │          │
│       └──── Bot Access Control (per-user per-bot) ───┘          │
│                            │                                     │
│                    ┌───────▼────────┐                            │
│                    │  Agent Pipeline │                            │
│                    │  (5 steps)      │                            │
│                    └───────┬────────┘                            │
│           ┌────────────────┼─────────────────┐                  │
│     ┌─────▼─────┐  ┌──────▼──────┐  ┌───────▼───────┐         │
│     │   Hooks   │  │Smart Model  │  │    Skills     │         │
│     │  System   │  │  Router     │  │ (14 code +    │         │
│     │           │  │ (4 tiers)   │  │  ClawhHub)    │         │
│     └───────────┘  └──────┬──────┘  └───────────────┘         │
│                     ┌──────▼──────┐                            │
│                     │ LLM Provider│                            │
│                     │ (5 engines) │                            │
│                     └─────────────┘                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Learning (Cronjob 3h sáng UTC+7)                        │   │
│  │  VectorizationService → _vectors/   (RAG)                │   │
│  │  ExportService        → _exports/   (Fine-tune)          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Database (PostgreSQL + TypeORM)                          │   │
│  │  users │ bot_users │ bot_access_grants │ chat_threads    │   │
│  │  chat_messages │ skills_registry │ config                │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**Framework:** NestJS 10 + TypeScript
**Database:** PostgreSQL + TypeORM
**Kế thừa từ OpenClaw:**
- Dual hook system (Internal + Plugin hooks)
- Message processing pipeline (receive → preprocess → route → agent run → deliver)
- Channel abstraction (multi-platform messaging)
- Skill/Tool system (code-based + prompt-based)
- ClawhHub marketplace integration
- Heart workspace (per-user agent data)

**Không phụ thuộc OpenClaw gateway** — toàn bộ hooks, tools, skills được kế thừa và chạy native trong NestJS.

---

## Bot Access Control

Mỗi user sở hữu bot riêng trên từng platform (Telegram, Discord, Zalo, Slack). Quy tắc truy cập:

```
┌────────────────────────────────────────────────────────────────┐
│  Bot Telegram của User A                                        │
│                                                                  │
│  ✅ telegram_id của User A (owner)     → LUÔN ĐƯỢC PHÉP         │
│  ✅ telegram_id X (đã verified grant)  → ĐƯỢC PHÉP              │
│  ❌ telegram_id Y (chưa verified)      → TỪ CHỐI               │
│  ❌ telegram_id Z (không có grant)     → TỪ CHỐI               │
└────────────────────────────────────────────────────────────────┘
```

### Quy tắc mặc định

Bot của user X trên platform Y → chỉ có `<platform>_id` của user X trong bảng `users` mới được tương tác.

| Platform | Field kiểm tra | Bot token field |
|----------|----------------|-----------------|
| Telegram | `users.telegram_id` | `bot_users.bu_telegram_bot_token` |
| Discord  | `users.discord_id`  | `bot_users.bu_discord_bot_token`  |
| Zalo     | `users.zalo_id`     | `bot_users.bu_zalo_bot_token`     |
| Slack    | `users.slack_id`    | `bot_users.bu_slack_bot_token`    |

### Flow cấp quyền cho người khác (giống OpenClaw allowFrom)

```
1. Owner (qua gateway web) tạo invite:
   POST /gateway/bot-access/invite
   { platform: "telegram", platformUserId: "987654321" }
   → Hệ thống sinh mã 6 ký tự hex (VD: "A3F2B1")
   → Gửi mã cho owner hiển thị

2. Guest nhắn mã vào bot Telegram:
   Guest → Bot: "A3F2B1"
   → Webhook nhận → BotAccessService.verifyCode()
   → Match → đánh dấu is_verified = true

3. Guest giờ có thể tương tác với bot bình thường.

4. Owner có thể thu hồi bất cứ lúc nào:
   DELETE /gateway/bot-access/revoke/:grantId
```

### Bảng `bot_access_grants`

```
bot_access_grants
├── grant_id (PK)
├── bu_id (FK → bot_users)       # Bot nào
├── platform (enum)               # telegram | discord | slack | zalo
├── platform_user_id (varchar)    # ID platform của guest
├── granted_by (FK → users)       # Owner nào cấp
├── verification_code (nullable)  # Mã chờ xác thực (null = đã dùng)
├── is_verified (bool)            # Đã xác thực chưa
└── created_at (timestamp)
```

### Files

| File | Vai trò |
|------|---------|
| `src/modules/bot-users/bot-access.service.ts` | Core logic: checkAccess, createInvite, verifyCode, revokeAccess |
| `src/modules/bot-users/entities/bot-access-grant.entity.ts` | TypeORM entity |
| `src/gateway/webhooks/telegram-webhook.controller.ts` | Access control cho Telegram (đã implement đầy đủ) |
| `src/gateway/webhooks/discord-webhook.controller.ts` | Access control cho Discord (skeleton) |
| `src/gateway/webhooks/zalo-webhook.controller.ts` | Access control cho Zalo (skeleton) |

---

## Gateway Layer

Gateway là lớp tiếp nhận giữa user và agent pipeline. **Cùng port** với HTTP server.

```
  User (Browser / App / Bot Platform)
    │
    ├─── REST API ──────── POST /gateway/message ────┐
    │    (JWT auth)        POST /gateway/reset        │
    │                      GET  /gateway/history      │
    │                      GET  /gateway/skills       │
    │                                                 │
    ├─── WebSocket ─────── ws://host:port/webchat ───┤     GatewayService
    │    (JWT handshake)   event: 'message'           ├────► (orchestrator)
    │                      event: 'reset'             │         │
    │                                                 │         ├─ ThreadResolver
    ├─── Telegram ──────── POST /webhooks/telegram/  ─┤         ├─ WorkspaceService
    │    (Bot Access)      :botToken                  │         ├─ ChatService
    ├─── Discord ───────── POST /webhooks/discord ───┤         └─ AgentService → Pipeline
    └─── Zalo ──────────── POST /webhooks/zalo ──────┘
```

**3 entry points, cùng 1 flow:**

1. **REST** (`POST /gateway/message`) — JWT header → extract userId → resolve thread → pipeline
2. **WebSocket** (`/webchat` namespace) — JWT handshake → map connection → events async
3. **Webhooks** (`/webhooks/*`) — platform gửi update → **Bot Access Control** → resolve owner → pipeline

**Chat Threads:** Mỗi user có thể có nhiều threads (per-platform). `ThreadResolverService` tự động tìm active thread trên platform tương ứng hoặc tạo mới.

**Xử lý song song:** Mỗi request là 1 async operation độc lập. NestJS event loop cho phép hàng trăm users xử lý đồng thời.

**Files:**

| File | Vai trò |
|------|---------|
| `src/gateway/gateway.service.ts` | Orchestrator: auth → resolve thread → pipeline → persist |
| `src/gateway/gateway.controller.ts` | REST endpoints (JWT protected) |
| `src/gateway/gateway.module.ts` | Module wiring |
| `src/gateway/session-resolver/session-resolver.service.ts` | ThreadResolverService: find/create thread per user per platform |
| `src/gateway/workspace/workspace.service.ts` | Quản lý heart/ per-user |
| `src/gateway/webhooks/*.controller.ts` | Telegram, Discord, Zalo webhooks (with access control) |
| `src/agent/channels/webchat/webchat.gateway.ts` | WebSocket (wired to GatewayService) |

---

## Heart — Per-User Workspace

Thư mục `heart/` (configurable qua `BRAIN_DIR` trong .env) lưu trữ dữ liệu agent per-user.

```
heart/
├── _shared/                         ← Tài nguyên DÙNG CHUNG (fallback)
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── TOOLS.md
│   ├── HEARTBEAT.md
│   └── skills/
│
├── <user_identifier_A>/             ← Workspace riêng user A
│   ├── workspace/
│   │   ├── AGENTS.md                ← Override (hoặc kế thừa từ _shared)
│   │   ├── SOUL.md
│   │   ├── IDENTITY.md              ← Riêng user
│   │   ├── USER.md
│   │   ├── TOOLS.md
│   │   ├── HEARTBEAT.md
│   │   ├── MEMORY.md                ← Long-term memory
│   │   ├── GOOGLE_DRIVE.md          ← Auto-tracked Google resources
│   │   └── memory/
│   │       └── 2026-03-19.md
│   ├── sessions/                    ← Chat history JSONL per thread
│   │   └── <threadId>.jsonl
│   └── skills/                      ← Skills riêng user
│
└── <user_identifier_B>/
    └── ... (cấu trúc tương tự)
```

**Logic kế thừa:**
- Khi đọc file → ưu tiên `heart/<identifier>/workspace/X.md` → fallback `heart/_shared/X.md`
- Khi tạo workspace mới → copy templates từ `_shared/`
- User có thể custom mọi thứ (SOUL, IDENTITY, skills) mà không ảnh hưởng user khác

---

## Cấu trúc thư mục

```
backend/src/
├── main.ts
├── app.module.ts
├── app.controller.ts / app.service.ts
│
├── config/
│   ├── app.config.ts
│   └── database.config.ts
│
├── common/guards/
├── middleware/
├── exceptions/
│
│   ┌──────────────────────────────────────────────────────────┐
│   │                     GATEWAY LAYER                         │
│   └──────────────────────────────────────────────────────────┘
├── gateway/
│   ├── gateway.module.ts
│   ├── gateway.service.ts
│   ├── gateway.controller.ts
│   ├── dto/send-message.dto.ts
│   ├── session-resolver/
│   │   └── session-resolver.service.ts    # ThreadResolverService
│   ├── workspace/
│   │   └── workspace.service.ts
│   └── webhooks/
│       ├── telegram-webhook.controller.ts  # + Bot Access Control
│       ├── discord-webhook.controller.ts   # + Bot Access Control
│       └── zalo-webhook.controller.ts      # + Bot Access Control
│
│   ┌──────────────────────────────────────────────────────────┐
│   │                    FEATURE MODULES                        │
│   └──────────────────────────────────────────────────────────┘
├── modules/
│   ├── users/                              # Table: users
│   │   ├── entities/user.entity.ts
│   │   ├── users.service.ts
│   │   ├── users.controller.ts
│   │   └── users.module.ts
│   ├── bot-users/                          # Tables: bot_users + bot_access_grants
│   │   ├── entities/
│   │   │   ├── bot-user.entity.ts
│   │   │   └── bot-access-grant.entity.ts
│   │   ├── bot-users.service.ts
│   │   ├── bot-access.service.ts           # Access control logic
│   │   └── bot-users.module.ts
│   ├── chat/                               # Tables: chat_threads + chat_messages
│   │   ├── entities/
│   │   │   ├── chat-thread.entity.ts
│   │   │   └── chat-message.entity.ts
│   │   ├── threads.service.ts
│   │   ├── chat.service.ts
│   │   └── chat.module.ts
│   └── global-config/                      # Table: config (API keys)
│       ├── entities/config.entity.ts
│       ├── global-config.service.ts
│       └── global-config.module.ts
│
│   ┌──────────────────────────────────────────────────────────┐
│   │                     AGENT SYSTEM                          │
│   └──────────────────────────────────────────────────────────┘
└── agent/
    ├── agent.module.ts
    ├── agent.service.ts
    ├── agent.controller.ts
    │
    ├── hooks/
    │   ├── enums/hook-events.enum.ts
    │   ├── interfaces/
    │   │   ├── hook-event.interface.ts
    │   │   └── hook-handler.interface.ts
    │   ├── decorators/on-hook.decorator.ts
    │   ├── hooks.service.ts
    │   └── hooks.module.ts
    │
    ├── channels/
    │   ├── interfaces/channel.interface.ts
    │   ├── channels.service.ts
    │   ├── channels.module.ts
    │   ├── telegram/telegram.channel.ts
    │   ├── discord/discord.channel.ts
    │   ├── zalo/zalo.channel.ts
    │   ├── slack/slack.channel.ts
    │   └── webchat/webchat.gateway.ts
    │
    ├── providers/
    │   ├── interfaces/llm-provider.interface.ts
    │   ├── providers.service.ts
    │   ├── providers.module.ts
    │   ├── openai/openai.provider.ts
    │   ├── anthropic/anthropic.provider.ts
    │   ├── gemini/gemini.provider.ts
    │   ├── deepseek/deepseek.provider.ts
    │   └── openrouter/openrouter.provider.ts
    │
    ├── skills/
    │   ├── interfaces/skill-runner.interface.ts
    │   ├── decorators/skill.decorator.ts
    │   ├── entities/skill.entity.ts
    │   ├── skills.service.ts
    │   ├── skills.module.ts
    │   │
    │   ├── built-in/
    │   │   ├── web/
    │   │   │   ├── web-search.skill.ts
    │   │   │   └── web-fetch.skill.ts
    │   │   ├── runtime/
    │   │   │   ├── exec.skill.ts
    │   │   │   └── cron-manage.skill.ts
    │   │   ├── browser/
    │   │   │   └── browser.skill.ts
    │   │   ├── media/
    │   │   │   ├── image-understand.skill.ts
    │   │   │   ├── pdf-read.skill.ts
    │   │   │   └── tts.skill.ts
    │   │   ├── memory/
    │   │   │   ├── memory-search.skill.ts
    │   │   │   ├── memory-get.skill.ts
    │   │   │   └── memory-write.skill.ts   # Ghi MEMORY.md, daily, workspace files
    │   │   ├── messaging/
    │   │   │   └── message-send.skill.ts
    │   │   ├── sessions/
    │   │   │   ├── sessions-list.skill.ts   # threads_list
    │   │   │   └── sessions-history.skill.ts # thread_history
    │   │   └── google/
    │   │       ├── google.module.ts
    │   │       ├── gog-cli.service.ts       # CLI wrapper per-user
    │   │       ├── google-workspace.skill.ts # 15 skill: Google Workspace
    │   │       └── drive-tracker.service.ts  # Auto-track → GOOGLE_DRIVE.md
    │   │
    │   └── clawhub/
    │       ├── interfaces/clawhub-skill.interface.ts
    │       ├── clawhub-loader.service.ts
    │       └── clawhub.module.ts
    │
    └── pipeline/
        ├── interfaces/pipeline-context.interface.ts
        ├── pipeline.service.ts
        ├── pipeline.module.ts
        ├── model-router/
        │   ├── model-tier.enum.ts          # ModelTier, IntentType, MODEL_PRIORITY
        │   ├── model-router.service.ts     # Smart routing logic (4 bước)
        │   └── model-router.module.ts
        └── steps/
            ├── receive.step.ts
            ├── preprocess.step.ts
            ├── route.step.ts               # Tích hợp ModelRouterService
            ├── agent-run.step.ts           # Mid-pipeline model switching
            └── deliver.step.ts
    │
    ├── scheduler/
    │   ├── entities/scheduled-task.entity.ts
    │   ├── scheduled-tasks.service.ts      # Retry policy + circuit breaker
    │   ├── heartbeat.service.ts            # Parse HEARTBEAT.md → cron tasks
    │   └── scheduler.module.ts
    │
    └── learning/
        ├── vectorization.service.ts        # Cronjob 3h sáng: embed → vectors
        ├── export.service.ts               # Cronjob 3h sáng: xuất .jsonl fine-tune
        └── learning.module.ts

heart/                                      # BRAIN_DIR (per-user workspace)
├── _vectors/                               # Vector embeddings (per userId)
│   ├── 1/                                  # userId = 1
│   │   ├── <msg_id>.json                   # { vector, content, role, ... }
│   │   └── ...
│   └── 2/
├── _exports/                               # Fine-tune .jsonl (per userId)
│   ├── 1/
│   │   ├── 2026-03-19.jsonl               # Raw messages + training pairs
│   │   └── ...
│   └── 2/
├── _shared/                                # Shared workspace files
└── <identifier>/                           # Per-user workspace
```

---

## Luồng xử lý chính (Pipeline)

```
  User Request (REST / WebSocket / Webhook)
       │
       ▼
  ┌─────────────────────────────────────────────────────────┐
  │ GATEWAY LAYER                                           │
  │   • JWT Auth (REST/WS) hoặc Bot Access (Webhooks)      │
  │   • Extract userId từ token / platform mapping          │
  │   • ThreadResolver: find/create thread per-user         │
  │   • WorkspaceService: ensure heart/<identifier>/        │
  │   • Persist user message → DB + JSONL                   │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  Inbound Message (đã có userId + threadId)
       │
       ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 1: RECEIVE                                         │
  │   • Nhận message từ channel                             │
  │   • 🔔 Internal: message.received                       │
  │   • 🔔 Plugin:   MESSAGE_RECEIVED (modifiable)          │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 2: PREPROCESS                                      │
  │   • ★ Load system context (SOUL, USER, AGENTS, MEMORY) │
  │   • ★ Load 15 tin nhắn gần nhất từ DB → history        │
  │   • Audio transcription, image description              │
  │   • 🔔 Internal: message.transcribed                    │
  │   • 🔔 Plugin:   BEFORE_PROMPT_BUILD (modifiable)       │
  │   • 🔔 Internal: message.preprocessed                   │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 3: ROUTE (Smart Model Router)                      │
  │   • Heuristic intent classification (không gọi LLM)    │
  │   • Resolve minModelTier từ active skills               │
  │   • User level gate (Owner/Colleague/Client)            │
  │   • Fallback chain nếu provider unavailable             │
  │   • 🔔 Plugin:   BEFORE_MODEL_RESOLVE (modifiable)      │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 4: AGENT RUN (Multi-Model Agent Loop)              │
  │   • 🔔 Plugin: BEFORE_AGENT_START, SESSION_START        │
  │   • ┌─── Agent Loop (max 15 iterations) ──────────┐    │
  │   │ │ 1. 🔔 LLM_INPUT hook                        │    │
  │   │ │ 2. Call LLM (with auto-retry on error)      │    │
  │   │ │ 3. 🔔 LLM_OUTPUT hook                       │    │
  │   │ │ 4. If no tool_calls → return final response  │    │
  │   │ │ 5. For each tool_call:                       │    │
  │   │ │    🔔 BEFORE_TOOL_CALL → execute skill       │    │
  │   │ │ 6. 🔔 AFTER_TOOL_CALL                        │    │
  │   │ │ 7. ★ Mid-loop model switch:                  │    │
  │   │ │    • Big data (>50K) → PROCESSOR (Gemini)    │    │
  │   │ │    • After processing → back to SKILL        │    │
  │   │ │    • Iteration ≥8 → EXPERT (DeepSeek-R1)    │    │
  │   │ │ 8. Loop back to step 1                       │    │
  │   │ └──────────────────────────────────────────────┘    │
  │   • On error: auto-fallback to different model          │
  │   • 🔔 Plugin: AGENT_END, SESSION_END                   │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 5: DELIVER                                         │
  │   • 🔔 Plugin:   MESSAGE_SENDING (modifiable)           │
  │   • Gửi response qua target channel                     │
  │   • 🔔 Internal: message.sent                           │
  │   • 🔔 Plugin:   MESSAGE_SENT                           │
  └─────────────────────────────────────────────────────────┘
```

**Pipeline context** dùng `threadId` (UUID) thay vì `sessionId` (integer).

---

## Smart Model Router

Hệ thống định tuyến model thông minh — tự động chọn LLM phù hợp theo tác vụ, tiết kiệm chi phí.

### Nhóm Model (ModelTier)

| Tier | Tên gọi | Models ưu tiên | Đặc điểm |
|------|---------|-----------------|-----------|
| `cheap` | The Grunt | DeepSeek-V3 → Gemini 1.5 Flash → GPT-4o-mini | Phân loại intent, chào hỏi, câu hỏi ngắn |
| `skill` | The Artisan | Claude 3.5 Sonnet → GPT-4o → DeepSeek-V3 | Gọi Tool, GOG CLI, Playwright, viết code |
| `processor` | The Processor | Gemini 1.5 Flash → Gemini 1.5 Pro → DeepSeek-V3 | Xử lý dữ liệu lớn (1M+ context) |
| `expert` | The Architect | DeepSeek-R1 → GPT-4o → Claude 3.5 Sonnet | Suy luận đa bước, lập kế hoạch phức tạp |

### Luồng Routing 4 Bước

```
  User Message
       │
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Bước 1: TRIAGE (Heuristic — không gọi LLM)                 │
  │   • Phân loại intent: smalltalk / tool_call / big_data /    │
  │     reasoning                                                │
  │   • Dựa vào keyword matching + message length               │
  └────────────────────────┬────────────────────────────────────┘
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Bước 2: SKILL TIER CHECK                                    │
  │   • Nếu active skills yêu cầu min_model_tier > intent tier  │
  │   • → Upgrade lên tier cao hơn                               │
  │   • Ví dụ: intent=smalltalk nhưng active skill=browser      │
  │     → tier upgrade từ CHEAP lên SKILL                        │
  └────────────────────────┬────────────────────────────────────┘
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Bước 3: USER LEVEL GATE                                     │
  │   • Owner:     Mặc định SKILL cho mọi thứ, EXPERT khi      │
  │                cần reasoning                                 │
  │   • Colleague:  Theo routing tiết kiệm, EXPERT khi cần     │
  │   • Client:    Theo routing tiết kiệm, chặn EXPERT →       │
  │                downgrade về SKILL                             │
  └────────────────────────┬────────────────────────────────────┘
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ Bước 4: FALLBACK CHAIN                                      │
  │   • Duyệt models trong tier theo thứ tự ưu tiên             │
  │   • Nếu provider không có API key → skip                    │
  │   • Nếu không model nào available → thử qua OpenRouter      │
  │   • Emergency: tìm BẤT KỲ model nào có key                  │
  │   • Cuối cùng: dùng DEFAULT_MODEL từ .env                   │
  └─────────────────────────────────────────────────────────────┘
```

### Mid-Pipeline Model Switching

Trong `AgentRunStep`, model có thể tự động đổi giữa pipeline:

| Tình huống | Model chuyển sang |
|------------|-------------------|
| Tool trả về >50K chars dữ liệu | → PROCESSOR (Gemini Flash) |
| Kết quả mâu thuẫn / cần reasoning | → EXPERT (DeepSeek-R1) |
| Model lỗi kết nối (timeout, 429, 503) | → Fallback model khác trong tier |

### Tích hợp vào Database

Bảng `skills_registry` có thêm cột `min_model_tier`:

```sql
ALTER TABLE skills_registry
ADD COLUMN min_model_tier VARCHAR(20) DEFAULT 'cheap';
-- Giá trị: 'cheap', 'skill', 'processor', 'expert'
```

Ví dụ cấu hình:

| Skill | min_model_tier | Lý do |
|-------|---------------|-------|
| `web_search` | `cheap` | Chỉ cần gọi API, không cần model mạnh |
| `browser`, `exec`, `google_workspace` | `skill` | Cần Claude Sonnet để tránh lỗi logic |
| `cron_manage`, `message_send` | `skill` | Gửi nhầm message/email = nguy hiểm |
| Skill "Phân tích tài chính" (custom) | `expert` | Cần reasoning đa bước |

### Cost Control theo User Level

```
Owner (Kim)      → SKILL tier mặc định cho mọi thứ
                 → EXPERT khi cần reasoning phức tạp
                 → CHEAP chỉ cho smalltalk

Colleague        → CHEAP mặc định
                 → Auto-upgrade khi skill yêu cầu
                 → EXPERT khi cần (được phép)

Client           → CHEAP mặc định
                 → Auto-upgrade khi skill yêu cầu
                 → EXPERT bị chặn → downgrade về SKILL
```

### Files

```
src/agent/pipeline/model-router/
├── model-tier.enum.ts         # ModelTier, IntentType, MODEL_PRIORITY
├── model-router.service.ts    # Smart routing logic
└── model-router.module.ts     # NestJS module
```

---

## Hệ thống Hooks

Kế thừa dual-hook system từ OpenClaw, map sang NestJS patterns:

### 1. Internal Hooks

**Bản chất:** Event-driven, fire-and-forget, chạy song song.
**NestJS pattern:** `@nestjs/event-emitter` (EventEmitter2)

```typescript
await hooksService.emitInternal(InternalHookEvent.MESSAGE_RECEIVED, {
  sessionKey: 'thread:abc-123',
  userId: 1,
  context: { channelId: 'telegram', content: 'Hello' },
});
```

### 2. Plugin Hooks

**Bản chất:** Priority-ordered, chạy tuần tự, có thể modify data.
**NestJS pattern:** Custom registry trong `HooksService`.

```typescript
const modifiedContext = await hooksService.executePluginHook(
  PluginHookName.BEFORE_MODEL_RESOLVE,
  { model: 'gpt-4o', userId: 1 },
);
```

### Bảng tổng hợp Hook Events

#### Internal Hooks (fire-and-forget)

| Event | Khi nào fire | Dữ liệu |
|-------|-------------|----------|
| `message.received` | Nhận message từ channel | channelId, content, senderId |
| `message.transcribed` | Sau audio transcription | transcript |
| `message.preprocessed` | Sau xử lý media + link | processedContent |
| `message.sent` | Sau khi gửi response | channelId, content |
| `agent.bootstrap` | Agent system khởi tạo | phase |
| `gateway.startup` | Channels + hooks sẵn sàng | channels, providers, skills |
| `gateway.shutdown` | App đang tắt | — |

#### Plugin Hooks (modifiable, sequential)

| Hook Name | Khi nào fire | Có thể modify |
|-----------|-------------|---------------|
| `before_model_resolve` | Trước khi chọn LLM model | model, userId |
| `before_prompt_build` | Trước khi build system prompt | content, transcript |
| `before_agent_start` | Trước khi bắt đầu agent loop | model, threadId |
| `llm_input` | Trước khi gọi LLM | messages[], tools[] |
| `llm_output` | Sau khi nhận response từ LLM | content, tokensUsed |
| `agent_end` | Sau khi agent loop kết thúc | tokensUsed |
| `message_received` | Nhận message (modifiable) | content, channelId |
| `message_sending` | Trước khi gửi response | content, targetId |
| `message_sent` | Sau khi gửi thành công | content, channelId |
| `before_tool_call` | Trước khi execute skill | skillCode, parameters |
| `after_tool_call` | Sau khi skill trả kết quả | skillCode, result |
| `session_start` | Bắt đầu pipeline run | threadId, userId |
| `session_end` | Kết thúc pipeline run | threadId |

### Cách đăng ký Hook Handler

**Decorator (khuyến khích):**

```typescript
@Injectable()
export class MyHookHandlers {
  @OnHook(PluginHookName.BEFORE_MODEL_RESOLVE, { priority: 10 })
  async overrideModel(context: { model: string; userId: number }) {
    if (context.userId === 1) {
      context.model = 'anthropic/claude-sonnet-4-20250514';
    }
    return context;
  }
}
```

**Programmatic:**

```typescript
hooksService.registerPluginHook(
  PluginHookName.LLM_OUTPUT,
  async (ctx) => {
    ctx.content = ctx.content.replace(/secret/gi, '***');
    return ctx;
  },
  5,
);
```

---

## Hệ thống Skills / Tools

```
┌─────────────────────────────────────────────────────┐
│              LLM (function calling + prompt)         │
│                                                     │
│  tools: [web_search, exec, browser, ...]            │
│  system_prompt: <available_skills>...</>             │
├──────────────────┬──────────────────────────────────┤
│  Code Skills     │     Prompt Skills                │
│  (ISkillRunner)  │     (IPromptSkill / ClawhHub)    │
│                  │                                  │
│  LLM gọi qua    │     Inject vào system prompt     │
│  function call   │     LLM đọc SKILL.md rồi dùng   │
│  → execute()     │     code skills để thực thi      │
├──────────────────┴──────────────────────────────────┤
│              SkillsService (unified)                │
└─────────────────────────────────────────────────────┘
```

### 1. Code Skills (Function Calling)

```typescript
interface ISkillRunner {
  readonly definition: ISkillDefinition;
  execute(context: ISkillExecutionContext): Promise<ISkillResult>;
}
```

### 2. Prompt Skills (ClawhHub)

Load từ 3 nguồn (priority thấp → cao):
1. `backend/skills/` — bundled
2. `~/.mira/skills/` — cài qua `clawhub install`
3. `<workspace>/skills/` — riêng user

### Bảng tổng hợp Built-in Skills

| # | Code | Category | Mô tả | External API |
|---|------|----------|-------|-------------|
| 1 | `web_search` | `web` | Tìm kiếm web real-time | Brave Search / Perplexity |
| 2 | `web_fetch` | `web` | Fetch & extract nội dung URL | Firecrawl / direct fetch |
| 3 | `exec` | `runtime` | Chạy shell command (owner-only) | child_process |
| 4 | `cron_manage` | `runtime` | Quản lý cron/scheduled jobs | NestJS SchedulerRegistry |
| 5 | `browser` | `browser` | Điều khiển headless browser | Playwright |
| 6 | `image_understand` | `media` | Phân tích hình ảnh (vision) | GPT-4o / Claude / Gemini |
| 7 | `pdf_read` | `media` | Trích xuất text từ PDF | pdf-parse |
| 8 | `tts` | `media` | Text → Speech audio | OpenAI TTS API |
| 9 | `memory_search` | `memory` | Tìm kiếm ngữ nghĩa | Vector DB |
| 10 | `memory_get` | `memory` | Đọc file memory | filesystem |
| 11 | `memory_write` | `memory` | Ghi/append vào MEMORY.md, daily memory, workspace files | filesystem |
| 12 | `message_send` | `messaging` | Gửi tin nhắn qua channel | ChannelsService |
| 13 | `threads_list` | `sessions` | Liệt kê chat threads | ThreadsService |
| 14 | `thread_history` | `sessions` | Lấy lịch sử chat thread | ChatService |
| 15 | `google_workspace` | `google` | Gmail, Calendar, Drive, Sheets, Docs, Tasks... | [gogcli](https://github.com/steipete/gogcli) |

### Google Workspace Skill (gogcli)

Tích hợp Google Workspace thông qua binary CLI [gogcli](https://github.com/steipete/gogcli). Mỗi user có tài khoản Google riêng biệt, xử lý song song.

```
┌──────────────────────────────────────────────────────────┐
│  LLM function call: google_workspace                      │
│  { service: "sheets", action: "get <id> A1:B10" }       │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│  GoogleWorkspaceSkill                                     │
│    → GogCliService.exec({userId, args, json: true})      │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│  gog --client user_<uid> --account <email> --json        │
│      sheets get <spreadsheetId> 'Sheet1!A1:B10'          │
│                                                           │
│  Auth: encrypted file keyring (per-user credentials)     │
│  Isolation: --client user_<uid> → token bucket riêng     │
└──────────────────────────────────────────────────────────┘
```

**Per-user isolation:**

| Concept | Cách xử lý |
|---------|------------|
| Credentials | `bot_users.bu_google_console_cloud_json_path` — mỗi user trỏ tới file OAuth JSON riêng |
| Token bucket | `--client user_<uid>` — gogcli isolate refresh token per client name |
| Account | `--account <email>` — Google account email của user |
| Song song | Async `child_process.execFile()` — User1 và User2 chạy gog đồng thời, không block |

**Ví dụ sử dụng tự nhiên (LLM gọi):**

```
User: "Tạo báo cáo doanh thu tháng 3 trên Google Sheets"
→ google_workspace(service: "sheets", action: "create 'Báo cáo T3'")
→ google_workspace(service: "sheets", action: "update <newId> A1 'Ngày|Doanh thu|Ghi chú'")

User: "Gửi email cho team về cuộc họp ngày mai"
→ google_workspace(service: "calendar", action: "events primary --tomorrow")
→ google_workspace(service: "gmail", action: "send --to team@company.com --subject 'Lịch họp ngày mai' --body '...'")

User: "Đọc file báo cáo mới nhất trên Drive"
→ google_workspace(service: "drive", action: "search 'báo cáo' --max 5")
→ google_workspace(service: "docs", action: "cat <docId>")
```

**Auto-install gogcli:**

Khi backend start, `GogCliService.onModuleInit()` tự kiểm tra và cài đặt:

1. Kiểm tra `gog` trong PATH (hoặc `GOG_BIN` env)
2. Kiểm tra local build tại `.gogcli/bin/gog`
3. Nếu chưa có → thử `brew install gogcli`
4. Nếu brew không có → `git clone` + `make` vào `.gogcli/`
5. Không cài được → log warning, skill trả lỗi rõ ràng

Yêu cầu tối thiểu: `git` + `go` (để build from source) hoặc `brew`.

**Setup per-user:**

1. Admin tạo OAuth Desktop client trên Google Cloud Console
2. Lưu JSON file path vào `bot_users.bu_google_console_cloud_json_path`
3. Chạy setup credentials: `gog --client user_<uid> auth credentials <path>`
4. Auth user: `gog --client user_<uid> auth add <email> --services user`
5. Lưu email vào env `GOG_ACCOUNT_USER_<uid>=<email>`

**Files:**

| File | Vai trò |
|------|---------|
| `src/agent/skills/built-in/google/gog-cli.service.ts` | CLI wrapper, per-user auth, exec isolation |
| `src/agent/skills/built-in/google/google-workspace.skill.ts` | Skill entry point, args builder, auto-tracking |
| `src/agent/skills/built-in/google/drive-tracker.service.ts` | Auto-track create/update/delete → GOOGLE_DRIVE.md |
| `src/agent/skills/built-in/google/google.module.ts` | Module wiring (imports BotUsersModule, UsersModule, WorkspaceModule) |

### Drive Tracker — Auto-tracking Google Resources

Mỗi khi `google_workspace` skill thực thi thành công một thao tác tạo/sửa/xóa,
`DriveTrackerService` tự động cập nhật file `GOOGLE_DRIVE.md` trong workspace user.

```
google_workspace.execute() → success
    │
    ▼ DriveTrackerService.trackOperation(userId, service, action, result)
    │
    ├── detectOperation() → create | update | delete | rename
    │
    ├── loadState() ← đọc GOOGLE_DRIVE.md (JSON ẩn trong HTML comment)
    │
    ├── handleCreate/Update/Delete/Rename → cập nhật state
    │
    └── saveState() → ghi GOOGLE_DRIVE.md (Markdown đọc được + JSON backup)
```

**Tự động detect các thao tác:**

| Service | Verb | Tracked |
|---------|------|---------|
| `sheets` | `create`, `update`, `append`, `delete` | Spreadsheet ID, name, sheets list |
| `docs` | `create`, `delete` | Document ID, name |
| `slides` | `create`, `delete` | Presentation ID, name |
| `drive` | `mkdir`, `upload`, `rm`, `trash`, `rename`, `mv` | Folder/File ID, name, parent |

**Ví dụ GOOGLE_DRIVE.md tự động sinh:**

```markdown
# Google Drive — Tracked Resources

## Spreadsheets (2)

- **Báo cáo hôm nay** `1BxiMVs...` — [Open](https://docs.google.com/spreadsheets/d/1BxiMVs...)
  - Sheets: Sheet1, Tuần 12
  - Updated: 2026-03-19 10:30

- **Doanh thu T3** `2CyNWt...` — [Open](https://docs.google.com/spreadsheets/d/2CyNWt...)
  - Sheets: Tổng hợp
  - Updated: 2026-03-18 15:00

## Folders (1)

- **Báo cáo 2026** `3DzOXu...`
  - Updated: 2026-03-17 09:00

## Deleted (1)

> These items have been deleted. Do not reference them.

- ~~Bản nháp~~ `4EaPYv...` (spreadsheet) — deleted 2026-03-18 14:00
```

**Tích hợp vào System Context:**

`buildAgentSystemContext()` tự động đọc `GOOGLE_DRIVE.md` (bỏ JSON ẩn) → agent luôn biết:
- Spreadsheet nào đang tồn tại (có ID, tên, danh sách sheets)
- Folder nào đã tạo
- File nào đã xóa (tránh gọi nhầm)

### Memory Write Skill & Conversation Context

Agent có khả năng **ghi nhớ** thông tin quan trọng qua 2 cơ chế:

**1. Tự động — PreprocessStep load context mỗi lượt chat:**

```
PreprocessStep.execute(context)
    │
    ├── loadSystemContext()
    │   └── UsersService.findById(userId) → identifier
    │   └── WorkspaceService.buildAgentSystemContext(identifier)
    │       → SOUL.md + USER.md + AGENTS.md + MEMORY.md + daily memory
    │       → inject làm system message đầu tiên
    │
    └── loadConversationHistory()
        └── ChatService.getRecentMessages(threadId, 15)
            → 15 tin nhắn gần nhất (user + assistant)
            → append vào conversationHistory
```

Kết quả `conversationHistory` gửi cho LLM:
```
[system: SOUL + USER + AGENTS + MEMORY + daily]
[user: "tin nhắn cũ 1"]
[assistant: "trả lời cũ 1"]
[user: "tin nhắn cũ 2"]
[assistant: "trả lời cũ 2"]
...
[user: "tin nhắn hiện tại"]    ← append ở AgentRunStep
```

**2. Chủ động — Agent gọi `memory_write` skill:**

| Action | Mô tả | File đích |
|--------|--------|----------|
| `append_memory` | Append vào long-term memory (có timestamp) | `MEMORY.md` |
| `write_memory` | Ghi đè toàn bộ MEMORY.md | `MEMORY.md` |
| `append_daily` | Ghi note hôm nay (có giờ) | `memory/YYYY-MM-DD.md` |
| `write_file` | Ghi file bất kỳ trong workspace | `<filename>` |
| `append_file` | Append vào file bất kỳ | `<filename>` |

**Ví dụ: User yêu cầu tạo Google Sheet và agent tự nhớ:**

```
User: "Tạo Google Sheet Báo cáo hôm nay"
    │
    ▼ Agent gọi google_workspace(sheets, "create 'Báo cáo hôm nay'")
    │ → Kết quả: { spreadsheetId: "1BxiMVs..." }
    │
    ▼ Agent gọi memory_write(append_memory, "Google Sheet 'Báo cáo hôm nay': ID=1BxiMVs...")
    │ → Lưu vào heart/<user>/workspace/MEMORY.md
    │
    ▼ Agent trả lời: "Đã tạo Sheet thành công!"

User (lượt sau): "Thêm sheet mới tên 'Tuần 12' vào file báo cáo"
    │
    ▼ PreprocessStep load MEMORY.md → agent biết ID = 1BxiMVs...
    │
    ▼ Agent gọi google_workspace(sheets, "...")
```

### Cách tạo Skill mới

```typescript
@RegisterSkill({
  code: 'my_skill',
  name: 'My Skill',
  description: 'Does something. Use when...',
  category: SkillCategory.CUSTOM,
  parametersSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
  },
})
@Injectable()
export class MySkill implements ISkillRunner {
  get definition(): ISkillDefinition { /* ... */ }
  async execute(context: ISkillExecutionContext): Promise<ISkillResult> { /* ... */ }
}
```

Thêm class vào `SkillsModule.providers` → auto-discover bởi `@RegisterSkill()`.

---

## Channels (Kênh giao tiếp)

```typescript
interface IChannelAdapter {
  readonly meta: IChannelMeta;
  readonly capabilities: IChannelCapabilities;
  initialize(config): Promise<void>;
  shutdown(): Promise<void>;
  sendMessage(message: IOutboundMessage): Promise<void>;
  isConfigured(): boolean;
}
```

| Channel | File | Transport | Token source |
|---------|------|-----------|-------------|
| Telegram | `telegram/telegram.channel.ts` | HTTP Bot API | `bot_users.bu_telegram_bot_token` |
| Discord | `discord/discord.channel.ts` | WebSocket | `bot_users.bu_discord_bot_token` |
| Zalo | `zalo/zalo.channel.ts` | HTTP OA API | `bot_users.bu_zalo_bot_token` |
| Slack | `slack/slack.channel.ts` | HTTP Web API | `bot_users.bu_slack_bot_token` |
| WebChat | `webchat/webchat.gateway.ts` | Socket.IO | JWT auth |

---

## LLM Providers

```typescript
interface ILlmProvider {
  readonly providerId: string;
  readonly displayName: string;
  readonly supportedModels: string[];
  isConfigured(): boolean;
  chat(options: ILlmRequestOptions): Promise<ILlmResponse>;
}
```

| Provider | Models | API Key |
|----------|--------|---------|
| OpenAI | gpt-4o, gpt-4o-mini, o1, o3-mini | `cof_openai_api_key` |
| Anthropic | claude-sonnet-4, claude-opus-4 | `cof_anthropic_api_key` |
| Gemini | gemini-2.5-pro, gemini-2.5-flash | `cof_gemini_api_key` |
| DeepSeek | deepseek-chat, deepseek-reasoner | `cof_deepseek_api_key` |
| OpenRouter | Any model (meta-provider) | `cof_openrouter_api_key` |

---

## Database Schema

```
┌──────────────┐     ┌────────────────┐     ┌──────────────────┐
│   config     │     │    users       │     │   bot_users      │
│──────────────│     │────────────────│     │──────────────────│
│ cof_id (PK)  │     │ uid (PK)       │◄────│ bu_uid (FK, UQ)  │
│ openai_key   │     │ identifier     │     │ telegram_token   │
│ gemini_key   │     │ uname          │     │ discord_token    │
│ anthropic_key│     │ email          │     │ slack_token      │
│ openrouter...|     │ telegram_id    │     │ zalo_token       │
│ deepseek_key │     │ discord_id     │     │ google_json_path │
│ kimi_key     │     │ zalo_id        │     └────────┬─────────┘
│ zai_key      │     │ slack_id       │              │
│ perplexity...|     │ facebook_id    │     ┌────────▼──────────┐
│ brave_key    │     │ password       │     │ bot_access_grants │
│ firecrawl_key│     │ level (enum)   │     │───────────────────│
└──────────────┘     │ status (enum)  │     │ grant_id (PK)     │
                     └───────┬────────┘     │ bu_id (FK)        │
                             │              │ platform (enum)   │
              ┌──────────────┼──────┐       │ platform_user_id  │
              ▼                     ▼       │ granted_by (FK)   │
┌─────────────────────┐  ┌────────────┐    │ verification_code │
│   chat_threads      │  │chat_messages│   │ is_verified       │
│─────────────────────│  │────────────│    └───────────────────┘
│ thread_id (PK, UUID)│◄─│thread_id(FK)│
│ uid (FK)            │  │msg_id(UUID) │   ┌─────────────────────┐
│ platform (enum)     │  │uid (FK)     │   │  skills_registry    │
│ title               │  │role (enum)  │   │─────────────────────│
│ is_active           │  │content      │   │ skill_id (PK)       │
│ created_at          │  │tokens_used  │   │ skill_code (UQ)     │
│ updated_at          │  │is_vectorized│   │ skill_name          │
└─────────────────────┘  │is_exported  │   │ description         │
                         │created_at   │   │ file_path           │
                         └────────────┘    │ parameters_schema   │
                                           │ is_active           │
                                           └─────────────────────┘
```

### Thay đổi so với phiên bản trước

| Trước | Sau | Lý do |
|-------|-----|-------|
| `config.cof_openclaw_token_gateway` | **Xóa** | Không phụ thuộc OpenClaw gateway nữa |
| `users.zalogram_id` | `users.telegram_id` | Đổi tên chính xác hơn |
| — | `users.discord_id`, `users.slack_id` | Bổ sung platform IDs |
| `openclaw_sessions` | **Xóa** → thay bằng `chat_threads` | Multi-thread per user, per platform |
| `chat_messages.os_id` (FK → sessions) | `chat_messages.thread_id` (FK → threads) | Reference chat_threads |
| — | `bot_access_grants` (bảng mới) | Access control per-bot |
| `bot_users.google_workspace_token` | `bot_users.google_console_cloud_json_path` | Chính xác hơn |

---

## Scheduler & Heartbeat

Hệ thống tác vụ tự động, kế thừa concept HEARTBEAT.md từ OpenClaw.

### Kiến trúc

```
  HEARTBEAT.md (per-user)          Owner yêu cầu agent
       │                                 │
       ▼                                 ▼
  HeartbeatService              cron_manage skill
  (parse MD → tasks)            (add/remove/pause/resume)
       │                                 │
       └──────────┬──────────────────────┘
                  ▼
         ScheduledTasksService
         ┌────────────────────────────────────────┐
         │  Cho mỗi task:                          │
         │  1. CronJob tick theo cronExpression     │
         │  2. Concurrent lock (1 instance/task)    │
         │  3. Gọi PipelineService.processMessage() │
         │  4. Retry policy + circuit breaker       │
         └────────────────────────────────────────┘
                  │
          ┌───────▼────────┐
          │ Agent Pipeline  │
          │ (Smart Router)  │
          └────────────────┘
```

### Retry Policy & Circuit Breaker (Quy tắc chung)

**Owner thiết lập trong bảng `config`** (hoặc qua `cron_manage` action `set_global_rules`):
- `cof_scheduler_max_retries_per_tick` = 3 (số lần thử trong 1 lượt tick)
- `cof_scheduler_max_consecutive_failed_ticks` = 3 (số lượt tick liên tiếp fail → tự đóng)

**Áp dụng cho mọi user**, kể cả owner.

```
Lượt tick 1:
  Thử lần 1 → FAIL
  Thử lần 2 → FAIL
  Thử lần 3 → FAIL
  → Bỏ qua lượt này, chờ lượt tiếp theo. consecutiveFailures = 1

Lượt tick 2:
  Thử lần 1 → FAIL
  Thử lần 2 → FAIL
  Thử lần 3 → FAIL
  → Bỏ qua lượt này. consecutiveFailures = 2

Lượt tick 3:
  Thử lần 1 → FAIL
  Thử lần 2 → FAIL
  Thử lần 3 → FAIL
  → TỰ ĐÓNG TASK ⛔ (không chạy nữa cho đến khi owner resume)

--- Owner resume ---

Lượt tick 4:
  Thử lần 1 → SUCCESS → consecutiveFailures = 0 ✅
```

**Safeguards chống tốn tài nguyên:**

| Safeguard | Mô tả |
|-----------|-------|
| `maxRetriesPerTick` (config, default: 3) | Trong 1 lượt tick: thử tối đa N lần, fail hết → bỏ qua lượt |
| `maxConsecutiveFailedTicks` (config, default: 3) | M lượt tick liên tiếp fail → tự đóng task |
| `timeoutMs` (per-task, default: 120s) | Mỗi lần chạy tối đa 2 phút |
| Concurrent lock | Nếu task đang chạy → skip tick hiện tại |
| `maxModelTier` | Giới hạn tier tối đa (ví dụ: `cheap` cho task đơn giản) |
| `allowedSkills` | Chỉ cho phép skill cụ thể (tránh agent "mò" skill đắt tiền) |
| Smart Router | Tự chọn model rẻ nhất phù hợp |

### HEARTBEAT.md Format

File `heart/<user>/workspace/HEARTBEAT.md`:

```markdown
## Kiểm tra email mới
- cron: 0 */1 * * *
- prompt: Kiểm tra Gmail, nếu có email quan trọng thì báo qua Telegram
- skills: google_workspace, message_send
- retries: 3
- tier: skill

## Báo cáo hàng ngày
- cron: 0 7 * * *
- prompt: Tạo báo cáo tổng hợp email + calendar hôm nay trên Google Sheet
- skills: google_workspace
- retries: 2
- timeout: 180000
```

HeartbeatService tự rescan mỗi 5 phút, tạo/cập nhật tasks từ file.

### Owner thiết lập quy tắc chung

Owner nói: _"Đặt quy tắc: mỗi lượt chỉ thử 3 lần, 3 lượt liên tiếp fail thì tự đóng"_

Agent gọi `cron_manage`:
```json
{
  "action": "set_global_rules",
  "maxRetriesPerTick": 3,
  "maxConsecutiveFailedTicks": 3
}
```

Hoặc cập nhật trực tiếp bảng `config`:
- `cof_scheduler_max_retries_per_tick`
- `cof_scheduler_max_consecutive_failed_ticks`

### Cách agent tạo cron job

Owner nói: _"Mỗi ngày 7h sáng, tự động đăng bài lên Facebook"_

Agent gọi `cron_manage`:
```json
{
  "action": "add",
  "taskCode": "daily_fb_post",
  "name": "Đăng bài Facebook hàng ngày",
  "cronExpression": "0 7 * * *",
  "prompt": "Đăng bài lên Facebook cá nhân với nội dung phù hợp với ngày hôm nay",
  "allowedSkills": ["browser", "image_understand"],
  "maxModelTier": "skill",
  "timeoutMs": 180000
}
```
(Quy tắc retry dùng chung từ config, không cần truyền per-task)

### Database: `scheduled_tasks`

| Column | Type | Mô tả |
|--------|------|-------|
| `task_id` | int PK | |
| `uid` | int FK → users | Owner task |
| `task_code` | varchar unique | Mã định danh |
| `cron_expression` | varchar | Biểu thức cron |
| `agent_prompt` | text | Lệnh cho agent |
| `allowed_skills` | json | Skill được phép (null = tất cả) |
| `status` | enum | active / paused / disabled |
| `source` | enum | heartbeat / agent / manual |
| `max_retries` | int (default 3) | Retry tối đa |
| `consecutive_failures` | int | Đếm fail liên tiếp |
| `max_model_tier` | varchar | Giới hạn model tier |
| `timeout_ms` | int (default 120000) | Timeout per run |
| `last_run_at` | timestamp | Lần chạy gần nhất |
| `last_error` | text | Lỗi gần nhất |

### Files

```
src/agent/scheduler/
├── entities/scheduled-task.entity.ts    # TypeORM entity
├── scheduled-tasks.service.ts           # Core engine + retry policy
├── heartbeat.service.ts                 # Parse HEARTBEAT.md → tasks
└── scheduler.module.ts                  # NestJS module
```

---

## Learning — Vectorization & Fine-Tune Export

> **Giai đoạn 3: TỰ HỌC** — Trí nhớ dài hạn & Tiến hóa

Hai cronjob độc lập chạy song song, mỗi ngày lúc **3h sáng (UTC+7)**:

### 1. VectorizationService (RAG Pipeline)

```
chat_messages (is_vectorized=false)
    │
    ▼ Batch 50 messages
    │
    ▼ Embedding API (OpenAI text-embedding-3-small / Gemini text-embedding-004)
    │
    ▼ Lưu vector → heart/_vectors/<userId>/<msg_id>.json
    │
    ▼ Đánh dấu is_vectorized = true
```

- **Auto-detect embedding provider**: ưu tiên OpenAI → fallback Gemini (dựa vào API key trong bảng `config`)
- **Batched processing**: 50 messages/batch × tối đa 20 batches/run = 1000 messages/ngày
- **Lock cơ chế**: `running` flag tránh chạy chồng chéo
- **Cosine similarity search**: `memory_search` skill dùng trực tiếp vectors đã lưu

**Luồng search (memory_search skill)**:

```
User hỏi "Hôm qua tôi nói gì về dự án X?"
    │
    ▼ memory_search skill
    │
    ▼ VectorizationService.search(userId, query)
    │
    ▼ Embed query → vector
    │
    ▼ Load all vectors of userId → cosine similarity
    │
    ▼ Filter by minScore (default 0.7) → top N results
    │
    ▼ Return { content, role, score, date }
```

### 2. ExportService (Fine-Tune Pipeline)

```
chat_messages (is_exported=false)
    │
    ▼ Batch 100 messages
    │
    ▼ Group by userId → threadId
    │
    ▼ Ghi 2 format vào heart/_exports/<userId>/YYYY-MM-DD.jsonl:
    │   ├── Raw messages: { thread_id, msg_id, role, content, tokens_used, created_at }
    │   └── Training pairs: { _type: "training_pair", messages: [user, assistant] }
    │
    ▼ Đánh dấu is_exported = true
```

- **Dual format output**: raw messages (để phân tích) + conversation pairs (để fine-tune)
- **Tương thích OpenAI fine-tune API** và các framework mã nguồn mở (LLaMA, Mistral, Qwen)
- **Batched**: 100 messages/batch × tối đa 50 batches/run = 5000 messages/ngày
- **Public API**: `getExportFiles(userId)` — liệt kê file đã export cho user

### Cron Schedule

| Cronjob | Cron Expression | Timezone | Mục đích |
|---------|----------------|----------|----------|
| `vectorize_messages` | `0 0 3 * * *` | Asia/Ho_Chi_Minh | Embed messages → vector storage |
| `export_messages` | `0 0 3 * * *` | Asia/Ho_Chi_Minh | Export .jsonl cho fine-tuning |

Cả hai chạy **song song** (NestJS `@Cron` scheduler), mỗi service có lock riêng nên không block nhau hay ảnh hưởng đến tác vụ agent đang xử lý.

### Cấu trúc file output

```
heart/
├── _vectors/
│   └── <userId>/
│       └── <msg_id>.json       # { id, threadId, userId, role, content (2000 chars), vector[], createdAt }
│
└── _exports/
    └── <userId>/
        └── YYYY-MM-DD.jsonl    # Append-only, mỗi ngày 1 file
```

### Nâng cấp Production

Hiện tại dùng file-based storage cho vectors (phù hợp dev/small-scale). Để scale lên:

| Backend | Thay đổi | Ưu điểm |
|---------|---------|---------|
| **pgvector** | Thêm extension + table `message_vectors` | Không cần infra mới, query SQL |
| **Qdrant** | Thay `storeVectors()` + `loadUserVectors()` | ANN search siêu nhanh, filter metadata |
| **Milvus** | Tương tự Qdrant | Scale ngang, GPU support |

### Module Wiring

```
LearningModule
├── imports: [ChatModule, GlobalConfigModule]
├── providers: [VectorizationService, ExportService]
└── exports: [VectorizationService, ExportService]

AgentModule.imports += [LearningModule]
SkillsModule.imports += [LearningModule]   ← để MemorySearchSkill inject VectorizationService
```

---

## Mở rộng

### Thêm Code Skill mới

1. Tạo file `src/agent/skills/built-in/<category>/<name>.skill.ts`
2. Implement `ISkillRunner` + `@RegisterSkill()`
3. Thêm class vào `SkillsModule.providers`

### Thêm Prompt Skill (ClawhHub)

1. Tạo folder `skills/<name>/SKILL.md`
2. `ClawhubLoaderService` tự động load

### Thêm Channel mới

1. Implement `IChannelAdapter`
2. Thêm vào `AgentModule.providers`

### Thêm LLM Provider mới

1. Implement `ILlmProvider`
2. Thêm vào `AgentModule.providers`

### Thêm Hook Handler

1. Tạo `@Injectable()` class với `@OnHook()` methods
2. Thêm vào bất kỳ module — `HooksService` auto-discover

---

> **Lưu ý:** Các file đánh dấu `TODO` trong code là phần cần implement chi tiết. Cấu trúc và interfaces đã sẵn sàng.
