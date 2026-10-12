export interface BoilObservation {
  id: string;
  observed_at: number;
  power_watts: number;
  ambient_c: number | null;
  liquid_c: number | null;
  start_liters: number;
  end_liters: number;
  duration_seconds: number;
}

export function boilOffRate(observation: BoilObservation): number {
  return (observation.start_liters - observation.end_liters) * 3600 / observation.duration_seconds;
}

export function boilOffByPower(observations: BoilObservation[]): { watts: number; litersPerHour: number }[] {
  const groups = new Map<number, { lost: number; seconds: number }>();
  for (const observation of observations) {
    if (observation.power_watts <= 0 || observation.duration_seconds <= 0 || observation.start_liters <= observation.end_liters) continue;
    const group = groups.get(observation.power_watts) || { lost: 0, seconds: 0 };
    group.lost += observation.start_liters - observation.end_liters;
    group.seconds += observation.duration_seconds;
    groups.set(observation.power_watts, group);
  }
  return [...groups].map(([watts, group]) => ({ watts, litersPerHour: group.lost * 3600 / group.seconds }))
    .sort((a, b) => a.watts - b.watts);
}

export function estimatedBoilOffAtPower(observations: BoilObservation[], watts: number): number | null {
  const points = boilOffByPower(observations);
  const exact = points.find(point => point.watts === watts);
  if (exact) return exact.litersPerHour;
  const upperIndex = points.findIndex(point => point.watts > watts);
  if (upperIndex < 1) return null;
  const lower = points[upperIndex - 1];
  const upper = points[upperIndex];
  return lower.litersPerHour + (upper.litersPerHour - lower.litersPerHour) * (watts - lower.watts) / (upper.watts - lower.watts);
}
