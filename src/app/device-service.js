import { append } from "./emit.js";
import { Repository } from "../store/repository.js";
import { packagePlayableAt, noticePlayableAt } from "../domain/content-package.js";

/**
 * 设备服务：注册、版本回执、心跳、重连判定与离线暴露排查。
 *
 * 重连顺序是硬性纪律——先按有效期判断“还能不能播”，再谈新鲜度：
 *   1. 装载的内容包已过有效期/被撤回 -> refresh_required，期间不得继续播报；
 *   2. 装载的紧急通知已过期或逾时未补签 -> stop_notice；
 *   3. 仍在有效期内时，对比后继发布包的指纹，列出设备上残留的旧说法/旧译文。
 */
export class DeviceService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.repo = new Repository(store);
    this.clock = clock;
  }

  register(cmd) {
    assert(cmd.device_id, "缺少 device_id");
    append(this.store, "device_receipt", cmd.device_id, [
      {
        command_id: cmd.command_id,
        event_type: "DEVICE_REGISTERED",
        occurred_at: cmd.occurred_at ?? this.clock(),
        summary: `注册讲解设备 ${cmd.label ?? cmd.device_id}`,
        label: cmd.label ?? cmd.device_id,
        site_id: cmd.site_id ?? null,
        languages: cmd.languages ?? ["zh"],
        offline_capable: cmd.offline_capable ?? true,
      },
    ]);
    return this.repo.device(cmd.device_id);
  }

  /**
   * 设备/网关回传版本回执。fingerprints 必须逐项列出，缺项视为未完整应用。
   * 幂等由 command_id 派生 event_id 保证（网关重试安全）。
   */
  acknowledge(cmd) {
    const device = this.repo.device(cmd.device_id);
    assert(device, `设备未注册：${cmd.device_id}`);
    assert(["package", "notice"].includes(cmd.kind), "回执对象类型必须是 package 或 notice");
    assert(cmd.object_id && Number.isInteger(cmd.object_version), "回执必须含 object_id 与 object_version");
    assert(["applied", "failed"].includes(cmd.status), "回执状态必须是 applied 或 failed");
    const expected =
      cmd.kind === "package"
        ? this.repo.package(cmd.object_id)?.publish?.content_fingerprints
        : null;
    if (cmd.kind === "package" && cmd.status === "applied" && expected) {
      const got = new Set((cmd.fingerprints ?? []).map((f) => `${f.ref}|${f.lang}|${f.hash}`));
      for (const f of expected) {
        if (!got.has(`${f.ref}|${f.lang}|${f.hash}`)) {
          throw new Error(`回执指纹与发布包 ${cmd.object_id} 不一致：缺少/不符 ${f.ref}/${f.lang}`);
        }
      }
    }
    append(this.store, "device_receipt", cmd.device_id, [
      {
        command_id: cmd.command_id,
        event_type: "DEVICE_ACKNOWLEDGED",
        occurred_at: cmd.occurred_at ?? this.clock(),
        summary: `设备回执 ${cmd.kind}/${cmd.object_id}@v${cmd.object_version}：${cmd.status}`,
        kind: cmd.kind,
        object_id: cmd.object_id,
        object_version: cmd.object_version,
        status: cmd.status,
        fingerprints: cmd.fingerprints ?? [],
        detail: cmd.detail ?? "",
      },
    ]);
    return this.repo.device(cmd.device_id);
  }

  heartbeat(cmd) {
    assert(this.repo.device(cmd.device_id), `设备未注册：${cmd.device_id}`);
    append(this.store, "device_receipt", cmd.device_id, [
      {
        command_id: cmd.command_id,
        event_type: "DEVICE_HEARTBEAT",
        occurred_at: cmd.occurred_at ?? this.clock(),
        summary: cmd.online ? "设备联网心跳" : "设备离线心跳",
        online: cmd.online,
        loaded: cmd.loaded ?? [],
      },
    ]);
    return this.repo.device(cmd.device_id);
  }

  /**
   * 设备重新联网时的判定。
   * @returns {{device_id, at, decisions: Array, summary: string}}
   */
  onReconnect(deviceId, atIso = this.clock()) {
    const device = this.repo.device(deviceId);
    assert(device, `设备未注册：${deviceId}`);
    const loaded = this.#loadedObjects(device);
    const decisions = [];

    for (const ref of loaded.filter((r) => r.kind === "package")) {
      const pkg = this.repo.package(ref.object_id);
      const play = packagePlayableAt(pkg, atIso);
      if (!play.playable) {
        decisions.push({
          kind: "package",
          object_id: ref.object_id,
          object_version: ref.object_version,
          action: "refresh_required",
          may_play: false,
          reasons: play.reasons,
          stale_items: [],
        });
        continue;
      }
      const latest = this.#latestInChain(pkg);
      const stale = latest.package_id === pkg.package_id ? [] : this.#diffStale(pkg, latest);
      decisions.push({
        kind: "package",
        object_id: ref.object_id,
        object_version: ref.object_version,
        latest_object_id: latest.package_id,
        action: stale.length > 0 ? "refresh_recommended" : "continue",
        may_play: true,
        reasons: [],
        stale_items: stale,
      });
    }

    for (const ref of loaded.filter((r) => r.kind === "notice")) {
      const play = noticePlayableAt(this.repo.notice(ref.object_id), atIso);
      decisions.push({
        kind: "notice",
        object_id: ref.object_id,
        object_version: ref.object_version,
        action: play.playable ? "continue" : "stop_notice",
        may_play: play.playable,
        reasons: play.reasons,
      });
    }

    return {
      device_id: deviceId,
      at: atIso,
      decisions,
      summary: decisions
        .map((d) => `${d.kind}/${d.object_id}:${d.action}`)
        .join("，") || "无装载内容",
    };
  }

  /**
   * 离线暴露排查：针对某个“最新包”，找出仍装载其基线链上旧版本、
   * 因而可能还在播放已被替换说法的设备。回答“错误说法还留在哪些离线设备里”。
   */
  devicesExposing(latestPackageId, atIso = this.clock()) {
    const latest = this.repo.package(latestPackageId);
    assert(latest?.status === "published", `最新包不存在或未发布：${latestPackageId}`);
    const chainIds = new Set(this.#chain(latest).map((p) => p.package_id));

    const report = [];
    for (const device of this.repo.allDevices()) {
      // 设备对该链上各包的最新 applied 回执
      const acked = device.acks
        .filter((a) => a.kind === "package" && chainIds.has(a.object_id) && a.status === "applied")
        .at(-1);
      if (!acked || acked.object_id === latestPackageId) continue;

      const onDevicePkg = this.repo.package(acked.object_id);
      const play = packagePlayableAt(onDevicePkg, atIso);
      const stale = this.#diffStale(onDevicePkg, latest);
      const online = device.last_heartbeat?.online ?? null;
      report.push({
        device_id: device.device_id,
        label: device.label,
        site_id: device.site_id,
        online,
        last_heartbeat_at: device.last_heartbeat?.at ?? null,
        loaded_package_id: acked.object_id,
        loaded_package_version: acked.object_version,
        acknowledged_at: acked.at,
        loaded_package_playable: play.playable,
        loaded_package_reasons: play.reasons,
        stale_items: stale,
      });
    }
    return {
      latest_package_id: latestPackageId,
      at: atIso,
      affected_devices: report,
      offline_devices: report.filter((d) => d.online === false).map((d) => d.device_id),
      unknown_devices: report.filter((d) => d.online === null).map((d) => d.device_id),
    };
  }

  // ---- 内部 ----

  #loadedObjects(device) {
    if (device.last_heartbeat?.loaded?.length) return device.last_heartbeat.loaded;
    // 无心跳快照时按最新回执推断
    const map = new Map();
    for (const ack of device.acks) {
      if (ack.status === "applied") map.set(`${ack.kind}:${ack.object_id}`, {
        kind: ack.kind,
        object_id: ack.object_id,
        object_version: ack.object_version,
      });
    }
    return [...map.values()];
  }

  /** 沿 impact_preview.baseline_package_id 向前找最新后继。 */
  #latestInChain(pkg) {
    let current = pkg;
    const seen = new Set();
    while (current) {
      if (seen.has(current.package_id)) break;
      seen.add(current.package_id);
      const child = this.repo.allPackages().find(
        (p) => p.status === "published" && p.publish?.impact_preview?.baseline_package_id === current.package_id
      );
      if (!child) return current;
      current = child;
    }
    return current;
  }

  /** 返回从最新包沿基线链回溯到（含）最新包的全部包，旧到新。 */
  #chain(latest) {
    const out = [];
    let cur = latest;
    const seen = new Set();
    while (cur && !seen.has(cur.package_id)) {
      seen.add(cur.package_id);
      out.unshift(cur);
      const baseId = cur.publish?.impact_preview?.baseline_package_id;
      cur = baseId ? this.repo.package(baseId) : null;
    }
    return out;
  }

  /** 设备包相对最新包被替换/移除的具体条目（含旧文本，便于现场核对）。 */
  #diffStale(onDevicePkg, latest) {
    const latestFp = new Map(
      (latest.publish.content_fingerprints ?? []).map((f) => [f.ref, f])
    );
    const stale = [];
    for (const f of onDevicePkg.publish.content_fingerprints ?? []) {
      const now = latestFp.get(f.ref);
      if (now && now.hash === f.hash) continue;
      const oldItem = onDevicePkg.publish.manifest.find((m) => m.ref === f.ref && m.lang === f.lang);
      const newItem = latest.publish.manifest.find((m) => m.ref === f.ref && m.lang === f.lang);
      stale.push({
        ref: f.ref,
        lang: f.lang,
        on_device_text: oldItem?.text ?? null,
        latest_text: newItem?.text ?? null,
        reason: !now ? "removed_in_latest" : "revised_in_latest",
        via_revision: newItem?.provenance_revision ?? null,
      });
    }
    return stale;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
