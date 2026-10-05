import assert from "node:assert/strict";
import test from "node:test";

import {
  EventStore,
  ReviewService,
  PublishService,
  NoticeService,
  DeviceService,
  AnswerService,
  ProvenanceQuery,
  ReleaseCompletion,
  CERTAINTY,
  TRANSLATION_ERROR_TYPES,
} from "../src/index.js";

/**
 * 端到端复现 2026-10-04 夜事故并验证新平台处置：
 * 1. “学界推测”被播成确定史实 -> 编译期强制对冲 + 答复不越证据；
 * 2. 日文把“局部开放”翻成“暂停开放” -> 翻译修订逐条列语句/问法，换包可解释；
 * 3. 不知错误说法还在哪些离线设备 -> 回执指纹 + 离线暴露排查；
 * 4. 设备重连先查有效期；紧急通知先发、限时补签、完整历史；
 * 5. 发布完成度四项全满足才算完成。
 */
function buildWorld() {
  const store = new EventStore();
  return {
    store,
    review: new ReviewService(store),
    publish: new PublishService(store),
    notice: new NoticeService(store),
    device: new DeviceService(store),
    answer: new AnswerService(store),
    provenance: new ProvenanceQuery(store),
    completion: new ReleaseCompletion(store),
  };
}

test("事故全流程：推测强制对冲、日文误译修订、离线设备排查、换包完成度", () => {
  const w = buildWorld();

  // ---------- 9月：内容登记与审校 ----------
  w.review.recordClaim({
    command_id: "cmd-record-open",
    claim_id: "claim-open-001",
    site_id: "site-museum",
    topic: "三层展厅开放状态",
    kind: "fact",
    certainty: CERTAINTY.ESTABLISHED,
    statement_zh: "主馆三层展厅目前局部开放。",
    sources: [
      {
        source_id: "src-bulletin-2026-09",
        access: "public",
        citation: "馆方公告 2026-09 第 12 期",
        excerpt: "主馆三层展厅目前局部开放。",
      },
    ],
    occurred_at: "2026-09-20T09:00:00+08:00",
  });
  w.review.approveClaim({
    command_id: "cmd-approve-open",
    claim_id: "claim-open-001",
    reviewer_id: "u-curator",
    approved_statement_zh: "主馆三层展厅目前局部开放。",
    source_ids: ["src-bulletin-2026-09"],
    occurred_at: "2026-09-20T10:00:00+08:00",
  });
  w.review.approveQaTemplate({
    command_id: "cmd-qa-open",
    claim_id: "claim-open-001",
    template_id: "tpl-open",
    reviewer_id: "u-curator",
    question_forms: [{ lang: "zh", text: "三层展厅现在能参观吗？" }],
    occurred_at: "2026-09-20T10:10:00+08:00",
  });

  // 解释性主张：学界推测，必须先有专家意见，批准时系统记录强制对冲
  w.review.recordClaim({
    command_id: "cmd-record-spec",
    claim_id: "claim-spec-001",
    site_id: "site-museum",
    topic: "遗址早期功能",
    kind: "interpretation",
    certainty: CERTAINTY.SCHOLARLY_SPECULATION,
    statement_zh: "该遗址早期功能可能与祭祀活动有关。",
    sources: [
      { source_id: "src-paper-2021", access: "public", citation: "《考古学报》2021 年第 3 期", excerpt: "部分学者推测与祭祀有关" },
      { source_id: "src-fieldnotes-2026", access: "restricted", citation: "2026 秋季发掘内部笔记（未公开）", excerpt: "H3 灰坑打破关系待确认" },
    ],
    occurred_at: "2026-09-21T09:00:00+08:00",
  });
  w.review.addExpertOpinion({
    command_id: "cmd-expert-spec",
    claim_id: "claim-spec-001",
    opinion_id: "op-001",
    expert_id: "expert-qin",
    expert_name: "秦研究员",
    stance: "unresolved",
    text: "目前证据只支持推测，不宜作为定论讲解。",
    occurred_at: "2026-09-21T14:00:00+08:00",
  });
  w.review.approveClaim({
    command_id: "cmd-approve-spec",
    claim_id: "claim-spec-001",
    reviewer_id: "u-chief-curator",
    approved_statement_zh: "该遗址早期功能可能与祭祀活动有关。",
    certainty: CERTAINTY.SCHOLARLY_SPECULATION,
    source_ids: ["src-paper-2021", "src-fieldnotes-2026"],
    expert_opinion_ids: ["op-001"],
    occurred_at: "2026-09-22T10:00:00+08:00",
  });
  w.review.approveQaTemplate({
    command_id: "cmd-qa-spec",
    claim_id: "claim-spec-001",
    template_id: "tpl-spec",
    reviewer_id: "u-chief-curator",
    question_forms: [{ lang: "zh", text: "这里古时候是做什么用的？" }],
    occurred_at: "2026-09-22T10:30:00+08:00",
  });
  w.review.approveGlossaryTerm({
    command_id: "cmd-glossary-001",
    term_id: "term-guan",
    terms: {
      zh: { text: "罍", pinyin: "léi" },
      ja: { text: "らい", reading: "らい（古代酒器）" },
    },
    accessibility_note: "读音单独成片，避免与器名连读",
    occurred_at: "2026-09-22T11:00:00+08:00",
  });

  // 日文初译——事故根因：局部开放被误译为“暂停开放/一時閉館”，且审校漏过
  w.review.proposeTranslationRevision({
    command_id: "cmd-ja-init",
    revision_id: "tr-ja-init",
    target_language: "ja",
    reason: "日文首版翻译",
    proposed_by: "u-translator-a",
    affected_statements: [
      {
        ref_id: "claim-open-001",
        old_text: null,
        new_text: "三階展示室は一時閉館しています。", // 错误：暂停开放
      },
      {
        ref_id: "claim-spec-001",
        old_text: null,
        new_text: "この遺跡の初期の用途は祭祀に関連するとみられています。",
      },
    ],
    affected_question_forms: [
      {
        ref_id: "claim-open-001",
        template_id: "tpl-open",
        old_text: null,
        new_text: "三階展示室は今見られますか？",
      },
      {
        ref_id: "claim-spec-001",
        template_id: "tpl-spec",
        old_text: null,
        new_text: "ここは昔どのような場所でしたか？",
      },
    ],
    occurred_at: "2026-09-23T09:00:00+08:00",
  });
  w.review.reviewTranslation({
    command_id: "cmd-ja-init-review",
    revision_id: "tr-ja-init",
    reviewer_id: "u-ja-reviewer",
    decision: "approved",
    note: "初版审校（事故版本，局部开放误译未被发现）",
    occurred_at: "2026-09-23T15:00:00+08:00",
  });

  // ---------- 9月25日：发布 pkg-v1（含事故日文），三台设备换包 ----------
  const specV1 = {
    package_id: "pkg-2026-09-v1",
    entries: [
      { claim_id: "claim-open-001", claim_version: 2, languages: ["zh", "ja"], qa_template_ids: ["tpl-open"] },
      { claim_id: "claim-spec-001", claim_version: 3, languages: ["zh", "ja"], qa_template_ids: ["tpl-spec"] },
    ],
    translation_refs: [{ revision_id: "tr-ja-init" }],
    valid_from: "2026-09-25T10:00:00+08:00",
    valid_until: "2026-10-10T22:00:00+08:00",
  };
  const compiledV1 = w.publish.draft(specV1, {
    command_id: "cmd-pkg-v1-draft",
    drafted_by: "u-ops",
    occurred_at: "2026-09-25T09:00:00+08:00",
  });
  // 推测条目即使翻译侧没写对冲，中文编译也强制加前缀
  const specZh = compiledV1.manifest.find((m) => m.ref === "claim:claim-spec-001@v3" && m.lang === "zh");
  assert.match(specZh.text, /^学界推测，/);
  const specJa = compiledV1.manifest.find((m) => m.ref === "claim:claim-spec-001@v3" && m.lang === "ja");
  assert.match(specJa.text, /学界ではこう推測/);
  w.publish.publish({
    command_id: "cmd-pkg-v1-publish",
    package_id: "pkg-2026-09-v1",
    published_by: "u-ops",
    impact_confirmation_checksum: compiledV1.impact_preview.checksum,
    occurred_at: "2026-09-25T10:00:00+08:00",
  });

  for (const [id, label] of [
    ["dev-01", "一层服务台机"],
    ["dev-02", "三层导览机A"],
    ["dev-03", "三层导览机B"],
  ]) {
    w.device.register({
      command_id: `cmd-reg-${id}`,
      device_id: id,
      label,
      site_id: "site-museum",
      languages: ["zh", "ja"],
      occurred_at: "2026-09-25T08:00:00+08:00",
    });
    w.device.acknowledge({
      command_id: `cmd-ack-v1-${id}`,
      device_id: id,
      kind: "package",
      object_id: "pkg-2026-09-v1",
      object_version: 2,
      status: "applied",
      fingerprints: compiledV1.fingerprints,
      occurred_at: "2026-09-25T10:05:00+08:00",
    });
  }
  // 三层两台机随后离线
  for (const id of ["dev-02", "dev-03"]) {
    w.device.heartbeat({
      command_id: `cmd-hb-off-${id}`,
      device_id: id,
      online: false,
      loaded: [{ kind: "package", object_id: "pkg-2026-09-v1", object_version: 2 }],
      occurred_at: "2026-10-01T12:00:00+08:00",
    });
  }

  // 机器答复：推测问题必须带对冲与公开出处，restricted 笔记不得出现在证据里
  const ans = w.answer.compose(
    { package_id: "pkg-2026-09-v1", lang: "zh", claim_id: "claim-spec-001", template_id: "tpl-spec" },
    "2026-10-04T22:00:00+08:00"
  );
  assert.equal(ans.status, "answered");
  assert.equal(ans.hedged, true);
  assert.equal(ans.certainty, CERTAINTY.SCHOLARLY_SPECULATION);
  assert.deepEqual(ans.evidence.sources.map((s) => s.source_id), ["src-paper-2021"]);
  assert.ok(!JSON.stringify(ans).includes("src-fieldnotes-2026"));
  // 没有证据的组合请求 -> 固定无法回答，不允许生成式补全
  const none = w.answer.compose(
    { package_id: "pkg-2026-09-v1", lang: "zh", claim_id: "claim-unknown" },
    "2026-10-04T22:00:00+08:00"
  );
  assert.equal(none.status, "unable_to_answer");

  // ---------- 10月4日夜：游客投诉，紧急修订日文 ----------
  // 翻译修订必须逐条列清受影响语句与问法
  assert.throws(
    () =>
      w.review.proposeTranslationRevision({
        command_id: "cmd-bad-revision",
        revision_id: "tr-empty",
        target_language: "ja",
        proposed_by: "u-translator-b",
        occurred_at: "2026-10-04T23:00:00+08:00",
      }),
    /逐条列出/
  );
  w.review.proposeTranslationRevision({
    command_id: "cmd-ja-fix",
    revision_id: "tr-ja-fix-1004",
    target_language: "ja",
    reason: "游客投诉：日文将“局部开放”误译为“一時閉館（暂停开放）”，语义相反",
    proposed_by: "u-translator-b",
    affected_statements: [
      {
        ref_id: "claim-open-001",
        old_text: "三階展示室は一時閉館しています。",
        new_text: "三階展示室は一部公開しています。",
        error_type: TRANSLATION_ERROR_TYPES.MISTRANSLATION,
      },
    ],
    affected_question_forms: [
      {
        ref_id: "claim-open-001",
        template_id: "tpl-open",
        old_text: "三階展示室は今見られますか？",
        new_text: "三階展示室の公開範囲を教えてください。",
      },
    ],
    occurred_at: "2026-10-04T23:00:00+08:00",
  });
  w.review.reviewTranslation({
    command_id: "cmd-ja-fix-review",
    revision_id: "tr-ja-fix-1004",
    reviewer_id: "u-ja-senior",
    decision: "approved",
    note: "确认语义相反误译，立即换包",
    occurred_at: "2026-10-04T23:20:00+08:00",
  });

  // ---------- 紧急换包 pkg-v2：影响预览必须能解释 ----------
  const specV2 = { ...specV1, package_id: "pkg-2026-10-v2", baseline_package_id: "pkg-2026-09-v1" };
  specV2.translation_refs = [{ revision_id: "tr-ja-init" }, { revision_id: "tr-ja-fix-1004" }];
  const compiledV2 = w.publish.draft(specV2, {
    command_id: "cmd-pkg-v2-draft",
    drafted_by: "u-ops",
    occurred_at: "2026-10-04T23:25:00+08:00",
  });
  const jaChange = compiledV2.impact_preview.changes.find(
    (c) => c.type === "changed" && c.ref === "claim:claim-open-001@v2" && c.lang === "ja"
  );
  assert.ok(jaChange, "影响预览必须列出日文语句变化");
  assert.equal(jaChange.old_text, "三階展示室は一時閉館しています。");
  assert.equal(jaChange.new_text, "三階展示室は一部公開しています。");
  assert.equal(jaChange.via_revision, "tr-ja-fix-1004");
  const qaChange = compiledV2.impact_preview.changes.find(
    (c) => c.type === "changed" && c.ref.startsWith("qa:tpl-open") && c.lang === "ja"
  );
  assert.ok(qaChange, "影响预览必须列出日文问法变化");

  // 未确认影响预览 / 校验和不符，一律拒绝发布
  assert.throws(
    () =>
      w.publish.publish({
        command_id: "cmd-pkg-v2-publish-noconfirm",
        package_id: "pkg-2026-10-v2",
        published_by: "u-ops",
        occurred_at: "2026-10-04T23:30:00+08:00",
      }),
    /影响预览/
  );
  assert.throws(
    () =>
      w.publish.publish({
        command_id: "cmd-pkg-v2-publish-badsum",
        package_id: "pkg-2026-10-v2",
        published_by: "u-ops",
        impact_confirmation_checksum: "deadbeef",
        occurred_at: "2026-10-04T23:30:00+08:00",
      }),
    /校验和不一致/
  );
  w.publish.publish({
    command_id: "cmd-pkg-v2-publish",
    package_id: "pkg-2026-10-v2",
    published_by: "u-ops",
    impact_confirmation_checksum: compiledV2.impact_preview.checksum,
    occurred_at: "2026-10-04T23:30:00+08:00",
  });

  // 在线设备 dev-01 换包成功（重试同一命令必须幂等，不多出回执）
  w.device.acknowledge({
    command_id: "cmd-ack-v2-dev01",
    device_id: "dev-01",
    kind: "package",
    object_id: "pkg-2026-10-v2",
    object_version: 2,
    status: "applied",
    fingerprints: compiledV2.fingerprints,
    occurred_at: "2026-10-04T23:35:00+08:00",
  });
  w.device.acknowledge({
    command_id: "cmd-ack-v2-dev01", // 网关重试
    device_id: "dev-01",
    kind: "package",
    object_id: "pkg-2026-10-v2",
    object_version: 2,
    status: "applied",
    fingerprints: compiledV2.fingerprints,
    occurred_at: "2026-10-04T23:35:00+08:00",
  });
  const acksV2Dev01 = w.store
    .loadStream("device_receipt", "dev-01")
    .filter((e) => e.event_type === "DEVICE_ACKNOWLEDGED" && e.object_id === "pkg-2026-10-v2");
  assert.equal(acksV2Dev01.length, 1, "重复回执命令必须幂等");

  // 回执指纹不符必须拒绝（防止设备谎报已换包）
  assert.throws(
    () =>
      w.device.acknowledge({
        command_id: "cmd-ack-v2-fake",
        device_id: "dev-02",
        kind: "package",
        object_id: "pkg-2026-10-v2",
        object_version: 2,
        status: "applied",
        fingerprints: compiledV1.fingerprints,
        occurred_at: "2026-10-04T23:40:00+08:00",
      }),
    /指纹/
  );

  // ---------- 排查：错误日文还在哪些（离线）设备 ----------
  const exposure = w.device.devicesExposing("pkg-2026-10-v2", "2026-10-05T00:30:00+08:00");
  assert.deepEqual(exposure.affected_devices.map((d) => d.device_id).sort(), ["dev-02", "dev-03"]);
  assert.deepEqual(exposure.offline_devices.sort(), ["dev-02", "dev-03"]);
  const staleJa = exposure.affected_devices[0].stale_items.filter((i) => i.lang === "ja");
  assert.ok(staleJa.some((i) => i.on_device_text.includes("一時閉館") && i.latest_text.includes("一部公開")));

  // ---------- 重连：先按有效期判定 ----------
  // dev-02 在旧包有效期内重连：可继续播，但收到 refresh_recommended 与具体旧说法
  w.device.heartbeat({
    command_id: "cmd-hb-on-dev02",
    device_id: "dev-02",
    online: true,
    loaded: [{ kind: "package", object_id: "pkg-2026-09-v1", object_version: 2 }],
    occurred_at: "2026-10-05T01:00:00+08:00",
  });
  const reconnect02 = w.device.onReconnect("dev-02", "2026-10-05T01:00:00+08:00");
  const pkgDecision = reconnect02.decisions.find((d) => d.object_id === "pkg-2026-09-v1");
  assert.equal(pkgDecision.action, "refresh_recommended");
  assert.equal(pkgDecision.may_play, true);
  assert.equal(pkgDecision.latest_object_id, "pkg-2026-10-v2");
  assert.ok(pkgDecision.stale_items.some((i) => i.lang === "ja" && i.on_device_text.includes("一時閉館")));

  // dev-03 在旧包过期后才重连：先判定有效期 -> 必须刷新，期间不得播报
  w.device.heartbeat({
    command_id: "cmd-hb-on-dev03",
    device_id: "dev-03",
    online: true,
    loaded: [{ kind: "package", object_id: "pkg-2026-09-v1", object_version: 2 }],
    occurred_at: "2026-10-11T09:00:00+08:00",
  });
  const reconnect03 = w.device.onReconnect("dev-03", "2026-10-11T09:00:00+08:00");
  assert.equal(reconnect03.decisions[0].action, "refresh_required");
  assert.equal(reconnect03.decisions[0].may_play, false);
  assert.ok(reconnect03.decisions[0].reasons.join("").includes("有效期"));

  // dev-02 完成换包
  w.device.acknowledge({
    command_id: "cmd-ack-v2-dev02",
    device_id: "dev-02",
    kind: "package",
    object_id: "pkg-2026-10-v2",
    object_version: 2,
    status: "applied",
    fingerprints: compiledV2.fingerprints,
    occurred_at: "2026-10-05T01:05:00+08:00",
  });

  // ---------- 发布完成度：设备未全部回执前不算完成 ----------
  const partial = w.completion.assess("pkg-2026-10-v2", ["dev-01", "dev-02", "dev-03"], "2026-10-05T01:10:00+08:00");
  assert.equal(partial.complete, false);
  const receiptCheck = partial.checks.find((c) => c.key === "device_receipts_confirmed");
  assert.equal(receiptCheck.passed, false);
  assert.ok(receiptCheck.devices.find((d) => d.device_id === "dev-03")?.status === "no_receipt");
  // 影响预览、出处、密级三项此时已满足
  assert.equal(partial.checks.find((c) => c.key === "impact_preview_explained").passed, true);
  assert.equal(partial.checks.find((c) => c.key === "visitor_provenance_queryable").passed, true);
  assert.equal(partial.checks.find((c) => c.key === "no_restricted_leakage").passed, true);

  // dev-03 换包后四项全绿，发布才算完成
  w.device.acknowledge({
    command_id: "cmd-ack-v2-dev03",
    device_id: "dev-03",
    kind: "package",
    object_id: "pkg-2026-10-v2",
    object_version: 2,
    status: "applied",
    fingerprints: compiledV2.fingerprints,
    occurred_at: "2026-10-11T09:05:00+08:00",
  });
  const full = w.completion.assess("pkg-2026-10-v2", ["dev-01", "dev-02", "dev-03"], "2026-10-11T09:10:00+08:00");
  assert.equal(full.complete, true);

  // 游客侧出处与更新时间可查询
  const prov = w.provenance.forItem(
    "pkg-2026-10-v2",
    "claim:claim-open-001@v2",
    "ja"
  );
  assert.deepEqual(prov.sources.map((s) => s.citation), ["馆方公告 2026-09 第 12 期"]);
  assert.ok(prov.content_updated_at);
});

test("紧急通知：先发布、限时补签、逾期失效，历史完整", () => {
  const w = buildWorld();
  w.device.register({
    command_id: "cmd-reg-n1",
    device_id: "dev-n1",
    label: "通知测试机",
    occurred_at: "2026-10-04T20:00:00+08:00",
  });

  // 22:40 先发，要求次日 08:00 前补签
  const notice = w.notice.issue({
    command_id: "cmd-notice-issue",
    notice_id: "notice-1004-01",
    title: "三层展厅临时管控",
    body: [
      { lang: "zh", text: "三层展厅明日临时管控，请听从现场指引。" },
      { lang: "ja", text: "三階展示室は明日、一時的に入場制限を行います。" },
    ],
    issued_by: "u-duty-manager",
    issued_at: "2026-10-04T22:40:00+08:00",
    countersign_deadline: "2026-10-05T08:00:00+08:00",
    valid_until: "2026-10-06T22:00:00+08:00",
  });
  assert.equal(notice.status, "issued");
  assert.deepEqual(
    w.notice.playable("notice-1004-01", "2026-10-04T22:45:00+08:00"),
    { playable: true, reasons: [] }
  );
  w.device.acknowledge({
    command_id: "cmd-ack-notice-n1",
    device_id: "dev-n1",
    kind: "notice",
    object_id: "notice-1004-01",
    object_version: 1,
    status: "applied",
    occurred_at: "2026-10-04T22:41:00+08:00",
  });

  // 次日 07:30 完成补签
  w.notice.countersign({
    command_id: "cmd-notice-sign",
    notice_id: "notice-1004-01",
    countersigned_by: "u-director",
    note: "情况属实，同意发布",
    at: "2026-10-05T07:30:00+08:00",
  });
  assert.equal(w.notice.playable("notice-1004-01", "2026-10-05T09:00:00+08:00").playable, true);

  // 设备重连时通知仍在有效期 -> continue
  const reconnect = w.device.onReconnect("dev-n1", "2026-10-05T09:00:00+08:00");
  assert.equal(reconnect.decisions[0].action, "continue");

  // 完整历史：issued -> countersigned，到期后追加 expired
  const expired = w.notice.expireDue("2026-10-07T00:00:00+08:00");
  assert.ok(expired.includes("notice-1004-01"));
  const end = w.store
    .loadStream("content_package", "notice-1004-01")
    .map((e) => e.event_type);
  assert.deepEqual(end, ["NOTICE_ISSUED", "NOTICE_COUNTERSIGNED", "NOTICE_EXPIRED"]);
});

test("紧急通知逾时未补签：补签被拒、设备停播、到期作业失效", () => {
  const w = buildWorld();
  w.notice.issue({
    command_id: "cmd-notice2-issue",
    notice_id: "notice-1004-02",
    title: "未补签通知",
    body: [{ lang: "zh", text: "测试。" }],
    issued_by: "u-duty-manager",
    issued_at: "2026-10-04T22:40:00+08:00",
    countersign_deadline: "2026-10-05T06:00:00+08:00",
    valid_until: "2026-10-06T22:00:00+08:00",
  });
  w.device.register({
    command_id: "cmd-reg-n2",
    device_id: "dev-n2",
    occurred_at: "2026-10-04T22:00:00+08:00",
  });
  w.device.acknowledge({
    command_id: "cmd-ack-notice-n2",
    device_id: "dev-n2",
    kind: "notice",
    object_id: "notice-1004-02",
    object_version: 1,
    status: "applied",
    occurred_at: "2026-10-04T22:41:00+08:00",
  });

  // 截止后补签必须拒绝
  assert.throws(
    () =>
      w.notice.countersign({
        command_id: "cmd-notice2-late-sign",
        notice_id: "notice-1004-02",
        countersigned_by: "u-director",
        at: "2026-10-05T09:00:00+08:00",
      }),
    /补签截止/
  );
  // 设备重连：逾时未补签 -> stop_notice，不得继续播报
  const reconnect = w.device.onReconnect("dev-n2", "2026-10-05T09:00:00+08:00");
  assert.equal(reconnect.decisions[0].action, "stop_notice");
  assert.equal(reconnect.decisions[0].may_play, false);
  assert.ok(reconnect.decisions[0].reasons.join("").includes("补签"));
  // 到期作业补记 NOTICE_EXPIRED，历史不缺失
  const expired = w.notice.expireDue("2026-10-05T09:00:00+08:00");
  assert.ok(expired.includes("notice-1004-02"));
  assert.equal(w.store.loadStream("content_package", "notice-1004-02").at(-1).event_type, "NOTICE_EXPIRED");
});
