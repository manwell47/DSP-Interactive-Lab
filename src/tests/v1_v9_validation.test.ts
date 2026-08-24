/**
 * src/tests/v1_v9_validation.test.ts
 *
 * Suite de validación matemática — mapeo uno-a-uno de la checklist V1–V9 de
 * THEORY_SPECS.md §8 a tests unitarios (T-V1..T-V9), según ARCHITECTURE.md §10.
 * Se añaden los invariantes T-I1, T-I4, T-I8 y T-UNWRAP-L (§10.1).
 *
 * Fase TDD: estos tests se escriben ANTES de la implementación (RED), y la
 * implementación de src/core/* debe hacerlos pasar estrictamente (GREEN).
 */
import { describe, it, expect } from 'vitest';

import { SosSynthesizer } from '../core/SosSynthesizer';
import { groupDelayAt, fillGroupDelay } from '../core/group-delay';
import { unwrapPhase, phaseFromGroupDelay } from '../core/phase-unwrap';
import { evaluateHAt, evaluateSosAt } from '../core/transfer';
import { polyFromRoots, polyProduct, polyMaxAbsDiff } from '../core/polynomial';
import {
    Complex,
    DEFAULT_SPECTRUM_LENGTH,
    MAX_POLE_RADIUS,
    SosCoefficients,
    ZPlaneState,
} from '../core/types';

const TAU = 2 * Math.PI;
const synth = new SosSynthesizer();

// ---- helpers de test (sin dependencias de la implementación) --------------

function c(re: number, im: number): Complex {
    return { re, im };
}

function polar(r: number, theta: number): Complex {
    return { re: r * Math.cos(theta), im: r * Math.sin(theta) };
}

// ---------------------------------------------------------------------------
// T-V1 — Ecuación del biquad (ec. 3.3, invariantes I2/I3)
// ---------------------------------------------------------------------------
describe('T-V1 — biquad desde par conjugado (ec. 3.3, I2/I3)', () => {
    it('con r=0.9, θ=π/4 produce a1≈-1.27279, a2=0.81, b0=1', () => {
        const state: ZPlaneState = {
            poles: [polar(0.9, Math.PI / 4), polar(0.9, -Math.PI / 4)],
            zeros: [],
            gain: 1,
        };
        const sos = synth.compute(state);
        expect(sos.sections).toHaveLength(1);
        expect(sos.firstOrderSection).toBeNull();
        expect(sos.order).toBe(2);

        const sec = sos.sections[0];
        // a2 = r² (I2)
        expect(sec.a2).toBeCloseTo(0.81, 12);
        // a1 = -2·r·cos(π/4)
        const a1Expected = -2 * 0.9 * Math.cos(Math.PI / 4); // ≈ -1.2727922
        expect(sec.a1).toBeCloseTo(a1Expected, 12);
        // checklist V1: ≈ -1.27279
        expect(sec.a1).toBeCloseTo(-1.2727922, 5);
        // b0 = 1 y sin ceros → b1 = b2 = 0
        expect(sec.b0).toBe(1);
        expect(sec.b1).toBe(0);
        expect(sec.b2).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// T-V2 — Identidad de cascada (ec. 3.5, I9): ∏H_k(z) = B(z)/A(z)
// ---------------------------------------------------------------------------
describe('T-V2 — identidad de cascada por convolución polinómica (I9)', () => {
    it('2 pares de polos + 2 pares de ceros: residuo < 1e-12', () => {
        const poles = [
            polar(0.85, 0.6), polar(0.85, -0.6),
            polar(0.7, 2.4), polar(0.7, -2.4),
        ];
        const zeros = [
            polar(0.5, 1.0), polar(0.5, -1.0),
            polar(0.3, 3.0), polar(0.3, -3.0),
        ];
        const sos = synth.compute({ poles, zeros, gain: 1 });
        expect(sos.sections).toHaveLength(2);
        expect(sos.firstOrderSection).toBeNull();

        // B_sos = ∏ numeradores de sección; A_sos = ∏ denominadores de sección
        const numPolys = sos.sections.map((s) => [c(1, 0), c(s.b1, 0), c(s.b2, 0)]);
        const denPolys = sos.sections.map((s) => [c(1, 0), c(s.a1, 0), c(s.a2, 0)]);
        const B_sos = polyProduct(numPolys);
        const A_sos = polyProduct(denPolys);

        // Forma directa desde raíces: B(z)=∏(1-c_i z⁻¹), A(z)=∏(1-d_k z⁻¹)
        const B_direct = polyFromRoots(zeros);
        const A_direct = polyFromRoots(poles);

        expect(polyMaxAbsDiff(B_sos, B_direct)).toBeLessThan(1e-12);
        expect(polyMaxAbsDiff(A_sos, A_direct)).toBeLessThan(1e-12);
    });
});

// ---------------------------------------------------------------------------
// T-V3 — Retardo de grupo, polo real (ec. 4.6)
// ---------------------------------------------------------------------------
describe('T-V3 — τ_g de polo real a=0.5 (ec. 4.6)', () => {
    it('τ_g(0) = a/(1-a) = 1', () => {
        expect(groupDelayAt(0, [c(0.5, 0)], [])).toBeCloseTo(1, 12);
    });
});

// ---------------------------------------------------------------------------
// T-V4 — Retardo de grupo, cero en z=1 (ec. 4.7)
// ---------------------------------------------------------------------------
describe('T-V4 — τ_g de cero en z=1 (ec. 4.7)', () => {
    it('τ_g = 1/2 en ω ∈ (0, 2π)', () => {
        for (const w of [0.1, Math.PI / 2, 3.0, 5.0]) {
            expect(groupDelayAt(w, [], [c(1, 0)])).toBeCloseTo(0.5, 12);
        }
    });
});

// ---------------------------------------------------------------------------
// T-V5 — Resonancia de par conjugado (ec. 4.5 exacta y límite ec. 4.8)
// ---------------------------------------------------------------------------
describe('T-V5 — τ_g de par conjugado r=0.9, θ=π/4 (ec. 4.5/4.8)', () => {
    it('valor EXACTO ec. 4.5 en ω=θ=π/4', () => {
        const th = Math.PI / 4;
        const poles = [polar(0.9, th), polar(0.9, -th)];
        const gd = groupDelayAt(th, poles, []);
        // contribución analítica exacta: r/(1-r) − r²/(1+r²)
        const expected = 0.9 / 0.1 - (0.9 * 0.9) / (1 + 0.9 * 0.9);
        expect(gd).toBeCloseTo(expected, 9);
        // sanity: ≈ 8.552486 (el límite ec. 4.8 = 18 solo vale θ→0)
        expect(gd).toBeCloseTo(8.552486, 5);
    });

    it('límite ec. 4.8: θ→0 ⇒ τ_g(θ) → 2r/(1-r) = 18', () => {
        const th = 1e-3;
        const poles = [polar(0.9, th), polar(0.9, -th)];
        const gd = groupDelayAt(th, poles, []);
        const limit = (2 * 0.9) / 0.1; // 18
        expect(Math.abs(gd - limit) / limit).toBeLessThan(1e-3);
    });
});

// ---------------------------------------------------------------------------
// T-V6 — Identidad integral del argumento (forma CORREGIDA de ec. 4.9)
//   ∫₀^{2π} τ_g dω = 2π·(M − N_z^int) = 2π·(#ceros EXTERIORES al círculo unidad)
//   (cada raíz interior —polo o cero— integra a 0 por el núcleo de Poisson;
//    cada cero exterior contribuye +2π; los polos son estables ⇒ todos interiores)
// ---------------------------------------------------------------------------
describe('T-V6 — identidad integral del argumento', () => {
    it('2 ceros EXTERIORES (no mínima fase) ⇒ ∫τ_g = 2π·2 = 4π', () => {
        const L = DEFAULT_SPECTRUM_LENGTH;
        const poles = [
            polar(0.6, 0.7), polar(0.6, -0.7),
            polar(0.6, 2.2), polar(0.6, -2.2),
        ];
        const zeros = [polar(1.5, 1.0), polar(1.5, -1.0)]; // fuera del círculo unidad
        const omega = new Float64Array(L);
        const gd = new Float64Array(L);
        for (let n = 0; n < L; n++) omega[n] = (n * TAU) / L;
        fillGroupDelay(poles, zeros, omega, gd);

        let sum = 0;
        for (let n = 0; n < L; n++) sum += gd[n];
        const integral = sum * (TAU / L);
        const expected = TAU * 2; // 2 ceros exteriores ⇒ 4π
        expect(integral).toBeCloseTo(expected, 6);
    });

    it('fase mínima (todos los ceros interiores) ⇒ ∫τ_g = 0', () => {
        const L = DEFAULT_SPECTRUM_LENGTH;
        const poles = [
            polar(0.6, 0.7), polar(0.6, -0.7),
            polar(0.6, 2.2), polar(0.6, -2.2),
        ];
        const zeros = [polar(0.4, 1.2), polar(0.4, -1.2)]; // interiores
        const omega = new Float64Array(L);
        const gd = new Float64Array(L);
        for (let n = 0; n < L; n++) omega[n] = (n * TAU) / L;
        fillGroupDelay(poles, zeros, omega, gd);

        let sum = 0;
        for (let n = 0; n < L; n++) sum += gd[n];
        const integral = sum * (TAU / L);
        expect(integral).toBeCloseTo(0, 6);
    });
});

// ---------------------------------------------------------------------------
// T-V7 — Consistencia fase desenvuelta (Alg. 5.1) vs integración (ec. 5.9)
// ---------------------------------------------------------------------------
describe('T-V7 — unwrap (Alg. 5.1) vs integración de τ_g (ec. 5.9)', () => {
    it('discrepancia < 1e-6 rad en todo el espectro', () => {
        const L = DEFAULT_SPECTRUM_LENGTH;
        const poles = [
            polar(0.6, 0.7), polar(0.6, -0.7),
            polar(0.6, 2.2), polar(0.6, -2.2),
        ];
        const zeros = [polar(0.4, 1.2), polar(0.4, -1.2)];

        const omega = new Float64Array(L);
        const gd = new Float64Array(L);
        const wrapped = new Float64Array(L);
        const uAlg = new Float64Array(L); // Algoritmo 5.1
        const uInt = new Float64Array(L); // ec. 5.9

        for (let n = 0; n < L; n++) {
            omega[n] = (n * TAU) / L;
            gd[n] = groupDelayAt(omega[n], poles, zeros);
            const h = evaluateHAt(omega[n], poles, zeros, 1);
            wrapped[n] = Math.atan2(h.im, h.re);
        }

        unwrapPhase(wrapped, uAlg);
        phaseFromGroupDelay(gd, omega, uInt, wrapped[0]);

        let maxDiff = 0;
        for (let n = 0; n < L; n++) {
            const d = Math.abs(uAlg[n] - uInt[n]);
            if (d > maxDiff) maxDiff = d;
        }
        expect(maxDiff).toBeLessThan(1e-6);
    });
});

// ---------------------------------------------------------------------------
// T-V8 — Estabilidad ante cuantificación float32 (ec. 6.4)
// ---------------------------------------------------------------------------
describe('T-V8 — r_efectivo tras cuantificar a1,a2 a float32 (ec. 6.4)', () => {
    it('con r=0.9999: r_efectivo < 1 y margen 1−r_ef > 1e-5', () => {
        const r = 0.9999;
        const th = Math.PI / 4;
        const a1 = -2 * r * Math.cos(th);
        const a2 = r * r;

        const a1q = Math.fround(a1);
        const a2q = Math.fround(a2);

        expect(Math.abs(a2q)).toBeLessThan(1);
        const rEff = Math.sqrt(Math.abs(a2q));
        expect(rEff).toBeLessThan(1);
        expect(1 - rEff).toBeGreaterThan(1e-5);
        // la perturbación es ~3e-8 ≪ margen 1e-4
        expect(Math.abs(rEff - r)).toBeLessThan(1e-6);
    });
});

// ---------------------------------------------------------------------------
// T-V9 — Ganancia de pico (ec. 6.6) y normalización I5 a 0 dB
// ---------------------------------------------------------------------------
describe('T-V9 — G_max ≈ 1e8 con r=0.9999 y normalización I5 a 0 dB', () => {
    it('doble polo real: pico crudo 1e8 y cascada normalizada = 0 dB', () => {
        const r = 0.9999;
        const sos = synth.compute({ poles: [c(r, 0), c(r, 0)], zeros: [], gain: 1 });
        expect(sos.sections).toHaveLength(1);
        expect(sos.firstOrderSection).toBeNull();

        const sec = sos.sections[0];
        // pico crudo en ω=0: 1/(1−r)² ≈ 1e8 (ec. 6.6)
        const rawPeak = 1 / ((1 - r) * (1 - r));
        expect(Math.abs(rawPeak - 1e8) / 1e8).toBeLessThan(1e-9);

        // I5: la ganancia de sección normaliza el pico a 1
        expect(sec.k).toBeCloseTo(1 / rawPeak, 10);

        // totalGain = gain_usuario · ∏K_k = 1e-8
        expect(sos.totalGain).toBeCloseTo(1e-8, 12);

        // cascada evaluada en la resonancia (ω=0) → magnitud 1 → 0 dB
        const h = evaluateSosAt(0, sos);
        const mag = Math.hypot(h.re, h.im);
        expect(mag).toBeCloseTo(1, 8);
        expect(20 * Math.log10(mag)).toBeCloseTo(0, 6);
    });
});

// ---------------------------------------------------------------------------
// T-I1 — Clamp de radio (invariante I1, ec. 6.3)
// ---------------------------------------------------------------------------
describe('T-I1 — clamp de radio a MAX_POLE_RADIUS (I1)', () => {
    it('polo con r=1.5 se clampea a 0.9999', () => {
        const sos = synth.compute({
            poles: [polar(1.5, 0.3), polar(1.5, -0.3)],
            zeros: [],
            gain: 1,
        });
        const sec = sos.sections[0];
        expect(Math.sqrt(sec.a2)).toBeCloseTo(MAX_POLE_RADIUS, 9);
    });
});

// ---------------------------------------------------------------------------
// T-I4 — Sección de primer orden para orden impar (I4, ec. 3.4)
// ---------------------------------------------------------------------------
describe('T-I4 — orden impar N=3 ⇒ 1 biquad + 1 sección de 1.er orden (I4)', () => {
    it('par conjugado + polo real', () => {
        const sos = synth.compute({
            poles: [polar(0.8, 0.6), polar(0.8, -0.6), c(0.5, 0)],
            zeros: [],
            gain: 1,
        });
        expect(sos.sections).toHaveLength(1);
        expect(sos.firstOrderSection).not.toBeNull();
        const f = sos.firstOrderSection!;
        expect(f.a1).toBeCloseTo(-0.5, 12);
        expect(f.b0).toBe(1);
        expect(f.b1).toBe(0);
        expect(sos.order).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// T-I8 — Ordenación por resonancia decreciente (I8, §3.6)
// ---------------------------------------------------------------------------
describe('T-I8 — secciones ordenadas por radio de polo decreciente (I8)', () => {
    it('par r=0.9 antes que par r=0.7', () => {
        const sos = synth.compute({
            poles: [
                polar(0.7, 1.0), polar(0.7, -1.0),
                polar(0.9, 0.5), polar(0.9, -0.5),
            ],
            zeros: [],
            gain: 1,
        });
        expect(sos.sections).toHaveLength(2);
        const radii = sos.sections.map((s) => Math.sqrt(Math.abs(s.a2)));
        expect(radii[0]).toBeCloseTo(0.9, 9);
        expect(radii[0]).toBeGreaterThan(radii[1]);
    });
});

// ---------------------------------------------------------------------------
// T-UNWRAP-L — Condición de malla ec. 5.7: sin saltos falsos de 2π
// ---------------------------------------------------------------------------
describe('T-UNWRAP-L — sin saltos falsos de 2π con r=0.9999 (ec. 5.7)', () => {
    it('L=65536 ⇒ Δω·max|τ_g| < π y paso máximo < π', () => {
        const L = DEFAULT_SPECTRUM_LENGTH;
        const poles = [polar(0.9999, Math.PI / 4), polar(0.9999, -Math.PI / 4)];
        const omega = new Float64Array(L);
        const wrapped = new Float64Array(L);
        const u = new Float64Array(L);
        for (let n = 0; n < L; n++) {
            omega[n] = (n * TAU) / L;
            const h = evaluateHAt(omega[n], poles, [], 1);
            wrapped[n] = Math.atan2(h.im, h.re);
        }
        unwrapPhase(wrapped, u);
        let maxStep = 0;
        for (let n = 1; n < L; n++) {
            const s = Math.abs(u[n] - u[n - 1]);
            if (s > maxStep) maxStep = s;
        }
        expect(maxStep).toBeLessThan(Math.PI);
    });
});
