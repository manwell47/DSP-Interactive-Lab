/**
 * src/core/sab-layout.ts
 *
 * Fase 9 — Layout canónico del SharedArrayBuffer compartido entre el DSP
 * Worker (hilo B, escritor) y el renderer de la UI (hilo A, lector directo,
 * §9.1). Único punto de verdad del tamaño/orden físico del SAB:
 *
 *   8 búferes Float64Array(L) contiguos
 *     (omega, magnitudeDb, phaseWrapped, phaseUnwrapped, groupDelay,
 *      impulse, step, scratch)
 *   + 1 Int32Array(1) con la versión atómica.
 *
 *   bytes = 8 · 8 · L + 4
 *
 * `createSabViews` infiere L del tamaño físico del SAB, por lo que el worker
 * y la UI nunca necesitan negociar la longitud por separado.
 */
import type { BufferKey } from './types';

/** Claves de búfer en el orden físico del SAB (coincide con §8). */
export const SAB_BUFFER_KEYS: readonly BufferKey[] = [
    'omega', 'magnitudeDb', 'phaseWrapped', 'phaseUnwrapped', 'groupDelay',
    'impulse', 'step', 'scratch',
];

/** Bytes por muestra Float64. */
export const F64_BYTES = 8;

/** Bytes del Int32 de versión atómica (§9.1). */
export const VERSION_INT32_BYTES = 4;

/** Número de búferes Float64Array del SAB. */
export const SAB_BUFFER_COUNT = SAB_BUFFER_KEYS.length;

/** Bytes totales del SAB para una longitud espectral L (8·8·L+4). */
export function sabByteLength(L: number): number {
    return SAB_BUFFER_COUNT * F64_BYTES * L + VERSION_INT32_BYTES;
}

/** Vistas sobre el SAB: un Float64Array por clave + la versión atómica Int32. */
export interface SabViews {
    readonly buffers: Map<BufferKey, Float64Array>;
    readonly versionView: Int32Array;
    readonly length: number;
}

/**
 * Crea las vistas sobre un SAB existente, infiriendo L del tamaño físico.
 * Lanza si `bytes` no coincide con el layout canónico 8·8·L+4 (L entero ≥ 1).
 */
export function createSabViews(sab: SharedArrayBuffer): SabViews {
    const bytes = sab.byteLength;
    const dataBytes = bytes - VERSION_INT32_BYTES;
    const L = dataBytes / (SAB_BUFFER_COUNT * F64_BYTES);
    if (dataBytes <= 0 || !Number.isInteger(L) || L < 1) {
        throw new Error(`SabLayout: tamaño de SAB no válido (${bytes} bytes)`);
    }
    const buffers = new Map<BufferKey, Float64Array>();
    let byteOffset = 0;
    for (const key of SAB_BUFFER_KEYS) {
        buffers.set(key, new Float64Array(sab, byteOffset, L));
        byteOffset += F64_BYTES * L;
    }
    const versionView = new Int32Array(sab, byteOffset, 1);
    return { buffers, versionView, length: L };
}

/** Repuebla omega[n] = n·2π/L (fijo; el motor solo lo lee, no lo escribe). */
export function fillOmega(omega: Float64Array, L: number): void {
    for (let n = 0; n < L; n++) omega[n] = (2 * Math.PI * n) / L;
}
