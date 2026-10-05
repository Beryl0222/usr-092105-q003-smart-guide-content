const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const eventTypesByAggregate = {
  knowledge_claim: [
    "CLAIM_RECORDED",
    "EXPERT_OPINION_ADDED",
    "CLAIM_APPROVED",
    "CLAIM_REVISED",
    "QA_TEMPLATE_APPROVED",
    "GLOSSARY_TERM_APPROVED",
  ],
  translation_revision: ["TRANSLATION_PROPOSED", "TRANSLATION_REVIEWED"],
  content_package: [
    "PACKAGE_DRAFTED",
    "PACKAGE_PUBLISHED",
    "PACKAGE_WITHDRAWN",
    "NOTICE_ISSUED",
    "NOTICE_COUNTERSIGNED",
    "NOTICE_EXPIRED",
  ],
  device_receipt: ["DEVICE_REGISTERED", "DEVICE_ACKNOWLEDGED", "DEVICE_HEARTBEAT"],
};

const knownEventTypes = new Set(Object.values(eventTypesByAggregate).flat());
const knownAggregateTypes = new Set(Object.keys(eventTypesByAggregate));

/** 返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length < 8)) {
    errors.push("event_id 至少 8 个字符");
  }
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length < 2)) {
    errors.push("summary 必须是不少于 2 个字符的中文摘要");
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  if ("event_type" in record && !knownEventTypes.has(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !knownAggregateTypes.has(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (
    knownEventTypes.has(record.event_type) &&
    knownAggregateTypes.has(record.aggregate_type) &&
    !eventTypesByAggregate[record.aggregate_type].includes(record.event_type)
  ) {
    errors.push(`事件类型 ${record.event_type} 不属于聚合 ${record.aggregate_type}`);
  }
  return errors;
}

export { eventTypesByAggregate };
