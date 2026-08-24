/**
 * src/core/group-delay.ts
 *
 * Retardo de grupo ANALÍTICO exacto (invariante I6) — ec. 4.5 de THEORY_SPECS.md.
 * Derivado de la geometría polo/cero sobre el círculo unidad, NUNCA por
 * diferenciación numérica finita (ec. 4.10 queda explícitamente prohibida).
 *
 *   τ_g(ω) = Σ_polos (r·cos(ω−φ) − r²)/(1 − 2r·cos(ω−φ) + r²)
 *          − Σ_ceros (ρ·cos(ω−φ) − ρ²)/(1 − 2ρ·cos(ω−φ) + ρ²)
 *
 * La API `fillGroupDelay` escribe en un búfer preasignado (zero-allocation).
 */
import type { Complex } from './types';

/**
 * ec. 4.4 — derivada dψ/dω del argumento del factor (1 − d·e^{-jω}).
 * El denominador |1 − d·e^{-jω}|² es estrictamente positivo para r < 1.
 *
 * Zero-allocation: r y phi se calculan inline (sin objetos temporales por
 * muestra) para mantener el hot path `fillGroupDelay` libre de GC.
 */
export function rootGroupDelay(omega: number, root: Complex): number {
    const r = Math.hypot(root.re, root.im);
    const phi = Math.atan2(root.im, root.re);
    const d = Math.cos(omega - phi);
    const den = 1 - 2 * r * d + r * r;
    return (r * d - r * r) / den;
}

/**
 * ec. 4.5 — retardo de grupo de la función de transferencia completa:
 * polos contribuyen positivo, ceros negativo. Coste O(N + M).
 */
export function groupDelayAt(
    omega: number,
    poles: readonly Complex[],
    zeros: readonly Complex[],
): number {
    let g = 0;
    for (const p of poles) g += rootGroupDelay(omega, p);
    for (const z of zeros) g -= rootGroupDelay(omega, z);
    return g;
}

/** Escritura vectorizada en búfer preasignado (zero-allocation): out[n] = τ_g(ω_n). */
export function fillGroupDelay(
    poles: readonly Complex[],
    zeros: readonly Complex[],
    omega: Float64Array,
    out: Float64Array,
): void {
    const L = Math.min(omega.length, out.length);
    for (let n = 0; n < L; n++) out[n] = groupDelayAt(omega[n], poles, zeros);
}

/**
 * ec. 4.3 — argumento continuo ψ_d(ω) del factor (1 − d·e^{-jω}).
 * Como Re = 1 − r·cos(ω−φ) ≥ 1 − r > 0, la fase es continua (sin cortes de rama).
 */
export function factorPhase(omega: number, root: Complex): number {
    const r = Math.hypot(root.re, root.im);
    const phi = Math.atan2(root.im, root.re);
    return Math.atan2(r * Math.sin(omega - phi), 1 - r * Math.cos(omega - phi));
}

/** ec. 4.2 — fase desenvuelta (continua) a partir de polos/ceros. */
export function exactUnwrappedPhase(
    omega: number,
    poles: readonly Complex[],
    zeros: readonly Complex[],
): number {
    let ph = 0;
    for (const z of zeros) ph += factorPhase(omega, z);
    for (const p of poles) ph -= factorPhase(omega, p);
    return ph;
}
