import { eventId } from "./emit-ids.js";

/**
 * 命令 -> 事件的幂等追加。
 * 每条上游命令带 command_id；重试同一命令必须复用 command_id，
 * 由此派生稳定 event_id，EventStore 的 event_id 唯一约束完成去重。
 * 重试时按已存事件的原版本号重建载荷：内容一致即 duplicate，内容被篡改则由存储拒绝。
 */
export function append(store, aggregateType, aggregateId, builds) {
  const baseVersion = store.streamVersion(aggregateType, aggregateId);
  return builds.map((build, i) => {
    const id = build.event_id ?? eventId(build.command_id, i + 1);
    const stored = store.getEvent(id);
    const version = stored ? stored.version : baseVersion + i + 1;
    const event = {
      ...build,
      event_id: id,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      version,
    };
    delete event.command_id;
    return store.append(event);
  });
}

export { eventId };
