import { validateEvent } from "../validator.js";

/**
 * 幂等事件存储：
 * - 按 event_id 全局幂等。来源系统重试沿用同一 event_id 时，返回已存事件，不产生重复版本。
 * - 按 (aggregate_type, aggregate_id) 形成事件流，version 必须为流内下一个连续整数。
 * - append 为同步串行；真实持久化实现需保证同一聚合流的串行化。
 * 存储为内存 Map，跨进程部署应替换为同样提供“event_id 唯一约束 + 聚合流顺序”的实现。
 */
export class EventStore {
  #events = new Map(); // event_id -> event
  #streams = new Map(); // streamKey -> event[]

  static streamKey(aggregateType, aggregateId) {
    return `${aggregateType}:${aggregateId}`;
  }

  /**
   * 追加事件。
   * @returns {{status: 'appended'|'duplicate', event: object}}
   *   重复 event_id 且载荷一致时返回 duplicate；载荷冲突时抛错（不能静默改写历史）。
   */
  append(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new EventContractError(errors);

    const existing = this.#events.get(event.event_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error(`幂等冲突：event_id=${event.event_id} 已存在但载荷不同，拒绝覆盖历史`);
      }
      return { status: "duplicate", event: existing };
    }

    const key = EventStore.streamKey(event.aggregate_type, event.aggregate_id);
    const stream = this.#streams.get(key) ?? [];
    const expected = stream.length + 1;
    if (event.version !== expected) {
      throw new ConcurrencyError(
        `版本冲突：聚合 ${key} 下一版本应为 ${expected}，收到 ${event.version}`
      );
    }
    stream.push(event);
    this.#streams.set(key, stream);
    this.#events.set(event.event_id, event);
    return { status: "appended", event };
  }

  /** 读取某聚合流的全部事件（按版本序）。 */
  loadStream(aggregateType, aggregateId) {
    const key = EventStore.streamKey(aggregateType, aggregateId);
    return [...(this.#streams.get(key) ?? [])];
  }

  /** 读取所有事件，默认按 (流键, 版本) 稳定排序；投影构建用。 */
  loadAll() {
    return [...this.#streams.values()]
      .flat()
      .sort((a, b) => {
        const ka = EventStore.streamKey(a.aggregate_type, a.aggregate_id);
        const kb = EventStore.streamKey(b.aggregate_type, b.aggregate_id);
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.version - b.version;
      });
  }

  hasEvent(eventId) {
    return this.#events.has(eventId);
  }

  getEvent(eventId) {
    return this.#events.get(eventId) ?? null;
  }

  streamVersion(aggregateType, aggregateId) {
    return (this.#streams.get(EventStore.streamKey(aggregateType, aggregateId)) ?? []).length;
  }
}

export class EventContractError extends Error {
  constructor(errors) {
    super(`事件契约不合法：${errors.join("；")}`);
    this.name = "EventContractError";
    this.errors = errors;
  }
}

export class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConcurrencyError";
  }
}
