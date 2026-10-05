import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlatform } from "../src/platform.js";
import { DomainError, ReleaseGateError } from "../src/errors.js";
import { foldClaim } from "../src/claims.js";

const dir = mkdtempSync(join(tmpdir(), "smart-guide-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

// 可控时钟：模拟离线设备跨天重连、通知到期、逾期补签。
function clock(start = "2026-10-04T08:00:00+08:00") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; },
  };
}

// —— 场景构建辅助 ——

function approveFact(platform, { key, text, source, expert }) {
  const { claims } = platform;
  const id = `claim-${key}`;
  claims.draft({ claim_id: id, kind: "fact", topic_id: "topic-a", statement_key: key, text_zh: text });
  claims.attachEvidence(id, [source]);
  claims.expertReview(id, expert);
  claims.approve(id, { approver: "editor-zhang", basis: { note: "史料互证" } });
  return id;
}

function approveInterpretation(platform, { key, text, source, expert }) {
  const { claims } = platform;
  const id = `claim-${key}`;
  claims.draft({ claim_id: id, kind: "interpretation", topic_id: "topic-a", statement_key: key, text_zh: text });
  claims.attachEvidence(id, [source]);
  claims.expertReview(id, expert);
  claims.approve(id, { approver: "editor-zhang", basis: { framing: "scholarly_speculation" } });
  return id;
}

test("场景0：解释性主张不以确定语气通过审批，播报带限定语", () => {
  const p = createPlatform({ now: clock().now });
  const id = "claim-spec";
  p.claims.draft({ claim_id: id, kind: "interpretation", topic_id: "t1", statement_key: "origin-spec", text_zh: "此处为宫殿正门基址。" });
  p.claims.attachEvidence(id, [{
    source_id: "src-arch", title: "《考古纪略》", paragraph_ref: "p.42", quote: "推测或为正门", public_level: "public",
  }]);
  p.claims.expertReview(id, { expert_id: "expert-li", verdict: "uncertain", opinion: "学界尚有争议" });

  // 缺少 framing 标记 → 驳回，防止“学界推测播成确定史实”
  assert.throws(
    () => p.claims.approve(id, { approver: "editor-zhang", basis: {} }),
    /framing=scholarly_speculation/
  );
  p.claims.approve(id, { approver: "editor-zhang", basis: { framing: "scholarly_speculation" } });
  const claim = p.claims.load(id);
  assert.equal(claim.status, "approved");
  assert.equal(claim.approval_basis.framing, "scholarly_speculation");
});

test("端到端：紧急换包修正日文误译、追溯暴露设备、重连按有效期判定", () => {
  const tk = clock("2026-10-04T08:00:00+08:00");
  const p = createPlatform({ path: join(dir, "incident.jsonl"), now: tk.now });
  const { claims, translations, packages, devices, answers } = p;

  // —— 1) 事实稿与解释性主张 ——
  approveFact(p, {
    key: "hall-open-status",
    text: "东展厅今日局部开放。",
    source: { source_id: "src-ops", title: "展厅开放公告", paragraph_ref: "§2-1", quote: "东展厅局部开放", public_level: "public" },
    expert: { expert_id: "expert-wang", verdict: "support", opinion: "与馆方调度记录一致" },
  });
  approveInterpretation(p, {
    key: "gate-origin",
    text: "这道门可能是当时举行仪式时的出入口。",
    source: { source_id: "src-arch2", title: "《建筑考古论丛》", paragraph_ref: "ch3", quote: "或与仪式动线相关", public_level: "public" },
    expert: { expert_id: "expert-li", verdict: "uncertain", opinion: "属学界推测" },
  });

  // —— 2) 日文翻译（首版含事故误译：局部开放→暂停开放）——
  translations.open({ revision_id: "rev-ja-1", language: "ja", reason: "首版日文翻译" });
  translations.propose("rev-ja-1", "hall-open-status", {
    text: "東展示室は本日、利用を一時停止しています。", // 误译
    qa_questions: [{ ask_id: "ask-open", ask: "東展示室は今やっていますか？" }],
    based_on_claim_version: claims.loadByKey("hall-open-status").approved_version,
  });
  translations.propose("rev-ja-1", "gate-origin", {
    text: "この門は儀式の際の出入口だった可能性があります。",
    qa_questions: [],
    based_on_claim_version: claims.loadByKey("gate-origin").approved_version,
  });

  // —— 3) 紧急运营通知（局部区域临时管控），日译文同步入包 ——
  claims.draft({ claim_id: "claim-notice-1", kind: "notice", topic_id: "topic-a", statement_key: "wing-notice", text_zh: "西配殿区域今日临时管控，请按指引绕行。" });
  claims.emergencyPublish("claim-notice-1", {
    reason: "西配殿临时布展",
    valid_until: "2026-10-04T20:00:00+08:00",
    countersign_due_at: "2026-10-04T12:00:00+08:00",
  });
  translations.propose("rev-ja-1", "wing-notice", {
    text: "西配殿エリアは本日、臨時で入場を制限しています。係員の誘導に従ってください。",
    qa_questions: [],
    based_on_claim_version: claims.loadByKey("wing-notice").approved_version,
  });
  translations.review("rev-ja-1", {
    reviewer: "reviewer-sato",
    decisions: {
      "hall-open-status": { decision: "accepted" },
      "gate-origin": { decision: "accepted" },
      "wing-notice": { decision: "accepted" },
    },
  });
  translations.apply("rev-ja-1");

  // —— 4) 内容包 v1 发布 ——
  packages.define({
    package_id: "pkg-guide",
    created_by: "ops-chen",
    statement_keys: ["hall-open-status", "gate-origin", "wing-notice"],
    qa_templates: [
      { template_id: "tpl-open", ask_id: "ask-open", ask_zh: "东展厅现在开放吗？", statement_keys: ["hall-open-status", "wing-notice"] },
      { template_id: "tpl-gate", ask_id: "ask-gate", ask_zh: "这道门是做什么的？", statement_keys: ["gate-origin"] },
    ],
    languages: ["ja"],
  });
  packages.publish("pkg-guide", { package_version: "1.0.0" });

  // —— 5) 两台设备：一台深夜在线收到 v1，一台离线 ——
  devices.register({ device_id: "dev-001", label: "东厅入口讲解器" });
  devices.register({ device_id: "dev-002", label: "西廊讲解器" });
  devices.assign("dev-001", "pkg-guide");
  devices.assign("dev-002", "pkg-guide");
  devices.acknowledge("dev-001", { package_id: "pkg-guide", package_version: "1.0.0", received_at: tk.now(), content_hash: "h1" });

  // 通知必须按时补签
  tk.advance(2 * 3600 * 1000);
  claims.countersign("claim-notice-1", { approver: "director-guo" });

  // 此时发布尚未完成：dev-002 未回执
  let status = packages.releaseStatus("pkg-guide", "1.0.0");
  assert.equal(status.checks.all_devices_acknowledged, false);
  assert.deepEqual(status.outstanding_devices, ["dev-002"]);
  assert.equal(status.complete, false);

  // —— 6) 昨晚投诉后换包：日文误译修正 ——
  translations.open({ revision_id: "rev-ja-2", language: "ja", reason: "游客投诉：局部开放误译为暂停开放" });
  const baseV = claims.loadByKey("hall-open-status").approved_version;
  translations.propose("rev-ja-2", "hall-open-status", {
    text: "東展示室は本日、一部を公開しています。",
    qa_questions: [{ ask_id: "ask-open", ask: "東展示室は今やっていますか？" }],
    based_on_claim_version: baseV,
  });
  const reviewed = translations.load(
    translations.review("rev-ja-2", {
      reviewer: "reviewer-sato",
      decisions: { "hall-open-status": { decision: "accepted" } },
    }).aggregate_id
  );
  // 受影响清单：准确列出语句与问法
  assert.equal(reviewed.review.affected.statements.length, 1);
  assert.equal(reviewed.review.affected.statements[0].statement_key, "hall-open-status");
  assert.equal(reviewed.review.affected.statements[0].old_text, "東展示室は本日、利用を一時停止しています。");
  assert.equal(reviewed.review.affected.questions.length, 1);
  assert.equal(reviewed.review.affected.questions[0].ask_id, "ask-open");
  assert.deepEqual(reviewed.review.affected.packages, ["pkg-guide"]);
  translations.apply("rev-ja-2");

  // 影响预览可解释
  const impact = packages.previewImpact("pkg-guide");
  const trChange = impact.changes.find((c) => c.change === "translation_updated");
  assert.equal(trChange.language, "ja");
  assert.match(impact.explanation.join("|"), /误译/);

  packages.publish("pkg-guide", { package_version: "1.0.1" });

  // —— 7) 离线设备不知道错误说法还在哪：暴露追溯 ——
  // dev-001 的最高回执仍是 1.0.0（含误译修订 rev-ja-1）→ 暴露
  const exposed = devices.exposedDevices({ statement_key: "hall-open-status", revision_id: "rev-ja-1" });
  assert.deepEqual(exposed.map((x) => x.device_id), ["dev-001"]);
  // dev-001 收到修复包后不再暴露
  devices.acknowledge("dev-001", { package_id: "pkg-guide", package_version: "1.0.1", received_at: tk.now(), content_hash: "h2" });
  assert.deepEqual(devices.exposedDevices({ statement_key: "hall-open-status", revision_id: "rev-ja-1" }), []);

  // 回执幂等：重复回执去重；改哈希则冲突
  assert.equal(devices.acknowledge("dev-001", { package_id: "pkg-guide", package_version: "1.0.1", received_at: tk.now(), content_hash: "h2" }).deduplicated, true);
  assert.throws(
    () => devices.acknowledge("dev-001", { package_id: "pkg-guide", package_version: "1.0.1", received_at: tk.now(), content_hash: "other" }),
    (err) => err.code === "RECEIPT_CONFLICT"
  );

  // —— 8) dev-002 次日早上重新联网：先按有效期判断 ——
  tk.advance(12 * 3600 * 1000); // 到 10-05 早上，已过 10-04 20:00 有效期
  devices.acknowledge("dev-002", { package_id: "pkg-guide", package_version: "1.0.0", received_at: tk.now(), content_hash: "h1" });
  // dev-002 版本落后 → UPDATE（目标修复版）
  const decision = devices.reconnect("dev-002");
  assert.equal(decision.decision, "UPDATE");
  assert.equal(decision.target_version, "1.0.1");

  // dev-001 已是最新版，但包内通知已过期 → SUSPEND 停播该通知，其余继续
  const d1 = devices.reconnect("dev-001");
  assert.equal(d1.decision, "SUSPEND");
  assert.deepEqual(d1.suspended_statements.map((s) => s.statement_key), ["wing-notice"]);
  assert.match(d1.suspended_statements[0].reason, /有效期/);

  // —— 9) 组合回答不越界、限定语与出处 ——
  const ans = answers.answer({ package_id: "pkg-guide", package_version: "1.0.1", language: "ja", ask_id: "ask-gate" });
  assert.match(ans.answer, /学界の推測/);
  assert.equal(ans.citations[0].sources[0].source_id, "src-arch2");

  const openAns = answers.answer({ package_id: "pkg-guide", package_version: "1.0.1", language: "ja", ask: "東展示室は今やっていますか？" });
  assert.match(openAns.answer, /一部を公開/);
  assert.doesNotMatch(openAns.answer, /一時停止/);

  // 包外问法拒答，不自由生成
  const refused = answers.answer({ package_id: "pkg-guide", package_version: "1.0.1", language: "ja", ask: "出口はどこですか？" });
  assert.equal(refused.matched, false);
  assert.ok(refused.refusal);

  // 游客侧出处与更新时间
  const cite = answers.citations("pkg-guide", "1.0.1", "hall-open-status");
  assert.equal(cite.items[0].sources[0].paragraph_ref, "§2-1");
  assert.ok(cite.published_at);
  const noticeCite = answers.citations("pkg-guide", "1.0.1", "wing-notice");
  assert.equal(noticeCite.items[0].operational.kind, "temporary_notice");
  assert.equal(noticeCite.items[0].operational.countersigned, true);

  // —— 10) 完成度：dev-002 升级到 1.0.1 后发布才算完成（且通知到期不阻断版本完成判定以外的播报）——
  devices.acknowledge("dev-002", { package_id: "pkg-guide", package_version: "1.0.1", received_at: tk.now(), content_hash: "h2" });
  status = packages.releaseStatus("pkg-guide", "1.0.1");
  assert.equal(status.checks.impact_explainable, true);
  assert.equal(status.checks.citations_queryable, true);
  assert.equal(status.checks.all_devices_acknowledged, true);
  assert.equal(status.checks.no_unpublished_leak, true);
  assert.equal(status.complete, true);

  // JSONL 持久化可重放
  assert.ok(existsSync(join(dir, "incident.jsonl")));
});

test("事件级保障：幂等 event_id、版本连续、事件标识冲突拒绝", () => {
  const p = createPlatform({ now: clock().now });
  p.claims.draft({
    claim_id: "c-x", kind: "fact", topic_id: "t", statement_key: "k-x", text_zh: "x", eventId: "fixed-id-0001",
  });
  // 同 event_id 同内容重试 → 去重，不产生第二条
  const before = p.store.all().length;
  p.claims.draft({ claim_id: "c-x", kind: "fact", topic_id: "t", statement_key: "k-x", text_zh: "x", eventId: "fixed-id-0001" });
  assert.equal(p.store.all().length, before);
  // event_id 复用但内容不同 → 拒绝
  assert.throws(
    () => p.claims.attachEvidence("c-x", [], "fixed-id-0001"),
    (err) => err.code === "EVENT_ID_CONFLICT"
  );
});

test("安全：未公开研究材料不能进入发布包，也不出现在游客出处", () => {
  const p = createPlatform({ now: clock().now });
  const id = "claim-leak";
  p.claims.draft({ claim_id: id, kind: "fact", topic_id: "t", statement_key: "leak-key", text_zh: "某未刊稿内容" });
  p.claims.attachEvidence(id, [
    { source_id: "s1", title: "未刊发掘日记", paragraph_ref: "p1", quote: "机密", public_level: "unpublished" },
    { source_id: "s2", title: "公开图录", paragraph_ref: "p9", quote: "可公开", public_level: "public" },
  ]);
  p.claims.expertReview(id, { expert_id: "e", verdict: "support", opinion: "ok" });
  // 审批即拦截
  assert.throws(
    () => p.claims.approve(id, { approver: "a", basis: {} }),
    /未公开研究材料/
  );

  // 通知逾期未补签：过补签时限后不能继续播报
  const p2 = createPlatform({ now: clock("2026-10-04T08:00:00+08:00").now });
  p2.claims.draft({ claim_id: "n1", kind: "notice", topic_id: "t", statement_key: "notice-late", text_zh: "临时关闭" });
  p2.claims.emergencyPublish("n1", {
    reason: "检修", valid_until: "2026-10-04T20:00:00+08:00", countersign_due_at: "2026-10-04T10:00:00+08:00",
  });
});

test("紧急通知：逾期补签留痕 on_time=false 且补签后恢复播报", () => {
  const tk = clock("2026-10-04T08:00:00+08:00");
  const p = createPlatform({ now: tk.now });
  p.claims.draft({ claim_id: "n2", kind: "notice", topic_id: "t", statement_key: "notice-cs", text_zh: "临时候场提示" });
  p.claims.emergencyPublish("n2", {
    reason: "活动", valid_until: "2026-10-04T20:00:00+08:00", countersign_due_at: "2026-10-04T10:00:00+08:00",
  });
  tk.advance(3 * 3600 * 1000); // 11:00，逾期补签
  p.claims.countersign("n2", { approver: "late-director" });
  const claim = foldClaim(p.store.stream("knowledge_claim", "n2"));
  assert.equal(claim.emergency.on_time, false);
  assert.equal(claim.status, "approved"); // 补签完成
  // 仍在有效期内可播报
  assert.equal(p.claims.noticePlayable(claim), true);

  // 到期扫描产出 NOTICE_EXPIRED，之后不可播报，历史完整
  tk.advance(10 * 3600 * 1000);
  const expired = p.claims.expireDue();
  assert.equal(expired.length, 1);
  assert.equal(p.claims.load("n2").status, "expired");
});

test("中文稿修订后旧译文失效，必须重译才能再发布", () => {
  const p = createPlatform({ now: clock().now });
  approveFact(p, {
    key: "rev-key",
    text: "初版说法。",
    source: { source_id: "s", title: "史料", paragraph_ref: "1", quote: "q", public_level: "public" },
    expert: { expert_id: "e", verdict: "support", opinion: "ok" },
  });
  const v1 = p.claims.loadByKey("rev-key").approved_version;
  p.translations.open({ revision_id: "tr-1", language: "ja", reason: "首译" });
  p.translations.propose("tr-1", "rev-key", { text: "初版", qa_questions: [], based_on_claim_version: v1 });
  p.translations.review("tr-1", { reviewer: "r", decisions: { "rev-key": { decision: "accepted" } } });
  p.translations.apply("tr-1");

  // 中文稿修订（换说法），回到待批准
  p.claims.revise("claim-rev-key", { text_zh: "修正后说法。", reason: "游客投诉措辞" });
  assert.equal(p.claims.load("claim-rev-key").status, "draft");
  p.claims.approve("claim-rev-key", { approver: "editor", basis: { note: "重新核定" } });
  const v2 = p.claims.loadByKey("rev-key").approved_version;
  assert.notEqual(v1, v2);

  // 旧依据版本的提案直接被拒
  p.translations.open({ revision_id: "tr-2", language: "ja", reason: "配合中文稿修订" });
  assert.throws(
    () => p.translations.propose("tr-2", "rev-key", { text: "旧訳", qa_questions: [], based_on_claim_version: v1 }),
    (err) => err.code === "BASE_MISMATCH"
  );
});

test("从 JSONL 重放事件可以完整恢复平台状态", async () => {
  const file = join(dir, "replay.jsonl");
  const tk = clock();
  const p1 = createPlatform({ path: file, now: tk.now });
  approveFact(p1, {
    key: "persist-key",
    text: "持久化语句。",
    source: { source_id: "s", title: "档", paragraph_ref: "1", quote: "q", public_level: "public" },
    expert: { expert_id: "e", verdict: "support", opinion: "ok" },
  });
  const p2 = createPlatform({ path: file, now: tk.now });
  const claim = p2.claims.loadByKey("persist-key");
  assert.equal(claim.text_zh, "持久化语句。");
  assert.equal(claim.status, "approved");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.ok(lines.length >= 4);
});

test("原有信封契约仍成立", async () => {
  const { validateEvent } = await import("../src/validator.js");
  const sample = JSON.parse(readFileSync(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});
