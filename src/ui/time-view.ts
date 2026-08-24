/**
 * src/ui/time-view.ts
 *
 * Fase 9 — Hilo A: vista Canvas del dominio temporal (respuesta al impulso
 * h[n] y al escalón s[n]) leída directamente del SAB (sab-layout.ts, §9.1).
 *
 * Escala simétrica respecto al centro vertical, auto-ajustada al máximo
 * absoluto:  y = h/2 − (v/scale)·(h/2).
 *
 * VENTANA VISIBLE: la respuesta completa ocupa L=65536 muestras, pero el
 * transitorio de polos típicos decae en pocas decenas de muestras y, proyectado
 * sobre todo el ancho, quedaría aplastado en unos pocos píxeles (problema
 * didáctico diagnosticado). Para que el transitorio llene el ancho del lienzo,
 * se detecta el índice de asentamiento (última muestra que difiere >0.5 % de la
 * escala respecto al valor final) y se proyecta solo la ventana [0, win):
 *   x = (i/(win−1))·w,   win recortado a [MIN_WINDOW, MAX_WINDOW] y ≤ len.
 *
 * El eje cero se dibuja en y = h/2 y una leyenda identifica las dos curvas.
 *
 * Sin dependencias del DOM (tsconfig lib = ES2020): el contexto es ZPlaneDraw.
 */
import type { ZPlaneDraw } from '../core/z-plane-view';
import type { TimeDomainBuffers } from '../core/types';

const IMPULSE_COLOR = '#ff8a65';
const STEP_COLOR = '#81c784';

/** Polyline: beginPath → moveTo → lineTo… → stroke. */
function drawPolyline(ctx: ZPlaneDraw, points: readonly { x: number; y: number }[]): void {
    if (points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
}

export class TimeView {
    /** Ventana mínima para no mostrar un solo píxel cuando no hay transitorio. */
    private static readonly MIN_WINDOW = 32;
    /** Ventana máxima: evita proyectar las 65536 muestras (aplastaría el transitorio). */
    private static readonly MAX_WINDOW = 4096;
    /** Fracción de la escala por debajo de la cual se considera "asentado". */
    private static readonly SETTLING_TOL = 0.005;

    private readonly ctx: ZPlaneDraw;
    private width: number;
    private height: number;

    constructor(ctx: ZPlaneDraw, width: number, height: number) {
        this.ctx = ctx;
        this.width = width;
        this.height = height;
    }

    /** Actualiza el tamaño del lienzo tras un resize. */
    setSize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    /** Respuesta al impulso h[n]. */
    drawImpulse(impulse: Float64Array, window?: number): void {
        this.ctx.strokeStyle = IMPULSE_COLOR;
        this.ctx.lineWidth = 1.5;
        const win = window ?? this.settlingWindow(impulse);
        drawPolyline(this.ctx, this.points(impulse, win));
    }

    /** Respuesta al escalón s[n] = Σ_{k≤n} h[k]. */
    drawStep(step: Float64Array, window?: number): void {
        this.ctx.strokeStyle = STEP_COLOR;
        this.ctx.lineWidth = 1.5;
        const win = window ?? this.settlingWindow(step);
        drawPolyline(this.ctx, this.points(step, win));
    }

    /** Dibuja ejes, impulso y escalón con una ventana común, más la leyenda. */
    drawAll(buffers: TimeDomainBuffers): void {
        // Sin fondo propio: canvas transparente sobre CSS #111; se limpia para
        // no acumular trazos fantasma entre redibujos.
        this.ctx.clearRect(0, 0, this.width, this.height);
        const win = this.commonWindow(buffers.impulse, buffers.step);
        this.drawAxes();
        this.drawImpulse(buffers.impulse, win);
        this.drawStep(buffers.step, win);
        this.drawLegend();
    }

    /** Ventana compartida por impulso y escalón para mantener el mismo eje X. */
    private commonWindow(a: Float64Array, b: Float64Array): number {
        const wa = this.settlingWindow(a);
        const wb = this.settlingWindow(b);
        return wa > wb ? wa : wb;
    }

    /**
     * Índice de asentamiento: última muestra que difiere del valor final más de
     * SETTLING_TOL·escala. El resultado se recorta a [MIN_WINDOW, MAX_WINDOW] y
     * a la longitud real del búfer.
     */
    private settlingWindow(values: Float64Array): number {
        const len = values.length;
        let scale = 0;
        for (let i = 0; i < len; i++) {
            const a = Math.abs(values[i]);
            if (a > scale) scale = a;
        }
        if (scale <= 0) {
            return Math.min(TimeView.MAX_WINDOW, Math.max(TimeView.MIN_WINDOW, len));
        }
        const final = values[len - 1];
        const tol = TimeView.SETTLING_TOL * scale;
        let last = 0;
        for (let i = 0; i < len; i++) {
            if (Math.abs(values[i] - final) > tol) last = i;
        }
        let win = last + 1;
        if (win < TimeView.MIN_WINDOW) win = TimeView.MIN_WINDOW;
        if (win > TimeView.MAX_WINDOW) win = TimeView.MAX_WINDOW;
        if (win > len) win = len;
        return win;
    }

    /** Líneas de referencia: bordes superior/inferior y eje cero (y = h/2). */
    private drawAxes(): void {
        const ctx = this.ctx;
        ctx.strokeStyle = '#2a2f36';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(this.width, 0);
        ctx.moveTo(0, this.height);
        ctx.lineTo(this.width, this.height);
        ctx.stroke();
        ctx.strokeStyle = '#777';
        ctx.beginPath();
        ctx.moveTo(0, this.height / 2);
        ctx.lineTo(this.width, this.height / 2);
        ctx.stroke();
    }

    /** Leyenda coloreada: impulso y escalón. */
    private drawLegend(): void {
        const x = 8;
        let y = 14;
        this.ctx.strokeStyle = IMPULSE_COLOR;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(x, y);
        this.ctx.lineTo(x + 18, y);
        this.ctx.stroke();
        this.ctx.fillStyle = IMPULSE_COLOR;
        this.ctx.fillText('impulso h[n]', x + 22, y + 3);
        y += 16;
        this.ctx.strokeStyle = STEP_COLOR;
        this.ctx.beginPath();
        this.ctx.moveTo(x, y);
        this.ctx.lineTo(x + 18, y);
        this.ctx.stroke();
        this.ctx.fillStyle = STEP_COLOR;
        this.ctx.fillText('escalón s[n]', x + 22, y + 3);
    }

    /**
     * Proyecta la ventana [0, win) a píxeles con escala simétrica auto-ajustada
     * al máximo absoluto del búfer completo: x = (i/(win−1))·w, y = h/2 −
     * (v/scale)·(h/2). `win` se recorta a la longitud real del búfer.
     */
    private points(values: Float64Array, win: number): { x: number; y: number }[] {
        const len = values.length;
        if (win > len) win = len;
        const denom = win > 1 ? win - 1 : 1;
        let scale = 0;
        for (let i = 0; i < len; i++) {
            const a = Math.abs(values[i]);
            if (a > scale) scale = a;
        }
        if (scale <= 0) scale = 1;
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < win; i++) {
            const x = (i / denom) * this.width;
            const y = this.height / 2 - (values[i] / scale) * (this.height / 2);
            pts.push({ x, y });
        }
        return pts;
    }
}
