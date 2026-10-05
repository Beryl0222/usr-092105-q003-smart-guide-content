import assert from "node:assert/strict";
import test from "node:test";

import {
  EventStore,
  ReviewService,
  PublishService,
  AnswerService,
  CERTAINTY,
} from "../src/index.js";

function world() {
  const store = new EventStore();
  return { store, review: new ReviewService(store), publish: new PublishService(store), answer: new AnswerService(store) };
}

const claimWithSources = (w) => {
  w.review.recordClaim({
    command_id: "c1",
    claim_id: "cl-1",
    kind: "fact",
    certainty: CERTAINTY.ESTABLISHED,
    statement_zh: "展厅局部开放",
    sources: [
      { source_id: "s1", access: "public", citation: "馆方公告", excerpt: "展厅局部开放" },
      { source_id: "s2", access: "restricted", citation: "内部发掘笔记", excerpt: "未公开段落密文九九九九" },
    ],
    occurred_at: "2026-09-20T09:00:00+08:00",
  });
};

test("解释性主张无专家意见不得批准", () => {
  const w = world();
  w.review.recordClaim({
    command_id: "c1",
    claim_id: "cl-i",
    kind: "interpretation",
    certainty: CERTAINTY.SCHOLARLY_SPECULATION,
    statement_zh: "可能与祭祀有关",
    sources: [{ source_id: "s1", access: "public", citation: "期刊", excerpt: "推测" }],
    occurred_at: "2026-09-20T09:00:00+08:00",
  });
  assert.throws(
    () =>
      w.review.approveClaim({
        command_id: "a1",
        claim_id: "cl-i",
        reviewer_id: "u",
        approved_statement_zh: "可能与祭祀有关",
        source_ids: ["s1"],
        occurred_at: "2026-09-20T10:00:00+08:00",
      }),
    /专家意见/
  );
});

test("事实主张不能登记成推测等级", () => {
  const w = world();
  assert.throws(
    () =>
      w.review.recordClaim({
        command_id: "c1",
        claim_id: "cl-bad",
        kind: "fact",
        certainty: CERTAINTY.SCHOLARLY_SPECULATION,
        statement_zh: "x",
        sources: [{ source_id: "s", access: "public", citation: "c", excerpt: "x" }],
        occurred_at: "2026-09-20T09:00:00+08:00",
      }),
    /事实主张/
  );
});

test("未审定/被修订搁置的主张版本不能入包", () => {
  const w = world();
  claimWithSources(w);
  const out = w.publish.compile({
    package_id: "p",
    entries: [{ claim_id: "cl-1", claim_version: 1, languages: ["zh"] }],
  });
  assert.equal(out.ok, false);
  assert.ok(out.problems.join("").includes("未审定"));

  w.review.approveClaim({
    command_id: "a1",
    claim_id: "cl-1",
    reviewer_id: "u",
    approved_statement_zh: "展厅局部开放",
    source_ids: ["s1"],
    occurred_at: "2026-09-20T10:00:00+08:00",
  });
  // 修订后回到待审：旧批准版本不可再引用
  w.review.reviseClaim({
    command_id: "r1",
    claim_id: "cl-1",
    revised_statement_zh: "三层展厅局部开放",
    occurred_at: "2026-09-21T10:00:00+08:00",
  });
  const out2 = w.publish.compile({
    package_id: "p2",
    entries: [{ claim_id: "cl-1", claim_version: 2, languages: ["zh"] }],
  });
  assert.equal(out2.ok, false);
  assert.ok(out2.problems.join("").includes("已被修订"));
});

test("密级外泄：审定措辞若包含 restricted 段落原文，发布被拦截", () => {
  const w = world();
  claimWithSources(w);
  w.review.approveClaim({
    command_id: "a1",
    claim_id: "cl-1",
    reviewer_id: "u",
    approved_statement_zh: "展厅局部开放，未公开段落密文九九九九",
    source_ids: ["s1", "s2"],
    occurred_at: "2026-09-20T10:00:00+08:00",
  });
  const out = w.publish.compile({
    package_id: "p",
    entries: [{ claim_id: "cl-1", claim_version: 2, languages: ["zh"] }],
  });
  assert.equal(out.ok, false);
  assert.ok(out.problems.join("").includes("密级外泄"));
});

test("restricted 来源不能作为游客侧出处（只批公开来源则可发布）", () => {
  const w = world();
  claimWithSources(w);
  w.review.approveClaim({
    command_id: "a1",
    claim_id: "cl-1",
    reviewer_id: "u",
    approved_statement_zh: "展厅局部开放",
    source_ids: ["s1"],
    occurred_at: "2026-09-20T10:00:00+08:00",
  });
  const out = w.publish.compile({
    package_id: "p",
    valid_from: "2026-09-25T10:00:00+08:00",
    entries: [{ claim_id: "cl-1", claim_version: 2, languages: ["zh"] }],
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.visitor_provenance.records[0].sources.map((s) => s.source_id), ["s1"]);
});

test("未批准的翻译修订不能入包；缺少该语种译文的条目被拒", () => {
  const w = world();
  claimWithSources(w);
  w.review.approveClaim({
    command_id: "a1",
    claim_id: "cl-1",
    reviewer_id: "u",
    approved_statement_zh: "展厅局部开放",
    source_ids: ["s1"],
    occurred_at: "2026-09-20T10:00:00+08:00",
  });
  w.review.proposeTranslationRevision({
    command_id: "t1",
    revision_id: "tr-1",
    target_language: "ja",
    proposed_by: "tr",
    affected_statements: [
      { ref_id: "cl-1", old_text: null, new_text: "一部公開" },
    ],
    occurred_at: "2026-09-21T09:00:00+08:00",
  });
  // 仅提出未批准
  const out = w.publish.compile({
    package_id: "p",
    entries: [{ claim_id: "cl-1", claim_version: 2, languages: ["zh", "ja"] }],
    translation_refs: [{ revision_id: "tr-1" }],
  });
  assert.ok(out.problems.join("").includes("未批准"));
});

test("发布包过有效期后，机器答复必须拒绝", () => {
  const w = world();
  claimWithSources(w);
  w.review.approveClaim({
    command_id: "a1",
    claim_id: "cl-1",
    reviewer_id: "u",
    approved_statement_zh: "展厅局部开放",
    source_ids: ["s1"],
    occurred_at: "2026-09-20T10:00:00+08:00",
  });
  const spec = {
    package_id: "p",
    valid_from: "2026-09-25T10:00:00+08:00",
    valid_until: "2026-10-10T22:00:00+08:00",
    entries: [{ claim_id: "cl-1", claim_version: 2, languages: ["zh"] }],
  };
  const c = w.publish.compile(spec);
  w.publish.draft(spec, { command_id: "d1", drafted_by: "ops", occurred_at: spec.valid_from });
  w.publish.publish({
    command_id: "pub1",
    package_id: "p",
    published_by: "ops",
    impact_confirmation_checksum: c.impact_preview.checksum,
    occurred_at: spec.valid_from,
  });
  const expired = w.answer.compose({ package_id: "p", lang: "zh", claim_id: "cl-1" }, "2026-10-11T00:00:00+08:00");
  assert.equal(expired.status, "unable_to_answer");
  assert.match(expired.reason, /有效期/);
});
