const finite = value => typeof value === 'number' && Number.isFinite(value);

// Display-only history. A value enters this path only after its source normalizer
// has accepted it; raw diagnostics and upstream-supplied lastValid are not trusted.
export function lastValidSample(metric, elapsedS = 0) {
  if (!metric || metric.valid !== true || !(finite(metric.value) || typeof metric.value === 'boolean')
      || !finite(metric.ageS) || metric.ageS < 0 || !finite(metric.maxAgeS) || metric.maxAgeS <= 0
      || metric.ageS > metric.maxAgeS || typeof metric.unit !== 'string'
      || typeof metric.source !== 'string' || !metric.source.trim() || !finite(elapsedS) || elapsedS < 0) return null;
  return { value: metric.value, unit: metric.unit, source: metric.source,
    ageS: metric.ageS + elapsedS, maxAgeS: metric.maxAgeS,
    ageBasis: metric.ageBasis || 'bridge_receive_monotonic' };
}

export class LastValidCache {
  constructor({ now = () => performance.now(), maxEntries = 2048, retentionS = 300 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.retentionS = retentionS;
    this.entries = new Map();
  }

  // Identity includes device, selected upstream, and its SYS/COMP/peer when known.
  metric(identity, path, current, { capture = true, property = 'lastValid', unit = current.unit, at = this.now() } = {}) {
    const now = at, candidate = capture ? current[property] : null;
    const source = candidate?.source || current.source || '';
    const key = JSON.stringify([identity, path, source, unit ?? candidate?.unit ?? '']);
    if (candidate && (finite(candidate.value) || typeof candidate.value === 'boolean')
        && finite(candidate.ageS) && candidate.ageS >= 0 && candidate.ageS <= this.retentionS) {
      const sampledAt = now - candidate.ageS * 1000;
      const previous = this.entries.get(key);
      if (!previous || sampledAt > previous.sampledAt) {
        this.entries.delete(key);
        this.entries.set(key, { sample: { ...candidate }, sampledAt });
      }
    }
    for (const [entryKey, entry] of this.entries) {
      if ((now - entry.sampledAt) / 1000 > this.retentionS) this.entries.delete(entryKey);
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    const stored = this.entries.get(key);
    current[property] = stored ? { ...stored.sample, ageS: Math.max(0, (now - stored.sampledAt) / 1000) } : null;
    return current;
  }

  metrics(identity, group, metrics, options) {
    for (const [key, metric] of Object.entries(metrics || {})) this.metric(identity, `${group}.${key}`, metric, options);
  }
}
