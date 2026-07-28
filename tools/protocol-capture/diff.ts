export type FieldDiff = { path: string; before?: unknown; after?: unknown };

export function diffHeaders(
  before: Record<string, string | string[]>,
  after: Record<string, string | string[]>,
): { added: FieldDiff[]; removed: FieldDiff[]; changed: FieldDiff[] } {
  const left = new Map(Object.entries(before).map(([key, value]) => [key.toLowerCase(), value]));
  const right = new Map(Object.entries(after).map(([key, value]) => [key.toLowerCase(), value]));
  const added: FieldDiff[] = [];
  const removed: FieldDiff[] = [];
  const changed: FieldDiff[] = [];
  for (const [key, value] of left) {
    if (!right.has(key)) removed.push({ path: key, before: value });
    else if (JSON.stringify(value) !== JSON.stringify(right.get(key))) {
      changed.push({ path: key, before: value, after: right.get(key) });
    }
  }
  for (const [key, value] of right) if (!left.has(key)) added.push({ path: key, after: value });
  return { added, removed, changed };
}

export function diffBodies(before: unknown, after: unknown, path = "$"): FieldDiff[] {
  if (Object.is(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const result: FieldDiff[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= before.length) result.push({ path: `${path}[${index}]`, after: after[index] });
      else if (index >= after.length) result.push({ path: `${path}[${index}]`, before: before[index] });
      else result.push(...diffBodies(before[index], after[index], `${path}[${index}]`));
    }
    return result;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const result: FieldDiff[] = [];
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in left)) result.push({ path: `${path}.${key}`, after: right[key] });
      else if (!(key in right)) result.push({ path: `${path}.${key}`, before: left[key] });
      else result.push(...diffBodies(left[key], right[key], `${path}.${key}`));
    }
    return result;
  }
  return [{ path, before, after }];
}
