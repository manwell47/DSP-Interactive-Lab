/**
 * src/core/transfer.ts
 *
 * Evaluación de la función de transferencia H(z) sobre el círculo unidad
 * (ec. 2.2) y de la cascada SOS (ec. 3.6).
 *
 *  - evaluateHAt: forma factorizada desde polos/ceros (dominio logarítmico,
 *    inmune al overflow de resonancias agudas).
 *  - evaluateSosAt: cascada SOS con totalGain aplicado (ec. 3.5, I5/I9).
 */
import type { Complex, SosCoefficients } from './types';

export interface ComplexValue {
    readonly re: number;
    readonly im: number;
}

/** Factor (1 − d·e^{-jω}) en forma polar (ec. 2.3–2.4, 4.3). Zero-allocation. */
function factor(omega: number, root: Complex): { mag: number; phase: number } {
    const r = Math.hypot(root.re, root.im);
    const phi = Math.atan2(root.im, root.re);
    const d = Math.cos(omega - phi);
    const mag2 = 1 - 2 * r * d + r * r;
    return {
        mag: Math.sqrt(mag2),
        phase: Math.atan2(r * Math.sin(omega - phi), 1 - r * Math.cos(omega - phi)),
    };
}

/**
 * ec. 2.2 — H(e^{jω}) = K·∏_ceros (1−c·e^{-jω}) / ∏_polos (1−d·e^{-jω}).
 * La magnitud se acumula en log para evitar overflow (relacionado con I5).
 */
export function evaluateHAt(
    omega: number,
    poles: readonly Complex[],
    zeros: readonly Complex[],
    gain = 1,
): ComplexValue {
    let logMag = Math.log(Math.abs(gain));
    let phase = gain < 0 ? Math.PI : 0;
    for (const z of zeros) {
        const f = factor(omega, z);
        logMag += Math.log(f.mag);
        phase += f.phase;
    }
    for (const p of poles) {
        const f = factor(omega, p);
        logMag -= Math.log(f.mag);
        phase -= f.phase;
    }
    const mag = Math.exp(logMag);
    return { re: mag * Math.cos(phase), im: mag * Math.sin(phase) };
}

/** Evalúa c0 + c1·z^{-1} + c2·z^{-2} en z = e^{jω} (z^{-k} = e^{-jkω}). */
function poly2(c0: number, c1: number, c2: number, omega: number): ComplexValue {
    const c = Math.cos(omega);
    const s = Math.sin(omega);
    const c2w = Math.cos(2 * omega);
    const s2w = Math.sin(2 * omega);
    return { re: c0 + c1 * c + c2 * c2w, im: -(c1 * s + c2 * s2w) };
}

function cdiv(num: ComplexValue, den: ComplexValue): ComplexValue {
    const d = den.re * den.re + den.im * den.im;
    return {
        re: (num.re * den.re + num.im * den.im) / d,
        im: (num.im * den.re - num.re * den.im) / d,
    };
}

function cmul(a: ComplexValue, b: ComplexValue): ComplexValue {
    return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

/**
 * ec. 3.6 — H(e^{jω}) de la cascada SOS: totalGain · ∏_k rawH_k(z),
 * con la ganancia de sección K_k ya plegada en totalGain (I5).
 */
export function evaluateSosAt(omega: number, sos: SosCoefficients): ComplexValue {
    let acc: ComplexValue = { re: sos.totalGain, im: 0 };
    for (const sec of sos.sections) {
        const num = poly2(sec.b0, sec.b1, sec.b2, omega);
        const den = poly2(1, sec.a1, sec.a2, omega);
        acc = cmul(acc, cdiv(num, den));
    }
    if (sos.firstOrderSection) {
        const sec = sos.firstOrderSection;
        const num = poly2(sec.b0, sec.b1, 0, omega);
        const den = poly2(1, sec.a1, 0, omega);
        acc = cmul(acc, cdiv(num, den));
    }
    return acc;
}

/** Magnitud de un biquad crudo (k = 1) en ω — usado para el escalado I5. */
export function evaluateBiquadMagnitude(
    sec: { readonly b0: number; readonly b1: number; readonly b2: number; readonly a1: number; readonly a2: number },
    omega: number,
): number {
    const num = poly2(sec.b0, sec.b1, sec.b2, omega);
    const den = poly2(1, sec.a1, sec.a2, omega);
    return Math.hypot(num.re, num.im) / Math.hypot(den.re, den.im);
}
