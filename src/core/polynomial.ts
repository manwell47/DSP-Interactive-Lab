/**
 * src/core/polynomial.ts
 *
 * Álgebra polinómica compleja para la verificación de la identidad de cascada
 * (invariante I9, ec. 3.5) y para la transformación polos/ceros → forma directa.
 *
 * Convención: un polinomio P(z) = Σ c_k·z^{-k} se representa como Complex[],
 * con c[0] = término constante y c[k] el coeficiente de z^{-k}.
 */
import type { Complex } from './types';

export function complexAdd(a: Complex, b: Complex): Complex {
    return { re: a.re + b.re, im: a.im + b.im };
}

export function complexMul(a: Complex, b: Complex): Complex {
    return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

/** Convolución polinómica (producto) de dos polinomios en z^{-1}. */
export function polyMultiply(a: readonly Complex[], b: readonly Complex[]): Complex[] {
    const n = a.length + b.length - 1;
    const out: Complex[] = [];
    for (let i = 0; i < n; i++) out.push({ re: 0, im: 0 });
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        for (let j = 0; j < b.length; j++) {
            const m = complexMul(ai, b[j]);
            const prev = out[i + j];
            out[i + j] = { re: prev.re + m.re, im: prev.im + m.im };
        }
    }
    return out;
}

/** ∏_k (1 − r_k·z^{-1}) a partir de las raíces — numerador/denominador factorizados. */
export function polyFromRoots(roots: readonly Complex[]): Complex[] {
    let poly: Complex[] = [{ re: 1, im: 0 }];
    for (const r of roots) {
        poly = polyMultiply(poly, [{ re: 1, im: 0 }, { re: -r.re, im: -r.im }]);
    }
    return poly;
}

/** Producto de una lista de polinomios. */
export function polyProduct(polys: readonly (readonly Complex[])[]): Complex[] {
    let acc: Complex[] = [{ re: 1, im: 0 }];
    for (const p of polys) acc = polyMultiply(acc, p);
    return acc;
}

/** Máxima desviación (norma infinito) entre dos polinomios (residuo de identidad). */
export function polyMaxAbsDiff(a: readonly Complex[], b: readonly Complex[]): number {
    const n = Math.max(a.length, b.length);
    let max = 0;
    for (let i = 0; i < n; i++) {
        const x = i < a.length ? a[i] : { re: 0, im: 0 };
        const y = i < b.length ? b[i] : { re: 0, im: 0 };
        const d = Math.hypot(x.re - y.re, x.im - y.im);
        if (d > max) max = d;
    }
    return max;
}
