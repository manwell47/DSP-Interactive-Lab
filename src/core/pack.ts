/**
 * src/core/pack.ts
 *
 * Fase 8 — Empaquetado/desempaquetado de raíces (polos/ceros) entre la
 * representación de dominio `Complex[]` y la transferible
 * `PackedComplexArray` (Float64Array [re, im] interleaved).
 *
 * La UI (hilo A) empaqueta una vez por frame (coalescing M5) y el worker
 * (hilo B) desempaqueta en la vía de cómputo. Único punto de serialización,
 * compartido por ambos lados.
 */
import type { Complex, PackedComplexArray } from './types';

/** Empaqueta raíces en PackedComplexArray (sin copias innecesarias). */
export function packRoots(roots: readonly Complex[]): PackedComplexArray {
    const data = new Float64Array(roots.length * 2);
    for (let i = 0; i < roots.length; i++) {
        data[2 * i] = roots[i].re;
        data[2 * i + 1] = roots[i].im;
    }
    return { data, count: roots.length };
}

/** Desempaqueta PackedComplexArray → Complex[] (tolera count > data.length/2). */
export function unpackRoots(packed: PackedComplexArray): Complex[] {
    const n = Math.min(packed.count, Math.floor(packed.data.length / 2));
    const out: Complex[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ re: packed.data[2 * i], im: packed.data[2 * i + 1] });
    }
    return out;
}
