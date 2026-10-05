/**
 * knowledge_claim 聚合的事件归约。
 *
 * 一个事件流承载一个“知识对象”：
 * - 主张（claim）：事实或解释性主张，带来源段落、确定性等级、专家意见、审定措辞；
 * - 问答模板（qa template）挂在其依据的主张流上，保存多语问法；
 * - 读音术语（glossary term）以独立流承载，事件类型区分。
 *
 * 关键纪律：
 * - 确定性 = scholarly_speculation / scholarly_debate 时，审定必须要求对冲表述，
 *   设备端与答复组合据此加“学界推测”类前缀，杜绝把推测播成史实。
 * - 来源段落区分 public / restricted；restricted 段落仅供内部审校，永不进入游客侧载荷。
 */

export const CERTAINTY = Object.freeze({
  ESTABLISHED: "established", // 确凿史实
  SCHOLARLY_DEBATE: "scholarly_debate", // 学界存在争议
  SCHOLARLY_SPECULATION: "scholarly_speculation", // 学界推测
});

export const HEDGING_PREFIX = Object.freeze({
  zh: "学界推测，",
  en: "Scholars speculate that ",
  ja: "学界ではこう推測されています。",
});

export function reduceKnowledgeClaim(events) {
  let state = null;
  for (const e of events) {
    switch (e.event_type) {
      case "CLAIM_RECORDED":
        state = {
          object_kind: "claim",
          claim_id: e.aggregate_id,
          site_id: e.site_id,
          topic: e.topic,
          kind: e.kind, // 'fact' | 'interpretation'
          certainty: e.certainty,
          statement_zh: e.statement_zh,
          sources: e.sources ?? [],
          expert_opinions: [],
          status: "recorded",
          approvals: [],
          current: null,
          templates: {},
          history: [{ version: e.version, at: e.occurred_at, note: "主张登记" }],
        };
        break;
      case "EXPERT_OPINION_ADDED":
        state.expert_opinions.push({
          opinion_id: e.opinion_id,
          expert_id: e.expert_id,
          expert_name: e.expert_name,
          stance: e.stance, // supports | disputes | unresolved
          text: e.text,
          at: e.occurred_at,
        });
        break;
      case "CLAIM_APPROVED": {
        const hedgingRequired = e.certainty !== CERTAINTY.ESTABLISHED;
        const approval = {
          version: e.version,
          reviewer_id: e.reviewer_id,
          at: e.occurred_at,
          approved_statement_zh: e.approved_statement_zh,
          certainty: e.certainty,
          hedging_required: hedgingRequired,
          hedging_prefix: e.hedging_prefix ?? HEDGING_PREFIX,
          source_ids: e.source_ids ?? [],
          expert_opinion_ids: e.expert_opinion_ids ?? [],
        };
        state.approvals.push(approval);
        state.current = approval;
        state.certainty = e.certainty;
        state.status = "approved";
        state.history.push({ version: e.version, at: e.occurred_at, note: e.summary });
        break;
      }
      case "CLAIM_REVISED":
        state.statement_zh = e.revised_statement_zh;
        if (e.certainty) state.certainty = e.certainty;
        // 修订后必须重新走 CLAIM_APPROVED 才能再次被引用
        state.status = "recorded";
        state.current = null;
        state.history.push({
          version: e.version,
          at: e.occurred_at,
          note: `措辞修订：${e.reason ?? ""}`,
          previous: state.approvals.at(-1)?.version ?? null,
        });
        break;
      case "QA_TEMPLATE_APPROVED":
        state.templates[e.template_id] = {
          template_id: e.template_id,
          version: e.version,
          at: e.occurred_at,
          reviewer_id: e.reviewer_id,
          question_forms: e.question_forms, // [{lang, text}]
        };
        break;
      case "GLOSSARY_TERM_APPROVED":
        state = reduceGlossaryTerm(state, e);
        break;
      default:
        throw new Error(`knowledge_claim 归约器无法处理事件：${e.event_type}`);
    }
  }
  return state;
}

function reduceGlossaryTerm(state, e) {
  const term = {
    object_kind: "glossary_term",
    term_id: e.aggregate_id,
    version: e.version,
    at: e.occurred_at,
    terms: e.terms, // {zh:{text,pinyin,ipa?}, ja:{text,reading?}, en:{text}}
    accessibility_note: e.accessibility_note ?? null, // 无障碍表述约定
    usage_note: e.usage_note ?? null,
  };
  if (!state) return term;
  // 同一术语可再次审定（读音/译名修正），保留上一版形成历史
  return { ...term, history: [...(state.history ?? []), prev(state)] };
}

function prev(state) {
  const { history: _h, ...snapshot } = state;
  return snapshot;
}

/** 主张在指定版本是否已审定；不传版本则取当前。 */
export function approvalAt(claimState, version) {
  if (!claimState || claimState.object_kind !== "claim") return null;
  if (version === undefined) return claimState.current;
  return claimState.approvals.find((a) => a.version === version) ?? null;
}

export function publicSources(claimState) {
  return (claimState?.sources ?? []).filter((s) => s.access !== "restricted");
}
