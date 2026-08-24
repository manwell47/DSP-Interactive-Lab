/**
 * src/core/spectrum.ts
 *
 * Motor espectral (invariantes I6, I7) — ARCHITECTURE.md §6.2, THEORY_SPECS.md
 * ec. 3.6, 4.5, 5.1–5.9 y Algoritmo 5.1.
 *
 * El contrato `computeInto(sos, buffers)` no recibe la geometría polo/cero
 * explícita (solo los coeficientes biquad), así que el motor la reconstruye
 * resolviendo las cuadráticas de numerador y denominador de cada sección
 * (polos: z² + a1·z + a2 = 0; ceros: b0·z² + b1·z + b2 = 0; la sección de
 * 1.er orden se trata como biquad con b2 = a2 = 0, cuyas raíces en el origen
 * contribuyen 0 a fase/magnitud/retardo). La geometría se cachea por
 * referencia del SosCoefficients: solo se reconstruye al cambiar el objeto.
 *
 * El barrido de relleno es zero-allocation (M1–M6):
 *
 *   - magnitudeDb    : 20·log10|H(e^{jω})| en dominio logarítmico (ec. 3.6, I5).
 *   - phaseWrapped   : Σ(atan2 num) − Σ(atan2 den) + fase de totalGain,
 *                      envuelta con atan2(sin P, cos P) (ec. 5.1).
 *   - groupDelay     : retardo de grupo ANALÍTICO de la geometría reconstruida
 *                      (ec. 4.5), nunca por diferenciación numérica (ec. 4.10).
 *   - phaseUnwrapped : Alg. 5.1 sobre la fase envuelta (ec. 5.3–5.5).
 *
 * computeInto devuelve una versión atómica que se incrementa en cada llamada
 * (la UI la usa para detectar cambios); el rebuild solo ocurre al cambiar la
 * referencia de sos.
 */
import type {
    SosCoefficients,
    SpectrumBuffers,
    SpectrumEngine as SpectrumEngineContract,
    TimeDomainBuffers,
} from './types';
import { unwrapPhase } from './phase-unwrap';
import { IirSosFilter } from './iir-sos-filter';

const DB_SCALE = 20 / Math.LN10; // 20·log10(x) = DB_SCALE·ln(x)

/**
 * Añade las raíces de c0·z² + c1·z + c2 = 0 a las listas re/im (0, 1 o 2 raíces).
 * Solo se usa en el rebuild (fuera del hot path).
 */
function solveQuadraticAdd(
    c0: number,
    c1: number,
    c2: number,
    re: number[],
    im: number[],
): void {
    if (Math.abs(c0) < 1e-18) {
        // degenerado: ecuación lineal c1·z + c2 = 0
        if (Math.abs(c1) > 1e-18) {
            re.push(-c2 / c1);
            im.push(0);
        }
        return;
    }
    const p = c1 / c0;
    const q = c2 / c0;
    // z² + p·z + q = 0  →  raíces = −p/2 ± sqrt(p² − 4q)/2
    const disc = p * p - 4 * q;
    const h = -0.5 * p;
    if (disc >= 0) {
        const s = 0.5 * Math.sqrt(disc);
        re.push(h + s, h - s);
        im.push(0, 0);
    } else {
        const s = 0.5 * Math.sqrt(-disc);
        re.push(h, h);
        im.push(s, -s);
    }
}

/** Empaqueta [re, im, r, phi] por raíz (r, phi precalculados para el hot path). */
function packRoots(re: number[], im: number[]): Float64Array {
    const arr = new Float64Array(re.length * 4);
    for (let i = 0; i < re.length; i++) {
        const b = i * 4;
        const r = Math.hypot(re[i], im[i]);
        const phi = Math.atan2(im[i], re[i]);
        arr[b] = re[i];
        arr[b + 1] = im[i];
        arr[b + 2] = r;
        arr[b + 3] = phi;
    }
    return arr;
}

/** Implementación del contrato SpectrumEngine (types.ts §4.5). */
export class SpectrumEngine implements SpectrumEngineContract {
    private version = 0;
    private lastSos: SosCoefficients | null = null;
    /** geometría reconstruida empaquetada [re, im, r, phi] por raíz */
    private poles: Float64Array = new Float64Array(0);
    private zeros: Float64Array = new Float64Array(0);
    private nPoles = 0;
    private nZeros = 0;
    private logGain = 0;     // ln|totalGain|
    private gainPhase = 0;   // π si totalGain < 0, si no 0
    /** Filtro IIR reutilizado para las respuestas temporales (zero-allocation, §6.2(5)). */
    private readonly tdFilter = new IirSosFilter();

    computeInto(sos: SosCoefficients, buffers: SpectrumBuffers): number {
        if (sos !== this.lastSos) {
            this.rebuild(sos);
            this.lastSos = sos;
        }
        this.fill(buffers);
        return ++this.version;
    }

    /**
     * Respuestas temporales h[n]/s[n] por recursión de la cascada (ARCHITECTURE.md
     * §6.2(5)): se acciona el filtro con δ[n] para el impulso y con escalón
     * (entrada constante 1) para s[n] = Σ_{k≤n} h[k]. Escribe en los búferes
     * reutilizados TimeDomainBuffers sin asignar memoria (M1).
     */
    computeTimeDomain(sos: SosCoefficients, buffers: TimeDomainBuffers): void {
        const Nt = Math.min(buffers.length, buffers.impulse.length, buffers.step.length);
        this.tdFilter.setSos(sos);
        this.tdFilter.resetState();
        for (let n = 0; n < Nt; n++) {
            buffers.impulse[n] = this.tdFilter.processSample(n === 0 ? 1 : 0);
        }
        this.tdFilter.resetState();
        for (let n = 0; n < Nt; n++) {
            buffers.step[n] = this.tdFilter.processSample(1);
        }
    }

    private rebuild(sos: SosCoefficients): void {
        const polesRe: number[] = [];
        const polesIm: number[] = [];
        const zerosRe: number[] = [];
        const zerosIm: number[] = [];
        for (const sec of sos.sections) {
            solveQuadraticAdd(1, sec.a1, sec.a2, polesRe, polesIm);
            solveQuadraticAdd(sec.b0, sec.b1, sec.b2, zerosRe, zerosIm);
        }
        if (sos.firstOrderSection) {
            const sec = sos.firstOrderSection;
            solveQuadraticAdd(1, sec.a1, 0, polesRe, polesIm);
            solveQuadraticAdd(sec.b0, sec.b1, 0, zerosRe, zerosIm);
        }
        this.nPoles = polesRe.length;
        this.nZeros = zerosRe.length;
        this.poles = packRoots(polesRe, polesIm);
        this.zeros = packRoots(zerosRe, zerosIm);
        this.logGain = Math.log(Math.abs(sos.totalGain));
        this.gainPhase = sos.totalGain < 0 ? Math.PI : 0;
    }

    /** Barrido zero-allocation: escribe magnitudeDb, phaseWrapped, groupDelay y desenvuelve. */
    private fill(buf: SpectrumBuffers): void {
        const L = Math.min(
            buf.length,
            buf.omega.length,
            buf.magnitudeDb.length,
            buf.phaseWrapped.length,
            buf.groupDelay.length,
            buf.phaseUnwrapped.length,
        );
        for (let n = 0; n < L; n++) {
            const w = buf.omega[n];
            let logMag = this.logGain;
            let P = this.gainPhase;
            let tau = 0;
            // polos (denominador): restan en magnitud/fase, suman en retardo
            for (let i = 0; i < this.nPoles; i++) {
                const b = i * 4;
                const r = this.poles[b + 2];
                const phi = this.poles[b + 3];
                const dw = w - phi;
                const d = Math.cos(dw);
                const f2 = 1 - 2 * r * d + r * r;
                logMag -= 0.5 * Math.log(f2);
                P -= Math.atan2(r * Math.sin(dw), 1 - r * d);
                tau += (r * d - r * r) / f2;
            }
            // ceros (numerador): suman en magnitud/fase, restan en retardo
            for (let i = 0; i < this.nZeros; i++) {
                const b = i * 4;
                const r = this.zeros[b + 2];
                const phi = this.zeros[b + 3];
                const dw = w - phi;
                const d = Math.cos(dw);
                const f2 = 1 - 2 * r * d + r * r;
                logMag += 0.5 * Math.log(f2);
                P += Math.atan2(r * Math.sin(dw), 1 - r * d);
                tau -= (r * d - r * r) / f2;
            }
            buf.magnitudeDb[n] = DB_SCALE * logMag;
            buf.phaseWrapped[n] = Math.atan2(Math.sin(P), Math.cos(P));
            buf.groupDelay[n] = tau;
        }
        // Alg. 5.1 (ec. 5.3–5.5) sobre la fase envuelta ya escrita
        unwrapPhase(buf.phaseWrapped, buf.phaseUnwrapped);
    }
}
