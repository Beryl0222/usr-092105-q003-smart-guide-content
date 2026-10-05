import { append } from "./emit.js";
import { CERTAINTY, reduceKnowledgeClaim } from "../domain/knowledge-claim.js";
import { TRANSLATION_ERROR_TYPES, reduceTranslationRevision } from "../domain/translation-revision.js";

/**
 * 审校路径服务：把内容组/专家/审校的命令转成幂等领域事件。
 *
 * 路径分流（对应事故教训：“学界推测”不能走事实的轻路径）：
 * - 事实主张（fact）：登记 + 审校批准，须引来源；
 * - 解释性主张（interpretation）：在事实路径之上，批准前必须有专家意见；
 * - 学界争议/推测：额外强制对冲表述，编译时由系统统一加前缀，不依赖人工记得；
 * - 翻译修订：逐条列受影响语句与问法，经翻译审校批准；
 * - 临时运营通知：不经此服务，走 notice-service 的先发后补签路径。
 */
export class ReviewService {
  constructor(store) {
    this.store = store;
  }

  recordClaim(cmd) {
    assert(cmd.command_id, "缺少 command_id");
    assert(cmd.claim_id, "缺少 claim_id");
    assert(["fact", "interpretation"].includes(cmd.kind), "kind 必须是 fact 或 interpretation");
    assert(Object.values(CERTAINTY).includes(cmd.certainty), "确定性等级不合法");
    assert(typeof cmd.statement_zh === "string" && cmd.statement_zh.length > 0, "缺少主张中文表述");
    assert(Array.isArray(cmd.sources) && cmd.sources.length > 0, "主张必须至少登记一个来源段落");
    for (const s of cmd.sources) {
      assert(s.source_id && s.excerpt, "来源段落必须含 source_id 与 excerpt");
      assert(["public", "restricted"].includes(s.access), "来源密级必须是 public 或 restricted");
      assert(s.citation, "来源段落必须含可核验引用 citation");
    }
    if (cmd.kind === "fact" && cmd.certainty !== CERTAINTY.ESTABLISHED) {
      throw new Error("事实主张只能登记为 established；推测/争议属于解释性主张");
    }
    return append(this.store, "knowledge_claim", cmd.claim_id, [
      {
        command_id: cmd.command_id,
        event_type: "CLAIM_RECORDED",
        occurred_at: cmd.occurred_at,
        summary: `登记${cmd.kind === "fact" ? "事实" : "解释性"}主张：${cmd.topic ?? ""}`,
        site_id: cmd.site_id ?? null,
        topic: cmd.topic ?? "",
        kind: cmd.kind,
        certainty: cmd.certainty,
        statement_zh: cmd.statement_zh,
        sources: cmd.sources,
      },
    ])[0];
  }

  addExpertOpinion(cmd) {
    const state = this.#claim(cmd.claim_id);
    assert(state, `主张不存在：${cmd.claim_id}`);
    assert(["supports", "disputes", "unresolved"].includes(cmd.stance), "专家立场不合法");
    assert(cmd.expert_id && cmd.text, "专家意见必须含 expert_id 与正文");
    return append(this.store, "knowledge_claim", cmd.claim_id, [
      {
        command_id: cmd.command_id,
        event_type: "EXPERT_OPINION_ADDED",
        occurred_at: cmd.occurred_at,
        summary: `收录专家 ${cmd.expert_name ?? cmd.expert_id} 意见：${cmd.stance}`,
        opinion_id: cmd.opinion_id,
        expert_id: cmd.expert_id,
        expert_name: cmd.expert_name ?? null,
        stance: cmd.stance,
        text: cmd.text,
      },
    ])[0];
  }

  approveClaim(cmd) {
    const state = this.#claim(cmd.claim_id);
    assert(state, `主张不存在：${cmd.claim_id}`);
    assert(cmd.approved_statement_zh, "缺少审定措辞");
    assert(Array.isArray(cmd.source_ids) && cmd.source_ids.length > 0, "批准必须列明依据来源");
    const knownSourceIds = new Set(state.sources.map((s) => s.source_id));
    for (const id of cmd.source_ids) assert(knownSourceIds.has(id), `来源未登记：${id}`);

    if (state.kind === "interpretation") {
      assert(state.expert_opinions.length > 0, "解释性主张批准前必须有专家意见");
      if (cmd.expert_opinion_ids) {
        const known = new Set(state.expert_opinions.map((o) => o.opinion_id));
        for (const id of cmd.expert_opinion_ids) assert(known.has(id), `专家意见不存在：${id}`);
      }
    }

    const certainty = cmd.certainty ?? state.certainty;
    assert(Object.values(CERTAINTY).includes(certainty), "确定性等级不合法");
    // 非确凿结论强制对冲：无论审校是否记得，系统都记录 hedging_required 并在编译时加前缀
    return append(this.store, "knowledge_claim", cmd.claim_id, [
      {
        command_id: cmd.command_id,
        event_type: "CLAIM_APPROVED",
        occurred_at: cmd.occurred_at,
        summary: `审校批准主张（${certainty}）`,
        reviewer_id: cmd.reviewer_id,
        approved_statement_zh: cmd.approved_statement_zh,
        certainty,
        source_ids: cmd.source_ids,
        expert_opinion_ids: cmd.expert_opinion_ids ?? [],
      },
    ])[0];
  }

  /** 措辞修订：回到待审状态，必须重新批准，旧批准在 history 中保留。 */
  reviseClaim(cmd) {
    const state = this.#claim(cmd.claim_id);
    assert(state, `主张不存在：${cmd.claim_id}`);
    assert(cmd.revised_statement_zh, "缺少修订后表述");
    return append(this.store, "knowledge_claim", cmd.claim_id, [
      {
        command_id: cmd.command_id,
        event_type: "CLAIM_REVISED",
        occurred_at: cmd.occurred_at,
        summary: `措辞修订：${cmd.reason ?? "未注明原因"}`,
        revised_statement_zh: cmd.revised_statement_zh,
        certainty: cmd.certainty,
        reason: cmd.reason ?? null,
      },
    ])[0];
  }

  approveQaTemplate(cmd) {
    const state = this.#claim(cmd.claim_id);
    assert(state, `主张不存在：${cmd.claim_id}`);
    assert(Array.isArray(cmd.question_forms) && cmd.question_forms.length > 0, "问答模板必须含问法");
    for (const q of cmd.question_forms) {
      assert(q.lang && q.text, "每条问法必须含 lang 与 text");
    }
    return append(this.store, "knowledge_claim", cmd.claim_id, [
      {
        command_id: cmd.command_id,
        event_type: "QA_TEMPLATE_APPROVED",
        occurred_at: cmd.occurred_at,
        summary: `审定问答模板 ${cmd.template_id}（${cmd.question_forms.length} 条问法）`,
        reviewer_id: cmd.reviewer_id,
        template_id: cmd.template_id,
        question_forms: cmd.question_forms,
      },
    ])[0];
  }

  approveGlossaryTerm(cmd) {
    assert(cmd.term_id && cmd.terms, "术语必须含 term_id 与多语条目");
    assert(cmd.terms.zh?.text, "术语必须含中文条目");
    return append(this.store, "knowledge_claim", cmd.term_id, [
      {
        command_id: cmd.command_id,
        event_type: "GLOSSARY_TERM_APPROVED",
        occurred_at: cmd.occurred_at,
        summary: `审定读音术语：${cmd.terms.zh.text}`,
        terms: cmd.terms,
        accessibility_note: cmd.accessibility_note ?? null,
        usage_note: cmd.usage_note ?? null,
      },
    ])[0];
  }

  proposeTranslationRevision(cmd) {
    assert(cmd.revision_id, "缺少 revision_id");
    assert(cmd.target_language, "缺少目标语言");
    const statements = cmd.affected_statements ?? [];
    const questions = cmd.affected_question_forms ?? [];
    assert(statements.length + questions.length > 0, "翻译修订必须逐条列出受影响语句或问法");
    for (const s of statements) {
      assert(s.ref_id && s.new_text != null, "语句修订必须含 ref_id 与 new_text");
      // old_text 为 null/空表示该语种初译，此时不要求错误类型；否则必须标注且新旧不同
      if (s.old_text == null) {
        assert(!s.error_type || Object.values(TRANSLATION_ERROR_TYPES).includes(s.error_type), "错误类型不合法");
      } else {
        assert(Object.values(TRANSLATION_ERROR_TYPES).includes(s.error_type), "修订语句必须标注错误类型");
        assert(s.old_text !== s.new_text, "新旧译文不能相同");
      }
    }
    for (const q of questions) {
      assert(q.ref_id && q.template_id && q.new_text != null, "问法修订必须含 ref_id、template_id、new_text");
      assert(q.old_text == null || q.old_text !== q.new_text, "新旧问法不能相同");
    }
    return append(this.store, "translation_revision", cmd.revision_id, [
      {
        command_id: cmd.command_id,
        event_type: "TRANSLATION_PROPOSED",
        occurred_at: cmd.occurred_at,
        summary: `提出${cmd.target_language}翻译修订：语句 ${statements.length} 条、问法 ${questions.length} 条`,
        target_language: cmd.target_language,
        reason: cmd.reason ?? "",
        affected_statements: statements,
        affected_question_forms: questions,
        accessibility_changes: cmd.accessibility_changes ?? [],
        proposed_by: cmd.proposed_by,
      },
    ])[0];
  }

  reviewTranslation(cmd) {
    const state = this.#revision(cmd.revision_id);
    assert(state, `翻译修订不存在：${cmd.revision_id}`);
    assert(["approved", "rejected", "changes_requested"].includes(cmd.decision), "审校决定不合法");
    return append(this.store, "translation_revision", cmd.revision_id, [
      {
        command_id: cmd.command_id,
        event_type: "TRANSLATION_REVIEWED",
        occurred_at: cmd.occurred_at,
        summary: `翻译修订审校结论：${cmd.decision}`,
        reviewer_id: cmd.reviewer_id,
        decision: cmd.decision,
        note: cmd.note ?? "",
      },
    ])[0];
  }

  #claim(id) {
    return reduceKnowledgeClaim(this.store.loadStream("knowledge_claim", id));
  }
  #revision(id) {
    return reduceTranslationRevision(this.store.loadStream("translation_revision", id));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
