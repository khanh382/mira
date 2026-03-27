## Hidden n8n integration (async callback)

### Overview
- **Mira** decides *what* to do (intent → policy → tool choice).
- **n8n** executes *how* to do integrations (fetch data, send email, sync SaaS).
- Users never see n8n UI.

### Endpoints
- **Mira → n8n dispatch**: `N8N_DISPATCH_URL`
- **n8n → Mira callback**: `POST /api/v1/webhooks/n8n/callback` (see `N8N_CALLBACK_URL`)
- **n8n → Mira brain (sync)**: `POST /api/v1/webhooks/n8n/brain` (API key per-user)

### Brain API key (per user)
- Header: `x-mira-api-key` (configurable via `N8N_BRAIN_API_KEY_HEADER`)
- Token is stored as **sha256 hash** in DB table `n8n_api_keys` and verified server-side.

### Request signature (HMAC)
Both directions use the same headers:
- `x-mira-ts`: unix epoch ms (string)
- `x-mira-nonce`: random nonce (string)
- `x-mira-signature`: hex HMAC-SHA256

Signature message:

```text
${ts}.${nonce}.${canonicalJsonStringify(body)}
```

Canonical JSON stringify rules (must match Mira’s `canonicalJsonStringify`):
- Objects: recursively sort keys lexicographically
- Arrays: keep order
- Then `JSON.stringify`

### Dispatch body (Mira → n8n)
Mira sends:
- `dispatchId`
- `workflowKey`
- `idempotencyKey`
- `userContext` + `threadContext`
- `payload`
- `callback.url`

See: `src/integrations/n8n/n8n-contract.ts`

### Callback body (n8n → Mira)
n8n should call back with:
- `dispatchId`
- `status`: `RUNNING|SUCCEEDED|FAILED` (others tolerated)
- `executionId` (optional)
- `result` (optional) or `error` (optional)

### Allowlist
Mira will reject `workflowKey` unless it is allowlisted for the user level:
- `N8N_WORKFLOWS_COMMON`
- `N8N_WORKFLOWS_OWNER`
- `N8N_WORKFLOWS_COLLEAGUE`
- `N8N_WORKFLOWS_CLIENT`

If none are set → n8n dispatch is effectively disabled.

### Notes
- TypeORM migrations are not used here; enabling `DB_SYNCHRONIZE=true` will create `n8n_dispatches` in dev.
- For webchat notifications, Mira emits `message:response` to `room user:<uid>` (see `WebChatGateway.emitToUser`).
- Scheduled automation uses `scheduled_tasks` with `target_type=n8n_workflow` and fields `n8n_workflow_key`, `n8n_payload`.

