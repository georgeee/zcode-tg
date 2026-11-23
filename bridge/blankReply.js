// Whitespace and zero-width characters only: nothing a reader would see.
// String.prototype.trim keeps U+200B, which agy (1.5.7, measured live) sends
// as the whole response when the model writes nothing after its last tool
// call, so trim() alone cannot answer this.
export function isBlankReply(text) {
  return !String(text ?? '').replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '');
}
