/**
 * src/core/SosSynthesizer.ts
 *
 * Sintetizador SOS puro e inmutable (invariantes I1–I5, I8) — ec. 3.3–3.5 de
 * THEORY_SPECS.md y §6.1 de ARCHITECTURE.md.
 *
 * Pipeline:
 *   1. Clamp de radio (I1, ec. 6.3): r_k = min(r_k, 0.9999).
 *   2. Partición en pares conjugados + polos reales (emparejamiento de Jackson, I8).
 *   3. Coeficientes de biquad (I2/I3, ec. 3.3).
 *   4. Sección de 1.er orden si N es impar (I4, ec. 3.4).
 *   5. Escalado de ganancia por sección (I5): k = 1/G_max; totalGain = gain·∏k.
 *   6. Ordenación por resonancia decreciente (I8, §3.6).
 */
import type {
    BiquadCoefficients,
    Complex,
    SosCoefficients,
    SosSynthesizer as SosSynthesizerContract,
    ZPlaneState,
} from './types';
import { MAX_POLE_RADIUS } from './types';
import { evaluateBiquadMagnitude } from './transfer';

const CONJ_EPS = 1e-9;

type RootGroup =
    | { readonly kind: 'conjugate'; readonly plus: Complex; readonly minus: Complex }
    | { readonly kind: 'real-pair'; readonly p1: Complex; readonly p2: Complex }
    | { readonly kind: 'real-single'; readonly p: Complex };

/** I1 — clamp de radio (ec. 6.3). Devuelve un objeto nuevo; no muta la entrada. */
function clampRadius(p: Complex): Complex {
    const r = Math.hypot(p.re, p.im);
    if (r <= MAX_POLE_RADIUS) return { re: p.re, im: p.im };
    const s = MAX_POLE_RADIUS / r;
    return { re: p.re * s, im: p.im * s };
}

function groupRep(g: RootGroup): Complex {
    if (g.kind === 'conjugate') return g.plus;
    if (g.kind === 'real-pair') return g.p1;
    return g.p;
}

/** Particiona raíces en pares conjugados, pares reales y reales sueltos (I8). */
function partitionGroups(roots: readonly Complex[]): RootGroup[] {
    const used = new Array<boolean>(roots.length).fill(false);
    const groups: RootGroup[] = [];
    const reals: Complex[] = [];
    for (let i = 0; i < roots.length; i++) {
        if (used[i]) continue;
        const p = roots[i];
        if (Math.abs(p.im) > CONJ_EPS) {
            let mate = -1;
            for (let j = i + 1; j < roots.length; j++) {
                if (
                    !used[j] &&
                    Math.abs(roots[j].re - p.re) < CONJ_EPS &&
                    Math.abs(roots[j].im + p.im) < CONJ_EPS
                ) {
                    mate = j;
                    break;
                }
            }
            if (mate < 0) {
                throw new Error('SosSynthesizer: polo/cero complejo sin conjugado (filtro no real).');
            }
            used[i] = true;
            used[mate] = true;
            groups.push({ kind: 'conjugate', plus: p, minus: roots[mate] });
        } else {
            used[i] = true;
            reals.push(p);
        }
    }
    for (let i = 0; i + 1 < reals.length; i += 2) {
        groups.push({ kind: 'real-pair', p1: reals[i], p2: reals[i + 1] });
    }
    if (reals.length % 2 === 1) {
        groups.push({ kind: 'real-single', p: reals[reals.length - 1] });
    }
    return groups;
}

/** I2/I3 — biquad desde un grupo de polos (biquad) y un grupo de ceros (ec. 3.3). */
function buildBiquad(pg: RootGroup, zg: RootGroup | null): BiquadCoefficients {
    let a1: number;
    let a2: number;
    if (pg.kind === 'conjugate') {
        const r = Math.hypot(pg.plus.re, pg.plus.im);
        const th = Math.atan2(pg.plus.im, pg.plus.re);
        a1 = -2 * r * Math.cos(th);
        a2 = r * r;
    } else if (pg.kind === 'real-pair') {
        a1 = -(pg.p1.re + pg.p2.re);
        a2 = pg.p1.re * pg.p2.re;
    } else {
        throw new Error('SosSynthesizer: un polo real suelto no construye un biquad.');
    }

    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    if (zg !== null) {
        if (zg.kind === 'conjugate') {
            const rho = Math.hypot(zg.plus.re, zg.plus.im);
            const phi = Math.atan2(zg.plus.im, zg.plus.re);
            b1 = -2 * rho * Math.cos(phi);
            b2 = rho * rho;
        } else if (zg.kind === 'real-pair') {
            b1 = -(zg.p1.re + zg.p2.re);
            b2 = zg.p1.re * zg.p2.re;
        } else {
            b1 = -zg.p.re;
        }
    }
    return { b0, b1, b2, a1, a2, k: 1 };
}

/** I4 — sección de primer orden para el polo real sin emparejar (ec. 3.4). */
function buildFirstOrder(pg: RootGroup, zg: RootGroup | null): BiquadCoefficients {
    if (pg.kind !== 'real-single') {
        throw new Error('SosSynthesizer: la sección de 1.er orden requiere un polo real suelto.');
    }
    const a1 = -pg.p.re;
    let b1 = 0;
    if (zg !== null && zg.kind === 'real-single') b1 = -zg.p.re;
    return { b0: 1, b1, b2: 0, a1, a2: 0, k: 1 };
}

/**
 * I5 — ganancia de pico de un biquad crudo (k=1). Se evalúa en los candidatos
 * ω ∈ {0, π} y en los puntos estacionarios de |num|² y |den|² (cosω = −c1(1+c2)/(4c2)).
 */
function biquadPeakGain(
    sec: { readonly b0: number; readonly b1: number; readonly b2: number; readonly a1: number; readonly a2: number },
): number {
    const candidates: number[] = [0, Math.PI];
    if (Math.abs(sec.a2) > 1e-15) {
        const cosDen = (-sec.a1 * (1 + sec.a2)) / (4 * sec.a2);
        if (Math.abs(cosDen) <= 1) candidates.push(Math.acos(cosDen));
    }
    if (Math.abs(sec.b2) > 1e-15) {
        const cosNum = (-sec.b1 * (1 + sec.b2)) / (4 * sec.b2);
        if (Math.abs(cosNum) <= 1) candidates.push(Math.acos(cosNum));
    }
    let peak = 0;
    for (const w of candidates) {
        const m = evaluateBiquadMagnitude(sec, w);
        if (m > peak) peak = m;
    }
    return peak;
}

/** Implementación del contrato SosSynthesizer (types.ts §4.5). */
export class SosSynthesizer implements SosSynthesizerContract {
    compute(state: ZPlaneState): SosCoefficients {
        // 1. I1 — clamp de radio
        const poles = state.poles.map(clampRadius);
        const zeros = state.zeros;

        // 2. I8 — partición en grupos (pares conjugados / pares reales / reales sueltos)
        const poleGroups = partitionGroups(poles);
        const zeroGroups = partitionGroups(zeros);

        // Emparejamiento de Jackson (I8): cada grupo de polos con el grupo de ceros
        // geométricamente más cercano (mínima distancia polo–cero).
        const assignedZeros = new Array<boolean>(zeroGroups.length).fill(false);
        const poleZeroMap: Array<RootGroup | null> = new Array(poleGroups.length).fill(null);
        for (let i = 0; i < poleGroups.length; i++) {
            const pg = poleGroups[i];
            let best: RootGroup | null = null;
            let bestDist = Infinity;
            for (let j = 0; j < zeroGroups.length; j++) {
                if (assignedZeros[j]) continue;
                const zg = zeroGroups[j];
                if (pg.kind === 'real-single' && zg.kind !== 'real-single') continue;
                const a = groupRep(pg);
                const b = groupRep(zg);
                const d = Math.hypot(a.re - b.re, a.im - b.im);
                if (d < bestDist) {
                    bestDist = d;
                    best = zg;
                }
            }
            if (best !== null) {
                assignedZeros[zeroGroups.indexOf(best)] = true;
            }
            poleZeroMap[i] = best;
        }

        // 3–5. Coeficientes + escalado de ganancia (I2/I3/I4/I5)
        const sections: BiquadCoefficients[] = [];
        let firstOrderSection: BiquadCoefficients | null = null;
        let totalGain = state.gain; // K del usuario; se multiplica por cada K_k (I5)

        for (let i = 0; i < poleGroups.length; i++) {
            const pg = poleGroups[i];
            const zg = poleZeroMap[i];
            if (pg.kind === 'real-single') {
                const raw = buildFirstOrder(pg, zg);
                const k = 1 / biquadPeakGain(raw);
                firstOrderSection = { ...raw, k };
                totalGain *= k;
            } else {
                const raw = buildBiquad(pg, zg);
                const k = 1 / biquadPeakGain(raw);
                sections.push({ ...raw, k });
                totalGain *= k;
            }
        }

        // 6. I8 — ordenación por resonancia decreciente (radio de polo = sqrt(|a2|))
        sections.sort((a, b) => Math.sqrt(Math.abs(b.a2)) - Math.sqrt(Math.abs(a.a2)));

        return {
            sections,
            firstOrderSection,
            totalGain,
            order: poles.length,
        };
    }
}
