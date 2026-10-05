import { Repository } from "../store/repository.js";
import { CERTAINTY } from "../domain/knowledge-claim.js";

/**
 * 机器答复组合服务（问答机/讲解设备生成回答时调用）。
 *
 * 铁律：组合回答不得越出已批准证据。
 * - 只能引用 claim 流中“当前已审定”的批准版本（CLAIM_REVISED 后未重新批准即不可用）；
 * - 推测/争议结论的回答必须带对冲标记与前缀；
 * - 引用来源只允许 public；restricted 来源即使被批准也不进游客侧回答；
 * - 问答文本必须来自已审定模板与已发布包；无证据时返回 unable_to_answer，禁止生成式补全。
 */
export class AnswerService {
  constructor(store, options = {}) {
    this.store = store;
    this.repo = new Repository(store);
    // 限定答复只能来自某个站点的“已发布且在有效期”的包；由调用方传入判定时刻
    this.at = options.at ?? null;
  }

  /**
   * 组合回答。
   * @param {{package_id, lang, claim_id, template_id?}} query
   */
  compose(query, atIso = this.at) {
    const pkg = this.repo.package(query.package_id);
    if (!pkg || pkg.status !== "published") {
      return AnswerService.unable(`内容包未发布：${query.package_id}`);
    }
    if (atIso) {
      const at = Date.parse(atIso);
      if (pkg.valid_from && Date.parse(pkg.valid_from) > at) return AnswerService.unable("内容包尚未生效");
      if (pkg.valid_until && Date.parse(pkg.valid_until) <= at) return AnswerService.unable("内容包已过有效期");
    }

    const claim = this.repo.claim(query.claim_id);
    if (!claim || claim.object_kind !== "claim" || claim.status !== "approved" || !claim.current) {
      return AnswerService.unable(`主张没有当前已审定版本：${query.claim_id}`);
    }
    const approval = claim.current;

    // 回答只能落在该发布包的 manifest 上（包 -> 批准版本的引用一致性）
    const ref = `claim:${claim.claim_id}@v${approval.version}`;
    const statementItem = pkg.publish.manifest.find(
      (m) => m.kind === "statement" && m.ref === ref && m.lang === query.lang
    );
    if (!statementItem) {
      return AnswerService.unable(`已发布包中没有该主张的 ${query.lang} 审定文本`);
    }

    // 问法匹配（可选）：必须命中已审定模板
    let matchedQuestion = null;
    if (query.template_id) {
      const qref = `qa:${query.template_id}@${ref}`;
      matchedQuestion = pkg.publish.manifest.find(
        (m) => m.kind === "question_form" && m.ref === qref && m.lang === query.lang
      );
      if (!matchedQuestion) return AnswerService.unable("问法不在已审定模板/已发布包内");
    }

    const sources = claim.sources
      .filter((s) => s.access === "public" && approval.source_ids.includes(s.source_id))
      .map((s) => ({ source_id: s.source_id, citation: s.citation }));

    return {
      status: "answered",
      lang: query.lang,
      text: statementItem.text, // 发布时已按确定性加好对冲前缀
      hedged: approval.hedging_required,
      certainty: approval.certainty,
      evidence: {
        claim_id: claim.claim_id,
        claim_version: approval.version,
        approved_at: approval.at,
        package_id: pkg.package_id,
        question: matchedQuestion?.text ?? null,
        sources, // 游客侧可见出处（仅 public）
      },
      content_updated_at: statementItem.updated_at,
    };
  }

  static unable(reason) {
    // 无证据不补全：设备/问答机应据此给出固定的“暂无法回答”话术
    return { status: "unable_to_answer", reason, text: null, evidence: null };
  }
}

/**
 * 游客侧出处与更新时间查询：直接读发布时固化的 visitor_provenance，
 * 保证游客听到的每条内容都能查到公开出处与更新时间。
 */
export class ProvenanceQuery {
  constructor(store) {
    this.repo = new Repository(store);
  }

  forItem(packageId, ref, lang) {
    const pkg = this.repo.package(packageId);
    if (!pkg?.publish) return null;
    const rec = pkg.publish.visitor_provenance.records.find(
      (r) => r.ref === ref && r.lang === lang
    );
    return rec ?? null;
  }

  forPackage(packageId) {
    const pkg = this.repo.package(packageId);
    if (!pkg?.publish) return null;
    return {
      package_id: packageId,
      published_at: pkg.publish.at,
      records: pkg.publish.visitor_provenance.records,
    };
  }
}
