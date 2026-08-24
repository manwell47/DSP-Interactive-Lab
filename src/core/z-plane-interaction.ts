/**
 * src/core/z-plane-interaction.ts
 *
 * Fase 8 — Hilo A: máquina de estado de interacción del plano Z.
 *
 * Mantiene los polos/ceros/ganancia editables y responde a gestos de puntero:
 *   - hitTest      : ¿qué raíz (polo/cero) está bajo un punto de píxel?
 *   - beginDrag    : selecciona la raíz bajo el puntero o, si no hay ninguna,
 *                    crea un POLO en el punto clampeado a la circunferencia
 *                    unidad (|z| ≤ 1). Devuelve el objetivo arrastrado.
 *   - dragTo       : mueve el objetivo. Los POLOS se clampean a |z| ≤ 1
 *                    (clamp visual; el worker re-clampea a MAX_POLE_RADIUS,
 *                    invariante I1). Los CEROS pueden salir de la circunferencia.
 *   - deleteSelected / setGain / snapshot.
 *
 * Módulo de estado puro: no toca el DOM ni el worker (la UI los orquesta en
 * interaction-manager.ts / audio-graph.ts).
 */
import { pixelToZ, zPixelDistance, zToPixel } from './z-plane-layout';
import type { ZPlaneLayout } from './z-plane-layout';
import type { Complex, ZPlaneState } from './types';

/** Estado editable (mutable) del plano Z. */
export interface ZPlaneInteractionState {
    poles: Complex[];
    zeros: Complex[];
    gain: number;
}

/** Referencia a una raíz concreta (polo o cero por índice). */
export interface RootTarget {
    readonly kind: 'pole' | 'zero';
    /** Índice mutable: las eliminaciones de espejos huérfanos pueden desplazarlo. */
    index: number;
}

/** Objetivo golpeado por el hit-test; null si no hay raíz cerca. */
export type HitTarget = RootTarget | null;

/**
 * Clamp visual a la circunferencia unidad: si r > 1, normaliza a r = 1.
 * El DSP real re-clampea a MAX_POLE_RADIUS = 0.9999 (I1) en el worker.
 */
function clampToUnit(z: Complex): Complex {
    const r = Math.hypot(z.re, z.im);
    if (r <= 1) return { re: z.re, im: z.im };
    return { re: z.re / r, im: z.im / r };
}

/**
 * Normaliza una lista de raíces para garantizar el invariante de filtro real
 * (I2/I3, THEORY_SPECS §3): toda raíz compleja (im ≠ 0) debe ir acompañada de
 * su conjugado. Deduplica: si una raíz (o su espejo) ya está en la salida, no
 * se vuelve a añadir. No muta la entrada.
 */
function normalizePairs(roots: readonly Complex[]): Complex[] {
    const out: Complex[] = [];
    for (const r of roots) {
        const hasSelf = out.some((o) => o.re === r.re && o.im === r.im);
        if (hasSelf) continue; // ya añadido (o ya existe su par)
        if (r.im !== 0) {
            const hasConj = out.some((o) => o.re === r.re && o.im === -r.im);
            if (hasConj) {
                // El espejo ya está: añadir solo este para completar el par.
                out.push({ re: r.re, im: r.im });
            } else {
                out.push({ re: r.re, im: r.im }, { re: r.re, im: -r.im });
            }
        } else {
            out.push({ re: r.re, im: r.im });
        }
    }
    return out;
}

/** Índice del conjugado exacto de `root` en `roots`, o -1 si no existe. */
function conjugateIndexOf(root: Complex, roots: readonly Complex[]): number {
    for (let j = 0; j < roots.length; j++) {
        if (roots[j].re === root.re && roots[j].im === -root.im) return j;
    }
    return -1;
}

export class ZPlaneInteraction {
    /** Polos editables (mutable durante el arrastre). */
    poles: Complex[];
    /** Ceros editables (mutable durante el arrastre). */
    zeros: Complex[];
    /** Ganancia del usuario K. */
    gain: number;
    /** Raíz seleccionada (resaltada por la vista). */
    selected: HitTarget = null;
    /** Raíz en arrastre activo (solo durante pointerdown→pointerup). */
    private dragging: HitTarget = null;

    constructor(initial?: ZPlaneInteractionState) {
        // Normaliza pares conjugados: el DSP de coeficientes reales (I2/I3)
        // rechaza raíces complejas sin su espejo (SosSynthesizer lanza).
        this.poles = initial ? normalizePairs(initial.poles) : [];
        this.zeros = initial ? normalizePairs(initial.zeros) : [];
        this.gain = initial?.gain ?? 1;
    }

    /** ¿Hay un arrastre en curso? (gestiona pointerMove en el manager). */
    get isDragging(): boolean {
        return this.dragging !== null;
    }

    /** Raíz bajo (px, py) a menos de `thresholdPx` píxeles (la más cercana). */
    hitTest(layout: ZPlaneLayout, px: number, py: number, thresholdPx: number): HitTarget {
        let best: { d: number; t: RootTarget } | null = null;
        for (let i = 0; i < this.poles.length; i++) {
            const p = zToPixel(layout, this.poles[i]);
            const d = zPixelDistance(px, py, p.x, p.y);
            if (d <= thresholdPx && (!best || d < best.d)) best = { d, t: { kind: 'pole', index: i } };
        }
        for (let i = 0; i < this.zeros.length; i++) {
            const p = zToPixel(layout, this.zeros[i]);
            const d = zPixelDistance(px, py, p.x, p.y);
            if (d <= thresholdPx && (!best || d < best.d)) best = { d, t: { kind: 'zero', index: i } };
        }
        return best ? best.t : null;
    }

    /**
     * Comienza un arrastre: selecciona la raíz bajo el puntero o, si no hay
     * ninguna, crea un polo clampeado a la circunferencia unidad. Devuelve el
     * objetivo arrastrado (siempre no-nulo: el clic en vacío crea un polo).
     */
    beginDrag(layout: ZPlaneLayout, px: number, py: number, thresholdPx: number): RootTarget {
        const hit = this.hitTest(layout, px, py, thresholdPx);
        if (hit) {
            this.selected = hit;
            this.dragging = hit;
            return hit;
        }
        const clamped = clampToUnit(pixelToZ(layout, px, py));
        const index = this.poles.length;
        this.poles.push(clamped);
        // Filtro real: una raíz compleja (im ≠ 0) lleva su conjugado como par.
        if (clamped.im !== 0) this.poles.push({ re: clamped.re, im: -clamped.im });
        const created: RootTarget = { kind: 'pole', index };
        this.selected = created;
        this.dragging = created;
        return created;
    }

    /** Mueve el objetivo arrastrado al punto dado (polos clampeados a |z| ≤ 1). */
    dragTo(layout: ZPlaneLayout, px: number, py: number): void {
        if (!this.dragging) return;
        const z = pixelToZ(layout, px, py);
        if (this.dragging.kind === 'pole') {
            this.setRootWithConjugate(this.poles, this.dragging.index, z, true);
        } else {
            this.setRootWithConjugate(this.zeros, this.dragging.index, z, false);
        }
    }

    /**
     * Mueve la raíz `roots[index]` a `z` manteniendo el par conjugado (filtro
     * real, I2/I3): si `z` es compleja se crea/actualiza su espejo; si la raíz
     * aterriza en el eje real (im = 0) se elimina el espejo huérfano del par
     * anterior. `clamp` clampea los polos a |z| ≤ 1 (los ceros no se clampean).
     */
    private setRootWithConjugate(roots: Complex[], index: number, z: Complex, clamp: boolean): void {
        const target = clamp ? clampToUnit(z) : { re: z.re, im: z.im };
        const old = roots[index];
        roots[index] = target;
        // Si la raíz arrastrada era compleja, su antiguo espejo queda huérfano
        // (salvo que la nueva posición lo reutilice): eliminarlo y corregir el
        // índice local si la eliminación se produjo antes de la raíz arrastrada.
        if (old && old.im !== 0) {
            const oldPartner = conjugateIndexOf(old, roots);
            if (oldPartner !== -1 && oldPartner !== index) {
                roots.splice(oldPartner, 1);
                if (index > oldPartner) index--;
            }
        }
        if (target.im === 0) {
            // Raíz real: su conjugado es ella misma; si quedó un espejo
            // fantasma (aterrizaje justo sobre el espejo), eliminarlo.
            const ghost = conjugateIndexOf(target, roots);
            if (ghost !== -1 && ghost !== index) {
                roots.splice(ghost, 1);
                if (index > ghost) index--;
            }
        } else {
            const partner = conjugateIndexOf(target, roots);
            if (partner === -1) {
                roots.push({ re: target.re, im: -target.im });
            } else {
                roots[partner] = { re: target.re, im: -target.im };
            }
        }
        // Mantener el objetivo de arrastre (y la selección, que comparte la
        // misma referencia) apuntando a la raíz tras posibles eliminaciones.
        if (this.dragging && this.dragging.index !== index) this.dragging.index = index;
    }

    /** Finaliza el arrastre (mantiene la selección). */
    endDrag(): void {
        this.dragging = null;
    }

    /**
     * Crea un cero en el punto dado (clic derecho, §5) y lo selecciona, sin
     * iniciar arrastre (el clic derecho no arrastra raíces).
     */
    createZero(z: Complex): RootTarget {
        const index = this.zeros.length;
        this.zeros.push({ re: z.re, im: z.im });
        // Filtro real: los ceros complejos también van en pares conjugados.
        if (z.im !== 0) this.zeros.push({ re: z.re, im: -z.im });
        const created: RootTarget = { kind: 'zero', index };
        this.selected = created;
        return created;
    }

    /** Elimina la raíz seleccionada (si la hay) y limpia la selección. */
    deleteSelected(): void {
        if (!this.selected) return;
        const { kind, index } = this.selected;
        const roots = kind === 'pole' ? this.poles : this.zeros;
        const root = roots[index];
        if (root && root.im !== 0) {
            // Borrar una raíz compleja elimina también su conjugado (el par).
            const partner = conjugateIndexOf(root, roots);
            if (partner !== -1 && partner !== index) {
                roots.splice(Math.min(index, partner), 2);
            } else {
                roots.splice(index, 1);
            }
        } else {
            roots.splice(index, 1);
        }
        this.selected = null;
        this.dragging = null;
    }

    /** Fija la ganancia del usuario. */
    setGain(gain: number): void {
        this.gain = gain;
    }

    /** Instantánea inmutable del estado (para el worker / la vista). */
    snapshot(): ZPlaneState {
        return {
            poles: this.poles.map((c) => ({ re: c.re, im: c.im })),
            zeros: this.zeros.map((c) => ({ re: c.re, im: c.im })),
            gain: this.gain,
        };
    }
}
