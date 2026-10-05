# 智能讲解内容发布平台

面向博物馆/景区讲解设备的内容发布领域实现。建立在事件溯源之上：所有状态变化都是**不可删除、按聚合流严格递增、按 `event_id` 幂等**的领域事件。

本地检查：`node --test`（17 个测试，含事故场景端到端复现）。零外部依赖，Node 18+。

## 背景与纪律

2026-10-04 夜事故：讲解设备把“学界推测”播成确定史实；紧急换包后又发现日文把“**局部开放**”翻成“**暂停开放（一時閉館）**”，且无人知道错误说法还留在哪几台离线设备里。本平台据此立下纪律：

1. **事实、解释性主张、临时运营通知各走各的审校路径**，不能混在同一条轻量发布链路里。
2. **机器组合回答不得越出已批准证据**；推测/争议结论由系统强制加对冲前缀，无证据时返回 `unable_to_answer`，不做生成式补全。
3. **翻译修订必须逐条列出受影响语句和问法**（旧译 → 新译、错误类型），换包影响由此可解释。
4. **设备重新联网先按有效期判断**能否继续播报，再谈新鲜度刷新。
5. **紧急通知可以先发布**，但必须在截止前限时补签；逾期未补签自动停播并失效；全过程留完整历史。
6. 一次发布只有在四项全部满足时才算完成（见“发布完成度”）。

## 聚合与事件

| 聚合 | 承载对象 | 事件 |
| --- | --- | --- |
| `knowledge_claim` | 事实/解释性主张、问答模板、读音术语 | `CLAIM_RECORDED` `EXPERT_OPINION_ADDED` `CLAIM_APPROVED` `CLAIM_REVISED` `QA_TEMPLATE_APPROVED` `GLOSSARY_TERM_APPROVED` |
| `translation_revision` | 一次翻译修订（一种目标语言，逐条语句/问法） | `TRANSLATION_PROPOSED` `TRANSLATION_REVIEWED` |
| `content_package` | 常规内容包 / 紧急运营通知（同聚合、不同流） | `PACKAGE_DRAFTED` `PACKAGE_PUBLISHED` `PACKAGE_WITHDRAWN` `NOTICE_ISSUED` `NOTICE_COUNTERSIGNED` `NOTICE_EXPIRED` |
| `device_receipt` | 一台设备的档案、版本回执、心跳 | `DEVICE_REGISTERED` `DEVICE_ACKNOWLEDGED` `DEVICE_HEARTBEAT` |

事件信封见 `contracts/domain.schema.json`。`event_id` 全局唯一；`version` 在聚合流内从 1 连续递增；`occurred_at` 是真实发生时间。上游命令带 `command_id`，重试复用同一标识即幂等（见 `src/app/emit.js`），载荷被篡改时存储拒绝覆盖历史。

## 三条审校路径

### 1. 事实主张（fact）
登记时必须绑定至少一个**来源段落**（`source_id`、`citation`、`excerpt`、密级 `public`/`restricted`）；确定性只能是 `established`。审校批准时列明依据来源，得到可引用的审定版本。

### 2. 解释性主张（interpretation）
确定性为 `scholarly_debate` / `scholarly_speculation`。批准前**必须有专家意见**；批准记录 `hedging_required`，编译播报文本时系统自动加对冲前缀（中：“学界推测，”；日：“学界ではこう推測されています。”），不依赖人工记得。措辞修订（`CLAIM_REVISED`）后回到待审状态，旧版本立即不可再被内容包引用，历史批准不删除。

### 3. 翻译修订（translation_revision）
提出修订时必须逐条列：
- `affected_statements[]`：`ref_id`、`old_text → new_text`、`error_type`（误译/术语/语域/无障碍/漏译）；`old_text: null` 表示该语种初译；
- `affected_question_forms[]`：问答问法的逐条修订。

经翻译审校 `approved` 才能入包。发布编译时若存在影响本包条目但**未纳入**的已批准修订，发布闸拒绝（已被更新修订覆盖的旧修订除外）。

### 临时运营通知（旁路）
不经内容审校：`NOTICE_ISSUED` 即播报 → 截止前 `NOTICE_COUNTERSIGNED` 补签 → 到期或逾时未补签 `NOTICE_EXPIRED`。有效期必须覆盖补签窗口。

## 内容包编译与发布闸（`PublishService`）

`compile(spec)` 只从**当前审定版本 + 已批准翻译修订**生成播报清单（manifest）与逐条目内容指纹（FNV-1a，设备可用同算法复核），并执行：

- 证据边界：非审定版本、未批准译文、未审定问法模板一律拒绝；
- 对冲强制：非 established 结论缺对冲即拒绝；
- 翻译时效：相关的已批准修订未纳入即拒绝；
- **密级外泄扫描**：载荷文本不得包含任何 `restricted` 来源段落原文。

同时产出两份随 `PACKAGE_PUBLISHED` 固化、发布后不可篡改的材料：

- **影响预览 `impact_preview`**：相对基线包逐条 `added/changed/removed`（含旧文本、新文本、来自哪个翻译修订）与校验和。操作者必须回传确认校验和才能发布；条目在校验后漂移则校验和不符、拒绝发布。
- **游客侧出处 `visitor_provenance`**：每条播报文本对应的公开出处 `citation` 与内容更新时间。restricted 来源永不出现。

## 设备回执、重连与离线排查（`DeviceService`）

- `DEVICE_ACKNOWLEDGED` 必须逐项回传指纹；与发布包指纹不符直接拒绝，防止设备谎报换包。
- **重连判定 `onReconnect` 的顺序是硬纪律**：
  1. 内容包过期/被撤回 → `refresh_required`，`may_play=false`，期间不得播报；
  2. 紧急通知过期或逾时未补签 → `stop_notice`；
  3. 仍在有效期 → 与后继包指纹对比，给出 `continue` 或 `refresh_recommended`，并列出设备上残留的具体旧说法（旧文本/新文本/修订号）。
- **离线暴露排查 `devicesExposing(latestPackageId)`**：沿基线链找出仍装载旧版本包的设备（含在线状态、最后心跳、过期与否、逐条残留内容），直接回答“错误说法还留在哪些离线设备里”。

## 机器答复（`AnswerService`）

问答机/讲解设备组合回答时：只能引用已发布且在有效期内的包、当前已审定的主张版本、已审定问法；来源只取 `public`；推测结论的回答带 `hedged` 标记与前缀。无证据一律 `status: "unable_to_answer"`，设备使用固定话术。`ProvenanceQuery` 向游客侧提供任意播报条目的出处与更新时间。

## 发布完成度（`ReleaseCompletion.assess`）

一次发布只有以下四项全部 `passed` 才 `complete: true`：

1. `impact_preview_explained`：影响预览齐备且带校验和；
2. `visitor_provenance_queryable`：每条内容有公开出处与更新时间；
3. `device_receipts_confirmed`：**每台目标设备** applied 回执的版本 == 发布版本且指纹逐项匹配（异步达成，未回执设备明确列出）；
4. `no_restricted_leakage`：发布载荷复核无未公开材料外泄。

## 文件地图

```
contracts/domain.schema.json   事件信封、聚合/事件白名单与归属
src/validator.js               信封校验（中文错误）
src/hash.js                    内容指纹 FNV-1a
src/store/event-store.js       幂等追加 + 聚合流版本约束
src/store/repository.js        事件流 -> 归约态的读取仓储
src/domain/*.js                四个聚合的归约器与判定（有效期、对冲、回执）
src/app/review-service.js      三条审校路径的命令服务
src/app/publish-service.js     编译、影响预览、密级扫描、发布闸、撤回
src/app/notice-service.js      紧急通知先发/限时补签/到期作业
src/app/device-service.js      注册/回执/心跳/重连判定/离线暴露排查
src/app/answer-service.js      机器答复证据边界 + 游客出处查询
src/app/release-completion.js  发布完成度四项清单
tests/                         契约/幂等、闸口负向、事故端到端、通知补签
```

存储为内存实现；接入真实底座时替换 `EventStore` 即可，需保持“`event_id` 唯一约束 + 聚合流串行追加”两条语义。
