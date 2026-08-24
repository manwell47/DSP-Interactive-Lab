/**
 * src/core/phase-unwrap.ts
 *
 * Desenvolvimiento de fase (invariante I7) — Sección 5 de THEORY_SPECS.md.
 *
 *  - Algoritmo 5.1 (ec. 5.3–5.5): desenvolvimiento incremental de la fase envuelta.
 *  - ec. 5.9: alternativa robusta por integración trapezoidal del retardo de
 *    grupo analítico (inmune a la ambigüedad de 2π).
 *
 * Ambas rutinas escriben en búferes preasignados (zero-allocation).
 */

const TWO_PI = 2 * Math.PI;

/**
 * Algoritmo 5.1 — ec. 5.3–5.5.
 *   θ_u[0] = φ_0;
 *   θ_u[n] = θ_u[n−1] + (φ_n − φ_{n−1}) − 2π·round((φ_n − φ_{n−1})/(2π)).
 * Válido si Δω ≤ π/max|τ_g| (ec. 5.7).
 */
export function unwrapPhase(wrapped: Float64Array, out: Float64Array): void {
    const L = Math.min(wrapped.length, out.length);
    if (L === 0) return;
    out[0] = wrapped[0];
    for (let n = 1; n < L; n++) {
        const delta = wrapped[n] - wrapped[n - 1];
        const q = Math.round(delta / TWO_PI);
        out[n] = out[n - 1] + delta - TWO_PI * q;
    }
}

/**
 * ec. 5.9 — integración trapezoidal de −τ_g:
 *   θ_u[n] = θ_u[n−1] − (Δω/2)·(τ_g(ω_{n−1}) + τ_g(ω_n)),
 * con θ_u[0] = initialPhase. Consistente por construcción con el panel de τ_g.
 */
export function phaseFromGroupDelay(
    groupDelay: Float64Array,
    omega: Float64Array,
    out: Float64Array,
    initialPhase = 0,
): void {
    const L = Math.min(groupDelay.length, omega.length, out.length);
    if (L === 0) return;
    out[0] = initialPhase;
    for (let n = 1; n < L; n++) {
        const dw = omega[n] - omega[n - 1];
        out[n] = out[n - 1] - 0.5 * dw * (groupDelay[n - 1] + groupDelay[n]);
    }
}
