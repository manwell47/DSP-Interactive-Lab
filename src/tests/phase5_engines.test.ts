/**
 * src/tests/phase5_engines.test.ts
 *
 * Fase 5 — Motores DSP (ARCHITECTURE.md §6.2 y §7):
 *   T-V7-engine   : SpectrumEngine (I6, I7) — fase desenvuelta consistente con la
 *                   integración del retardo de grupo (< 1e-6 rad) y cross-check de
 *                   magnitudeDb / phaseWrapped contra evaluateSosAt.
 *   T-V7-L        : SpectrumEngine — sin saltos falsos de 2π con r = 0.9999, L = 65536.
 *   T-V2-filter   : IirSosFilter (I9) — cascada SOS = forma directa (respuesta al impulso).
 *   T-M3          : IirSosFilter + ParameterSmoother — 0 asignaciones en process()
 *                   (contador de alocaciones por interceptación de constructores).
 *   T-SMOOTH      : ParameterSmoother (§7.3a) — rampa lineal sin clics (|Δy| acotado).
 *   T-BYPASS      : ParameterSmoother (§7.3b/§7.4) — crossfade a bypass: residuo < -80 dB.
 */
import { describe, it, expect } from 'vitest';
import { SosSynthesizer } from '../core/SosSynthesizer';
import { SpectrumEngine } from '../core/spectrum';
import { IirSosFilter } from '../core/iir-sos-filter';
import { ParameterSmoother } from '../core/parameter-smoother';
import { phaseFromGroupDelay } from '../core/phase-unwrap';
import { evaluateSosAt } from '../core/transfer';
import { polyProduct } from '../core/polynomial';
import type { Complex, SosCoefficients, SpectrumBuffers, ZPlaneState } from '../core/types';
import { DEFAULT_SPECTRUM_LENGTH } from '../core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const synth = new SosSynthesizer();

/** Complejo polar: r·e^{jθ}. */
function cp(r: number, th: number): Complex {
    return { re: r * Math.cos(th), im: r * Math.sin(th) };
}

function makeSos(poles: Complex[], zeros: Complex[], gain: number): SosCoefficients {
    const state: ZPlaneState = { poles, zeros, gain };
    return synth.compute(state);
}

function makeBuffers(L: number): SpectrumBuffers {
    const omega = new Float64Array(L);
    const dw = (2 * Math.PI) / L;
    for (let n = 0; n < L; n++) omega[n] = n * dw;
    return {
        omega,
        magnitudeDb: new Float64Array(L),
        phaseWrapped: new Float64Array(L),
        phaseUnwrapped: new Float64Array(L),
        groupDelay: new Float64Array(L),
        length: L,
    };
}

/** Ganancia DC total de una cascada SOS: totalGain·∏(Σb)/(Σa). */
function dcGain(sos: SosCoefficients): number {
    let g = sos.totalGain;
    for (const s of sos.sections) g *= (s.b0 + s.b1 + s.b2) / (1 + s.a1 + s.a2);
    if (sos.firstOrderSection) {
        const s = sos.firstOrderSection;
        g *= (s.b0 + s.b1) / (1 + s.a1);
    }
    return g;
}

/**
 * Harness de conteo de asignaciones (ARCHITECTURE.md §8.3): intercepta los
 * constructores de ArrayBuffer/SharedArrayBuffer/Float32Array/Float64Array/
 * Array/DataView durante la ejecución de `fn` y devuelve cuántas asignaciones
 * se intentaron. Cualquier asignación en el hot path es un fallo.
 */
function countAllocations(fn: () => void): number {
    let count = 0;
    const names = ['ArrayBuffer', 'SharedArrayBuffer', 'Float32Array', 'Float64Array', 'Array', 'DataView'] as const;
    const saved = new Map<string, unknown>();
    for (const name of names) {
        const orig = (globalThis as unknown as Record<string, unknown>)[name];
        saved.set(name, orig);
        if (typeof orig !== 'function') continue;
        const wrapped = function (this: unknown, ...args: unknown[]) {
            count++;
            return Reflect.construct(orig as never, args);
        };
        (globalThis as unknown as Record<string, unknown>)[name] = wrapped;
    }
    try {
        fn();
    } finally {
        for (const [name, orig] of saved) {
            (globalThis as unknown as Record<string, unknown>)[name] = orig;
        }
    }
    return count;
}

// ---------------------------------------------------------------------------
// T-V7-engine — SpectrumEngine: consistencia fase desenvuelta / retardo de grupo
// ---------------------------------------------------------------------------

describe('SpectrumEngine (I6, I7)', () => {
    const poles = [cp(0.8, 0.3), cp(0.8, -0.3)];
    const zeros = [cp(0.5, 0.7), cp(0.5, -0.7)];

    it('T-V7-engine — phaseUnwrapped == -∫τ_g dentro de 1e-6 rad', () => {
        const sos = makeSos(poles, zeros, 1);
        const L = DEFAULT_SPECTRUM_LENGTH;
        const buffers = makeBuffers(L);
        const engine = new SpectrumEngine();

        const version = engine.computeInto(sos, buffers);
        expect(version).toBeGreaterThanOrEqual(1);
        // segunda llamada con el mismo sos: versión incremental, sin re-rebuild
        expect(engine.computeInto(sos, buffers)).toBe(version + 1);

        // Fase desenvuelta por integración trapezoidal de -τ_g (ec. 5.9)
        const scratch = new Float64Array(L);
        phaseFromGroupDelay(buffers.groupDelay, buffers.omega, scratch, 0);

        let maxErr = 0;
        for (let n = 0; n < L; n++) {
            const e = Math.abs(scratch[n] - buffers.phaseUnwrapped[n]);
            if (e > maxErr) maxErr = e;
        }
        expect(maxErr).toBeLessThan(1e-6);
    });

    it('T-V7-engine — magnitudeDb y phaseWrapped coinciden con evaluateSosAt', () => {
        const sos = makeSos(poles, zeros, 1);
        const L = DEFAULT_SPECTRUM_LENGTH;
        const buffers = makeBuffers(L);
        const engine = new SpectrumEngine();
        engine.computeInto(sos, buffers);

        const step = 4096;
        for (let n = 0; n < L; n += step) {
            const w = buffers.omega[n];
            const h = evaluateSosAt(w, sos);
            const magDb = 20 * Math.log10(Math.hypot(h.re, h.im));
            const wrapped = Math.atan2(h.im, h.re);
            expect(Math.abs(buffers.magnitudeDb[n] - magDb)).toBeLessThan(1e-9);
            expect(Math.abs(buffers.phaseWrapped[n] - wrapped)).toBeLessThan(1e-9);
        }
    });

    it('T-V7-L — sin saltos falsos de 2π con r = 0.9999 y L = 65536 (ec. 5.7)', () => {
        // doble polo real en r = 0.9999 → max|τ_g| ≈ 2e4 (peor caso)
        const sos = makeSos([{ re: 0.9999, im: 0 }, { re: 0.9999, im: 0 }], [], 1);
        const L = DEFAULT_SPECTRUM_LENGTH;
        const buffers = makeBuffers(L);
        const engine = new SpectrumEngine();
        engine.computeInto(sos, buffers);

        let maxJump = 0;
        for (let n = 1; n < L; n++) {
            const d = Math.abs(buffers.phaseUnwrapped[n] - buffers.phaseUnwrapped[n - 1]);
            if (d > maxJump) maxJump = d;
        }
        expect(maxJump).toBeLessThanOrEqual(Math.PI);
    });
});

// ---------------------------------------------------------------------------
// T-V2-filter — IirSosFilter: cascada SOS == forma directa (respuesta al impulso)
// ---------------------------------------------------------------------------

describe('IirSosFilter (I9, M3)', () => {
    it('T-V2-filter — la respuesta al impulso de la cascada coincide con la forma directa', () => {
        const poles = [cp(0.8, 0.3), cp(0.8, -0.3), cp(0.6, 1.1), cp(0.6, -1.1)];
        const zeros = [cp(0.5, 0.7), cp(0.5, -0.7), { re: -0.9, im: 0 }];
        const gain = 1.5;
        const sos = makeSos(poles, zeros, gain);

        // Polinomios de la forma directa desde la cascada (álgebra polinómica,
        // independiente de la recursión del filtro): A(z)=∏den_k, B(z)=totalGain·∏num_k
        const aPoly: Complex[][] = [];
        const bPoly: Complex[][] = [];
        for (const s of sos.sections) {
            aPoly.push([{ re: 1, im: 0 }, { re: s.a1, im: 0 }, { re: s.a2, im: 0 }]);
            bPoly.push([{ re: s.b0, im: 0 }, { re: s.b1, im: 0 }, { re: s.b2, im: 0 }]);
        }
        if (sos.firstOrderSection) {
            const s = sos.firstOrderSection;
            aPoly.push([{ re: 1, im: 0 }, { re: s.a1, im: 0 }]);
            bPoly.push([{ re: s.b0, im: 0 }, { re: s.b1, im: 0 }]);
        }
        const A = polyProduct(aPoly);
        const Braw = polyProduct(bPoly);
        const B = Braw.map((c) => ({ re: c.re * sos.totalGain, im: c.im * sos.totalGain }));

        // Referencia: recursión de forma directa h[n] = B[n] - Σ_{k=1..n} A[k]·h[n-k]
        const M = 512;
        const hRef = new Float64Array(M);
        const maxH = { v: 0 };
        for (let n = 0; n < M; n++) {
            let acc = n < B.length ? B[n].re : 0;
            const kmax = Math.min(n, A.length - 1);
            for (let k = 1; k <= kmax; k++) acc -= A[k].re * hRef[n - k];
            hRef[n] = acc;
            if (Math.abs(acc) > maxH.v) maxH.v = Math.abs(acc);
        }

        // Filtro en cascada (Float32 I/O, estado float64)
        const filter = new IirSosFilter();
        filter.setSos(sos);
        const input = new Float32Array(M);
        input[0] = 1; // impulso
        const output = new Float32Array(M);
        filter.process(input, output);

        let maxErr = 0;
        for (let n = 0; n < M; n++) {
            const e = Math.abs(output[n] - hRef[n]);
            if (e > maxErr) maxErr = e;
        }
        expect(maxErr).toBeLessThanOrEqual(1e-6 * (1 + maxH.v));
    });

    it('T-M3 — process() ejecuta 0 asignaciones (harness de conteo)', () => {
        const sos = makeSos([cp(0.9, 0.3), cp(0.9, -0.3)], [cp(0.5, 1.0), cp(0.5, -1.0)], 1);
        const filter = new IirSosFilter();
        filter.setSos(sos);

        const block = new Float32Array(128);
        const out = new Float32Array(128);
        for (let i = 0; i < block.length; i++) block[i] = Math.sin(i * 0.1);

        // sanity: el harness detecta una asignación real
        const sanity = countAllocations(() => {
            new Float64Array(8);
        });
        expect(sanity).toBeGreaterThanOrEqual(1);

        const allocs = countAllocations(() => {
            for (let k = 0; k < 200; k++) filter.process(block, out);
        });
        expect(allocs).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// ParameterSmoother — T-SMOOTH (rampa lineal) y T-BYPASS (crossfade)
// ---------------------------------------------------------------------------

describe('ParameterSmoother (§7.3)', () => {
    it('T-SMOOTH — rampa lineal: transición de ganancia DC sin clics', () => {
        // Nota: con la normalización I5 (k = 1/peak en totalGain) el par original
        // (0.5@±0.3 vs 0.7@±0.3) daba gA = gB = 1.0 (pico en DC), haciendo
        // insatisfacible |gB - gA| > 0.05. Este par (picos interiores) sí separa
        // las ganancias DC: gA ≈ 0.8164, gB ≈ 0.0834 (verificado por simulación).
        const sosA = makeSos([cp(0.6, 0.9), cp(0.6, -0.9)], [], 1);
        const sosB = makeSos([cp(0.9, 1.8), cp(0.9, -1.8)], [], 1);
        const gA = dcGain(sosA);
        const gB = dcGain(sosB);
        expect(Math.abs(gB - gA)).toBeGreaterThan(0.05);

        const R = 512;
        const N0 = 2000;
        const N1 = 600;
        const input = new Float32Array(Math.max(N0, N1)).fill(1); // DC
        const pre = new Float32Array(N0);
        const out = new Float32Array(N1);

        // Rampa lineal
        const smooth = new ParameterSmoother();
        smooth.setCoefficients(sosA, { samples: 0, mode: 'linear' });
        smooth.process(input.subarray(0, N0), pre);
        expect(Math.abs(pre[N0 - 1] - gA)).toBeLessThan(1e-3);
        smooth.setCoefficients(sosB, { samples: R, mode: 'linear' });
        smooth.process(input.subarray(0, N1), out);

        let smoothMax = 0;
        for (let n = 1; n < N1; n++) {
            const d = Math.abs(out[n] - out[n - 1]);
            if (d > smoothMax) smoothMax = d;
        }

        // Control abrupto (R = 0)
        const abrupt = new ParameterSmoother();
        abrupt.setCoefficients(sosA, { samples: 0, mode: 'linear' });
        abrupt.process(input.subarray(0, N0), new Float32Array(N0));
        abrupt.setCoefficients(sosB, { samples: 0, mode: 'linear' });
        const outAb = new Float32Array(N1);
        abrupt.process(input.subarray(0, N1), outAb);
        let abruptMax = 0;
        for (let n = 1; n < N1; n++) {
            const d = Math.abs(outAb[n] - outAb[n - 1]);
            if (d > abruptMax) abruptMax = d;
        }

        // Sin clics: la rampa mantiene |Δy| por muestra pequeño; el cambio brusco produce un salto grande
        expect(smoothMax).toBeLessThanOrEqual(0.01);
        expect(abruptMax).toBeGreaterThanOrEqual(0.02);
        expect(abruptMax).toBeGreaterThan(5 * smoothMax);
    });

    it('T-BYPASS — crossfade a bypass: residuo < -80 dB al final de la rampa', () => {
        const sos = makeSos([cp(0.7, 0.5), cp(0.7, -0.5)], [], 1);
        const smoother = new ParameterSmoother();
        smoother.setCoefficients(sos, { samples: 0, mode: 'crossfade' });

        const fs = 48000;
        const f = 440;
        const R = 512;
        const N0 = 2000;
        const N1 = 1200;
        const input = new Float32Array(N0 + N1);
        for (let n = 0; n < input.length; n++) input[n] = Math.sin((2 * Math.PI * f * n) / fs);

        // El filtro atenúa la señal (el bypass debe ser audiblemente distinto)
        const pre = new Float32Array(N0);
        smoother.process(input.subarray(0, N0), pre);
        let preDiff = 0;
        for (let n = 0; n < N0; n++) preDiff = Math.max(preDiff, Math.abs(pre[n] - input[n]));
        expect(preDiff).toBeGreaterThan(1e-3);

        smoother.setBypass(true, { samples: R, mode: 'crossfade' });
        const out = new Float32Array(N1);
        smoother.process(input.subarray(N0, N0 + N1), out);

        let maxResid = 0;
        let maxSig = 0;
        for (let n = R + 64; n < N1; n++) {
            const r = Math.abs(out[n] - input[N0 + n]);
            const s = Math.abs(input[N0 + n]);
            if (r > maxResid) maxResid = r;
            if (s > maxSig) maxSig = s;
        }
        // -80 dB de residuo relativo a la señal
        expect(maxResid).toBeLessThan(1e-4 * maxSig);
    });

    it('T-M3 — ParameterSmoother.process() también es cero-asignación', () => {
        const sosA = makeSos([cp(0.5, 0.3), cp(0.5, -0.3)], [], 1);
        const sosB = makeSos([cp(0.7, 0.3), cp(0.7, -0.3)], [], 1);
        const smoother = new ParameterSmoother();
        smoother.setCoefficients(sosA, { samples: 0, mode: 'linear' });

        const block = new Float32Array(128);
        const out = new Float32Array(128);
        for (let i = 0; i < block.length; i++) block[i] = Math.sin(i * 0.05);

        const allocs = countAllocations(() => {
            for (let k = 0; k < 100; k++) smoother.process(block, out);
            // rampa lineal en curso (sin commit dentro de la medición)
            smoother.setCoefficients(sosB, { samples: 512, mode: 'linear' });
            for (let k = 0; k < 40; k++) smoother.process(block, out);
        });
        expect(allocs).toBe(0);
    });
});
