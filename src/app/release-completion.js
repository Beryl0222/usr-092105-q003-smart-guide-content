import { Repository } from "../store/repository.js";
import { packagePlayableAt } from "../domain/content-package.js";

/**
 * 发布完成度清单。
 *
 * “一次发布只有在以下四项全部满足时才算完成”：
 *  1. 影响预览可解释：PACKAGE_PUBLISHED 固化 impact_preview（含基线、逐项变化、校验和）；
 *  2. 游客侧出处与更新时间可查询：visitor_provenance 每条记录都有公开出处与更新时间；
 *  3. 每台目标设备的版本回执可确认：applied 回执对象版本 == 发布事件版本，指纹逐项匹配；
 *  4. 未公开研究材料未外泄：发布载荷不含 restricted 段落（发布闸已拦截，这里复核并留痕）。
 *
 * 第 3 项是发布后异步达成的：发布事件先落、设备陆续回执，本清单给出当前完成度，
 * 运营据此知道“还剩哪些设备没换到新包”。
 */
export class ReleaseCompletion {
  constructor(store) {
    this.repo = new Repository(store);
  }

  assess(packageId, expectedDeviceIds, atIso = new Date().toISOString()) {
    const pkg = this.repo.package(packageId);
    const checks = [];

    // 1. 影响预览
    const preview = pkg?.publish?.impact_preview ?? null;
    checks.push({
      key: "impact_preview_explained",
      passed: Boolean(
        preview &&
          Array.isArray(preview.changes) &&
          typeof preview.checksum === "string" &&
          preview.checksum.length > 0
      ),
      detail: preview
        ? `基线 ${preview.baseline_package_id ?? "无"}，变化 ${preview.changes.length} 项，校验和 ${preview.checksum}`
        : "发布事件中缺少影响预览",
    });

    // 2. 游客侧出处与更新时间
    const prov = pkg?.publish?.visitor_provenance ?? null;
    const missingProv = (prov?.records ?? []).filter(
      (r) => !r.sources || r.sources.length === 0 || !r.content_updated_at
    );
    checks.push({
      key: "visitor_provenance_queryable",
      passed: Boolean(prov && prov.records.length > 0 && missingProv.length === 0),
      detail: prov
        ? `出处记录 ${prov.records.length} 条，缺出处/更新时间 ${missingProv.length} 条`
        : "缺少游客侧出处清单",
      missing: missingProv.map((r) => `${r.ref}/${r.lang}`),
    });

    // 3. 设备回执覆盖
    const publishedVersion = pkg?.publish?.version ?? null;
    const expectedFp = new Set(
      (pkg?.publish?.content_fingerprints ?? []).map((f) => `${f.ref}|${f.lang}|${f.hash}`)
    );
    const devices = [];
    for (const deviceId of expectedDeviceIds ?? []) {
      const device = this.repo.device(deviceId);
      if (!device) {
        devices.push({ device_id: deviceId, status: "unknown_device" });
        continue;
      }
      const ack = [...device.acks]
        .reverse()
        .find((a) => a.kind === "package" && a.object_id === packageId);
      if (!ack) {
        devices.push({ device_id: deviceId, status: "no_receipt" });
        continue;
      }
      if (ack.status === "failed") {
        devices.push({ device_id: deviceId, status: "failed", at: ack.at, detail: ack.detail });
        continue;
      }
      const versionOk = ack.object_version === publishedVersion;
      const got = new Set(ack.fingerprints.map((f) => `${f.ref}|${f.lang}|${f.hash}`));
      const missingFp = [...expectedFp].filter((k) => !got.has(k));
      devices.push({
        device_id: deviceId,
        status: versionOk && missingFp.length === 0 ? "confirmed" : "version_mismatch",
        acknowledged_version: ack.object_version,
        published_version: publishedVersion,
        missing_fingerprints: missingFp,
        at: ack.at,
      });
    }
    const confirmed = devices.filter((d) => d.status === "confirmed").length;
    checks.push({
      key: "device_receipts_confirmed",
      passed: devices.length > 0 && confirmed === devices.length,
      detail: `目标设备 ${devices.length} 台，版本回执确认 ${confirmed} 台`,
      devices,
    });

    // 4. 密级外泄复核（静态扫描发布时固化的载荷）
    const leakage = [];
    for (const entry of pkg?.entries ?? []) {
      const claim = this.repo.claim(entry.claim_id);
      for (const s of claim?.sources ?? []) {
        if (s.access !== "restricted" || !s.excerpt) continue;
        for (const item of pkg.publish?.manifest ?? []) {
          if (item.text?.includes(s.excerpt)) leakage.push({ source_id: s.source_id, ref: item.ref, lang: item.lang });
        }
      }
    }
    checks.push({
      key: "no_restricted_leakage",
      passed: leakage.length === 0,
      detail: leakage.length === 0 ? "发布载荷未包含未公开来源段落原文" : `发现外泄 ${leakage.length} 处`,
      leakage,
    });

    // 附：当前是否仍在播报窗口（非完成标准，但运营需要）
    const play = pkg ? packagePlayableAt(pkg, atIso) : { playable: false, reasons: ["内容包不存在"] };

    const passed = checks.every((c) => c.passed);
    return {
      package_id: packageId,
      at: atIso,
      complete: passed,
      playable: play.playable,
      playable_reasons: play.reasons,
      checks,
    };
  }
}
