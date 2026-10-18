// HTML の断片を文字列で組み立てるときの共通エスケープ（属性値の中でも安全なよう、引用符も変換する）
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
