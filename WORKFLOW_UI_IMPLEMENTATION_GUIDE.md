# Workflow UI Implementation Guide

Tai lieu nay mo ta chi tiet de frontend xay dung UI workflow dung voi backend hien tai.
Muc tieu:

- Nguoi dung (owner/colleague) tao/sua/chay workflow bang UI keo-tha.
- UI luu graph on-demand (bulk) va tranh ghi de khi mo nhieu tab.
- Node cau hinh duoc cho ca 2 kieu: dung tool va khong dung tool.

---

## 1) Tu duy san pham

Workflow la mot do thi huong:

- `Workflow` = metadata tong (name, status, entry node, version).
- `Node` = don vi xu ly.
- `Edge` = huong di tiep theo (co the co dieu kien).

Co 2 loai node chinh:

1. **Node LLM direct** (`toolCode = null`)
   - He thong goi model truc tiep.
   - Dung cho: rewrite content, tom tat, dat ten tieu de, tao prompt.

2. **Node Tool execution** (`toolCode != null`)
   - He thong uu tien chay `commandCode`.
   - Neu loi/khong co command, fallback sang `promptTemplate`.
   - Retry toi da 5 lan.

---

## 2) Backend capabilities (hien co)

Base: `/agent/workflows` (yeu cau JWT)

- `GET /agent/workflows/tool-options` (lay danh sach tool de UI select `toolCode`)
- `GET /agent/workflows`
- `POST /agent/workflows`
- `PATCH /agent/workflows/:workflowId/status`
- `PATCH /agent/workflows/:workflowId/entry-node`
- `GET /agent/workflows/:workflowId/graph`
- `PUT /agent/workflows/:workflowId/graph` (bulk save graph + optimistic lock)
- `POST /agent/workflows/:workflowId/nodes`
- `PATCH /agent/workflows/:workflowId/nodes/:nodeId`
- `DELETE /agent/workflows/:workflowId/nodes/:nodeId`
- `POST /agent/workflows/:workflowId/edges`
- `PATCH /agent/workflows/:workflowId/edges/:edgeId`
- `DELETE /agent/workflows/:workflowId/edges/:edgeId`
- `POST /agent/workflows/:workflowId/run`
- `POST /agent/workflows/:workflowId/nodes/:nodeId/run` (test nhanh 1 node)
- `GET /agent/workflows/:workflowId/runs` (lich su run theo workflow)
- `GET /agent/workflows/:workflowId/nodes/:nodeId/runs` (lich su attempt theo node)
- `DELETE /agent/workflows/:workflowId/runs` (soft-delete toan bo lich su workflow)
- `DELETE /agent/workflows/:workflowId/nodes/:nodeId/runs` (soft-delete lich su 1 node)
- `GET /agent/workflows/runs/:runId`

Tai lieu API chi tiet:

- `WORKFLOW_API_DOCS.md`

---

## 3) Data model de frontend nam chac

## 3.1 Workflow

- `id: uuid`
- `code: string` (unique)
- `name: string`
- `description: string | null`
- `status: draft | active | paused | archived`
- `entry_node_id: uuid | null`
- `version: number` (optimistic lock)

## 3.2 Node

- `id: uuid`
- `workflow_id: uuid`
- `name: string`
- `prompt_template: string | null`
- `tool_code: string | null`
- `command_code: string | null`
- `model_override: string | null`
- `max_attempts: number` (backend cap 5)
- `timeout_ms: number`
- `output_schema: json | null`
- `join_mode: none | wait_any | wait_all`
- `join_expected: number | null`
- `pos_x: number`
- `pos_y: number`

Luu y quan trong cho frontend:

- `tool_code` phai luu gia tri `skillCode` (vi du: `web_fetch`, `memory_search`), khong luu category.
- Category (`web`, `runtime`, `browser`, ...) chi dung de UI filter/group tool list.

## 3.3 Edge

- `id: uuid`
- `workflow_id: uuid`
- `from_node_id: uuid`
- `to_node_id: uuid`
- `condition_expr: string | null`
- `priority: number`
- `is_default: boolean`

---

## 4) Kien truc UI de de mo rong

De xuat chia UI thanh 3 khu:

1. **Workflow Sidebar**
   - Danh sach workflow
   - Tao moi / doi status / duplicate / xoa (neu co)

2. **Canvas Editor**
   - Node card keo-tha
   - Noi edge (source handle -> target handle)
   - Chon entry node
   - Hien thi nhanh default vs condition

3. **Inspector Panel**
   - Cau hinh node dang chon
   - Cau hinh edge dang chon
   - Validation message theo field

---

## 5) Luong lam viec khuyen nghi tren UI

1. User tao workflow (`POST /agent/workflows`)
2. UI mo graph editor (`GET /:id/graph`)
3. User thao tac:
   - them/sua/xoa node
   - noi edge
   - dat entry node
   - cap nhat vi tri node
4. UI bam Save -> goi 1 request bulk:
   - `PUT /:id/graph`
   - truyen `expectedVersion` hien tai
5. Neu conflict version:
   - thong bao "Workflow da duoc cap nhat o noi khac"
   - cho user reload graph
6. User activate workflow (`PATCH /status`)
7. User run test (`POST /run`) + xem log (`GET /runs/:runId`)

---

## 6) Huong dan bulk-save graph (quan trong cho keo-tha)

UI **nen uu tien** endpoint bulk:

- Giam request (khong patch tung node)
- Tranh graph half-saved
- Dung transaction va version-check

Body mau:

```json
{
  "expectedVersion": 7,
  "entryNodeClientKey": "node_fetch",
  "nodes": [
    {
      "id": "4b5e....",
      "name": "rewrite_content",
      "toolCode": null,
      "promptTemplate": "Viet lai: {nodes.fetch_news.content}",
      "maxAttempts": 5,
      "timeoutMs": 120000,
      "posX": 560,
      "posY": 240
    },
    {
      "clientKey": "node_fetch",
      "name": "fetch_news",
      "toolCode": "web_fetch",
      "commandCode": "{\"url\":\"{input.newsUrl}\"}",
      "promptTemplate": "Doc noi dung bai viet tu {input.newsUrl}",
      "posX": 220,
      "posY": 240
    }
  ],
  "edges": [
    {
      "fromClientKey": "node_fetch",
      "toNodeId": "4b5e....",
      "conditionExpr": "$.nodes.fetch_news.success == true",
      "priority": 10,
      "isDefault": false
    }
  ]
}
```

Response co `nodeKeyMap`, UI phai:

- map node local `clientKey` -> `real id`
- cap nhat state editor de lan sau khong gui clientKey nua

---

## 7) Cau hinh Node theo tung nhom use-case

## 7.1 Node LLM direct (khong dung tool)

Khi nao dung:

- rewrite/tom tat/noi dung sang tao
- dat title, viet caption, tao prompt

Cau hinh:

- `toolCode = null`
- `promptTemplate` bat buoc co noi dung
- `modelOverride = null` neu de router tu chon
- `modelOverride = "openai/gpt-4o-mini"` neu muon khoa model
- `commandCode` de trong

Vi du:

```json
{
  "name": "rewrite_content",
  "toolCode": null,
  "promptTemplate": "Viet lai bai viet sau theo phong cach thuong hieu: {nodes.fetch_news.content}",
  "modelOverride": null,
  "maxAttempts": 5,
  "timeoutMs": 120000
}
```

## 7.2 Node tool-first (co commandCode)

Khi nao dung:

- tool co input cau truc ro rang (web_fetch, http_request, google_workspace...)
- can hanh vi on dinh, it phu thuoc model hieu prompt

Cau hinh:

- `toolCode` bat buoc
- `commandCode` uu tien
- `promptTemplate` nen co de fallback

Vi du:

```json
{
  "name": "fetch_news",
  "toolCode": "web_fetch",
  "commandCode": "{\"url\":\"{input.newsUrl}\"}",
  "promptTemplate": "Doc noi dung bai viet tu URL {input.newsUrl}",
  "maxAttempts": 5
}
```

## 7.3 Node tool-with-prompt (khong commandCode)

Khi nao dung:

- tool linh hoat, input mo, kho mo ta bang JSON command
- can de AI suy luan tham so tool

Cau hinh:

- `toolCode` bat buoc
- `commandCode = null`
- `promptTemplate` chi tiet, ro bien dong

Vi du:

```json
{
  "name": "notify_result",
  "toolCode": "message_send",
  "commandCode": null,
  "promptTemplate": "Gui thong bao ket qua toi Telegram voi noi dung: {nodes.publish_post.content}",
  "maxAttempts": 5
}
```

## 7.4 Node HTTP publish (thuong gap)

Khi dang bai web/API:

- `toolCode = "http_request"`
- `commandCode` JSON ro method/url/body
- co fallback prompt de giam fail

Vi du:

```json
{
  "name": "publish_post",
  "toolCode": "http_request",
  "commandCode": "{\"method\":\"POST\",\"url\":\"{input.websiteApiUrl}\",\"body\":{\"title\":\"{input.title}\",\"content\":\"{nodes.rewrite_content.content}\"}}",
  "promptTemplate": "Dang bai len website voi title={input.title}, content={nodes.rewrite_content.content}",
  "maxAttempts": 5
}
```

---

## 8) Template bien dong va nguon du lieu

Frontend can huong dan user dung `{...}`:

- `{input.xxx}`: tu payload luc run workflow
- `{nodes.<nodeName>.xxx}`: tu output node truoc
- `{nodes.<nodeId>.xxx}`: tu output theo id node

Luu y:

- Neu bien khong ton tai, backend thay bang chuoi rong.
- Gia tri object/array se stringify JSON.
- Can guidance tren UI de user tranh typo key.

De xuat UX:

- autocomplete bien tu context (`input` + danh sach node truoc do)
- preview "resolved prompt" truoc khi run

---

## 9) Rule validation UI nen bat buoc truoc khi Save

Nen validate client-side truoc khi goi API:

- Workflow co it nhat 1 node.
- Co entry node.
- Ten node khong trung nhau.
- Moi edge co `from` va `to`.
- Moi node khong qua 1 edge `isDefault=true`.
- Khong cho noi edge tu node -> chinh no (self-loop) neu khong ho tro loop.

Backend cung validate, nhung validate som tren UI cho UX tot hon.

---

## 10) Rule hien thi edge/branch tren Canvas

De nguoi dung de hieu:

- Edge condition: line mau xanh + badge `if`.
- Edge default: line mau xam + badge `default`.
- Sap xep branch theo `priority` nho den lon.
- Inspector cho edit:
  - `conditionExpr`
  - `priority`
  - `isDefault`

---

## 10.1 Cac thao tac dieu huong bat buoc UI phai ho tro

Phan nay dinh nghia ro "doi thu tu", "tach nhanh", "tao nhanh", "gop nhanh"
de frontend implement dung hanh vi backend.

### A) Doi thu tu thuc thi node (linear reorder)

Cach thuc hien:

1. Chon node entry moi neu can (`PATCH /:workflowId/entry-node` hoac bulk save).
2. Sua cac edge de tao chain moi.
3. Xoa edge cu khong dung nua.

Vi du:

- Cu: `A -> B -> C`
- Moi: `A -> C -> B`

Trong bulk payload:

- Cap nhat mang `edges` dung huong moi.
- Dat `entryNodeId`/`entryNodeClientKey` dung node bat dau mong muon.

### B) Tao nhanh / Tach nhanh (split branch)

Muc tieu:

- Tu 1 node `A`, di ra nhieu huong tuy dieu kien.

Cach thuc hien:

- Tao nhieu edge co cung `from_node_id = A`
- Moi edge co `conditionExpr` rieng
- (Khuyen nghi) co them 1 edge `isDefault=true` lam fallback

Vi du:

- `A --if score > 0.8--> B1`
- `A --if score <= 0.8--> B2`
- `A --default--> B3`

Luu y backend:

- Moi node toi da 1 edge default.
- Branch duoc xet theo `priority` tang dan.

### C) Gop nhanh (merge branch)

Muc tieu:

- Nhieu node cung tro ve 1 node chung.

Cach thuc hien:

- Tao nhieu edge co cung `to_node_id`.

Vi du:

- `B1 -> D`
- `B2 -> D`
- `B3 -> D`

Luu y runtime hien tai:

- Engine ho tro fan-out khi nhieu edge condition dung.
- Cac node trong cung wave co the duoc xu ly song song.
- Node merge co the cau hinh:
  - `joinMode=none|wait_any`
  - `joinMode=wait_all` + `joinExpected` de doi du nhanh truoc khi chay tiep.

### D) Diem canh bao UX khi thao tac dieu huong

UI nen canh bao som:

- Node khong co outgoing edge (tru node ket thuc chu dich).
- Node co >1 default edge (khong hop le).
- Co cycle (A -> B -> A) se bi backend chan.
- Edge tham chieu node da bi xoa.

---

## 11) Giao dien Run/Test de frontend can co

Can 1 panel "Run Workflow":

- Input JSON editor (`input`)
- Nut Run (`POST /:id/run`)
- Hien status + final output
- Link den log run detail (`GET /runs/:runId`)

Panel run detail:

- danh sach `nodeRuns` theo thu tu
- moi attempt hien:
  - resolved prompt
  - resolved command
  - success/fail
  - duration
  - error (neu co)

---

## 12) Permission UX

Hien tai backend scope theo JWT user:

- user chi thay/sua/chay workflow cua chinh ho

UI nen:

- khong cho nhap/chon userId thu cong
- neu 401/403 -> day user ve login

---

## 13) Gap ky thuat frontend

Framework de xay canvas:

- React Flow (khuyen nghi) hoac drawflow

State shape khuyen nghi:

- `workflowMeta`
- `nodes[]` (co `clientKey` cho node moi)
- `edges[]`
- `dirty`
- `expectedVersion`

Save strategy:

- autosave debounce 1.0-1.5s hoac nut Save thu cong
- khi save thanh cong: cap nhat `expectedVersion = response.workflow.version`

---

## 14) Checklist frontend done-definition

- Co list page workflow.
- Co editor keo-tha node.
- Co create/update/delete node.
- Co create/update/delete edge.
- Co set entry node.
- Co bulk save graph + conflict handling.
- Co run test + run logs.
- Co helper cho template variables.
- Co thong bao loi theo field (node/edge).

---

## 15) Flow numbering strategy (1 -> 2 -> 3.1, 3.2)

Muc tieu:

- Giup user nhin nhanh thu tu logic thuc thi.
- Ho tro de doc cac nhanh split/merge tren canvas.

### 15.1 Nguyen tac quan trong

- `flowOrderLabel` la **gia tri hien thi** (derived/computed), khong phai source of truth.
- Khong luu cung label vao DB de tranh lech du lieu khi graph doi.
- Source of truth van la:
  - `entry_node_id`
  - danh sach `edges`
  - `priority`

### 15.2 Quy tac danh so de xuat (theo yeu cau moi)

Muc tieu hien thi:

- Tuyen chinh: `1 -> 2 -> 3`
- Neu tach nhanh tai buoc 3: `3.1`, `3.2`
- Khong dung kieu long sau: `1.1.1`, `1.1.2`

Quy tac:

1. Node entry la `1`.
2. Di theo duong chinh (mainline), moi node tiep theo tang so nguyen:
   - `1 -> 2 -> 3 -> 4 ...`
3. Neu tai node `x` co split branch, cac nhanh con duoc danh:
   - `x.1`, `x.2`, `x.3`...
4. Neu nhanh con tiep tuc di tiep, UI giu nhan nhanh va tang so cuoi:
   - `3.1 -> 3.2 -> 3.3` (neu la chuoi tren nhanh thu nhat)
   - `3.2 -> 3.2.1` **khong su dung** trong che do numbering nay.
5. Thu tu branch van sap xep theo `priority` tang dan
   (tie-break bang `created_at` hoac `id` neu can).

Vi du:

- Mainline: `A(1) -> B(2) -> C(3)`
- C split 2 nhanh:
  - `C -> D` label `3.1`
  - `C -> E` label `3.2`
- Neu sau do D di tiep F, co the hien thi:
  - `F` la node tiep cua branch 3.1 (goi y nhan `3.1-next` hoac tiep tuc `3.1`)
  - tuy chon UI, nhung khong doi sang `3.1.1`.

### 15.3 Truong hop merge branch

Khi 2+ nhanh tro ve cung 1 node:

- UI chi gan 1 `primaryPathLabel` cho node merge (duong uu tien cao hon).
- Cac duong con lai hien trong metadata:
  - `incomingFromLabels: ["3.1", "3.2"]`

Khuyen nghi hien thi:

- Badge chinh tren node: `4` (neu merge quay ve mainline) hoac `3.1` (neu giu branch line)
- Hover tooltip: `Merged from: 3.1, 3.2`

### 15.4 Truong hop default branch

- Default edge (`isDefault=true`) van tham gia danh so theo thu tu priority.
- Tren edge nen hien them badge `default` de user phan biet voi condition edge.

### 15.5 Truong hop node khong reachable

Neu co node khong di duoc tu entry:

- Label: `unreachable`
- Mau node canh bao.
- Chan activate hoac canh bao manh de user sua graph.

### 15.6 De xuat output cho frontend state

State runtime/canvas co the bo sung:

- `node.flowOrderLabel: string` (vd. `1`, `2`, `3.1`, `3.2`)
- `node.primaryPath: boolean`
- `node.incomingFromLabels: string[]`
- `edge.orderIndex: number`

Tat ca field tren la field tinh toan tren client, khong bat buoc luu DB.

### 15.7 Khi nao can endpoint ho tro numbering tu backend

MVP:

- frontend tu tinh label la du.

Neu graph lon (100+ node) va can consistency giua nhieu client:

- can them endpoint read-only:
  - `GET /agent/workflows/:workflowId/graph-numbering`
- backend tra ve map:
  - `nodeId -> flowOrderLabel`
  - `nodeId -> incomingFromLabels[]`

---

## 16) Yeu cau UI cho keo-tha nhanh (edge drag & reconnect)

Muc tieu:

- User co the keo-tha de tao nhanh moi lien ket.
- User co the "reconnect" de doi huong nhanh (doi `from`/`to`) ma khong can xoa tao lai bang tay.
- Sau moi thao tac keo-tha, UI luu graph dung endpoint bulk.

### 16.1 Hanh vi can co tren Canvas

1. **Tao nhanh moi edge**
   - User keo tu output handle cua node A sang input handle cua node B.
   - UI tao edge tam trong state local.
   - Mac dinh:
     - `conditionExpr = null`
     - `priority = 100`
     - `isDefault = false`

2. **Reconnect edge hien co**
   - User keo dau edge dang ton tai sang node khac.
   - UI cap nhat lai `from` hoac `to` tren edge do.
   - Giu nguyen metadata edge (`conditionExpr`, `priority`, `isDefault`) tru khi user sua.

3. **Xoa edge nhanh**
   - User chon edge + Delete/Backspace hoac context menu.
   - UI xoa edge khoi local graph.

4. **Drag node position**
   - Khi tha node, UI cap nhat `posX`, `posY` local.

### 16.2 Luong save khuyen nghi sau thao tac keo-tha

Sau moi thao tac drag/reconnect/delete:

- Danh dau `dirty = true`.
- Debounce 800-1500ms.
- Goi `PUT /agent/workflows/:workflowId/graph` voi:
  - `expectedVersion`
  - toan bo `nodes` (kem `posX/posY`)
  - toan bo `edges`
  - `entryNodeId` hoac `entryNodeClientKey`

Neu save thanh cong:

- Cap nhat `expectedVersion = response.workflow.version`
- Xoa `dirty`

Neu save conflict:

- Hien modal: "Workflow vua duoc cap nhat o noi khac"
- Cho user:
  - Reload graph (khuyen nghi)
  - Hoac force merge local (neu muon nang cao)

### 16.3 Rule validate ngay tren UI luc keo-tha

UI can chan som, truoc khi goi API:

- Khong noi edge vao node khong ton tai.
- Khong tao self-loop (`from == to`) neu product khong cho.
- Moi node chi duoc co toi da 1 edge `isDefault=true`.
- Canh bao neu reconnect lam node tro thanh unreachable tu entry.

Luu y:

- Backend van validate lan cuoi (source of truth).
- UI validate som de UX muot, giam so lan save fail.

### 16.4 Rule de user "thay doi thu tu thuc thi" bang keo-tha

UI phai truyen thong ro:

- Thu tu thuc thi **khong** den tu vi tri trai-phai tren canvas.
- Thu tu thuc thi den tu:
  1. `entryNodeId`
  2. Quan he edge
  3. `priority` neu co nhieu edge cung node goc

Vi vay:

- Keo node di cho khac chi doi layout (khong doi logic).
- Muon doi logic, user phai doi edge hoac doi entry node.

### 16.5 Rule cho split/merge bang thao tac drag

**Split branch:**

- Keo tu 1 node den nhieu node dich.
- Mo inspector cua tung edge de dat `conditionExpr` + `priority`.

**Merge branch:**

- Keo tu nhieu node nguon den cung 1 node dich.
- UI nen hien badge "merge" tren node dich de user de nhan biet.

### 16.6 Event contract de frontend team thong nhat

De xuat event-level contract:

- `onConnect(sourceId, targetId)`
- `onReconnect(edgeId, nextSourceId, nextTargetId)`
- `onEdgeDelete(edgeId)`
- `onNodeDragStop(nodeId, x, y)`
- `onSaveGraph()`

Moi event tren cap nhat local store, sau do di qua co che debounce save.

### 16.7 Trang thai UI nen co

- `dirty: boolean`
- `saving: boolean`
- `lastSavedAt: number | null`
- `saveError: string | null`
- `versionConflict: boolean`

Hien thi goi y:

- Badge "Unsaved changes" khi `dirty=true`
- Spinner khi `saving=true`
- Toast xanh khi save thanh cong
- Toast do + action "Reload graph" khi conflict

---

