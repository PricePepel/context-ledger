// Deterministic grader for latent slices on the synthetic codebase Q&A set.
// A slice is correct when its answer and finding labels contain every required
// group and no forbidden option, and cited when at least one evidence span
// overlaps an acceptable span. An option is a string (see contains) or
// { "pattern": "..." }, a case-insensitive regular expression over the same text.

const text = slice => [slice.answer, ...(slice.findings ?? []).map(finding => finding.label)].join('\n').toLowerCase();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// An option that starts with a digit must match as a whole number ("3" must not
// pass on "30 minutes"); word options match as substrings ("doubl" covers
// "doubles" and "doubling").
function contains(haystack, option) {
  if (typeof option === 'object' && option !== null) return new RegExp(option.pattern, 'iu').test(haystack);
  const needle = option.toLowerCase();
  if (!/^\d/u.test(needle)) return haystack.includes(needle);
  // No digit (or decimal point) glued on either side; units such as "250ms" are fine.
  return new RegExp(`(?<![\\d.])${escape(needle)}(?!\\d|\\.\\d)`, 'u').test(haystack);
}

export function gradeSlice(question, slice) {
  const haystack = text(slice);
  const correct = question.required.every(group => group.some(option => contains(haystack, option)))
    && !(question.forbidden ?? []).some(option => contains(haystack, option));
  const spans = (slice.findings ?? []).flatMap(finding => finding.evidence ?? []);
  const cited = spans.some(span => question.evidence.some(({ path, lines: [start, end] }) =>
    span.path === path && span.startLine <= end && span.endLine >= start));
  return { id: question.id, correct, cited };
}

export function summarize(results) {
  const total = results.length;
  const share = key => (total ? results.filter(result => result[key]).length / total : 0);
  return { total, accuracy: share('correct'), citationRate: share('cited') };
}
