import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { DomainError } from "./errors.js";

/** 来源系统重试时沿用原 event_id；版本号从 1 起在单聚合内连续递增。 */
export class EventStore {
  constructor({ path } = {}) {
    this.path = path;
    /** @type {Array<object>} */
    this.events = [];
    this.byEventId = new Map();
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this._ingest(JSON.parse(trimmed));
      }
    }
  }

  _ingest(event) {
    this.events.push(event);
    this.byEventId.set(event.event_id, event);
  }

  /** 幂等追加：同一 event_id 重试直接返回已存事件；版本必须严格接续。 */
  append(event) {
    const existing = this.byEventId.get(event.event_id);
    if (existing) {
      if (
        existing.aggregate_id !== event.aggregate_id ||
        existing.event_type !== event.event_type ||
        existing.version !== event.version
      ) {
        throw new DomainError(
          "EVENT_ID_CONFLICT",
          `事件 ${event.event_id} 已存在但内容不一致，禁止复用标识`
        );
      }
      return { event: existing, deduplicated: true };
    }

    const tail = this.events
      .filter((e) => e.aggregate_id === event.aggregate_id && e.aggregate_type === event.aggregate_type)
      .at(-1);
    const expected = tail ? tail.version + 1 : 1;
    if (event.version !== expected) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `${event.aggregate_type}/${event.aggregate_id} 期望版本 ${expected}，收到 ${event.version}`
      );
    }

    this._ingest(event);
    if (this.path) appendFileSync(this.path, JSON.stringify(event) + "\n");
    return { event, deduplicated: false };
  }

  getEvent(eventId) {
    return this.byEventId.get(eventId) ?? null;
  }

  stream(aggregateType, aggregateId) {
    return this.events.filter(
      (e) => e.aggregate_type === aggregateType && e.aggregate_id === aggregateId
    );
  }

  all(aggregateType) {
    return aggregateType ? this.events.filter((e) => e.aggregate_type === aggregateType) : [...this.events];
  }
}
