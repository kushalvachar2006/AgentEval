// A query is tenant-safe only if organizationId is matched by plain equality (not $ne/$in/$or tricks).
export function hasTenantFilter(filter) {
  if (!filter || typeof filter !== 'object') return false;
  const v = filter.organizationId;
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.length > 0;
  return typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).some((k) => k.startsWith('$'));
}

export function hasTenantMatchStage(pipeline) {
  const first = Array.isArray(pipeline) ? pipeline[0] : null;
  return Boolean(first?.$match && hasTenantFilter(first.$match));
}
