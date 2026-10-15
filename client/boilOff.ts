// At 100 °C, saturated liquid water is 0.95835 kg/L and its latent heat is
// 2256.4 kJ/kg (NISTIR 5078, Table 1). This is about 600.7 W per L/h.
// https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir5078.pdf
export const wattsPerLiterPerHour = 600.7;

export function heatLossFromBoil(powerWatts: number, startLiters: number, endLiters: number,
  durationMinutes: number): number {
  if (!Number.isFinite(powerWatts) || powerWatts <= 0 || !Number.isFinite(startLiters)
    || !Number.isFinite(endLiters) || startLiters <= endLiters || endLiters < 0
    || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error('Enter positive power and duration, with an end volume below the start volume');
  }
  const evaporatedLitersPerHour = (startLiters - endLiters) * 60 / durationMinutes;
  const heatLoss = powerWatts - evaporatedLitersPerHour * wattsPerLiterPerHour;
  if (heatLoss < 0) throw new Error('Measured evaporation exceeds the power used; check the volumes, duration, and wattage');
  return heatLoss;
}

export function predictedBoilOff(powerWatts: number, heatLossWatts: number): number {
  return Math.max(0, powerWatts - heatLossWatts) / wattsPerLiterPerHour;
}
