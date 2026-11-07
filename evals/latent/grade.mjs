// Deterministic grader for latent slices on the synthetic codebase Q&A set.
// A slice is correct when its answer and finding labels contain every required
// group, and cited when at least one evidence span overlaps an acceptable span.

const text = slice => [slice.answer, ...(slice.findings ?? []).map(finding => finding.label)].join('\n').toLowerCase();

export function gradeSlice(question, slice) {
  const haystack = text(slice);
  const correct = question.required.every(group => group.some(option => haystack.includes(option.toLowerCase())));
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
