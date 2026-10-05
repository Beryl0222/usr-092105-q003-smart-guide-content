/** 稳定内容指纹：FNV-1a 32 位，十六进制。无外部依赖，设备侧可用同样算法复核。 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 内容条目指纹：引用键 + 语言 + 实际播报文本。 */
export function contentFingerprint(ref, lang, text) {
  return { ref, lang, hash: fnv1a(`${ref}|${lang}|${text}`) };
}

/** 用指纹反查文本是否与设备回执一致。 */
export function fingerprintMatches(fp, ref, lang, text) {
  return fp.ref === ref && fp.lang === lang && fp.hash === fnv1a(`${ref}|${lang}|${text}`);
}
