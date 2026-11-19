/**
 * Exact BigInt integer & basis-point arithmetic helpers for monetary calculations.
 * Zero IEEE-754 floating-point arithmetic is used during financial totals, discounts,
 * proportional allocations, or tax computations.
 */

export type DiscountMode = 'AMOUNT' | 'PERCENT';

/**
 * Parses a decimal string or number into scaled integer units without floating-point drift.
 * E.g. scale=2 converts "11.5" -> 1150n (basis points for percentages).
 */
export function parseDecimalToScaledInt(raw: unknown, scale = 2): bigint {
  if (typeof raw === 'bigint') {
    const mult = 10n ** BigInt(scale);
    return raw * mult;
  }
  const str = String(raw ?? '0').trim().replace(/,/g, '.');
  if (!str) return 0n;
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Nilai desimal tidak valid: "${str}"`);
  }
  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const paddedFrac = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const combined = BigInt(intPart + paddedFrac);
  return negative ? -combined : combined;
}

/**
 * Exact half-up division for non-negative numerator and positive denominator.
 */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('Penyebut pembagian harus lebih besar dari 0.');
  }
  if (numerator <= 0n) return 0n;
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Computes discount amount using exact BigInt arithmetic, clamped to [0, baseAmount].
 * For PERCENT mode, percentageValue is parsed to 2 decimal places (basis points, 100% = 10000 bps).
 */
export function calculateExactDiscount(
  baseAmount: bigint,
  mode: DiscountMode,
  value: unknown
): { amount: bigint; normalizedValue: number } {
  if (baseAmount <= 0n) {
    return { amount: 0n, normalizedValue: 0 };
  }
  if (mode === 'PERCENT') {
    const bps = parseDecimalToScaledInt(value, 2); // e.g., 10.5% -> 1050n
    if (bps < 0n || bps > 10000n) {
      throw new Error('Persentase diskon harus antara 0% hingga 100%.');
    }
    const raw = roundHalfUpDiv(baseAmount * bps, 10000n);
    const clamped = raw > baseAmount ? baseAmount : raw;
    return {
      amount: clamped,
      normalizedValue: Number(bps) / 100,
    };
  }

  const fixed = roundHalfUpDiv(parseDecimalToScaledInt(value, 0), 1n);
  if (fixed < 0n) {
    throw new Error('Nominal diskon tidak boleh negatif.');
  }
  const clamped = fixed > baseAmount ? baseAmount : fixed;
  return {
    amount: clamped,
    normalizedValue: Number(clamped),
  };
}

/**
 * Proportionally allocates `totalToAllocate` across `weights` using exact BigInt math
 * and largest-remainder distribution so the sum of parts equals `totalToAllocate` exactly.
 */
export function allocateProportionally(totalToAllocate: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  if (totalToAllocate <= 0n) return weights.map(() => 0n);
  const weightSum = weights.reduce((acc, w) => acc + (w > 0n ? w : 0n), 0n);
  if (weightSum <= 0n) return weights.map(() => 0n);

  const floors: bigint[] = [];
  const remainders: Array<{ index: number; rem: bigint }> = [];
  let allocated = 0n;

  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] > 0n ? weights[i] : 0n;
    const product = totalToAllocate * w;
    const floorVal = product / weightSum;
    const rem = product % weightSum;
    floors.push(floorVal);
    remainders.push({ index: i, rem });
    allocated += floorVal;
  }

  let leftover = totalToAllocate - allocated;
  remainders.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.index - b.index));
  for (let i = 0; i < remainders.length && leftover > 0n; i++) {
    floors[remainders[i].index] += 1n;
    leftover -= 1n;
  }

  return floors;
}
