/**
 * src/core/z-plane-view.ts
 *
 * Fase 8 — Hilo A: render de la vista Canvas 2D del plano Z.
 *
 * Dibuja contra una interfaz mínima `ZPlaneDraw` (compatible estructuralmente
 * con CanvasRenderingContext2D) para poder testear con un contexto mock y
 * mantener el módulo sin dependencias del DOM (tsconfig lib = ES2020).
 *
 * Capas de dibujo:
 *   1. fondo + ejes real/imaginario a través del centro;
 *   2. circunferencia unidad inscrita (radio del layout);
 *   3. ceros como ○ (marca de radio MARK_RADIUS) y polos como ×;
 *   4. la raíz seleccionada se resalta con color distinto.
 */
import { zToPixel } from './z-plane-layout';
import type { ZPlaneLayout } from './z-plane-layout';
import type { HitTarget } from './z-plane-interaction';
import type { ZPlaneState } from './types';

/** Radio en píxeles de las marcas de polos (×) y ceros (○). */
export const MARK_RADIUS = 8;
const TWO_PI = 2 * Math.PI;

/** Subconjunto mínimo de CanvasRenderingContext2D que usa la vista. */
export interface ZPlaneDraw {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    clearRect(x: number, y: number, w: number, h: number): void;
    fillRect(x: number, y: number, w: number, h: number): void;
    beginPath(): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
    fill(): void;
    fillText(text: string, x: number, y: number): void;
}

/** ¿Es `target` exactamente la raíz (kind, index)? */
function isSelected(target: HitTarget, kind: 'pole' | 'zero', index: number): boolean {
    return target !== null && target.kind === kind && target.index === index;
}

export class ZPlaneView {
    private readonly ctx: ZPlaneDraw;
    private layout: ZPlaneLayout;

    constructor(ctx: ZPlaneDraw, layout: ZPlaneLayout) {
        this.ctx = ctx;
        this.layout = layout;
    }

    /** Actualiza el layout tras un resize. */
    setLayout(layout: ZPlaneLayout): void {
        this.layout = layout;
    }

    /** Redibuja el plano Z completo a partir del estado y la selección. */
    draw(state: ZPlaneState, selected: HitTarget = null): void {
        const { width, height, cx, cy, radius } = this.layout;
        const ctx = this.ctx;

        // Fondo
        ctx.fillStyle = '#111';
        ctx.clearRect(0, 0, width, height);
        ctx.fillRect(0, 0, width, height);

        // Ejes real (horizontal) e imaginario (vertical)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(width, cy);
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, height);
        ctx.stroke();

        // Circunferencia unidad inscrita
        ctx.strokeStyle = '#777';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, TWO_PI);
        ctx.stroke();

        // Etiquetas de los ejes (Re/Im) y marcas de la circunferencia unidad
        ctx.fillStyle = '#8b949e';
        ctx.fillText('Re', width - 20, cy - 8);
        ctx.fillText('Im', cx + 10, 14);
        ctx.fillText('1', cx + radius - 6, cy + 18);
        ctx.fillText('-1', cx - radius - 22, cy + 18);
        ctx.fillText('j', cx - 26, cy - radius + 4);
        ctx.fillText('-j', cx - 30, cy + radius + 16);

        // Ceros (○) debajo de los polos (×)
        for (let i = 0; i < state.zeros.length; i++) {
            this.drawZero(state.zeros[i], isSelected(selected, 'zero', i));
        }
        for (let i = 0; i < state.poles.length; i++) {
            this.drawPole(state.poles[i], isSelected(selected, 'pole', i));
        }
    }

    /** Marca de cero: circunferencia ○ en el píxel proyectado. */
    private drawZero(z: { readonly re: number; readonly im: number }, highlighted: boolean): void {
        const p = zToPixel(this.layout, z);
        const ctx = this.ctx;
        ctx.strokeStyle = highlighted ? '#ffd700' : '#4fc3f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, MARK_RADIUS, 0, TWO_PI);
        ctx.stroke();
    }

    /** Marca de polo: cruz × en el píxel proyectado. */
    private drawPole(p: { readonly re: number; readonly im: number }, highlighted: boolean): void {
        const pt = zToPixel(this.layout, p);
        const ctx = this.ctx;
        ctx.strokeStyle = highlighted ? '#ffd700' : '#ff5252';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pt.x - MARK_RADIUS, pt.y - MARK_RADIUS);
        ctx.lineTo(pt.x + MARK_RADIUS, pt.y + MARK_RADIUS);
        ctx.moveTo(pt.x + MARK_RADIUS, pt.y - MARK_RADIUS);
        ctx.lineTo(pt.x - MARK_RADIUS, pt.y + MARK_RADIUS);
        ctx.stroke();
    }
}
