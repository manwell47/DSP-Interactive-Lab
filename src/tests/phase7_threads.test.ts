/**
 * src/tests/phase7_threads.test.ts
 *
 * Fase 7 — Hilos (ARCHITECTURE.md §3, §7, §9):
 *   T-WORKER-1 : DspWorker (hilo B) — PING → PONG (contrato §3.2).
 *   T-WORKER-2 : SET_Z_PLANE → SPECTRUM_VERSION + COEFFICIENTS; escribe el espectro
 *                en el SAB (magnitudeDb finito, omega[n] = n·2π/L) y publica la
 *                versión atómica (handshake §9.1: Atomics.load coincide con el mensaje).
 *   T-WORKER-3 : polo r=1.5 → sqrt(|a2|) ≈ MAX_POLE_RADIUS (invariante I1 en la vía
 *                del worker: el SOS encadenado a COEFFICIENTS ya viene clampeado).
 *   T-WORKER-4 : SET_SPECTRUM_LENGTH(1024) → reasigna el SAB (M6), refill de omega,
 *                length actualizado y nuevo SPECTRUM_VERSION.
 *   T-PROC-1   : IirSosProcessor (hilo C) — SET_BYPASS inmediato → passthrough exacto
 *                de la entrada (identidad y = x, §7.4).
 *   T-PROC-2   : SET_COEFFICIENTS → el escalón asienta a la ganancia DC (I5).
 *   T-PROC-3   : fuente senoidal + PLAY → salida senoidal no nula (generador interno).
 *   T-PROC-4   : process() ejecuta 0 asignaciones (M3, harness de conteo).
 *   T-PROC-5   : SET_BYPASS con crossfade → residuo relativo < -80 dB al final
 *                de la rampa (§7.4).
 */
import { describe, it, expect } from 'vitest';
import { DspWorker } from '../core/dsp-worker';
import { IirSosProcessor } from '../core/iir-sos-processor';
import { SosSynthesizer } from '../core/SosSynthesizer';
import { evaluateSosAt } from '../core/transfer';
import { MAX_POLE_RADIUS } from '../core/types';
import type {
    AudioNodeMessage,
    Complex,
    PackedComplexArray,
    SosCoefficients,
    WorkerResponse,
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

/** Empaqueta raíces en PackedComplexArray (re, im interleaved). */
function pack(roots: readonly Complex[]): PackedComplexArray {
    const data = new Float64Array(roots.length * 2);
    for (let i = 0; i < roots.length; i++) {
        data[2 * i] = roots[i].re;
        data[2 * i + 1] = roots[i].im;
    }
    return { data, count: roots.length };
}

function makeSos(poles: Complex[], zeros: Complex[], gain: number): SosCoefficients {
    const state: ZPlaneState = { poles, zeros, gain };
    return synth.compute(state);
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

const DB = 20 / Math.LN10;

/** Crea un canal mono de N muestras relleno con `fill`. */
function monoBlock(N: number, fill: (i: number) => number): Float32Array {
    const b = new Float32Array(N);
    for (let i = 0; i < N; i++) b[i] = fill(i);
    return b;
}

/** Envuelve un bloque mono en el formato de AudioWorkletProcesser (inputs/outputs). */
function wrapIO(input?: Float32Array): { inputs: Float32Array[][]; outputs: Float32Array[][] } {
    const out = new Float32Array(128);
    return {
        inputs: input ? [[input]] : [[]],
        outputs: [[out]],
    };
}

/** Mensajes capturados por el puerto simulado del worker. */
function makePort(): { messages: WorkerResponse[]; port: { postMessage: (m: WorkerResponse) => void } } {
    const messages: WorkerResponse[] = [];
    return {
        messages,
        port: { postMessage: (m: WorkerResponse) => void messages.push(m) },
    };
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
// T-WORKER — DspWorker (hilo B): mensajería + handshake SAB/Atomics (§3.2, §9.1)
// ---------------------------------------------------------------------------

describe('DspWorker (hilo B, §3/§9)', () => {
    it('T-WORKER-1 — PING → PONG (contrato §3.2)', () => {
        const { messages, port } = makePort();
        const worker = new DspWorker(port, 64);
        worker.handleRequest({ type: 'PING' });
        expect(messages.some((m) => m.type === 'PONG')).toBe(true);
    });

    it('T-WORKER-2 — SET_Z_PLANE: espectro en SAB + COEFFICIENTS (handshake §9.1)', () => {
        const L = 256;
        const { messages, port } = makePort();
        const worker = new DspWorker(port, L);
        worker.handleRequest({
            type: 'SET_Z_PLANE',
            poles: pack([cp(0.9, 0.5), cp(0.9, -0.5)]),
            zeros: pack([cp(0.2, 0.3), cp(0.2, -0.3)]),
            gain: 1.0,
        });

        const versionMsg = messages.find((m): m is Extract<WorkerResponse, { type: 'SPECTRUM_VERSION' }> =>
            m.type === 'SPECTRUM_VERSION');
        const coeffMsg = messages.find((m): m is Extract<WorkerResponse, { type: 'COEFFICIENTS' }> =>
            m.type === 'COEFFICIENTS');
        expect(versionMsg).toBeTruthy();
        expect(coeffMsg).toBeTruthy();
        expect(versionMsg!.version).toBeGreaterThan(0);
        expect(coeffMsg!.sos.sections.length).toBe(1);

        // §9.1: Atomics.load(version) coincide con el mensaje (happens-before)
        expect(worker.version).toBe(versionMsg!.version);

        // Layout del SAB: 8 búferes Float64Array(L) + 1 Int32 de versión
        expect(worker.sharedBuffer.byteLength).toBe(8 * L * 8 + 4);

        // omega[n] = n·2π/L (fijo, escrito por el worker al asignar)
        const omega = worker.view('omega');
        expect(omega.length).toBe(L);
        expect(omega[1]).toBeCloseTo((2 * Math.PI) / L, 12);
        expect(omega[L - 1]).toBeCloseTo((2 * Math.PI * (L - 1)) / L, 9);

        // magnitudeDb finito y consistente con evaluateSosAt (ec. 3.6)
        const mag = worker.view('magnitudeDb');
        for (let n = 0; n < L; n++) expect(Number.isFinite(mag[n])).toBe(true);
        const hv = evaluateSosAt(omega[1], coeffMsg!.sos);
        expect(mag[1]).toBeCloseTo(DB * Math.log(Math.hypot(hv.re, hv.im)), 6);
    });

    it('T-WORKER-3 — polo r=1.5 → sqrt(|a2|) ≈ MAX_POLE_RADIUS (I1 en la vía del worker)', () => {
        const { messages, port } = makePort();
        const worker = new DspWorker(port, 64);
        worker.handleRequest({
            type: 'SET_Z_PLANE',
            poles: pack([cp(1.5, 0.4), cp(1.5, -0.4)]),
            zeros: pack([]),
            gain: 1.0,
        });
        const coeffMsg = messages.find((m): m is Extract<WorkerResponse, { type: 'COEFFICIENTS' }> =>
            m.type === 'COEFFICIENTS');
        expect(coeffMsg).toBeTruthy();
        expect(Math.sqrt(Math.abs(coeffMsg!.sos.sections[0].a2))).toBeCloseTo(MAX_POLE_RADIUS, 6);
    });

    it('T-WORKER-4 — SET_SPECTRUM_LENGTH: reasigna SAB y refill de omega (M6)', () => {
        const { messages, port } = makePort();
        const worker = new DspWorker(port, 128);
        const oldBuffer = worker.sharedBuffer;
        worker.handleRequest({ type: 'SET_SPECTRUM_LENGTH', length: 1024 });

        expect(worker.length).toBe(1024);
        expect(worker.sharedBuffer).not.toBe(oldBuffer);
        expect(worker.sharedBuffer.byteLength).toBe(8 * 1024 * 8 + 4);

        const omega = worker.view('omega');
        expect(omega.length).toBe(1024);
        expect(omega[1]).toBeCloseTo((2 * Math.PI) / 1024, 12);

        expect(messages.some((m) => m.type === 'SPECTRUM_VERSION')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T-PROC — IirSosProcessor (hilo C): mensajes AudioNodeMessage + procesado §7
// ---------------------------------------------------------------------------

describe('IirSosProcessor (hilo C, §7)', () => {
    it('T-PROC-1 — SET_BYPASS inmediato: passthrough exacto de la entrada (§7.4)', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'user-sample', ramp: { samples: 0, mode: 'crossfade' } });
        const N = 128;
        proc.onMessage({ type: 'SET_BYPASS', bypass: true, ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const input = monoBlock(N, (i) => 0.5 * Math.sin((2 * Math.PI * 5 * i) / N));
        const { inputs, outputs } = wrapIO(input);
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];
        for (let i = 0; i < N; i++) expect(out[i]).toBeCloseTo(input[i], 6);
    });

    it('T-PROC-2 — SET_COEFFICIENTS: el escalón asienta a la ganancia DC (I5)', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'user-sample', ramp: { samples: 0, mode: 'crossfade' } });
        const sos = makeSos(
            [cp(0.8, 0.6), cp(0.8, -0.6)],
            [cp(0.3, 0.1), cp(0.3, -0.1)],
            1.0,
        );
        proc.onMessage({ type: 'SET_COEFFICIENTS', sos, ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        let last = 0;
        for (let b = 0; b < 60; b++) {
            const { inputs, outputs } = wrapIO(monoBlock(N, () => 1));
            proc.process(inputs, outputs, {});
            last = outputs[0][0][N - 1];
        }
        expect(last).toBeCloseTo(dcGain(sos), 3);
    });

    it('T-PROC-3 — fuente senoidal + PLAY: salida senoidal no nula (generador interno)', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'sine', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const { inputs, outputs } = wrapIO(); // sin canal de entrada → generador
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];

        let peak = 0;
        for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
        expect(peak).toBeGreaterThan(0.5); // seno normalizado a ~1
        expect(out.some((v) => v > 0.3)).toBe(true);
        expect(out.some((v) => v < -0.3)).toBe(true);
    });

    it('T-PROC-4 — process() ejecuta 0 asignaciones (M3)', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'white-noise', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const input = monoBlock(N, (i) => 0.1 * Math.sin(i));
        const { inputs, outputs } = wrapIO(input);
        const allocs = countAllocations(() => {
            proc.process(inputs, outputs, {});
        });
        expect(allocs).toBe(0);
    });

    it('T-PROC-5 — SET_BYPASS con crossfade: residuo relativo < -80 dB al final de la rampa (§7.4)', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'user-sample', ramp: { samples: 0, mode: 'crossfade' } });
        const sos = makeSos([cp(0.9, 0.7), cp(0.9, -0.7)], [], 1.0);
        // Filtro activo con rampa crossfade (R = 256 muestras = 2 bloques)
        proc.onMessage({ type: 'SET_COEFFICIENTS', sos, ramp: { samples: 256, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const run = () => {
            const { inputs, outputs } = wrapIO(monoBlock(N, () => 1));
            proc.process(inputs, outputs, {});
            return outputs[0][0];
        };

        // Avanza la rampa de coeficientes (2 bloques) → el filtro queda activo
        run();
        run();

        // Bypass con crossfade hacia la identidad (§7.4)
        proc.onMessage({ type: 'SET_BYPASS', bypass: true, ramp: { samples: 256, mode: 'crossfade' } });

        // Avanza la rampa de bypass (2 bloques) + margen de asentamiento (1 bloque)
        run();
        run();
        run();

        // Tras la rampa: la salida debe coincidir con la entrada (1). Residuo
        // relativo < -80 dB → 10^{-80/20} = 1e-4.
        let maxResid = 0;
        for (let b = 0; b < 4; b++) {
            const out = run();
            for (let i = 0; i < N; i++) maxResid = Math.max(maxResid, Math.abs(out[i] - 1));
        }
        expect(maxResid).toBeLessThan(1e-4);
    });

    it('T-PROC-6 — ruido blanco con canal de entrada mudo: el generador interno sigue sonando (§7.4)', () => {
        // Regresión del bug "no suena el ruido": en algunos navegadores un
        // AudioWorkletNode entrega un canal de entrada mudo (a ceros) aunque no
        // haya conexiones aguas arriba. Los generadores internos NO deben
        // depender de ese canal: solo 'user-sample' lo consume.
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'white-noise', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const { inputs, outputs } = wrapIO(new Float32Array(N)); // canal presente pero mudo
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];

        let peak = 0;
        let nz = 0;
        for (let i = 0; i < N; i++) {
            peak = Math.max(peak, Math.abs(out[i]));
            if (out[i] !== 0) nz++;
        }
        expect(peak).toBeGreaterThan(0.1); // ruido audible, no silencio
        expect(nz).toBeGreaterThan(N / 2); // no es una muestra suelta
    });

    it('T-PROC-7 — seno con canal de entrada mudo: el generador interno sigue sonando', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'sine', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const { inputs, outputs } = wrapIO(new Float32Array(N));
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];
        let peak = 0;
        for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
        expect(peak).toBeGreaterThan(0.5);
    });

    it('T-PROC-8 — user-sample: filtra el canal de entrada (identidad por defecto)', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'user-sample', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const input = monoBlock(N, (i) => 0.4 * Math.sin((2 * Math.PI * 3 * i) / N));
        const { inputs, outputs } = wrapIO(input);
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];
        for (let i = 0; i < N; i++) expect(out[i]).toBeCloseTo(input[i], 6);
    });

    it('T-PROC-9 — user-sample sin canal de entrada: silencio', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'user-sample', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const { inputs, outputs } = wrapIO(); // sin canal de entrada
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];
        for (let i = 0; i < N; i++) expect(out[i]).toBe(0);
    });

    it('T-PROC-10 — none (Silencio): salida nula incluso con canal de entrada', () => {
        const proc = new IirSosProcessor({ sampleRate: 48000 });
        proc.onMessage({ type: 'SET_SOURCE', source: 'none', ramp: { samples: 0, mode: 'crossfade' } });
        proc.onMessage({ type: 'PLAY', start: true });

        const N = 128;
        const { inputs, outputs } = wrapIO(monoBlock(N, () => 1));
        proc.process(inputs, outputs, {});
        const out = outputs[0][0];
        for (let i = 0; i < N; i++) expect(out[i]).toBe(0);
    });
});
