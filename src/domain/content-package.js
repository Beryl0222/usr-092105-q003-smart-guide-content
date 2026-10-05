/**
 * content_package 聚合的事件归约。
 *
 * 同一聚合类型承载两类对象，二者互不出现在同一条流：
 * 1. 常规内容包：PACKAGE_DRAFTED -> PACKAGE_PUBLISHED ->（可选）PACKAGE_WITHDRAWN；
 * 2. 紧急运营通知：NOTICE_ISSUED（先发布）-> NOTICE_COUNTERSIGNED（限时补签）-> NOTICE_EXPIRED。
 *
 * 版本关系通过载荷中的引用固化：
 * - 内容包条目引用 claim_id + 已审定 claim 版本 + translation_revision id/版本；
 * - PACKAGE_PUBLISHED 携带编译时的影响预览快照与出处清单，发布后不可篡改。
 */

export function reduceContentPackage(events) {
  let state = null;
  for (const e of events) {
    switch (e.event_type) {
      case "PACKAGE_DRAFTED":
        state = {
          object_kind: "package",
          package_id: e.aggregate_id,
          status: "drafted",
          entries: e.entries ?? [], // [{claim_id, claim_version, languages:[...], qa_template_ids:[]}]
          translation_refs: e.translation_refs ?? [], // [{revision_id, version}]
          glossary_refs: e.glossary_refs ?? [],
          baseline_package_id: e.baseline_package_id ?? null,
          valid_from: e.valid_from,
          valid_until: e.valid_until ?? null,
          drafted_at: e.occurred_at,
          drafted_by: e.drafted_by,
          impact_preview: null,
          publish: null,
          withdrawal: null,
        };
        break;
      case "PACKAGE_PUBLISHED":
        state.status = "published";
        state.publish = {
          version: e.version,
          at: e.occurred_at,
          by: e.published_by,
          manifest: e.manifest, // [{ref:'claim@id/v', lang, source_ids:[], updated_at}]
          content_fingerprints: e.content_fingerprints ?? [], // 设备回执逐项核对用
          impact_preview: e.impact_preview, // 发布前已向操作者解释并确认的影响快照
          visitor_provenance: e.visitor_provenance, // 游客侧可见的出处与更新时间策略
        };
        break;
      case "PACKAGE_WITHDRAWN":
        state.status = "withdrawn";
        state.withdrawal = { version: e.version, at: e.occurred_at, reason: e.reason };
        break;
      case "NOTICE_ISSUED":
        state = {
          object_kind: "notice",
          notice_id: e.aggregate_id,
          status: "issued", // issued -> countersigned -> expired；逾期未补签则 stale_unsigned
          title: e.title,
          body: e.body, // [{lang, text}]
          issued_at: e.occurred_at,
          issued_by: e.issued_by,
          valid_until: e.valid_until,
          countersign_deadline: e.countersign_deadline, // 限时补签截止
          countersign: null,
          expiry: null,
          history: [{ version: e.version, at: e.occurred_at, status: "issued" }],
        };
        break;
      case "NOTICE_COUNTERSIGNED":
        state.status = "countersigned";
        state.countersign = {
          version: e.version,
          at: e.occurred_at,
          by: e.countersigned_by,
          note: e.note ?? "",
        };
        state.history.push({ version: e.version, at: e.occurred_at, status: "countersigned" });
        break;
      case "NOTICE_EXPIRED":
        state.status = "expired";
        state.expiry = { version: e.version, at: e.occurred_at, reason: e.reason ?? "到期失效" };
        state.history.push({ version: e.version, at: e.occurred_at, status: "expired" });
        break;
      default:
        throw new Error(`content_package 归约器无法处理事件：${e.event_type}`);
    }
  }
  return state;
}

/**
 * 紧急通知在指定时刻能否继续播报：
 * - 先看过期时间；
 * - 再看限时补签：超过截止仍未补签即失效（设备必须停止播报该通知）。
 */
export function noticePlayableAt(noticeState, atIso) {
  if (!noticeState || noticeState.object_kind !== "notice") {
    return { playable: false, reasons: ["对象不是紧急通知"] };
  }
  const at = Date.parse(atIso);
  const reasons = [];
  if (noticeState.status === "expired") reasons.push("通知已到期失效");
  if (Date.parse(noticeState.valid_until) <= at) reasons.push("已超过通知有效期");
  if (
    noticeState.status === "issued" &&
    Date.parse(noticeState.countersign_deadline) <= at
  ) {
    reasons.push("紧急通知逾时未补签，不得继续播报");
  }
  return { playable: reasons.length === 0, reasons };
}

/** 常规内容包在指定时刻是否仍在有效播报窗口内。 */
export function packagePlayableAt(packageState, atIso) {
  if (!packageState || packageState.object_kind !== "package") {
    return { playable: false, reasons: ["对象不是内容包"] };
  }
  const reasons = [];
  if (packageState.status === "drafted") reasons.push("内容包尚未发布");
  if (packageState.status === "withdrawn") reasons.push("内容包已撤回");
  const at = Date.parse(atIso);
  if (packageState.valid_from && Date.parse(packageState.valid_from) > at) {
    reasons.push("尚未到达生效时间");
  }
  if (packageState.valid_until && Date.parse(packageState.valid_until) <= at) {
    reasons.push("内容包已过有效期");
  }
  return { playable: reasons.length === 0, reasons };
}
