import assert from "node:assert/strict";
import test from "node:test";

import { EventStore, EventContractError, ConcurrencyError } from "../src/store/event-store.js";
import { validateEvent } from "../src/validator.js";

const base = (over = {}) => ({
  event_id: "evt-test-0001",
  event_type: "CLAIM_RECORDED",
  aggregate_type: "knowledge_claim",
  aggregate_id: "c-1",
  occurred_at: "2026-10-04T20:00:00+08:00",
  version: 1,
  summary: "测试事件",
  ...over,
});

test("同一 event_id 重试为幂等 duplicate，不新增版本", () => {
  const store = new EventStore();
  const r1 = store.append(base());
  const r2 = store.append(base({ occurred_at: "2026-10-04T20:00:00+08:00" }));
  assert.equal(r1.status, "appended");
  assert.equal(r2.status, "duplicate");
  assert.equal(store.loadStream("knowledge_claim", "c-1").length, 1);
  assert.equal(store.streamVersion("knowledge_claim", "c-1"), 1);
});

test("同一 event_id 载荷不同拒绝覆盖历史", () => {
  const store = new EventStore();
  store.append(base());
  assert.throws(() => store.append(base({ summary: "被篡改的摘要" })), /幂等冲突/);
});

test("版本必须按流连续递增", () => {
  const store = new EventStore();
  assert.throws(() => store.append(base({ version: 3 })), ConcurrencyError);
  store.append(base());
  assert.throws(
    () => store.append(base({ event_id: "evt-test-0002", version: 3 })),
    ConcurrencyError
  );
});

test("不同聚合流各自从 1 开始", () => {
  const store = new EventStore();
  store.append(base());
  store.append(
    base({
      event_id: "evt-test-0002",
      event_type: "DEVICE_REGISTERED",
      aggregate_type: "device_receipt",
      aggregate_id: "d-1",
      summary: "注册设备",
      version: 1,
    })
  );
  assert.equal(store.streamVersion("device_receipt", "d-1"), 1);
});

test("契约校验：事件类型与聚合必须匹配", () => {
  const errors = validateEvent(base({ event_type: "DEVICE_ACKNOWLEDGED", aggregate_type: "content_package" }));
  assert.ok(errors.some((e) => e.includes("不属于聚合")));
  assert.deepEqual(validateEvent(base()), []);
});

test("契约校验：缺字段、坏版本、坏时间给中文错误", () => {
  const errors = validateEvent({ event_id: "x", version: 0, occurred_at: "not-a-date" });
  assert.ok(errors.some((e) => e.includes("缺少字段：event_type")));
  assert.ok(errors.some((e) => e.includes("version 必须是正整数")));
  assert.ok(errors.some((e) => e.includes("occurred_at")));
  assert.throws(() => new EventStore().append({}), EventContractError);
});
