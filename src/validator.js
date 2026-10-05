const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const EVENT_TYPES = [
  "CLAIM_DRAFTED",
  "CLAIM_REVISED",
  "CLAIM_EVIDENCE_ATTACHED",
  "CLAIM_EXPERT_REVIEWED",
  "CLAIM_APPROVED",
  "CLAIM_EMERGENCY_PUBLISHED",
  "CLAIM_COUNTERSIGNED",
  "NOTICE_EXPIRED",
  "TRANSLATION_REVISION_OPENED",
  "TRANSLATION_PROPOSED",
  "TRANSLATION_REVIEWED",
  "TRANSLATION_APPLIED",
  "PACKAGE_DEFINED",
  "PACKAGE_PUBLISHED",
  "DEVICE_REGISTERED",
  "DEVICE_ASSIGNED",
  "DEVICE_ACKNOWLEDGED",
];

const AGGREGATE_TYPES = ["knowledge_claim", "translation_revision", "content_package", "device_receipt"];

/** 返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);
  return errors;
}
