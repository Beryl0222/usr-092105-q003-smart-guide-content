/**
 * device_receipt 聚合的事件归约（一台设备一条流）。
 *
 * 保存三类事实：
 * - DEVICE_REGISTERED：设备档案（站点、支持语言、离线能力）；
 * - DEVICE_ACKNOWLEDGED：设备对某个内容包/紧急通知版本的回执，含逐项内容指纹，
 *   这是“每台设备的版本回执可确认”的依据，也是离线设备排查的基础；
 * - DEVICE_HEARTBEAT：联网状态与当前装载版本快照。
 *
 * 设备重新联网时“先按有效期判断能否继续播报”的跨聚合判定不在本归约器内，
 * 由 services/reconnection.js 结合内容包/通知状态完成。
 */

export function reduceDeviceReceipt(events) {
  let state = null;
  for (const e of events) {
    switch (e.event_type) {
      case "DEVICE_REGISTERED":
        state = {
          device_id: e.aggregate_id,
          label: e.label,
          site_id: e.site_id,
          languages: e.languages ?? ["zh"],
          offline_capable: e.offline_capable ?? true,
          registered_at: e.occurred_at,
          acks: [], // 按时间追加，最新一条代表该对象的当前版本
          last_heartbeat: null,
        };
        break;
      case "DEVICE_ACKNOWLEDGED":
        state.acks.push({
          kind: e.kind, // 'package' | 'notice'
          object_id: e.object_id,
          object_version: e.object_version,
          at: e.occurred_at,
          status: e.status, // applied | failed
          fingerprints: e.fingerprints ?? [], // [{ref, lang, hash}]
          detail: e.detail ?? "",
        });
        break;
      case "DEVICE_HEARTBEAT":
        state.last_heartbeat = {
          at: e.occurred_at,
          online: e.online,
          loaded: e.loaded ?? [], // [{kind:'package'|'notice', object_id, object_version}]
        };
        break;
      default:
        throw new Error(`device_receipt 归约器无法处理事件：${e.event_type}`);
    }
  }
  return state;
}

/** 设备对某内容对象的最新回执；无回执返回 null。 */
export function latestAck(deviceState, kind, objectId) {
  if (!deviceState) return null;
  for (let i = deviceState.acks.length - 1; i >= 0; i--) {
    const ack = deviceState.acks[i];
    if (ack.kind === kind && ack.object_id === objectId) return ack;
  }
  return null;
}

/** 设备当前确认在用的全部内容包（以最新回执为准，applied 状态）。 */
export function acknowledgedPackages(deviceState) {
  if (!deviceState) return [];
  const latest = new Map();
  for (const ack of deviceState.acks) {
    if (ack.kind === "package") latest.set(ack.object_id, ack);
  }
  return [...latest.values()].filter((a) => a.status === "applied");
}
