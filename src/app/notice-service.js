import { append } from "./emit.js";
import { Repository } from "../store/repository.js";
import { noticePlayableAt } from "../domain/content-package.js";

/**
 * 紧急运营通知服务：独立于常规审校路径。
 *
 * 规则（对应“紧急通知可以先发布，但必须留下限时补签和完整历史”）：
 * - NOTICE_ISSUED 即生效播报，事件本身完整记录发布人、正文多语、有效期与补签截止；
 * - 必须在 countersign_deadline 前由有权人 NOTICE_COUNTERSIGNED 补签；
 * - 到期或逾时未补签，写入 NOTICE_EXPIRED；设备重连判定在补签缺失时也会自行停播；
 * - 任何状态变化都是不可删除的事件，history 给出完整轨迹。
 */
export class NoticeService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.repo = new Repository(store);
    this.clock = clock;
  }

  issue(cmd) {
    assert(cmd.notice_id, "缺少 notice_id");
    assert(Array.isArray(cmd.body) && cmd.body.length > 0, "紧急通知必须含多语正文");
    for (const b of cmd.body) assert(b.lang && b.text, "通知正文必须含 lang 与 text");
    assert(cmd.valid_until, "紧急通知必须设有效期 valid_until");
    assert(cmd.countersign_deadline, "紧急通知必须设补签截止时间");
    assert(Date.parse(cmd.countersign_deadline) > Date.parse(cmd.issued_at ?? this.clock()), "补签截止必须晚于发布时间");
    assert(Date.parse(cmd.valid_until) > Date.parse(cmd.countersign_deadline), "通知有效期必须覆盖补签窗口");
    append(this.store, "content_package", cmd.notice_id, [
      {
        command_id: cmd.command_id,
        event_type: "NOTICE_ISSUED",
        occurred_at: cmd.issued_at ?? this.clock(),
        summary: `先发布紧急通知：${cmd.title}（限时 ${cmd.countersign_deadline} 前补签）`,
        title: cmd.title,
        body: cmd.body,
        issued_by: cmd.issued_by,
        valid_until: cmd.valid_until,
        countersign_deadline: cmd.countersign_deadline,
      },
    ]);
    return this.repo.notice(cmd.notice_id);
  }

  countersign(cmd) {
    const notice = this.repo.notice(cmd.notice_id);
    assert(notice, `紧急通知不存在：${cmd.notice_id}`);
    const now = cmd.at ?? this.clock();
    assert(notice.status === "issued", `通知状态为 ${notice.status}，不能补签`);
    assert(Date.parse(now) <= Date.parse(notice.countersign_deadline), "已超过补签截止时间，补签被拒绝（通知应停播并走正式发布）");
    append(this.store, "content_package", cmd.notice_id, [
      {
        command_id: cmd.command_id,
        event_type: "NOTICE_COUNTERSIGNED",
        occurred_at: now,
        summary: `紧急通知限时补签完成：${cmd.countersigned_by}`,
        countersigned_by: cmd.countersigned_by,
        note: cmd.note ?? "",
      },
    ]);
    return this.repo.notice(cmd.notice_id);
  }

  /** 到期作业：对过期或逾时未补签的通知写 NOTICE_EXPIRED；返回本次处理的 id。 */
  expireDue(atIso = this.clock()) {
    const expired = [];
    for (const notice of this.repo.allNotices()) {
      if (notice.status === "expired") continue;
      const at = Date.parse(atIso);
      const overdue =
        Date.parse(notice.valid_until) <= at ||
        (notice.status === "issued" && Date.parse(notice.countersign_deadline) <= at);
      if (!overdue) continue;
      append(this.store, "content_package", notice.notice_id, [
        {
          command_id: `expiry:${notice.notice_id}:${atIso}`,
          event_type: "NOTICE_EXPIRED",
          occurred_at: atIso,
          summary:
            notice.status === "issued"
              ? "紧急通知逾时未补签，到期失效"
              : "紧急通知到达有效期，失效",
          reason: notice.status === "issued" ? "逾时未补签" : "到达有效期",
        },
      ]);
      expired.push(notice.notice_id);
    }
    return expired;
  }

  playable(noticeId, atIso = this.clock()) {
    return noticePlayableAt(this.repo.notice(noticeId), atIso);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
