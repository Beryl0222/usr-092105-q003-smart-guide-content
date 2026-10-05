import { DomainError } from "./errors.js";
import { makeEvent } from "./events.js";
import { foldPackage } from "./packages.js";
import { noticePlayable } from "./claims.js";

export function foldDevice(events) {
  const state = {
    device_id: null,
    label: null,
    package_id: null,
    acks: [],
    version: 0,
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "DEVICE_REGISTERED":
        state.device_id = e.aggregate_id;
        state.label = p.label;
        break;
      case "DEVICE_ASSIGNED":
        state.package_id = p.package_id;
        break;
      case "DEVICE_ACKNOWLEDGED":
        state.acks.push({
          package_id: p.package_id,
          package_version: p.package_version,
          received_at: p.received_at,
          content_hash: p.content_hash ?? null,
        });
        break;
      default:
    }
    state.version = e.version;
  }
  return state;
}

export function createDeviceService(store, { now, genId, claims }) {
  const load = (deviceId) => {
    const events = store.stream("device_receipt", deviceId);
    if (!events.length) throw new DomainError("DEVICE_NOT_FOUND", `设备不存在：${deviceId}`);
    return foldDevice(events);
  };

  const emit = (deviceId, eventType, payload, summary, eventId) => {
    const version = store.stream("device_receipt", deviceId).length + 1;
    return store.append(
      makeEvent({
        eventId: eventId ?? genId("evt-dev"),
        eventType,
        aggregateType: "device_receipt",
        aggregateId: deviceId,
        version,
        occurredAt: now(),
        summary,
        payload,
      })
    ).event;
  };

  const packageState = (packageId) => foldPackage(store.stream("content_package", packageId));

  const replay = (eventId, expectedType) => {
    if (!eventId) return null;
    const existing = store.getEvent(eventId);
    if (existing && existing.event_type !== expectedType) {
      throw new DomainError("EVENT_ID_CONFLICT", `事件 ${eventId} 已存在但类型不一致，禁止复用标识`);
    }
    return existing;
  };

  /** 已发布版本按发布先后排序（语义版本号字典序不可靠）。 */
  const orderedVersions = (packageId) => [...packageState(packageId).versions.keys()];

  return {
    register({ device_id, label }, eventId) {
      const existing = replay(eventId, "DEVICE_REGISTERED");
      if (existing) return existing;
      if (store.stream("device_receipt", device_id).length) {
        throw new DomainError("DEVICE_EXISTS", `设备已注册：${device_id}`);
      }
      return emit(device_id, "DEVICE_REGISTERED", { label }, `注册设备：${label}`, eventId);
    },

    assign(device_id, package_id, eventId) {
      const existing = replay(eventId, "DEVICE_ASSIGNED");
      if (existing) return existing;
      const device = load(device_id);
      if (!store.stream("content_package", package_id).length) {
        throw new DomainError("PACKAGE_NOT_FOUND", `内容包不存在：${package_id}`);
      }
      return emit(device_id, "DEVICE_ASSIGNED", { package_id }, `设备 ${device.label} 投放到 ${package_id}`, eventId);
    },

    /**
     * 设备回执：按设备+包版本幂等。重发同一版本且内容哈希一致直接去重；
     * 哈希冲突说明包体被改动，拒绝并要求重新下载。
     */
    acknowledge(device_id, { package_id, package_version, received_at, content_hash = null }, eventId) {
      const device = load(device_id);
      const pkg = packageState(package_id);
      if (!pkg.versions.has(package_version)) {
        throw new DomainError("VERSION_NOT_FOUND", `未发布版本不存在：${package_id}@${package_version}`);
      }
      const prior = device.acks.find((a) => a.package_id === package_id && a.package_version === package_version);
      if (prior) {
        if ((prior.content_hash ?? null) !== (content_hash ?? null)) {
          throw new DomainError(
            "RECEIPT_CONFLICT",
            `设备 ${device_id} 对 ${package_id}@${package_version} 的回执内容哈希不一致，包体可能被篡改`
          );
        }
        return { deduplicated: true, event: null };
      }
      const event = emit(
        device_id,
        "DEVICE_ACKNOWLEDGED",
        { package_id, package_version, received_at, content_hash },
        `设备 ${device.label} 确认 ${package_id}@${package_version}（${received_at}）`,
        eventId
      );
      return { deduplicated: false, event };
    },

    /**
     * 设备重新联网时的判定——先按有效期判断能否继续播报：
     * CONTINUE：版本最新且包内通知均在有效期；
     * UPDATE：有新版本（含修复包）；
     * SUSPEND：版本最新但包内有通知失效/紧急件未按时补签，相关语句须停播。
     */
    reconnect(device_id) {
      const device = load(device_id);
      if (!device.package_id) throw new DomainError("NOT_ASSIGNED", `设备 ${device_id} 未投放内容包`);
      const pkg = packageState(device.package_id);
      const latest = pkg.current_version;
      const order = orderedVersions(device.package_id);
      const lastAck = device.acks
        .filter((a) => a.package_id === device.package_id)
        .sort((a, b) => order.indexOf(a.package_version) - order.indexOf(b.package_version))
        .at(-1);

      if (!lastAck) {
        return { decision: "UPDATE", reason: "设备尚未回执任何版本", target_version: latest };
      }
      if (lastAck.package_version !== latest) {
        return {
          decision: "UPDATE",
          reason: `设备版本 ${lastAck.package_version}，最新版本 ${latest}`,
          from_version: lastAck.package_version,
          target_version: latest,
        };
      }

      const release = pkg.versions.get(latest);
      const suspended = [];
      for (const s of release.manifest.statements) {
        if (s.kind !== "notice") continue;
        const claim = claims.loadByKey(s.statement_key);
        if (!noticePlayable(claim, now())) {
          const pastValidity = Date.parse(now()) > Date.parse(claim.emergency.valid_until);
          suspended.push({
            statement_key: s.statement_key,
            reason: pastValidity
              ? `通知已过有效期（至 ${claim.emergency.valid_until}）`
              : "紧急通知未在时限内补签",
          });
        }
      }
      if (suspended.length) {
        return { decision: "SUSPEND", package_version: latest, suspended_statements: suspended };
      }
      return { decision: "CONTINUE", package_version: latest, checked_at: now() };
    },

    /**
     * 错误说法暴露追溯：返回仍可能在离线播报指定语句（可选：指定 claim 版本/译文修订）的设备。
     * “仍可能”= 已回执的最高版本清单包含该语句，且设备尚未回执不含该问题的修复版本。
     */
    exposedDevices({ statement_key, claim_version = null, revision_id = null }) {
      const result = [];
      for (const e of store.all("device_receipt")) {
        if (e.event_type !== "DEVICE_ACKNOWLEDGED") continue;
        const { package_id, package_version } = e.payload;
        const order = orderedVersions(package_id);
        const release = packageState(package_id).versions.get(package_version);
        const hit = (release.manifest.statements ?? []).find((s) => {
          if (s.statement_key !== statement_key) return false;
          if (claim_version !== null && s.claim_version !== claim_version) return false;
          if (revision_id !== null) {
            const refs = Object.values(s.translations).map((t) => t.revision_id);
            if (!refs.includes(revision_id)) return false;
          }
          return true;
        });
        if (hit) {
          // 该设备是否已收到不含问题语句的更新版本？
          const device = foldDevice(store.stream("device_receipt", e.aggregate_id));
          const newest = device.acks
            .filter((a) => a.package_id === package_id)
            .map((a) => a.package_version)
            .sort((x, y) => order.indexOf(x) - order.indexOf(y))
            .at(-1);
          if (newest === package_version) {
            result.push({ device_id: e.aggregate_id, package_id, package_version, received_at: e.payload.received_at });
          }
        }
      }
      return result;
    },

    load,
  };
}
