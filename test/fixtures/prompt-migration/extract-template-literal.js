// Split a JS template-literal body into [text, expr, text, expr, ...] using BRACE MATCHING.
// Pattern-based extraction cannot survive `${JSON.stringify({ a: 1 })}` — the first `}` is not
// the end of the expression. This walks the braces, so multi-line object literals are handled.
function splitTemplateLiteral(lit) {
  const parts = []; let text = ''; let i = 0;
  while (i < lit.length) {
    if (lit[i] === '$' && lit[i + 1] === '{') {
      let depth = 1, j = i + 2;
      while (j < lit.length && depth > 0) {
        if (lit[j] === '{') depth++;
        else if (lit[j] === '}') depth--;
        if (depth > 0) j++;
      }
      parts.push({ text }); text = '';
      parts.push({ expr: lit.slice(i + 2, j) });
      i = j + 1;
      continue;
    }
    text += lit[i]; i++;
  }
  parts.push({ text });
  return parts;
}
module.exports = { splitTemplateLiteral };
