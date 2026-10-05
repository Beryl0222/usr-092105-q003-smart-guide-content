# 智能讲解内容发布

让**事实、解释性主张、临时运营通知**各走合适审校路径的事件溯源平台。所有状态来自追加式领域事件，覆盖来源段落、专家意见、多语翻译、读音术语、无障碍表述、问答模板、内容包版本与设备回执之间的版本关系。

## 要解决的事故

- 讲解设备把“学界推测”播成确定史实 → 解释性主张必须显式标注 `scholarly_speculation`，组合播报强制加限定语。
- 日文把“局部开放”翻成“暂停开放” → 翻译修订审校时精确产出**受影响语句与问法清单**，中文稿一改，旧译文立即失效。
- 不知道错误说法还留在哪些离线设备里 → 按 `device_receipt` 追溯仍可能播报问题版本的设备清单。
- 紧急通知需要先发，但必须限时补签、到期自动下线、全程留痕。

## 三条审校路径（knowledge_claim）

| 类型 `kind` | 审校路径 | 播报形态 |
| --- | --- | --- |
| `fact` 事实 | 公开来源段落 + 专家 `support` + 编辑批准 | 直接陈述 |
| `interpretation` 解释性主张 | 专家意见（support/dispute/uncertain 均可留痕）+ 批准时必须 `basis.framing = scholarly_speculation` | 自动前缀“（学界推测，尚无定论）” |
| `notice` 临时运营通知 | 紧急发布（`valid_until` + `countersign_due_at`）→ 限时补签；逾期补签如实标记 `on_time=false` | 前缀“（临时运营通知）”并播有效期 |

来源公开级别：`public`（可对游客展示）、`restricted`（内部）、`unpublished`（未公开研究材料）。含 `unpublished` 证据的主张既不能批准，也无法进入任何内容包，游客侧出处只返回 `public` 段落。

中文稿修订（`CLAIM_REVISED`）使主张回到待批准状态；翻译提案声明 `based_on_claim_version`，与当前批准版本不符会被 `BASE_MISMATCH`/`STALE_BASE` 拒绝。

## 翻译修订（translation_revision）

`open → propose → review → apply`：

- 每条提案含译文、问答问法（`ask_id` 绑定中文模板）、依据的 claim 版本。
- `TRANSLATION_REVIEWED` 固化受影响清单 `affected`：
  - `statements`：语句键、旧译→新译、依据版本；
  - `questions`：受影响问法（问法文本变化，或问法不变但答案文本变化都会列出，含 `answer_text_changed`）；
  - `packages`：引用这些语句的内容包，便于定向换包。
- 只有 `apply` 后的译文进入翻译投影，设备与组合回答读不到未应用译文。

## 内容包（content_package）

`define → previewImpact → publish`：

- 清单钉死版本：每条语句记录 `claim_version` 与各语言 `revision_id`。
- 发布门禁：全部语句已批准、通知在有效期且补签合规、各语言译文与中文版本一致、无未公开材料。
- 影响预览对照上一版本给出 `added / removed / statement_updated / translation_updated`，每项变化必须带可解释理由（审批意见、修订原因）。
- 游客侧 `citations` 随包固化：公开来源的出处、段落定位、原文摘录、更新时间；通知给运营出处（原因、有效期、是否已补签）。

**一次发布只有满足以下条件才 `complete`（`releaseStatus`）：**

1. `impact_explainable`：影响预览每项变化可解释；
2. `citations_queryable`：游客侧出处与更新时间可查；
3. `all_devices_acknowledged`：投放到该包的每台设备都有该版本回执；
4. `no_unpublished_leak`：未公开研究材料未外泄。

## 设备回执（device_receipt）与重连

`register → assign → acknowledge`：回执按设备+包版本幂等，重复回执带内容哈希校验（不一致抛 `RECEIPT_CONFLICT`，防包体被篡改）。

设备重新联网**先按有效期判断**（`reconnect`）：

- `CONTINUE`：版本最新，包内通知均在有效期；
- `UPDATE`：有新版本（修复包），给出目标版本；
- `SUSPEND`：版本最新但有通知失效或紧急件未按时补签，返回须停播的语句清单。

`exposedDevices({ statement_key, claim_version?, revision_id? })` 返回最高已回执版本仍含问题说法的设备——设备一旦回执不含该问题的新版本，立即从清单消失。

## 机器组合回答（src/answers.js）

只能按问答模板（`ask_id`）拼装包内已批准、在有效期内的钉版本语句，不引入包外证据、不自由生成；包外问法返回固定拒答话术。解释性主张与通知的前缀在服务端拼接，设备端不可去除。

## 事件与幂等

- 事件由 `event_id` 唯一标识；`aggregate_id` + 版本从 1 连续递增，断号/重号被 `VERSION_CONFLICT` 拒绝。
- 来源系统重试必须沿用原 `event_id`：同内容重试直接返回原事件；同标识不同类型/聚合抛 `EVENT_ID_CONFLICT`。
- 事件可落 JSONL（`createPlatform({ path })`），重放即恢复全部状态。

事件目录见 `contracts/domain.schema.json`。

## 代码结构

- `src/event-store.js`：幂等追加存储（内存 + 可选 JSONL）
- `src/events.js`：事件工厂与载荷必填校验
- `src/claims.js` / `translations.js` / `packages.js` / `devices.js` / `answers.js`：各聚合与查询
- `src/platform.js`：装配入口
- `tests/platform.test.js`：从“昨晚投诉→紧急换包→暴露追溯→跨天重连”的完整端到端用例

## 本地检查

```bash
node --test
```
