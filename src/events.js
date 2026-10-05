import { DomainError } from "./errors.js";

export const EVENT_TYPES = [
  // knowledge_claim
  "CLAIM_DRAFTED",
  "CLAIM_REVISED",
  "CLAIM_EVIDENCE_ATTACHED",
  "CLAIM_EXPERT_REVIEWED",
  "CLAIM_APPROVED",
  "CLAIM_EMERGENCY_PUBLISHED",
  "CLAIM_COUNTERSIGNED",
  "NOTICE_EXPIRED",
  // translation_revision
  "TRANSLATION_REVISION_OPENED",
  "TRANSLATION_PROPOSED",
  "TRANSLATION_REVIEWED",
  "TRANSLATION_APPLIED",
  // content_package
  "PACKAGE_DEFINED",
  "PACKAGE_PUBLISHED",
  // device_receipt
  "DEVICE_REGISTERED",
  "DEVICE_ASSIGNED",
  "DEVICE_ACKNOWLEDGED",
];

export const AGGREGATE_TYPES = [
  "knowledge_claim",
  "translation_revision",
  "content_package",
  "device_receipt",
];

const REQUIRE = {
  CLAIM_DRAFTED: ["kind", "topic_id", "statement_key", "text_zh"],
  CLAIM_REVISED: ["text_zh", "reason"],
  CLAIM_EVIDENCE_ATTACHED: ["sources"],
  CLAIM_EXPERT_REVIEWED: ["expert_id", "verdict", "opinion"],
  CLAIM_APPROVED: ["approver", "basis"],
  CLAIM_EMERGENCY_PUBLISHED: ["reason", "countersign_due_at", "valid_until"],
  CLAIM_COUNTERSIGNED: ["approver"],
  NOTICE_EXPIRED: ["reason"],
  TRANSLATION_REVISION_OPENED: ["language", "reason"],
  TRANSLATION_PROPOSED: ["statement_key", "text", "based_on_claim_version"],
  TRANSLATION_REVIEWED: ["reviewer", "decisions", "affected"],
  TRANSLATION_APPLIED: ["applied"],
  PACKAGE_DEFINED: ["created_by", "statement_keys", "qa_templates"],
  PACKAGE_PUBLISHED: ["package_version", "impact", "citations", "published_at"],
  DEVICE_REGISTERED: ["label"],
  DEVICE_ASSIGNED: ["package_id"],
  DEVICE_ACKNOWLEDGED: ["package_id", "package_version", "received_at"],
};

/** 构造一条完整事件信封并做最小载荷校验。 */
export function makeEvent({
  eventId,
  eventType,
  aggregateType,
  aggregateId,
  version,
  occurredAt,
  summary,
  payload = {},
}) {
  if (!AGGREGATE_TYPES.includes(aggregateType)) throw new DomainError("BAD_EVENT", `未知聚合类型：${aggregateType}`);
  if (!EVENT_TYPES.includes(eventType)) throw new DomainError("BAD_EVENT", `未知事件类型：${eventType}`);
  for (const field of REQUIRE[eventType] ?? []) {
    if (!(field in payload)) throw new DomainError("BAD_EVENT", `${eventType} 缺少字段：${field}`);
  }
  return {
    event_id: eventId,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version,
    summary,
    ...(Object.keys(payload).length ? { payload } : {}),
  };
}
