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
│     │   Hooks   │  │ LLM Provider│  │    Skills     │         │
│     │  System   │  │  (routing)  │  │ (13 code +    │         │
│     │           │  │             │  │  ClawhHub)    │         │
│     └───────────┘  └─────────────┘  └───────────────┘         │
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
    │   │   │   └── memory-get.skill.ts
    │   │   ├── messaging/
    │   │   │   └── message-send.skill.ts
    │   │   └── sessions/
    │   │       ├── sessions-list.skill.ts   # threads_list
    │   │       └── sessions-history.skill.ts # thread_history
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
        └── steps/
            ├── receive.step.ts
            ├── preprocess.step.ts
            ├── route.step.ts
            ├── agent-run.step.ts
            └── deliver.step.ts
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
  │   • Audio transcription, image description              │
  │   • 🔔 Internal: message.transcribed                    │
  │   • 🔔 Plugin:   BEFORE_PROMPT_BUILD (modifiable)       │
  │   • 🔔 Internal: message.preprocessed                   │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 3: ROUTE                                           │
  │   • Chọn LLM model                                     │
  │   • 🔔 Plugin:   BEFORE_MODEL_RESOLVE (modifiable)      │
  └───────────────────────┬─────────────────────────────────┘
                          ▼
  ┌─────────────────────────────────────────────────────────┐
  │ Step 4: AGENT RUN                                       │
  │   • 🔔 Plugin: BEFORE_AGENT_START, SESSION_START        │
  │   • ┌─── Agent Loop ────────────────────────────┐       │
  │   │ │  LLM call (via ProvidersService)          │       │
  │   │ │  🔔 Plugin: LLM_INPUT → LLM_OUTPUT        │       │
  │   │ │  If tool_calls → execute skill → loop     │       │
  │   │ └───────────────────────────────────────────┘       │
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
| 11 | `message_send` | `messaging` | Gửi tin nhắn qua channel | ChannelsService |
| 12 | `threads_list` | `sessions` | Liệt kê chat threads | ThreadsService |
| 13 | `thread_history` | `sessions` | Lấy lịch sử chat thread | ChatService |

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
