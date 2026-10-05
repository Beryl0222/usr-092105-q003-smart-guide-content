import { DomainError, ReleaseGateError } from "./errors.js";
import { makeEvent } from "./events.js";
import { buildTranslationIndex } from "./translations.js";
import { noticePlayable } from "./claims.js";

export function foldPackage(events) {
  const state = {
    package_id: null,
    definition: null,
    versions: new Map(),
    current_version: null,
    version: 0,
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "PACKAGE_DEFINED":
        state.package_id = e.aggregate_id;
        state.definition = {
          created_by: p.created_by,
          statement_keys: p.statement_keys,
          qa_templates: p.qa_templates,
          languages: p.languages,
        };
        break;
      case "PACKAGE_PUBLISHED":
        state.versions.set(p.package_version, {
          package_version: p.package_version,
          manifest: p.manifest,
          impact: p.impact,
          citations: p.citations,
          published_at: p.published_at,
        });
        state.current_version = p.package_version;
        break;
      default:
    }
    state.version = e.version;
  }
  return state;
}

export function createPackageService(store, { now, genId, claims }) {
  const load = (packageId) => {
    const events = store.stream("content_package", packageId);
    if (!events.length) throw new DomainError("PACKAGE_NOT_FOUND", `内容包不存在：${packageId}`);
    return foldPackage(events);
  };

  const emit = (packageId, eventType, payload, summary, eventId) => {
    const version = store.stream("content_package", packageId).length + 1;
    return store.append(
      makeEvent({
        eventId: eventId ?? genId("evt-pkg"),
        eventType,
        aggregateType: "content_package",
        aggregateId: packageId,
        version,
        occurredAt: now(),
        summary,
        payload,
      })
    ).event;
  };

  /** 把语句清单解析成钉死版本的清单：claim 版本 + 各语言译文修订。 */
  const resolveManifest = (definition) => {
    const idx = buildTranslationIndex(store);
    const failures = [];
    const statements = [];
    for (const key of definition.statement_keys) {
      let claim;
      try {
        claim = claims.loadByKey(key);
      } catch {
        failures.push(`语句 ${key} 不存在`);
        continue;
      }
      if (!["approved", "emergency"].includes(claim.status)) {
        failures.push(`语句 ${key} 未批准（当前状态 ${claim.status}），不得入包`);
        continue;
      }
      if (claim.status === "emergency" && !noticePlayable(claim, now())) {
        failures.push(`紧急通知 ${key} 已过补签时限或有效期，不得继续播报`);
        continue;
      }
      if (claim.sources.some((s) => s.public_level === "unpublished")) {
        failures.push(`语句 ${key} 含未公开研究材料，禁止外泄到设备`);
        continue;
      }
      const translations = {};
      for (const lang of definition.languages) {
        const t = idx.get(lang, key);
        if (!t) {
          failures.push(`语句 ${key} 缺少 ${lang} 已应用译文`);
        } else if (t.claim_version !== claim.approved_version) {
          failures.push(`语句 ${key} 的 ${lang} 译文基于旧版本 ${t.claim_version}，当前为 ${claim.approved_version}`);
        } else {
          translations[lang] = { text: t.text, revision_id: t.revision_id, qa_questions: t.qa_questions };
        }
      }
      statements.push({
        statement_key: key,
        kind: claim.kind,
        claim_version: claim.approved_version,
        status: claim.status,
        text_zh: claim.text_zh,
        accessible_text_zh: claim.accessible_text_zh,
        terms: claim.terms,
        framing: claim.approval_basis?.framing ?? null,
        notice: claim.emergency
          ? { valid_until: claim.emergency.valid_until, countersign_due_at: claim.emergency.countersign_due_at }
          : null,
        translations,
      });
    }
    return { statements, failures };
  };

  /** 为游客侧准备的出处：事实/解释只暴露公开来源段落；通知给运营出处。 */
  const buildCitations = (statements) => {
    const citations = {};
    for (const s of statements) {
      const claim = claims.loadByKey(s.statement_key);
      if (s.kind === "notice") {
        citations[s.statement_key] = {
          updated_at: claim.approved_at,
          sources: [],
          operational: {
            kind: "temporary_notice",
            reason: claim.emergency?.reason ?? null,
            valid_until: claim.emergency?.valid_until ?? null,
            countersigned: Boolean(claim.emergency?.countersigned_at),
          },
        };
      } else {
        citations[s.statement_key] = {
          updated_at: claim.approved_at,
          sources: claim.sources
            .filter((src) => src.public_level === "public")
            .map((src) => ({
              source_id: src.source_id,
              title: src.title,
              paragraph_ref: src.paragraph_ref,
              quote: src.quote,
            })),
        };
      }
    }
    return citations;
  };

  /** 修订原因追溯：给每条变化找可解释理由。 */
  const reasonForClaim = (claim) => {
    const lastReview = claim.expert_reviews.at(-1);
    if (claim.approval_basis?.note) return claim.approval_basis.note;
    if (lastReview) return `专家意见（${lastReview.verdict}）：${lastReview.opinion}`;
    return claim.kind === "notice" ? `运营通知：${claim.emergency?.reason ?? ""}` : "首次发布";
  };

  const revisionReason = (revisionId) => {
    const opened = store.stream("translation_revision", revisionId).find((e) => e.event_type === "TRANSLATION_REVISION_OPENED");
    return opened ? opened.payload.reason : null;
  };

  return {
    define({ package_id, created_by, statement_keys, qa_templates = [], languages = [] }, eventId) {
      if (eventId) {
        const existing = store.getEvent(eventId);
        if (existing && existing.event_type !== "PACKAGE_DEFINED") {
          throw new DomainError("EVENT_ID_CONFLICT", `事件 ${eventId} 已存在但类型不一致，禁止复用标识`);
        }
        if (existing) return existing;
      }
      if (store.stream("content_package", package_id).length) {
        throw new DomainError("PACKAGE_EXISTS", `内容包已存在：${package_id}`);
      }
      const dup = statement_keys.filter((k, i) => statement_keys.indexOf(k) !== i);
      if (dup.length) throw new DomainError("DUP_KEYS", `清单内语句重复：${[...new Set(dup)].join(", ")}`);
      for (const t of qa_templates) {
        for (const f of ["template_id", "ask_id", "ask_zh", "statement_keys"]) {
          if (!(f in t)) throw new DomainError("BAD_TEMPLATE", `问答模板缺少字段：${f}`);
        }
        if (!t.statement_keys.every((k) => statement_keys.includes(k))) {
          throw new DomainError("ORPHAN_TEMPLATE", `问答模板 ${t.template_id} 引用了不在清单内的语句`);
        }
      }
      return emit(
        package_id,
        "PACKAGE_DEFINED",
        { created_by, statement_keys, qa_templates, languages },
        `定义内容包：${statement_keys.length} 条语句、${languages.length} 种语言`,
        eventId
      );
    },

    /** 影响预览：对照上一版本，列出语句级与译文级变化及可解释理由。 */
    previewImpact(packageId) {
      const pkg = load(packageId);
      const { statements, failures } = resolveManifest(pkg.definition);
      if (failures.length) throw new ReleaseGateError(failures);

      const prev = pkg.versions.get(pkg.current_version);
      const prevByKey = new Map((prev?.manifest.statements ?? []).map((s) => [s.statement_key, s]));
      const changes = [];
      for (const s of statements) {
        const old = prevByKey.get(s.statement_key);
        const claim = claims.loadByKey(s.statement_key);
        if (!old) {
          changes.push({ statement_key: s.statement_key, change: "added", reason: reasonForClaim(claim) });
          continue;
        }
        if (old.claim_version !== s.claim_version) {
          changes.push({
            statement_key: s.statement_key,
            change: "statement_updated",
            from_claim_version: old.claim_version,
            to_claim_version: s.claim_version,
            reason: reasonForClaim(claim),
          });
        }
        for (const lang of pkg.definition.languages) {
          const oldText = old.translations[lang]?.text;
          const newText = s.translations[lang]?.text;
          if (oldText !== newText) {
            changes.push({
              statement_key: s.statement_key,
              change: "translation_updated",
              language: lang,
              old_text: oldText ?? null,
              new_text: newText,
              from_revision: old.translations[lang]?.revision_id ?? null,
              to_revision: s.translations[lang].revision_id,
              reason: revisionReason(s.translations[lang].revision_id) ?? "译文修订",
            });
          }
        }
      }
      for (const key of prevByKey.keys()) {
        if (!statements.some((s) => s.statement_key === key)) {
          changes.push({ statement_key: key, change: "removed", reason: "移出本内容包清单" });
        }
      }
      return {
        package_id: packageId,
        base_version: pkg.current_version,
        changes,
        explanation: changes.map((c) => {
          const where = c.language ? `（${c.language} 译文）` : "";
          return `${c.statement_key}${where}：${c.change} — ${c.reason}`;
        }),
      };
    },

    /** 发布：门禁全过才产生 PACKAGE_PUBLISHED；影响预览随事件固化。 */
    publish(packageId, { package_version }, eventId) {
      if (eventId) {
        const existing = store.getEvent(eventId);
        if (existing && existing.event_type !== "PACKAGE_PUBLISHED") {
          throw new DomainError("EVENT_ID_CONFLICT", `事件 ${eventId} 已存在但类型不一致，禁止复用标识`);
        }
        if (existing) return existing;
      }
      const pkg = load(packageId);
      if ([...pkg.versions.keys()].includes(package_version)) {
        throw new DomainError("VERSION_EXISTS", `内容包版本已发布：${package_version}`);
      }
      const impact = this.previewImpact(packageId);
      const failures = [];
      if (!impact.changes.length && pkg.current_version) {
        failures.push("与上一版本完全相同，没有需要发布的变化");
      }
      if (impact.changes.some((c) => !c.reason)) failures.push("影响预览存在无法解释的变化");
      if (failures.length) throw new ReleaseGateError(failures);

      const { statements } = resolveManifest(pkg.definition);
      const manifest = {
        statements,
        qa_templates: pkg.definition.qa_templates,
        languages: pkg.definition.languages,
      };
      const citations = buildCitations(statements);
      const publishedAt = now();
      return emit(
        packageId,
        "PACKAGE_PUBLISHED",
        {
          package_version,
          manifest,
          impact,
          citations,
          published_at: publishedAt,
        },
        `发布内容包 ${packageId}@${package_version}：${impact.changes.length} 项变化`,
        eventId
      );
    },

    /**
     * 发布完成度：影响预览可解释、出处与更新时间可查、每台设备回执确认、无未公开材料外泄。
     * 回执状态来自 device_receipt 事件。
     */
    releaseStatus(packageId, packageVersion) {
      const pkg = load(packageId);
      const release = pkg.versions.get(packageVersion);
      if (!release) throw new DomainError("VERSION_NOT_FOUND", `未找到版本：${packageId}@${packageVersion}`);

      const acked = new Set();
      const assigned = new Set();
      for (const e of store.all("device_receipt")) {
        if (e.event_type === "DEVICE_ASSIGNED" && e.payload.package_id === packageId) {
          assigned.add(e.aggregate_id);
        }
        if (
          e.event_type === "DEVICE_ACKNOWLEDGED" &&
          e.payload.package_id === packageId &&
          e.payload.package_version === packageVersion
        ) {
          acked.add(e.aggregate_id);
        }
      }
      const outstanding = [...assigned].filter((id) => !acked.has(id));

      const citationsComplete = release.manifest.statements.every((s) => {
        const c = release.citations[s.statement_key];
        if (!c) return false;
        return s.kind === "notice" ? Boolean(c.operational) : (c.sources?.length ?? 0) > 0;
      });
      const explainable =
        release.impact.changes.every((c) => c.reason) && release.impact.explanation.length >= release.impact.changes.length;
      const noLeak = !release.manifest.statements.some((s) =>
        claims.loadByKey(s.statement_key).sources.some((src) => src.public_level === "unpublished")
      );

      const checks = {
        impact_explainable: explainable,
        citations_queryable: citationsComplete,
        all_devices_acknowledged: outstanding.length === 0,
        no_unpublished_leak: noLeak,
      };
      return {
        package_id: packageId,
        package_version: packageVersion,
        published_at: release.published_at,
        registered_devices: assigned.size,
        acknowledged_devices: acked.size,
        outstanding_devices: outstanding,
        checks,
        complete: Object.values(checks).every(Boolean),
      };
    },

    load,
  };
}
