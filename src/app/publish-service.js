import { append } from "./emit.js";
import { Repository } from "../store/repository.js";
import { CERTAINTY } from "../domain/knowledge-claim.js";
import { fnv1a, contentFingerprint } from "../hash.js";

/**
 * 发布服务：把“已审定的主张 + 已批准的翻译修订”编译为内容包，并守住发布闸。
 *
 * 编译不可越界：
 * - 每条播报文本只能来自某个 claim 的“已批准版本”，并按确定性自动加对冲前缀；
 * - 非中文文本只能来自“已批准”的翻译修订；若某条目存在更新的已批准修订而未纳入，拒绝发布；
 * - restricted 来源段落永不进入载荷（密级外泄扫描）；
 * - 问答文本只能挂在已审定模板上。
 *
 * 一次发布必须带与编译结果一致的影响预览校验和（操作者已看过并确认），否则拒绝。
 */
export class PublishService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.repo = new Repository(store);
    this.clock = clock;
  }

  /**
   * 编译草稿并生成可解释影响预览（不产生发布事件）。
   * @param {{package_id, entries, translation_refs, valid_from, valid_until, baseline_package_id?}} spec
   */
  compile(spec) {
    const problems = [];
    const manifest = [];
    const fingerprints = [];
    const changeReasons = [];

    for (const entry of spec.entries ?? []) {
      const claim = this.repo.claim(entry.claim_id);
      const approval = claim?.approvals?.find((a) => a.version === entry.claim_version) ?? null;
      if (!claim || claim.object_kind !== "claim") {
        problems.push(`主张不存在：${entry.claim_id}`);
        continue;
      }
      if (!approval) {
        problems.push(`主张 ${entry.claim_id} 的版本 v${entry.claim_version} 未审定，不能入包`);
        continue;
      }
      // 修订后旧批准版本即被“搁置”：必须引用流内最新一次批准
      if (claim.status !== "approved" || claim.current.version !== approval.version) {
        problems.push(`主张 ${entry.claim_id} 已被修订，引用的 v${entry.claim_version} 不是当前审定版本`);
        continue;
      }

      for (const lang of entry.languages ?? ["zh"]) {
        const compiled = this.#compileStatement(claim, approval, lang, spec.translation_refs ?? [], problems);
        if (!compiled) continue;
        const ref = `claim:${claim.claim_id}@v${approval.version}`;
        manifest.push({
          ref,
          kind: "statement",
          lang,
          claim_id: claim.claim_id,
          claim_version: approval.version,
          certainty: approval.certainty,
          text: compiled.text,
          source_ids: approval.source_ids,
          provenance_revision: compiled.revision_id ?? null,
          updated_at: approval.at,
        });
        fingerprints.push(contentFingerprint(ref, lang, compiled.text));
        if (compiled.revision_id) {
          changeReasons.push({ ref, lang, reason: "translation", revision_id: compiled.revision_id });
        }
        if (approval.certainty !== CERTAINTY.ESTABLISHED && !compiled.hedged) {
          problems.push(`主张 ${claim.claim_id}（${approval.certainty}）缺少对冲表述`);
        }
      }

      for (const templateId of entry.qa_template_ids ?? []) {
        const tpl = claim.templates[templateId];
        if (!tpl) {
          problems.push(`主张 ${claim.claim_id} 下问答模板未审定：${templateId}`);
          continue;
        }
        for (const lang of entry.languages ?? ["zh"]) {
          const q = this.#compileQuestion(claim, tpl, lang, spec.translation_refs ?? [], problems);
          if (!q) continue;
          const ref = `qa:${templateId}@claim:${claim.claim_id}@v${approval.version}`;
          manifest.push({
            ref,
            kind: "question_form",
            lang,
            claim_id: claim.claim_id,
            claim_version: approval.version,
            template_id: templateId,
            text: q.text,
            source_ids: approval.source_ids,
            provenance_revision: q.revision_id ?? null,
            updated_at: tpl.at,
          });
          fingerprints.push(contentFingerprint(ref, lang, q.text));
        }
      }
    }

    // 翻译时效：找出影响本包条目、已批准但未纳入的修订
    this.#checkTranslationCurrency(spec, problems);

    // 密级外泄扫描：载荷文本不得包含任何 restricted 来源段落原文
    const leakage = this.#scanLeakage(manifest, spec.entries ?? []);
    problems.push(...leakage);

    const impactPreview = this.#buildImpactPreview(manifest, fingerprints, spec.baseline_package_id);
    return {
      package_id: spec.package_id,
      ok: problems.length === 0,
      problems,
      manifest,
      fingerprints,
      impact_preview: impactPreview,
      visitor_provenance: this.#buildVisitorProvenance(manifest),
    };
  }

  /** 起草：编译通过后落 PACKAGE_DRAFTED（携带快照，发布时复核防漂移）。 */
  draft(spec, cmd) {
    const compiled = this.compile(spec);
    if (!compiled.ok) throw new PublishGateError(compiled.problems);
    append(this.store, "content_package", spec.package_id, [
      {
        command_id: cmd.command_id,
        event_type: "PACKAGE_DRAFTED",
        occurred_at: cmd.occurred_at ?? this.clock(),
        summary: `起草内容包 ${spec.package_id}：${compiled.manifest.length} 个播报条目`,
        entries: spec.entries,
        translation_refs: spec.translation_refs ?? [],
        glossary_refs: spec.glossary_refs ?? [],
        baseline_package_id: spec.baseline_package_id ?? null,
        valid_from: spec.valid_from,
        valid_until: spec.valid_until ?? null,
        drafted_by: cmd.drafted_by,
      },
    ]);
    return compiled;
  }

  /**
   * 发布闸。必须满足：
   * 1. 草稿存在且未撤回；2. 重新编译结果与草稿引用无漂移、无问题；
   * 3. 影响预览可解释且操作者已确认（校验和一致）；
   * 4. 游客侧出处与更新时间齐备；5. 载荷无 restricted 内容。
   * 设备回执在发布后由 release-completion 跟踪，不阻塞发布事件本身。
   */
  publish(cmd) {
    const pkg = this.repo.package(cmd.package_id);
    if (!pkg) throw new Error(`内容包不存在：${cmd.package_id}`);
    if (pkg.status === "withdrawn") throw new Error("内容包已撤回，不能发布");
    if (pkg.status === "published") throw new Error("内容包已发布（重复发布被拒绝）");

    const spec = {
      package_id: pkg.package_id,
      entries: pkg.entries,
      translation_refs: pkg.translation_refs,
      glossary_refs: pkg.glossary_refs,
      baseline_package_id: pkg.baseline_package_id,
      valid_from: pkg.valid_from,
      valid_until: pkg.valid_until,
    };
    const compiled = this.compile(spec);
    if (!compiled.ok) throw new PublishGateError(compiled.problems);

    if (!cmd.impact_confirmation_checksum) {
      throw new PublishGateError(["发布前必须确认影响预览（缺少 impact_confirmation_checksum）"]);
    }
    if (cmd.impact_confirmation_checksum !== compiled.impact_preview.checksum) {
    throw new PublishGateError([
        "影响预览校验和不一致：条目自编译后已变化，请重新查看并确认影响预览",
      ]);
    }
    const provProblems = compiled.visitor_provenance.problems;
    if (provProblems.length > 0) throw new PublishGateError(provProblems);

    append(this.store, "content_package", cmd.package_id, [
      {
        command_id: cmd.command_id,
        event_type: "PACKAGE_PUBLISHED",
        occurred_at: cmd.occurred_at ?? this.clock(),
        summary: `发布内容包 ${cmd.package_id}：${compiled.impact_preview.changes.length} 项变化已向操作者解释`,
        published_by: cmd.published_by,
        manifest: compiled.manifest,
        content_fingerprints: compiled.fingerprints,
        impact_preview: compiled.impact_preview,
        visitor_provenance: compiled.visitor_provenance,
      },
    ]);
    return this.repo.package(cmd.package_id);
  }

  withdraw(cmd) {
    const pkg = this.repo.package(cmd.package_id);
    if (!pkg || pkg.status !== "published") throw new Error("只能撤回已发布内容包");
    append(this.store, "content_package", cmd.package_id, [
      {
        command_id: cmd.command_id,
        event_type: "PACKAGE_WITHDRAWN",
        occurred_at: cmd.occurred_at ?? this.clock(),
        summary: `撤回内容包：${cmd.reason ?? "未注明"}`,
        reason: cmd.reason ?? null,
      },
    ]);
    return this.repo.package(cmd.package_id);
  }

  // ---- 编译细节 ----

  #latestApprovedRevisionFor(refId, lang, translationRefs, problems) {
    // 仅允许引用显式纳入草稿且已批准的修订；同一 ref 取纳入清单中版本最新者
    const candidates = [];
    for (const ref of translationRefs) {
      const rev = this.repo.revision(ref.revision_id);
      if (!rev) {
        problems.push(`翻译修订不存在：${ref.revision_id}`);
        continue;
      }
      if (rev.status !== "approved") {
        problems.push(`翻译修订 ${ref.revision_id} 状态为 ${rev.status}，未批准不能入包`);
        continue;
      }
      if (rev.target_language !== lang) continue;
      const hit = rev.affected_statements.find((s) => s.ref_id === refId);
      if (hit) candidates.push({ rev, text: hit.new_text });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b.rev.proposed_at) - Date.parse(a.rev.proposed_at));
    return candidates[0];
  }

  #compileStatement(claim, approval, lang, translationRefs, problems) {
    if (lang === "zh") {
      const hedged = approval.hedging_required;
      const text = hedged ? `${approval.hedging_prefix.zh}${approval.approved_statement_zh}` : approval.approved_statement_zh;
      return { text, hedged };
    }
    const hit = this.#latestApprovedRevisionFor(claim.claim_id, lang, translationRefs, problems);
    if (!hit) {
      problems.push(`主张 ${claim.claim_id} 缺少 ${lang} 已批准译文`);
      return null;
    }
    const hedged = approval.hedging_required;
    const prefix = approval.hedging_prefix?.[lang] ?? "";
    return { text: hedged ? `${prefix}${hit.text}` : hit.text, hedged, revision_id: hit.rev.revision_id };
  }

  #compileQuestion(claim, tpl, lang, translationRefs, problems) {
    const base = tpl.question_forms.find((q) => q.lang === lang);
    // 非模板语种：允许“初译修订”（old_text 为 null）提供首个译文
    const initialRev = translationRefs
      .map((ref) => this.repo.revision(ref.revision_id))
      .find(
        (rev) =>
          rev &&
          rev.status === "approved" &&
          rev.target_language === lang &&
          rev.affected_question_forms.some(
            (q) => q.template_id === tpl.template_id && q.old_text == null
          )
      );
    if (!base && !initialRev) {
      problems.push(`模板 ${tpl.template_id} 缺少 ${lang} 问法`);
      return null;
    }
    let text =
      base?.text ??
      initialRev.affected_question_forms.find((q) => q.template_id === tpl.template_id).new_text;
    let revision_id = initialRev?.revision_id ?? null;
    for (const ref of translationRefs) {
      const rev = this.repo.revision(ref.revision_id);
      if (!rev || rev.status !== "approved" || rev.target_language !== lang) continue;
      const hit = rev.affected_question_forms.find((q) => q.template_id === tpl.template_id);
      if (hit) {
        if (hit.old_text == null) continue; // 初译已处理
        if (hit.old_text !== text) {
          problems.push(`问法修订 ${rev.revision_id} 的旧译与模板 ${tpl.template_id} 当前 ${lang} 问法不一致`);
          continue;
        }
        text = hit.new_text;
        revision_id = rev.revision_id;
      }
    }
    return { text, revision_id };
  }

  #checkTranslationCurrency(spec, problems) {
    const claimIds = new Set((spec.entries ?? []).map((e) => e.claim_id));
    const templateIds = new Set((spec.entries ?? []).flatMap((e) => e.qa_template_ids ?? []));
    const referenced = new Set((spec.translation_refs ?? []).map((r) => r.revision_id));
    const approved = this.repo.allRevisions().filter((r) => r.status === "approved");

    const touchesEntry = (rev) =>
      [...rev.affected_statements, ...rev.affected_question_forms].some(
        (x) => claimIds.has(x.ref_id) || (x.template_id && templateIds.has(x.template_id))
      );
    const overlaps = (a, b) => {
      if (a.target_language !== b.target_language) return false;
      const aStmt = new Set(a.affected_statements.map((s) => s.ref_id));
      const bStmt = new Set(b.affected_statements.map((s) => s.ref_id));
      const aTpl = new Set(a.affected_question_forms.map((q) => q.template_id));
      const bTpl = new Set(b.affected_question_forms.map((q) => q.template_id));
      return [...aStmt].some((k) => bStmt.has(k)) || [...aTpl].some((k) => bTpl.has(k));
    };

    for (const rev of approved) {
      if (referenced.has(rev.revision_id) || !touchesEntry(rev)) continue;
      // 已被同语种、更新的已批准修订覆盖（如误译已被纠正），不再要求纳入旧修订
      const superseded = approved.some(
        (other) =>
          other.revision_id !== rev.revision_id &&
          Date.parse(other.proposed_at) > Date.parse(rev.proposed_at) &&
          overlaps(rev, other)
      );
      if (!superseded) {
        problems.push(`存在影响本包但未纳入的已批准翻译修订：${rev.revision_id}（${rev.target_language}）`);
      }
    }
  }

  #scanLeakage(manifest, entries) {
    const restrictedExcerpts = [];
    for (const entry of entries) {
      const claim = this.repo.claim(entry.claim_id);
      for (const s of claim?.sources ?? []) {
        if (s.access === "restricted") restrictedExcerpts.push({ source_id: s.source_id, excerpt: s.excerpt });
      }
    }
    const problems = [];
    for (const item of manifest) {
      for (const s of restrictedExcerpts) {
        if (s.excerpt && item.text.includes(s.excerpt)) {
          problems.push(`密级外泄：${item.ref}/${item.lang} 载荷包含未公开来源 ${s.source_id} 的段落原文`);
        }
      }
    }
    return problems;
  }

  #buildImpactPreview(manifest, fingerprints, baselinePackageId) {
    const baseline = baselinePackageId ? this.repo.package(baselinePackageId) : null;
    const baseFp = new Map((baseline?.publish?.content_fingerprints ?? []).map((f) => [`${f.ref}|${f.lang}`, f]));
    const changes = [];
    for (const f of fingerprints) {
      const key = `${f.ref}|${f.lang}`;
      const before = baseFp.get(key);
      const item = manifest.find((m) => m.ref === f.ref && m.lang === f.lang);
      if (!before) {
        changes.push({ type: "added", ref: f.ref, lang: f.lang, new_text: item.text });
      } else if (before.hash !== f.hash) {
        const baseItem = baseline.publish.manifest.find((m) => m.ref === f.ref && m.lang === f.lang);
        changes.push({
          type: "changed",
          ref: f.ref,
          lang: f.lang,
          old_text: baseItem?.text ?? null,
          new_text: item.text,
          via_revision: item.provenance_revision,
        });
      }
    }
    if (baseline) {
      const now = new Set(fingerprints.map((f) => `${f.ref}|${f.lang}`));
      for (const f of baseline.publish.content_fingerprints) {
        if (!now.has(`${f.ref}|${f.lang}`)) changes.push({ type: "removed", ref: f.ref, lang: f.lang });
      }
    }
    const checksum = fnv1a(JSON.stringify(changes.map((c) => [c.type, c.ref, c.lang, c.old_text ?? "", c.new_text ?? ""])));
    return {
      baseline_package_id: baselinePackageId ?? null,
      generated_at: this.clock(),
      total_items: fingerprints.length,
      changes,
      checksum,
    };
  }

  #buildVisitorProvenance(manifest) {
    const records = [];
    const problems = [];
    for (const item of manifest) {
      const claim = this.repo.claim(item.claim_id);
      const sources = (claim?.sources ?? [])
        .filter((s) => s.access === "public" && item.source_ids.includes(s.source_id))
        .map((s) => ({ source_id: s.source_id, citation: s.citation }));
      if (sources.length === 0) {
        problems.push(`${item.ref}/${item.lang} 没有可向游客展示的公开出处`);
      }
      records.push({
        ref: item.ref,
        lang: item.lang,
        sources,
        content_updated_at: item.updated_at,
      });
    }
    return { records, problems };
  }
}

export class PublishGateError extends Error {
  constructor(problems) {
    super(`发布闸未通过：${problems.join("；")}`);
    this.name = "PublishGateError";
    this.problems = problems;
  }
}
