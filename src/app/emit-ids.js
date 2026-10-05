/** 由命令标识派生稳定事件标识：命令重试沿用同一 command_id 即可幂等。 */
export function eventId(commandId, step = 1) {
  return `evt:cmd:${commandId}:${step}`;
}
