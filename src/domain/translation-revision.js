/**
 * translation_revision 聚合的事件归约。
 *
 * 一次翻译修订针对一种目标语言，必须逐条列出受影响语句：
 * - affected_statements：claim 审定措辞或播报稿语句的译文修订（旧译 -> 新译、错误类型）；
 * - affected_question_forms：问答问法的译文修订。
 *
 * 日文把“局部开放”翻成“暂停开放”这类事故，必须形成显式的逐条记录，
 * 发布闸与设备影响分析据此找出“哪些设备仍在播错误译文”。
 */

export const TRANSLATION_ERROR_TYPES = Object.freeze({
  MISTRANSLATION: "mistranslation", // 误译（语义相反/偏移）
  TERMINOLOGY: "terminology", // 术语/读音不一致
  REGISTER: "register", // 语气/语域
  ACCESSIBILITY: "accessibility", // 无障碍表述
  OMISSION: "omission", // 漏译
});

export function reduceTranslationRevision(events) {
  let state = null;
  for (const e of events) {
    switch (e.event_type) {
      case "TRANSLATION_PROPOSED":
        state = {
          revision_id: e.aggregate_id,
          target_language: e.target_language,
          reason: e.reason ?? "",
          status: "proposed",
          affected_statements: e.affected_statements ?? [],
          affected_question_forms: e.affected_question_forms ?? [],
          accessibility_changes: e.accessibility_changes ?? [],
          proposed_at: e.occurred_at,
          proposed_by: e.proposed_by,
          review: null,
          history: [{ version: e.version, at: e.occurred_at, status: "proposed" }],
        };
        break;
      case "TRANSLATION_REVIEWED":
        state.status = e.decision; // approved | rejected | changes_requested
        state.review = {
          reviewer_id: e.reviewer_id,
          at: e.occurred_at,
          decision: e.decision,
          note: e.note ?? "",
        };
        state.history.push({ version: e.version, at: e.occurred_at, status: e.decision });
        break;
      default:
        throw new Error(`translation_revision 归约器无法处理事件：${e.event_type}`);
    }
  }
  return state;
}

/** 被该修订“替换掉”的全部旧译文签名，用于匹配设备上仍在播的旧内容。 */
export function supersededTranslationKeys(revisionState) {
  if (!revisionState) return [];
  const fromStatements = revisionState.affected_statements.map((s) => ({
    kind: "statement",
    ref_id: s.ref_id,
    lang: revisionState.target_language,
    old_text: s.old_text,
  }));
  const fromQuestions = revisionState.affected_question_forms.map((q) => ({
    kind: "question_form",
    ref_id: q.ref_id,
    lang: revisionState.target_language,
    old_text: q.old_text,
  }));
  return [...fromStatements, ...fromQuestions];
}
