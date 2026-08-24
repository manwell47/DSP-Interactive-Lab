/**
 * src/core/buffer-pool.ts
 *
 * Fase 6 — BufferPool (ARCHITECTURE.md §8; invariantes M1, M6):
 *   Pool de búferes Float64Array preasignados (GC-safe) con las 8 claves de
 *   BufferKey: omega, magnitudeDb, phaseWrapped, phaseUnwrapped, groupDelay,
 *   impulse, step, scratch.
 *
 * Garantías:
 *   - M1 : todos los vectores se preasignan una vez en el constructor
 *          (longitud fija L/Nt); acquire() devuelve el búfer residente sin
 *          asignar memoria y release() solo marca libre (sin GC).
 *   - M6 : resizeAll(length) es la única operación de (re)asignación masiva;
 *          si la longitud no cambia, conserva la identidad de los búferes.
 */
import type { BufferKey, BufferPool as BufferPoolContract } from './types';

/** Las 8 claves del pool (ARCHITECTURE.md §8, types.ts §4.4). */
const ALL_KEYS: readonly BufferKey[] = [
    'omega', 'magnitudeDb', 'phaseWrapped', 'phaseUnwrapped', 'groupDelay',
    'impulse', 'step', 'scratch',
];

/** Implementación del contrato BufferPool (types.ts §4.4). */
export class BufferPool implements BufferPoolContract {
    private readonly buffers: Record<BufferKey, Float64Array>;
    private length: number;

    constructor(length: number) {
        this.length = length;
        this.buffers = {
            omega: new Float64Array(length),
            magnitudeDb: new Float64Array(length),
            phaseWrapped: new Float64Array(length),
            phaseUnwrapped: new Float64Array(length),
            groupDelay: new Float64Array(length),
            impulse: new Float64Array(length),
            step: new Float64Array(length),
            scratch: new Float64Array(length),
        };
    }

    /** Devuelve el búfer residente para la clave (sin asignación, M1). */
    acquire(key: BufferKey): Float64Array {
        return this.buffers[key];
    }

    /** Marca libre (no GC): con un pool residente no hay nada que hacer. */
    release(_key: BufferKey): void {
        // sin operación: los ArrayBuffer permanecen vivos (M1)
    }

    /** Reasigna los 8 búferes (única (re)asignación masiva, M6). */
    resizeAll(length: number): void {
        if (length === this.length) return; // misma longitud: conserva identidad
        this.length = length;
        for (const key of ALL_KEYS) {
            this.buffers[key] = new Float64Array(length);
        }
    }
}
