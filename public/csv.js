// Textfält skyddas mot Excel-formler; tal behåller sin numeriska typ.
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v !== 'number' && /^[\s\u0000-\u001f]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
