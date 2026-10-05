import { DomainError } from "./errors.js";
import { makeEvent } from "./events.js";

export function foldRevision(events) {
  const state = {
    revision_id: null,
    language: null,
    reason: null,
    status: "missing",
    version: 0,
    proposals: new Map(),
    review: null,
    applied: null,
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "TRANSLATION_REVISION_OPENED":
        Object.assign(state, { revision_id: e.aggregate_id, language: p.language, reason: p.reason, status: "open" });
        break;
      case "TRANSLATION_PROPOSED":
        state.proposals.set(p.statement_key, {
          statement_key: p.statement_key,
          text: p.text,
          qa_questions: p.qa_questions ?? [],
          based_on_claim_version: p.based_on_claim_version,
        });
        state.status = "proposed";
        break;
      case "TRANSLATION_REVIEWED":
        state.review = { reviewer: p.reviewer, decisions: p.decisions, affected: p.affected, at: e.occurred_at };
        state.status = "reviewed";
        break;
      case "TRANSLATION_APPLIED":
        state.applied = { keys: p.applied, at: e.occurred_at };
        state.status = "applied";
        break;
      default:
    }
    state.version = e.version;
  }
  return state;
}

/**
 * 跨修订投影：每种语言、每个语句键当前生效的译文与问法。
 * 设备/组合回答只能读到 applied 之后的译文。
 */
export function buildTranslationIndex(store) {
  const index = new Map(); // lang -> key -> {text, qa_questions, revision_id, claim_version}
  for (const e of store.all("translation_revision")) {
    if (e.event_type !== "TRANSLATION_APPLIED") continue;
    const p = e.payload;
    const bucket = index.get(p.language) ?? new Map();
    for (const item of p.texts) {
      bucket.set(item.statement_key, {
        text: item.text,
        qa_questions: item.qa_questions,
        revision_id: e.aggregate_id,
        claim_version: item.based_on_claim_version,
        applied_at: e.occurred_at,
      });
    }
    index.set(p.language, bucket);
  }
  return {
    get(language, statementKey) {
      return index.get(language)?.get(statementKey) ?? null;
    },
    languages: () => [...index.keys()],
  };
}

export function createTranslationService(store, { now, genId, claims }) {
  const load = (revisionId) => {
    const events = store.stream("translation_revision", revisionId);
    if (!events.length) throw new DomainError("REVISION_NOT_FOUND", `翻译修订不存在：${revisionId}`);
    return foldRevision(events);
  };

  const emit = (revisionId, eventType, payload, summary, eventId) => {
    const version = store.stream("translation_revision", revisionId).length + 1;
    return store.append(
      makeEvent({
        eventId: eventId ?? genId("evt-tr"),
        eventType,
        aggregateType: "translation_revision",
        aggregateId: revisionId,
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

  /** 找出把某语句键编入清单的全部内容包（问法清单要能追到包）。 */
  const packagesUsing = (keys) => {
    const hit = new Set(keys);
    const ids = new Set();
    for (const e of store.all("content_package")) {
      if (e.event_type === "PACKAGE_DEFINED" && (e.payload.statement_keys ?? []).some((k) => hit.has(k))) {
        ids.add(e.aggregate_id);
      }
    }
    return [...ids];
  };

  return {
    open({ revision_id, language, reason }, eventId) {
      const existing = replay(eventId, "TRANSLATION_REVISION_OPENED");
      if (existing) return existing;
      if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(language)) {
        throw new DomainError("BAD_LANGUAGE", "语言代码形如 ja、en、zh-Hant");
      }
      if (store.stream("translation_revision", revision_id).length) {
        throw new DomainError("REVISION_EXISTS", `翻译修订已存在：${revision_id}`);
      }
      return emit(
        revision_id,
        "TRANSLATION_REVISION_OPENED",
        { language, reason },
        `开启 ${language} 翻译修订：${reason}`,
        eventId
      );
    },

    /** 为单个语句提交新译文及其问答问法；必须声明依据的 claim 版本。 */
    propose(revision_id, statement_key, { text, qa_questions = [], based_on_claim_version }, eventId) {
      const existing = replay(eventId, "TRANSLATION_PROPOSED");
      if (existing) return existing;
      const rev = load(revision_id);
      if (["reviewed", "applied"].includes(rev.status)) {
        throw new DomainError("REVISION_LOCKED", "已审校的修订不能再追加提案");
      }
      const claim = claims.loadByKey(statement_key);
      if (claim.approved_version !== based_on_claim_version) {
        throw new DomainError(
          "BASE_MISMATCH",
          `${statement_key} 当前批准版本为 ${claim.approved_version}，提案依据 ${based_on_claim_version}，请据最新中文稿重译`
        );
      }
      return emit(
        revision_id,
        "TRANSLATION_PROPOSED",
        { statement_key, text, qa_questions, based_on_claim_version },
        `${rev.language} 译文提案：${statement_key}`,
        eventId
      );
    },

    /**
     * 审校：逐条 accepted/rejected，并精确生成受影响清单——
     * 受影响语句（含旧译→新译）、受影响问法、引用这些语句的内容包。
     */
    review(revision_id, { reviewer, decisions }, eventId) {
      const existing = replay(eventId, "TRANSLATION_REVIEWED");
      if (existing) return existing;
      const rev = load(revision_id);
      if (!rev.proposals.size) throw new DomainError("NO_PROPOSALS", "没有可审校的译文提案");
      const idx = buildTranslationIndex(store);

      const affectedStatements = [];
      const affectedQuestions = [];
      for (const [key, decision] of Object.entries(decisions)) {
        if (!["accepted", "rejected"].includes(decision.decision)) {
          throw new DomainError("BAD_DECISION", `${key} 的审校决定必须是 accepted 或 rejected`);
        }
        if (decision.decision === "rejected") continue;
        const proposal = rev.proposals.get(key);
        if (!proposal) throw new DomainError("DECISION_WITHOUT_PROPOSAL", `${key} 没有对应提案`);
        const current = idx.get(rev.language, key);
        const textChanged = !current || current.text !== proposal.text;
        if (textChanged) {
          affectedStatements.push({
            statement_key: key,
            old_text: current?.text ?? null,
            new_text: proposal.text,
            based_on_claim_version: proposal.based_on_claim_version,
          });
        }
        // 问法原文变化、或问法不变但答案文本变化，都算受影响问法（游客得到的内容不同）。
        for (const q of proposal.qa_questions) {
          const oldQ = current?.qa_questions?.find((x) => x.ask_id === q.ask_id);
          if (!oldQ || oldQ.ask !== q.ask || textChanged) {
            affectedQuestions.push({
              statement_key: key,
              ask_id: q.ask_id,
              old_ask: oldQ?.ask ?? null,
              new_ask: q.ask,
              answer_text_changed: textChanged,
            });
          }
        }
      }

      const affectedKeys = new Set([
        ...affectedStatements.map((s) => s.statement_key),
        ...affectedQuestions.map((q) => q.statement_key),
      ]);
      const affected = {
        statements: affectedStatements,
        questions: affectedQuestions,
        packages: packagesUsing(affectedKeys),
      };
      return emit(
        revision_id,
        "TRANSLATION_REVIEWED",
        { reviewer, decisions, affected },
        `${reviewer} 完成 ${rev.language} 审校：改语句 ${affectedStatements.length} 条、问法 ${affectedQuestions.length} 条`,
        eventId
      );
    },

    /** 应用审校通过的译文；再次校验依据版本未漂移，漂移则拒绝并要求重译。 */
    apply(revision_id, eventId) {
      const existing = replay(eventId, "TRANSLATION_APPLIED");
      if (existing) return existing;
      const rev = load(revision_id);
      if (rev.status !== "reviewed") throw new DomainError("NOT_REVIEWED", "修订须先审校通过才能应用");
      const accepted = Object.entries(rev.review.decisions)
        .filter(([, d]) => d.decision === "accepted")
        .map(([key]) => key);

      const texts = [];
      for (const key of accepted) {
        const proposal = rev.proposals.get(key);
        const claim = claims.loadByKey(key);
        if (claim.approved_version !== proposal.based_on_claim_version) {
          throw new DomainError(
            "STALE_BASE",
            `${key} 中文稿在审校后已变更（批准版本 ${claim.approved_version}），本次译文须重译`
          );
        }
        texts.push({
          statement_key: key,
          text: proposal.text,
          qa_questions: proposal.qa_questions,
          based_on_claim_version: proposal.based_on_claim_version,
        });
      }
      return emit(
        revision_id,
        "TRANSLATION_APPLIED",
        { language: rev.language, applied: accepted, texts },
        `${rev.language} 译文应用 ${accepted.length} 条：${accepted.join(", ")}`,
        eventId
      );
    },

    load,
  };
}
