/**
 * src/core/z-plane-layout.ts
 *
 * Fase 8 — Hilo A: transformación pura píxel ↔ plano Z (ARCHITECTURE.md §9).
 *
 * El plano Z (Complejo: re, im con |z| ≤ 1 en la circunferencia unidad) se
 * proyecta sobre un lienzo de `width × height`. La circunferencia unidad se
 * inscribe con un margen:  radius = min(w, h)/2 − margin.
 *
 * Convención de ejes (estándar del plano Z):
 *   - x = cx + re·radius   (real → derecha)
 *   - y = cy − im·radius   (imaginario → ARRIBA; el eje Y del lienzo crece hacia abajo)
 *
 * Módulo puro: sin estado, sin I/O. Hilo A no calcula DSP (§2), solo geometría.
 */
import type { Complex } from './types';

/** Geometría del lienzo del plano Z (inmutable). */
export interface ZPlaneLayout {
    /** Centro del lienzo en píxeles (origen del plano Z). */
    readonly cx: number;
    /** Centro del lienzo en píxeles (origen del plano Z). */
    readonly cy: number;
    /** Radio en píxeles de la circunferencia unidad (inscrita con margen). */
    readonly radius: number;
    /** Ancho total del lienzo. */
    readonly width: number;
    /** Alto total del lienzo. */
    readonly height: number;
}

/** Punto en píxeles del lienzo. */
export interface PixelPoint {
    readonly x: number;
    readonly y: number;
}

/**
 * Construye el layout: la circunferencia unidad queda inscrita con `margin`
 * píxeles de separación al borde menor del lienzo.
 */
export function makeLayout(width: number, height: number, margin = 8): ZPlaneLayout {
    const radius = Math.min(width, height) / 2 - margin;
    return { cx: width / 2, cy: height / 2, radius, width, height };
}

/** Proyecta un punto del plano Z a píxeles del lienzo (volteo del eje Y). */
export function zToPixel(layout: ZPlaneLayout, z: Complex): PixelPoint {
    return {
        x: layout.cx + z.re * layout.radius,
        y: layout.cy - z.im * layout.radius,
    };
}

/** Invierte un punto de píxeles a coordenadas del plano Z. */
export function pixelToZ(layout: ZPlaneLayout, px: number, py: number): Complex {
    return {
        re: (px - layout.cx) / layout.radius,
        im: (layout.cy - py) / layout.radius,
    };
}

/** Distancia euclídea entre dos puntos en píxeles (hit-testing). */
export function zPixelDistance(x0: number, y0: number, x1: number, y1: number): number {
    return Math.hypot(x1 - x0, y1 - y0);
}
