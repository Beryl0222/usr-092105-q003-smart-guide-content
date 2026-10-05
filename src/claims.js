import { DomainError } from "./errors.js";
import { makeEvent } from "./events.js";

const PUBLIC_LEVELS = ["public", "restricted", "unpublished"];

/** 把某条 claim 的事件流折叠为当前状态。 */
export function foldClaim(events) {
  const state = {
    claim_id: null,
    kind: null,
    topic_id: null,
    statement_key: null,
    text_zh: null,
    terms: [],
    accessible_text_zh: null,
    sources: [],
    expert_reviews: [],
    status: "missing",
    version: 0,
    approved_at: null,
    approved_version: null,
    emergency: null,
    revisions: [],
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "CLAIM_DRAFTED":
        Object.assign(state, {
          claim_id: e.aggregate_id,
          kind: p.kind,
          topic_id: p.topic_id,
          statement_key: p.statement_key,
          text_zh: p.text_zh,
          terms: p.terms ?? [],
          accessible_text_zh: p.accessible_text_zh ?? null,
          status: "draft",
        });
        break;
      case "CLAIM_REVISED":
        state.revisions.push({ text_zh: p.text_zh, reason: p.reason, at: e.occurred_at });
        state.text_zh = p.text_zh;
        if (p.terms) state.terms = p.terms;
        if (p.accessible_text_zh !== undefined) state.accessible_text_zh = p.accessible_text_zh;
        state.status = "draft";
        break;
      case "CLAIM_EVIDENCE_ATTACHED":
        state.sources.push(...p.sources);
        break;
      case "CLAIM_EXPERT_REVIEWED":
        state.expert_reviews.push({
          expert_id: p.expert_id,
          verdict: p.verdict,
          opinion: p.opinion,
          at: e.occurred_at,
        });
        break;
      case "CLAIM_APPROVED":
        state.status = "approved";
        state.approved_at = e.occurred_at;
        state.approved_version = e.version;
        state.approver = p.approver;
        state.approval_basis = p.basis;
        break;
      case "CLAIM_EMERGENCY_PUBLISHED":
        state.status = "emergency";
        state.approved_at = e.occurred_at;
        state.approved_version = e.version;
        state.emergency = {
          reason: p.reason,
          countersign_due_at: p.countersign_due_at,
          valid_until: p.valid_until,
          published_at: e.occurred_at,
          countersigned_at: null,
          countersigned_by: null,
          on_time: null,
        };
        break;
      case "CLAIM_COUNTERSIGNED":
        if (state.emergency) {
          state.emergency.countersigned_at = e.occurred_at;
          state.emergency.countersigned_by = p.approver;
          state.emergency.on_time = Date.parse(e.occurred_at) <= Date.parse(state.emergency.countersign_due_at);
          state.status = "approved";
        }
        break;
      case "NOTICE_EXPIRED":
        state.status = "expired";
        break;
      default:
    }
    state.version = e.version;
  }
  return state;
}

/** 通知此刻是否允许继续播报：未过期，且紧急件已按时补签或仍在补签时限内。 */
export function noticePlayable(claim, nowIso) {
  if (claim.kind !== "notice" || claim.status === "expired") return false;
  const t = Date.parse(nowIso);
  if (t > Date.parse(claim.emergency.valid_until)) return false;
  const em = claim.emergency;
  if (em.countersigned_at) return true;
  return t <= Date.parse(em.countersign_due_at);
}

export function createClaimService(store, { now, genId }) {
  const load = (claimId) => {
    const events = store.stream("knowledge_claim", claimId);
    if (!events.length) throw new DomainError("CLAIM_NOT_FOUND", `主张不存在：${claimId}`);
    return foldClaim(events);
  };

  const emit = (claimId, eventType, payload, summary, eventId) => {
    const version = store.stream("knowledge_claim", claimId).length + 1;
    return store.append(
      makeEvent({
        eventId: eventId ?? genId("evt-claim"),
        eventType,
        aggregateType: "knowledge_claim",
        aggregateId: claimId,
        version,
        occurredAt: now(),
        summary,
        payload,
      })
    ).event;
  };

  const replay = (eventId, expectedType) => {
    if (!eventId) return null;
    const existing = store.getEvent(eventId);
    if (existing && existing.event_type !== expectedType) {
      throw new DomainError("EVENT_ID_CONFLICT", `事件 ${eventId} 已存在但类型不一致，禁止复用标识`);
    }
    return existing;
  };

  return {
    draft({ claim_id, kind, topic_id, statement_key, text_zh, terms = [], accessible_text_zh = null, eventId } = {}) {
      const existing = replay(eventId, "CLAIM_DRAFTED");
      if (existing) return existing;
      if (!["fact", "interpretation", "notice"].includes(kind)) {
        throw new DomainError("BAD_KIND", "kind 必须是 fact、interpretation 或 notice");
      }
      if (store.stream("knowledge_claim", claim_id).length) {
        throw new DomainError("CLAIM_EXISTS", `主张已存在：${claim_id}`);
      }
      return emit(
        claim_id,
        "CLAIM_DRAFTED",
        { kind, topic_id, statement_key, text_zh, terms, accessible_text_zh },
        `登记${kind === "fact" ? "事实" : kind === "interpretation" ? "解释性主张" : "临时运营通知"}：${statement_key}`,
        eventId
      );
    },

    /** 中文稿修订：改后回到待批准状态，必须重走门禁，译文依据版本也会随之失效。 */
    revise(claim_id, { text_zh, reason, terms = undefined, accessible_text_zh = undefined }, eventId) {
      const existing = replay(eventId, "CLAIM_REVISED");
      if (existing) return existing;
      const claim = load(claim_id);
      if (claim.kind === "notice") throw new DomainError("NOTICE_REVISION", "临时通知以到期/下线管理，不在此修订");
      return emit(
        claim_id,
        "CLAIM_REVISED",
        { text_zh, reason, ...(terms !== undefined ? { terms } : {}), ...(accessible_text_zh !== undefined ? { accessible_text_zh } : {}) },
        `修订 ${claim.statement_key}：${reason}`,
        eventId
      );
    },

    attachEvidence(claim_id, sources, eventId) {
      const existing = replay(eventId, "CLAIM_EVIDENCE_ATTACHED");
      if (existing) return existing;
      const claim = load(claim_id);
      for (const s of sources) {
        for (const f of ["source_id", "title", "paragraph_ref", "quote", "public_level"]) {
          if (!(f in s)) throw new DomainError("BAD_SOURCE", `来源缺少字段：${f}`);
        }
        if (!PUBLIC_LEVELS.includes(s.public_level)) {
          throw new DomainError("BAD_SOURCE", `公开级别非法：${s.public_level}`);
        }
      }
      return emit(claim_id, "CLAIM_EVIDENCE_ATTACHED", { sources }, `为 ${claim.statement_key} 关联 ${sources.length} 条来源段落`, eventId);
    },

    expertReview(claim_id, { expert_id, verdict, opinion }, eventId) {
      const existing = replay(eventId, "CLAIM_EXPERT_REVIEWED");
      if (existing) return existing;
      const claim = load(claim_id);
      if (!["support", "dispute", "uncertain"].includes(verdict)) {
        throw new DomainError("BAD_VERDICT", "专家结论必须是 support、dispute 或 uncertain");
      }
      return emit(
        claim_id,
        "CLAIM_EXPERT_REVIEWED",
        { expert_id, verdict, opinion },
        `专家 ${expert_id} 对 ${claim.statement_key} 出具意见：${verdict}`,
        eventId
      );
    },

    /** 事实须有公开来源支撑且专家支持；解释性主张须有专家意见并显式标注为学界推测。 */
    approve(claim_id, { approver, basis }, eventId) {
      const existing = replay(eventId, "CLAIM_APPROVED");
      if (existing) return existing;
      const claim = load(claim_id);
      if (claim.kind === "notice") {
        throw new DomainError("NOTICE_NEEDS_EMERGENCY_PATH", "临时通知走紧急发布路径，不能常规审批");
      }
      const failures = [];
      const publicSources = claim.sources.filter((s) => s.public_level === "public");
      if (!publicSources.length) failures.push("缺少公开来源段落");
      if (claim.kind === "fact" && !claim.expert_reviews.some((r) => r.verdict === "support")) {
        failures.push("事实类主张须有专家支持意见");
      }
      if (claim.kind === "interpretation") {
        if (!claim.expert_reviews.length) failures.push("解释性主张须留存专家意见");
        if (basis?.framing !== "scholarly_speculation") {
          failures.push("解释性主张必须标注 framing=scholarly_speculation，避免以确定语气播报");
        }
      }
      if (claim.sources.some((s) => s.public_level === "unpublished")) {
        failures.push("不得依赖未公开研究材料");
      }
      if (failures.length) throw new DomainError("APPROVAL_REJECTED", `审批驳回：${failures.join("；")}`);
      return emit(
        claim_id,
        "CLAIM_APPROVED",
        { approver, basis },
        `${approver} 批准 ${claim.statement_key}（${claim.kind}）`,
        eventId
      );
    },

    /** 紧急通知可先发；必须给出补签时限与有效期，全过程留痕。 */
    emergencyPublish(claim_id, { reason, valid_until, countersign_due_at }, eventId) {
      const existing = replay(eventId, "CLAIM_EMERGENCY_PUBLISHED");
      if (existing) return existing;
      const claim = load(claim_id);
      if (claim.kind !== "notice") throw new DomainError("NOT_NOTICE", "只有临时通知可以紧急发布");
      if (!(Date.parse(valid_until) > Date.parse(now()))) throw new DomainError("BAD_WINDOW", "valid_until 必须晚于当前时间");
      if (!(Date.parse(countersign_due_at) > Date.parse(now())) || !(Date.parse(countersign_due_at) <= Date.parse(valid_until))) {
        throw new DomainError("BAD_WINDOW", "补签时限必须在当前时间之后、且不晚于通知有效期");
      }
      return emit(
        claim_id,
        "CLAIM_EMERGENCY_PUBLISHED",
        { reason, valid_until, countersign_due_at },
        `紧急发布通知 ${claim.statement_key}：${reason}（须于 ${countersign_due_at} 前补签）`,
        eventId
      );
    },

    /** 补签；逾期补签会被如实标记 on_time=false，播报空窗期保留在历史中。 */
    countersign(claim_id, { approver }, eventId) {
      const existing = replay(eventId, "CLAIM_COUNTERSIGNED");
      if (existing) return existing;
      const claim = load(claim_id);
      if (!claim.emergency) throw new DomainError("NOT_EMERGENCY", "该主张不是待补签的紧急通知");
      if (claim.emergency.countersigned_at) throw new DomainError("ALREADY_COUNTERSIGNED", "补签已完成，不能重复");
      const onTime = Date.parse(now()) <= Date.parse(claim.emergency.countersign_due_at);
      const e = emit(
        claim_id,
        "CLAIM_COUNTERSIGNED",
        { approver, on_time: onTime },
        `${approver} ${onTime ? "按时" : "逾期"}补签通知 ${claim.statement_key}`,
        eventId
      );
      return e;
    },

    /** 过期扫描：对超过 valid_until 的通知补发 NOTICE_EXPIRED，返回本次到期的事件。 */
    expireDue(eventIdFor = () => genId("evt-notice")) {
      const expired = [];
      const ids = new Set(store.all("knowledge_claim").map((e) => e.aggregate_id));
      for (const id of ids) {
        const claim = load(id);
        if (claim.kind !== "notice" || claim.status === "expired" || !claim.emergency) continue;
        if (Date.parse(now()) >= Date.parse(claim.emergency.valid_until)) {
          expired.push(
            emit(id, "NOTICE_EXPIRED", { reason: "超过通知有效期" }, `通知 ${claim.statement_key} 到期下线`, eventIdFor(id))
          );
        }
      }
      return expired;
    },

    load,
    loadByKey(statementKey) {
      const ids = new Set(store.all("knowledge_claim").map((e) => e.aggregate_id));
      for (const id of ids) {
        const claim = load(id);
        if (claim.statement_key === statementKey) return claim;
      }
      throw new DomainError("CLAIM_NOT_FOUND", `语句键不存在：${statementKey}`);
    },
    noticePlayable: (claim) => noticePlayable(claim, now()),
  };
}
