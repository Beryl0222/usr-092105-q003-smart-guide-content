/** 领域规则被违反时抛出，message 为可直接展示的中文说明。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** 发布门禁未通过（影响预览、出处、回执、外泄检查等）。 */
export class ReleaseGateError extends DomainError {
  constructor(failures) {
    super("RELEASE_GATE_FAILED", `发布门禁未通过：${failures.join("；")}`);
    this.name = "ReleaseGateError";
    this.failures = failures;
  }
}
