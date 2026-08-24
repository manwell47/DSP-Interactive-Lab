/**
 * src/core/types.ts
 *
 * Tipos de dominio inmutables y contratos de los módulos DSP.
 * Fuente de verdad arquitectónica: ARCHITECTURE.md §4 (Estructuras de Datos e Interfaces).
 * Fuente de verdad matemática: THEORY_SPECS.md (ecuaciones 3.3, 3.5, 4.5, 5.1–5.9, 6.3–6.6).
 *
 * Todos los tipos de dominio son inmutables en la API pública. Las representaciones
 * de alto rendimiento (empaquetadas / preasignadas) son tipos separados para no
 * contaminar la API con detalles de memoria (política zero-allocation, §8).
 */

// ---------------------------------------------------------------------------
// Constantes de diseño (THEORY_SPECS.md §6.2)
// ---------------------------------------------------------------------------

/**
 * Restricción de radio de diseño — ec. 6.3 (invariante I1).
 * Todo polo debe satisfacer |d_k| = r_k <= MAX_POLE_RADIUS.
 * Garantiza estabilidad BIBO (ec. 6.2) y acota G_max <= 1e8 (ec. 6.6).
 */
export const MAX_POLE_RADIUS = 0.9999;

/**
 * Longitud espectral por defecto — ARCHITECTURE.md §4.2.
 * L = 65536 satisface la condición de desenvolvimiento (ec. 5.7) para
 * el peor caso r = 0.9999 (margen ~1.6× sobre L >= 4e4).
 */
export const DEFAULT_SPECTRUM_LENGTH = 65536;

/**
 * Frecuencia de muestreo de referencia (ARCHITECTURE.md §12, supuesto 3).
 * El motor usa frecuencias normalizadas omega = 2·pi·f/fs (independiente de fs).
 */
export const REFERENCE_SAMPLE_RATE = 48_000;

/** Número máximo de biquads soportado (N <= 64) — ARCHITECTURE.md §12, supuesto 4. */
export const MAX_BIQUADS = 32;

// ---------------------------------------------------------------------------
// §4.1 Tipos inmutables del dominio
// ---------------------------------------------------------------------------

/** Número complejo inmutable (polos y ceros del plano Z). */
export interface Complex {
    readonly re: number;
    readonly im: number;
}

/** Par conjugado r·e^{±jθ} — invariantes I2, I3 (ec. 3.3). */
export interface ConjugatePair {
    readonly plus: Complex;   // r·e^{+jθ}
    readonly minus: Complex;  // r·e^{-jθ}
}

/** Coeficientes de una sección biquad — ec. 3.3 (I2, I3). */
export interface BiquadCoefficients {
    readonly b0: number; // = 1 (o K_k si se absorbe ganancia de sección)
    readonly b1: number; // = -2·ρ_z·cos(φ_z)
    readonly b2: number; // = ρ_z²
    readonly a1: number; // = -2·r_p·cos(θ_p)
    readonly a2: number; // = r_p²
    readonly k: number;  // ganancia de sección K_k (I5); típicamente 1 tras normalizar
}

/** Coeficientes SOS completos — invariantes I1–I5, I8. */
export interface SosCoefficients {
    readonly sections: readonly BiquadCoefficients[];       // N_s = ceil(N/2) biquads
    readonly firstOrderSection: BiquadCoefficients | null;  // I4 (solo N impar)
    readonly totalGain: number;   // K = ∏ K_k  (ec. 3.5)
    readonly order: number;       // N
}

/** Estado inmutable del plano Z — invariante I1 (radio clamp 0.9999). */
export interface ZPlaneState {
    readonly poles: readonly Complex[];
    readonly zeros: readonly Complex[];
    readonly gain: number; // K del usuario
}

// ---------------------------------------------------------------------------
// §4.2 Búferes reutilizables (zero-allocation)
// ---------------------------------------------------------------------------

/** Búferes espectrales preasignados — invariantes I6, I7. */
export interface SpectrumBuffers {
    readonly omega: Float64Array;         // ω_n = n·Δω, n = 0..L-1 (fijo)
    readonly magnitudeDb: Float64Array;   // 20·log10|H(e^{jω})|  (ec. 3.6)
    readonly phaseWrapped: Float64Array;  // φ_n = atan2 (ec. 5.1)
    readonly phaseUnwrapped: Float64Array;// θ_u[n]  (Alg. 5.1 / ec. 5.9)
    readonly groupDelay: Float64Array;    // τ_g(ω)  (ec. 4.5)
    readonly length: number;              // L
}

/** Búferes de dominio temporal (respuesta al impulso y escalón). */
export interface TimeDomainBuffers {
    readonly impulse: Float64Array; // h[n] = H(δ[n])
    readonly step: Float64Array;    // s[n]
    readonly length: number;        // Nt
}

// ---------------------------------------------------------------------------
// §4.3 Mensajería entre hilos
// ---------------------------------------------------------------------------

/** Fuente de audio seleccionable (inspector de audio de la UI). */
export type AudioSourceId = 'white-noise' | 'sine' | 'user-sample' | 'none';

/** Especificación de la rampa anti-click (ARCHITECTURE.md §7.3). */
export interface SmoothingRamp {
    readonly samples: number;      // R: longitud de la rampa en muestras
    readonly mode: 'linear' | 'crossfade';
}

/** Mensajes dirigidos al AudioWorkletProcessor (hilo C). */
export type AudioNodeMessage =
    | {
        readonly type: 'SET_COEFFICIENTS';
        readonly sos: SosCoefficients; // SOS completo: incluye totalGain y firstOrderSection (I5, I4)
        readonly ramp: SmoothingRamp
    }
    | { readonly type: 'SET_SOURCE'; readonly source: AudioSourceId; readonly ramp: SmoothingRamp }
    | { readonly type: 'SET_GAIN'; readonly gain: number; readonly ramp: SmoothingRamp }
    | { readonly type: 'SET_BYPASS'; readonly bypass: boolean; readonly ramp: SmoothingRamp }
    | { readonly type: 'PLAY'; readonly start: boolean };

/** Mensajes UI → DSP Worker (hilo B). */
export type WorkerRequest =
    | { readonly type: 'SET_Z_PLANE'; readonly poles: PackedComplexArray; readonly zeros: PackedComplexArray; readonly gain: number }
    | { readonly type: 'SET_SPECTRUM_LENGTH'; readonly length: number }
    | { readonly type: 'PING' };

/** Mensajes DSP Worker → UI (hilo B). */
export type WorkerResponse =
    | {
        readonly type: 'SPECTRUM_VERSION';
        readonly version: number;
        // SAB recién escrito (presente tras SET_Z_PLANE / SET_SPECTRUM_LENGTH).
        // La UI lo convierte en vistas con createSabViews (sab-layout.ts, §9.1).
        readonly sharedBuffer?: SharedArrayBuffer;
    }
    | { readonly type: 'COEFFICIENTS'; readonly sos: SosCoefficients }
    | { readonly type: 'PONG' }; // respuesta a PING (heartbeat, §3.2)

// ---------------------------------------------------------------------------
// §4.4 Primitivas zero-allocation
// ---------------------------------------------------------------------------

/** Representación empaquetada (re, im) entrelazados: sin objetos por polo. */
export interface PackedComplexArray {
    readonly data: Float64Array; // [re0, im0, re1, im1, …]
    readonly count: number;      // número de elementos válidos
}

/** Claves de pool de búferes preasignados (ARCHITECTURE.md §8). */
export type BufferKey =
    | 'omega' | 'magnitudeDb' | 'phaseWrapped' | 'phaseUnwrapped' | 'groupDelay'
    | 'impulse' | 'step' | 'scratch';

/** Pool de búferes Float64Array preasignados (GC-safe). */
export interface BufferPool {
    /** devuelve búfer residente */
    readonly acquire: (key: BufferKey) => Float64Array;
    /** marca libre (no GC) */
    readonly release: (key: BufferKey) => void;
    /** reasigna todos (raro) */
    readonly resizeAll: (length: number) => void;
}

// ---------------------------------------------------------------------------
// §4.5 Contratos de los módulos DSP (mapeo a invariantes)
// ---------------------------------------------------------------------------

/** Sintetizador SOS — I1, I2, I3, I4, I5, I8. Puro e inmutable. */
export interface SosSynthesizer {
    /** No muta la entrada; devuelve un nuevo SosCoefficients. */
    compute(state: ZPlaneState): SosCoefficients;
}

/** Motor espectral — I6, I7; ec. 3.6, 4.5, 5.9; Alg. 5.1. */
export interface SpectrumEngine {
    /** Escribe en buffers reutilizados; devuelve versión atómica. */
    computeInto(sos: SosCoefficients, buffers: SpectrumBuffers): number;
    /** Respuestas temporales h[n]/s[n] por recursión de la cascada (§6.2(5)). */
    computeTimeDomain(sos: SosCoefficients, buffers: TimeDomainBuffers): void;
}

/** Filtro IIR en tiempo real (AudioWorklet) — I9. Sin asignación. */
export interface IirSosFilter {
    readonly process: (input: Float32Array, output: Float32Array) => void;
}
