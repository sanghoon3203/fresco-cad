const HASH = /^[a-f0-9]{64}$/u;
const STATUSES = new Set(['reviewing', 'excluded', 'recheck']);

function fail() {
  throw Object.assign(new Error('Invalid review export input'), { code: 'E_REVIEW_EXPORT' });
}

function cell(value) {
  let text = String(value ?? '');
  // Quoting alone does not stop spreadsheet formulas. Keep untrusted text literal.
  if (typeof value !== 'number' && (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** CSV for a single checked capture/rules context; no filesystem or browser dependency. */
export function reviewCsv(issues, reviews, contextKey) {
  if (typeof contextKey !== 'string' || !HASH.test(contextKey)
    || !Array.isArray(issues) || issues.length > 200_000
    || !Array.isArray(reviews) || reviews.length > 500) fail();
  const byId = new Map();
  for (const review of reviews) {
    if (!review || review.contextKey !== contextKey || typeof review.issueId !== 'string'
      || byId.has(review.issueId) || !STATUSES.has(review.status)
      || typeof review.note !== 'string' || review.note.length > 2000
      || typeof review.updatedAt !== 'string') fail();
    byId.set(review.issueId, review);
  }
  const rows = [['context_key', 'issue_id', 'rule', 'severity', 'x_mm', 'y_mm', 'entity_ids', 'review_status', 'note', 'reviewed_at']];
  const seen = new Set();
  for (const issue of issues) {
    if (!issue || typeof issue.id !== 'string' || issue.id.length > 1024 || seen.has(issue.id)
      || typeof issue.ruleId !== 'string' || typeof issue.severity !== 'string'
      || !Array.isArray(issue.location) || issue.location.length !== 2 || !issue.location.every(Number.isFinite)
      || !Array.isArray(issue.entityIds) || !issue.entityIds.every(id => typeof id === 'string')) fail();
    seen.add(issue.id);
    const review = byId.get(issue.id);
    rows.push([contextKey, issue.id, issue.ruleId, issue.severity, ...issue.location,
      issue.entityIds.join(' | '), review?.status ?? 'unreviewed', review?.note ?? '', review?.updatedAt ?? '']);
  }
  // UTF-8 BOM assists Japanese text when a saved CSV is opened by spreadsheet apps.
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
