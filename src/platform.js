import { EventStore } from "./event-store.js";
import { createClaimService } from "./claims.js";
import { createTranslationService } from "./translations.js";
import { createPackageService } from "./packages.js";
import { createDeviceService } from "./devices.js";
import { createAnswerService } from "./answers.js";

let seq = 0;
const defaultGenId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** 装配全部领域服务；传入 path 可把事件落 JSONL，时钟可注入以便测试有效期。 */
export function createPlatform({ path, now = () => new Date().toISOString(), genId = defaultGenId } = {}) {
  const store = new EventStore({ path });
  const claims = createClaimService(store, { now, genId });
  const translations = createTranslationService(store, { now, genId, claims });
  const packages = createPackageService(store, { now, genId, claims });
  const devices = createDeviceService(store, { now, genId, claims });
  const answers = createAnswerService(store, { now, claims });

  return { store, claims, translations, packages, devices, answers };
}
