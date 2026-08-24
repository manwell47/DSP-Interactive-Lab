/**
 * src/ui/inspector-view.ts
 *
 * Fase 9 — Hilo A: inspector matemático y de control de audio (ARCHITECTURE.md §5).
 *
 * Renderiza el SOS como texto para el panel de inspección:
 *   - formatTransfer : H(z) = K · ∏ (b0 + b1 z^-1 + b2 z^-2 / 1 + a1 z^-1 + a2 z^-2)
 *   - formatEquation : sección k: y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2]
 *                                     − a1 y[n-1] − a2 y[n-2]  (forma de recursión)
 * Mantiene además el estado de control de audio (fuente, ganancia, bypass, play)
 * que el DspApp propaga al nodo de audio vía AudioGraphRelay.
 *
 * Formateo numérico sin ambigüedad: `fmt` (toFixed(4) sin ceros finales) y
 * `signed` (signo explícito) para coeficientes negativos.
 *
 * Sin dependencias del DOM (tsconfig lib = ES2020): produce cadenas puras.
 */
import type { AudioSourceId, SosCoefficients } from '../core/types';

/** Número a 4 decimales sin ceros finales; |x| < 1e-9 → '0'. */
export function fmt(x: number): string {
    if (Math.abs(x) < 1e-9) return '0';
    let s = x.toFixed(4);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}

/** Coeficiente con signo explícito: '- 1.2' / '+ 0.36' / '+ 0'. */
export function signed(c: number): string {
    return c < 0 ? `- ${fmt(-c)}` : `+ ${fmt(c)}`;
}

/** Sección biquad como fracción (b0 + b1 z^-1 + b2 z^-2 / 1 + a1 z^-1 + a2 z^-2). */
function sectionString(b: { b0: number; b1: number; b2: number; a1: number; a2: number }): string {
    return `(${fmt(b.b0)} ${signed(b.b1)} z^-1 ${signed(b.b2)} z^-2 / 1 ${signed(b.a1)} z^-1 ${signed(b.a2)} z^-2)`;
}

/** Recursión de una sección (ec. 3.3 en forma de diferencia). */
function equationString(
    i: number,
    b: { b0: number; b1: number; b2: number; a1: number; a2: number },
): string {
    return `sección ${i}: y[n] = ${fmt(b.b0)} x[n] ${signed(b.b1)} x[n-1] ${signed(b.b2)} x[n-2] ${signed(-b.a1)} y[n-1] ${signed(-b.a2)} y[n-2]`;
}

export class InspectorView {
    private _source: AudioSourceId = 'white-noise';
    private _gain = 1;
    private _bypass = false;
    private _playing = false;

    /** Fuente de audio seleccionada (inspector de audio de la UI). */
    get source(): AudioSourceId { return this._source; }
    set source(v: AudioSourceId) { this._source = v; }

    /** Ganancia de reproducción del nodo. */
    get gain(): number { return this._gain; }
    set gain(v: number) { this._gain = v; }

    /** Bypass del filtro en el nodo. */
    get bypass(): boolean { return this._bypass; }
    set bypass(v: boolean) { this._bypass = v; }

    /** Reproducción activa en el nodo. */
    get playing(): boolean { return this._playing; }
    set playing(v: boolean) { this._playing = v; }

    /** H(z) = K · ∏ secciones, incluyendo la sección de 1.er orden (I4) si existe. */
    static formatTransfer(sos: SosCoefficients): string {
        const parts: string[] = sos.sections.map(sectionString);
        if (sos.firstOrderSection) parts.push(sectionString(sos.firstOrderSection));
        return `H(z) = ${fmt(sos.totalGain)} · ${parts.join(' · ')}`;
    }

    /** Recursión de cada sección (una línea por sección). */
    static formatEquation(sos: SosCoefficients): string {
        const lines: string[] = sos.sections.map((s, i) => equationString(i, s));
        if (sos.firstOrderSection) lines.push(equationString(sos.sections.length, sos.firstOrderSection));
        return lines.join('\n');
    }
}
