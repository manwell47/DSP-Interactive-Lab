/**
 * src/tests/phase6_fuzz.test.ts
 *
 * Fase 6 — Fuzzing de invariantes (ARCHITECTURE.md §10.2):
 *   T-FUZZ : ≥ 10^4 configuraciones aleatorias de polos/ceros verifican
 *            - I1 (ec. 6.3): tras el clamp, toda sección SOS tiene polos dentro
 *              de MAX_POLE_RADIUS (sqrt(|a2|) para biquads, |a1| para la sección
 *              de 1.er orden).
 *            - I9 (ec. 3.5): la respuesta al impulso de la cascada SOS coincide
 *              con la forma directa (recursión polinómica) dentro de una
 *              tolerancia relativa ~1e-6·(1 + max|h|).
 *
 * El PRNG es un LCG estilo Numerical Recipes (determinista y reproducible):
 * seed fijo ⇒ el fuzzing es totalmente reproducible entre ejecuciones.
 * ~15 % de los radios de polo superan 1.0 para ejercitar el clamp I1; los ceros
 * pueden caer en el círculo unidad (no se clampean).
 */
import { describe, it, expect } from 'vitest';
import { SosSynthesizer } from '../core/SosSynthesizer';
import { IirSosFilter } from '../core/iir-sos-filter';
import { polyProduct } from '../core/polynomial';
import { MAX_POLE_RADIUS } from '../core/types';
import type { Complex, SosCoefficients, ZPlaneState } from '../core/types';

const synth = new SosSynthesizer();

/** Complejo polar: r·e^{jθ}. */
function cp(r: number, th: number): Complex {
    return { re: r * Math.cos(th), im: r * Math.sin(th) };
}

/** LCG estilo Numerical Recipes: s ← a·s + c (mod 2³²), devuelve ∈ [0, 1). */
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** Estado del plano Z aleatorio: pares conjugados + reales, con radios variados. */
function randomState(rnd: () => number): ZPlaneState {
    const poles: Complex[] = [];
    const zeros: Complex[] = [];

    const nPairsP = Math.floor(rnd() * 3); // 0..2 pares de polos
    const nRealP = Math.floor(rnd() * 2);  // 0..1 polo real
    for (let i = 0; i < nPairsP; i++) {
        // ~15 % de radios > 1.0: ejercitan el clamp I1 a MAX_POLE_RADIUS
        const r = rnd() < 0.15 ? 1.0 + rnd() * 0.6 : rnd() * 0.99;
        const th = rnd() * Math.PI;
        poles.push(cp(r, th), cp(r, -th));
    }
    for (let i = 0; i < nRealP; i++) {
        const r = rnd() < 0.15 ? 1.0 + rnd() * 0.6 : rnd() * 0.99;
        poles.push({ re: r, im: 0 });
    }

    const nPairsZ = Math.floor(rnd() * 3); // 0..2 pares de ceros
    const nRealZ = Math.floor(rnd() * 2);  // 0..1 cero real
    for (let i = 0; i < nPairsZ; i++) {
        const r = rnd() * 1.0; // los ceros pueden caer en el círculo unidad
        const th = rnd() * Math.PI;
        zeros.push(cp(r, th), cp(r, -th));
    }
    for (let i = 0; i < nRealZ; i++) {
        zeros.push({ re: rnd() * 1.0, im: 0 });
    }

    const gain = 0.1 + rnd() * 4.0;
    return { poles, zeros, gain };
}

/**
 * I1 (ec. 6.3): toda sección de la cascada tiene polos dentro de MAX_POLE_RADIUS.
 * Biquad: radio del par conjugado = sqrt(|a2|); sección de 1.er orden: radio = |a1|.
 */
function checkI1(sos: SosCoefficients): boolean {
    for (const s of sos.sections) {
        if (Math.sqrt(Math.abs(s.a2)) > MAX_POLE_RADIUS + 1e-9) return false;
    }
    if (sos.firstOrderSection) {
        if (Math.abs(sos.firstOrderSection.a1) > MAX_POLE_RADIUS + 1e-9) return false;
    }
    return true;
}

/**
 * I9 (ec. 3.5): error relativo máximo entre la respuesta al impulso de la cascada
 * (IirSosFilter) y la forma directa (recursión polinómica sobre D(z)·h = N(z)·δ).
 * Devuelve maxErr / (1 + max|h|) — la tolerancia ~1e-6 es relativa al pico (ec. §10.2).
 */
function checkI9(sos: SosCoefficients, N: number): number {
    const numPolys: Complex[][] = [];
    const denPolys: Complex[][] = [];
    for (const s of sos.sections) {
        numPolys.push([{ re: s.b0, im: 0 }, { re: s.b1, im: 0 }, { re: s.b2, im: 0 }]);
        denPolys.push([{ re: 1, im: 0 }, { re: s.a1, im: 0 }, { re: s.a2, im: 0 }]);
    }
    if (sos.firstOrderSection) {
        const s = sos.firstOrderSection;
        numPolys.push([{ re: s.b0, im: 0 }, { re: s.b1, im: 0 }]);
        denPolys.push([{ re: 1, im: 0 }, { re: s.a1, im: 0 }]);
    }
    const num = polyProduct(numPolys);
    const den = polyProduct(denPolys); // den[0] = 1

    // Forma directa: recursión h[n] = totalGain·num[n] − Σ_{k≥1} den[k]·h[n−k]
    const direct = new Float64Array(N);
    for (let n = 0; n < N; n++) {
        const nn = n < num.length ? num[n].re : 0;
        let v = nn * sos.totalGain;
        const dmax = Math.min(n, den.length - 1);
        for (let k = 1; k <= dmax; k++) v -= den[k].re * direct[n - k];
        direct[n] = v;
    }

    // Cascada: IirSosFilter accionado con δ[n]
    const filter = new IirSosFilter();
    filter.setSos(sos);
    filter.resetState();
    const h = new Float64Array(N);
    for (let n = 0; n < N; n++) h[n] = filter.processSample(n === 0 ? 1 : 0);

    let maxErr = 0;
    let maxH = 0;
    for (let n = 0; n < N; n++) {
        const ah = Math.abs(h[n]);
        if (ah > maxH) maxH = ah;
        const e = Math.abs(h[n] - direct[n]);
        if (e > maxErr) maxErr = e;
    }
    return maxErr / (1 + maxH);
}

describe('T-FUZZ — invariantes I1/I9 bajo fuzzing (§10.2)', () => {
    it(
        '≥ 10^4 configuraciones aleatorias verifican I1 (estabilidad) e I9 (cascada = forma directa)',
        () => {
            const K = 10_000;
            const N = 128; // muestras de la respuesta al impulso por configuración
            const rnd = makeRng(0xC0FFEE); // seed fijo ⇒ reproducible

            let i1Ok = true;
            let i1Bad = 0;
            let maxRelErrI9 = 0;
            for (let k = 0; k < K; k++) {
                const state = randomState(rnd);
                const sos = synth.compute(state);
                if (!checkI1(sos)) {
                    i1Ok = false;
                    i1Bad++;
                }
                const rel = checkI9(sos, N);
                if (rel > maxRelErrI9) maxRelErrI9 = rel;
            }

            // I1 (ec. 6.3): tras el clamp, todos los polos dentro de MAX_POLE_RADIUS
            expect(i1Ok, `I1 falló en ${i1Bad} configuraciones`).toBe(true);
            // I9 (ec. 3.5): error relativo de la cascada vs. forma directa < 1e-6
            expect(maxRelErrI9).toBeLessThan(1e-6);
        },
        120_000,
    );
});
