import { EventStore } from "./event-store.js";
import { reduceKnowledgeClaim } from "../domain/knowledge-claim.js";
import { reduceTranslationRevision } from "../domain/translation-revision.js";
import { reduceContentPackage } from "../domain/content-package.js";
import { reduceDeviceReceipt } from "../domain/device-receipt.js";

/** 从事件存储装载归约态；所有读取都走事件，不另存可变状态。 */
export class Repository {
  constructor(store) {
    this.store = store;
  }

  claim(id) {
    return reduceKnowledgeClaim(this.store.loadStream("knowledge_claim", id));
  }
  revision(id) {
    return reduceTranslationRevision(this.store.loadStream("translation_revision", id));
  }
  /** 内容包与紧急通知共用 content_package 流，归约器按首事件区分。 */
  packageOrNotice(id) {
    return reduceContentPackage(this.store.loadStream("content_package", id));
  }
  package(id) {
    const s = this.packageOrNotice(id);
    return s?.object_kind === "package" ? s : null;
  }
  notice(id) {
    const s = this.packageOrNotice(id);
    return s?.object_kind === "notice" ? s : null;
  }
  device(id) {
    return reduceDeviceReceipt(this.store.loadStream("device_receipt", id));
  }

  /** 列出某聚合类型下的全部对象 id（取流 id 段）。 */
  #ids(aggregateType) {
    const prefix = `${aggregateType}:`;
    const ids = [];
    for (const key of this.#streamKeys()) if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
    return ids;
  }

  #streamKeys() {
    // loadAll 会排序；这里直接借它枚举流，规模大时可让 EventStore 暴露键集合
    const keys = new Set();
    for (const e of this.store.loadAll()) keys.add(EventStore.streamKey(e.aggregate_type, e.aggregate_id));
    return keys;
  }

  allDevices() {
    return this.#ids("device_receipt").map((id) => this.device(id));
  }
  allPackages() {
    return this.#ids("content_package")
      .map((id) => this.packageOrNotice(id))
      .filter((s) => s?.object_kind === "package");
  }
  allNotices() {
    return this.#ids("content_package")
      .map((id) => this.packageOrNotice(id))
      .filter((s) => s?.object_kind === "notice");
  }
  allClaims() {
    return this.#ids("knowledge_claim")
      .map((id) => this.claim(id))
      .filter((s) => s?.object_kind === "claim");
  }
  allRevisions() {
    return this.#ids("translation_revision").map((id) => this.revision(id));
  }
}
