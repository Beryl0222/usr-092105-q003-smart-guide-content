import { DomainError } from "./errors.js";
import { foldPackage } from "./packages.js";
import { noticePlayable } from "./claims.js";

/** 解释性主张的播报前缀，设备端不得去除，防止把学界推测讲成确定史实。 */
const QUALIFIER = {
  zh: "（学界推测，尚无定论）",
  ja: "（学界の推測であり、定説ではありません）",
  en: "(Scholarly speculation, not settled fact)",
};

const NOTICE_PREFIX = {
  zh: "（临时运营通知）",
  ja: "（運営上の臨時のお知らせ）",
  en: "(Temporary operational notice)",
};

export function createAnswerService(store, { now, claims }) {
  const loadRelease = (packageId, packageVersion) => {
    const pkg = foldPackage(store.stream("content_package", packageId));
    if (!pkg.versions.size) throw new DomainError("PACKAGE_NOT_PUBLISHED", `内容包尚未发布：${packageId}`);
    const version = packageVersion ?? pkg.current_version;
    const release = pkg.versions.get(version);
    if (!release) throw new DomainError("VERSION_NOT_FOUND", `未找到版本：${packageId}@${version}`);
    return { pkg, release, version };
  };

  /**
   * 机器组合回答：只允许按问答模板拼装已发布、已批准、在有效期内的语句，
   * 不引入包外证据，不自由生成。匹配方式为问法精确命中（ask_id 或问法原文）。
   */
  function answer({ package_id, package_version = null, language, ask = null, ask_id = null }) {
    const { release, version } = loadRelease(package_id, package_version);
    if (!release.manifest.languages.includes(language) && language !== "zh") {
      throw new DomainError("LANGUAGE_NOT_IN_PACKAGE", `本包不提供语言：${language}`);
    }

    // 1) 找模板：模板经 ask_id 绑定，中文问法在模板上，其他语言问法随译文入包。
    let template = null;
    let matchedAskId = ask_id;
    const askTextFor = (t, lang) => {
      if (lang === "zh") return t.ask_zh;
      for (const s of release.manifest.statements) {
        const q = s.translations[lang]?.qa_questions?.find((x) => x.ask_id === t.ask_id);
        if (q) return q.ask;
      }
      return null;
    };

    if (ask_id) {
      template = release.manifest.qa_templates.find((t) => t.ask_id === ask_id);
      if (!template) throw new DomainError("ASK_NOT_FOUND", `本版本不存在问法：${ask_id}`);
    } else if (ask != null) {
      template = release.manifest.qa_templates.find((t) => askTextFor(t, language) === ask);
      if (template) matchedAskId = template.ask_id;
      if (!template) {
        // 越界问法：明确拒答，不得用模型自由发挥。
        return {
          package_id,
          package_version: version,
          language,
          ask,
          matched: false,
          answer: null,
          refusal: "该问题没有已批准的问答内容，讲解员无法作答，请咨询现场工作人员。",
          citations: [],
          answered_at: now(),
        };
      }
    } else {
      throw new DomainError("NO_ASK", "必须提供 ask_id 或 ask 原文");
    }

    // 2) 按模板顺序取钉版本语句，通知先过有效期。
    const parts = [];
    const citations = [];
    for (const key of template.statement_keys) {
      const s = release.manifest.statements.find((x) => x.statement_key === key);
      const claim = claims.loadByKey(key);
      if (s.kind === "notice" && !noticePlayable(claim, now())) continue; // 失效通知不参与组合

      const text = language === "zh" ? s.text_zh : s.translations[language]?.text;
      let rendered = text;
      if (s.kind === "interpretation") {
        rendered = `${QUALIFIER[language] ?? QUALIFIER.zh}${text}`;
      } else if (s.kind === "notice") {
        rendered = `${NOTICE_PREFIX[language] ?? NOTICE_PREFIX.zh}${text}（有效期至 ${s.notice.valid_until}）`;
      }
      parts.push({
        statement_key: key,
        kind: s.kind,
        claim_version: s.claim_version,
        text: rendered,
        accessible_text_zh: s.accessible_text_zh,
        terms: s.terms ?? [],
      });
      citations.push({ statement_key: key, ...release.citations[key] });
    }

    if (!parts.length) {
      return {
        package_id,
        package_version: version,
        language,
        matched_ask_id: matchedAskId,
        matched: true,
        answer: null,
        refusal: "相关内容当前不在播报有效期内。",
        citations: [],
        answered_at: now(),
      };
    }

    return {
      package_id,
      package_version: version,
      language,
      matched_ask_id: matchedAskId,
      matched: true,
      statements: parts,
      answer: parts.map((p) => p.text).join("\n"),
      citations,
      answered_at: now(),
    };
  }

  /** 游客侧出处与更新时间查询：只返回随包发布的公开来源。 */
  function citations(package_id, package_version = null, statement_key = null) {
    const { version } = loadRelease(package_id, package_version);
    const { release } = loadRelease(package_id, version);
    const keys = statement_key ? [statement_key] : release.manifest.statements.map((s) => s.statement_key);
    return {
      package_id,
      package_version: version,
      published_at: release.published_at,
      items: keys.map((key) => {
        if (!(key in release.citations)) throw new DomainError("STATEMENT_NOT_IN_PACKAGE", `本版本不含语句：${key}`);
        return { statement_key: key, ...release.citations[key] };
      }),
    };
  }

  /** 列出某语言全部可提问法（设备离线问答入口用）。 */
  function askList(package_id, package_version = null, language) {
    const { release, version } = loadRelease(package_id, package_version);
    const asks = release.manifest.qa_templates.map((t) => ({
      ask_id: t.ask_id,
      ask: language === "zh" ? t.ask_zh : askTextInManifest(release, t.ask_id, language),
      statement_keys: t.statement_keys,
    })).filter((x) => x.ask != null);
    return { package_id, package_version: version, language, asks };
  }

  function askTextInManifest(release, askId, lang) {
    for (const s of release.manifest.statements) {
      const q = s.translations[lang]?.qa_questions?.find((x) => x.ask_id === askId);
      if (q) return q.ask;
    }
    return null;
  }

  return { answer, citations, askList };
}
