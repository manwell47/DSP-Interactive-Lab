/**
 * src/tests/phase6_engines.test.ts
 *
 * Fase 6 — Motores DSP y pool de búferes (ARCHITECTURE.md §6.2(5), §8):
 *   T-TIME-1 : computeTimeDomain — h[0] = totalGain y s[n] = Σ_{k≤n} h[k] (identidad
 *              exacta de la recursión de la cascada sobre impulso/escalón), con
 *              cross-check contra un IirSosFilter accionado directamente.
 *   T-TIME-2 : computeTimeDomain — el escalón asienta a la ganancia DC (I5) en dos
 *              configuraciones (par conjugado + sección de 1.er orden, I4).
 *   T-TIME-3 : computeTimeDomain — 0 asignaciones (M1, harness de conteo).
 *   T-POOL-1 : BufferPool — acquire devuelve el búfer residente (identidad + longitud).
 *   T-POOL-2 : BufferPool — acquire/release ejecutan 0 asignaciones (M1).
 *   T-POOL-3 : BufferPool — resizeAll(L') reasigna (la identidad cambia, M6).
 *   T-POOL-4 : BufferPool — resizeAll(L) con la misma longitud conserva la identidad.
 */
import { describe, it, expect } from 'vitest';
import { SosSynthesizer } from '../core/SosSynthesizer';
import { SpectrumEngine } from '../core/spectrum';
import { IirSosFilter } from '../core/iir-sos-filter';
import { BufferPool } from '../core/buffer-pool';
import type {
    BufferKey,
    Complex,
    SosCoefficients,
    TimeDomainBuffers,
    ZPlaneState,
} from '../core/types';

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

function makeTimeBuffers(Nt: number): TimeDomainBuffers {
    return {
        impulse: new Float64Array(Nt),
        step: new Float64Array(Nt),
        length: Nt,
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

/** Todas las claves del pool (ARCHITECTURE.md §8). */
const ALL_KEYS: readonly BufferKey[] = [
    'omega', 'magnitudeDb', 'phaseWrapped', 'phaseUnwrapped', 'groupDelay',
    'impulse', 'step', 'scratch',
];

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
// T-TIME — computeTimeDomain: respuestas h[n]/s[n] por recursión de la cascada
// ---------------------------------------------------------------------------

describe('SpectrumEngine.computeTimeDomain (§6.2(5))', () => {
    const engine = new SpectrumEngine();

    it('T-TIME-1 — h[0] = totalGain y s[n] = Σ_{k≤n} h[k] (cross-check con IirSosFilter)', () => {
        const sos = makeSos(
            [cp(0.7, 1.1), cp(0.7, -1.1), cp(0.4, 0)],
            [cp(0.2, 0.4), cp(0.2, -0.4)],
            2.5,
        );
        const Nt = 1024;
        const bufs = makeTimeBuffers(Nt);
        engine.computeTimeDomain(sos, bufs);

        // h[0] = totalGain: todas las secciones tienen b0 = 1 (I5)
        expect(bufs.impulse[0]).toBeCloseTo(sos.totalGain, 12);

        // Cross-check: h[n] coincide con un IirSosFilter accionado con δ[n]
        const ref = new IirSosFilter();
        ref.setSos(sos);
        ref.resetState();
        for (let n = 0; n < Nt; n++) {
            const hRef = ref.processSample(n === 0 ? 1 : 0);
            expect(Math.abs(bufs.impulse[n] - hRef)).toBeLessThan(1e-12 * (1 + Math.abs(hRef)));
        }

        // s[n] = Σ_{k≤n} h[k] (identidad exacta de la recursión sobre el escalón)
        let acc = 0;
        for (let n = 0; n < Nt; n++) {
            acc += bufs.impulse[n];
            const tol = 1e-9 * (1 + Math.abs(acc));
            expect(Math.abs(bufs.step[n] - acc)).toBeLessThan(tol);
        }
    });

    it('T-TIME-2 — el escalón asienta a la ganancia DC (I5) en dos configuraciones', () => {
        const configs = [
            { poles: [cp(0.9, 0.5), cp(0.9, -0.5)], zeros: [cp(0.4, 0.2), cp(0.4, -0.2)], gain: 1.0 },
            { poles: [cp(0.8, 1.9), cp(0.8, -1.9), cp(0.3, 0)], zeros: [cp(0.6, 0.9), cp(0.6, -0.9)], gain: 0.75 },
        ];
        const Nt = 8192;
        for (const cfg of configs) {
            const sos = makeSos(cfg.poles, cfg.zeros, cfg.gain);
            const g = dcGain(sos);
            const bufs = makeTimeBuffers(Nt);
            engine.computeTimeDomain(sos, bufs);
            const settled = Math.abs(bufs.step[Nt - 1] - g);
            expect(settled).toBeLessThan(1e-6 * (1 + Math.abs(g)));
        }
    });

    it('T-TIME-3 — computeTimeDomain() ejecuta 0 asignaciones (M1)', () => {
        const sos = makeSos(
            [cp(0.7, 1.0), cp(0.7, -1.0)],
            [cp(0.3, 0.6), cp(0.3, -0.6)],
            1.5,
        );
        const bufs = makeTimeBuffers(1024);
        const allocs = countAllocations(() => {
            engine.computeTimeDomain(sos, bufs);
        });
        expect(allocs).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// T-POOL — BufferPool: preasignación residente y resizeAll (M1, M6)
// ---------------------------------------------------------------------------

describe('BufferPool (§8, M1/M6)', () => {
    it('T-POOL-1 — acquire devuelve el búfer residente con la longitud correcta', () => {
        const L = 512;
        const pool = new BufferPool(L);
        for (const key of ALL_KEYS) {
            const a = pool.acquire(key);
            expect(a).toBeInstanceOf(Float64Array);
            expect(a.length).toBe(L);
            const b = pool.acquire(key);
            expect(b).toBe(a); // residente: misma identidad en cada acquire
        }
    });

    it('T-POOL-2 — acquire/release ejecutan 0 asignaciones (M1)', () => {
        const pool = new BufferPool(256);
        const allocs = countAllocations(() => {
            for (const key of ALL_KEYS) {
                pool.acquire(key);
                pool.release(key);
            }
        });
        expect(allocs).toBe(0);
    });

    it("T-POOL-3 — resizeAll(L') reasigna: la identidad cambia y la longitud se actualiza (M6)", () => {
        const L = 128;
        const pool = new BufferPool(L);
        const before = new Map(ALL_KEYS.map((k) => [k, pool.acquire(k)]));
        pool.resizeAll(2 * L);
        for (const key of ALL_KEYS) {
            const after = pool.acquire(key);
            expect(after).not.toBe(before.get(key));
            expect(after.length).toBe(2 * L);
        }
    });

    it('T-POOL-4 — resizeAll(L) con la misma longitud conserva la identidad', () => {
        const L = 256;
        const pool = new BufferPool(L);
        const before = new Map(ALL_KEYS.map((k) => [k, pool.acquire(k)]));
        pool.resizeAll(L);
        for (const key of ALL_KEYS) {
            expect(pool.acquire(key)).toBe(before.get(key));
        }
    });
});
