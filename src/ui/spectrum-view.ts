/**
 * src/ui/spectrum-view.ts
 *
 * Fase 9 — Hilo A: vista Canvas del espectro (magnitud dB, fase, retardo de
 * grupo) leída directamente del SharedArrayBuffer (sab-layout.ts, §9.1).
 *
 * El renderer (renderer.ts) invoca drawAll() cuando la versión atómica cambia;
 * el main NO calcula DSP (§2: A no calcula), solo proyecta búferes a píxeles.
 *
 * Convenciones de dibujo sobre un lienzo w×h:
 *   - magnitud  : x = (ω/2π)·w ; y = h − ((dB−MIN)/(MAX−MIN))·h con dB clampeado
 *                 a [MAG_DB_MIN, MAG_DB_MAX] = [−120, 20] dB.
 *   - fase      : y = h/2 − (φ/2π)·h   (fase envuelta en [−π, π]).
 *   - retardo   : y = h·(1 − τ/max|τ|) (auto-escala al máximo absoluto).
 *
 * Sin dependencias del DOM (tsconfig lib = ES2020): el contexto es la interfaz
 * mínima ZPlaneDraw, compatible estructuralmente con CanvasRenderingContext2D.
 */
import type { ZPlaneDraw } from '../core/z-plane-view';
import type { SpectrumBuffers } from '../core/types';

const TWO_PI = 2 * Math.PI;
const MAG_DB_MIN = -120;
const MAG_DB_MAX = 20;
const DB_RANGE = MAG_DB_MAX - MAG_DB_MIN;

/** Polyline: beginPath → moveTo → lineTo… → stroke. */
function drawPolyline(ctx: ZPlaneDraw, points: readonly { x: number; y: number }[]): void {
    if (points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
}

export class SpectrumView {
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

    /** Curva de magnitud en dB (ec. 3.6), clampeada al rango visible. */
    drawMagnitude(magnitudeDb: Float64Array, omega: Float64Array): void {
        this.ctx.strokeStyle = '#4fc3f7';
        this.ctx.lineWidth = 1.5;
        const pts: { x: number; y: number }[] = [];
        const n = Math.min(magnitudeDb.length, omega.length);
        for (let i = 0; i < n; i++) {
            const db = Math.max(MAG_DB_MIN, Math.min(MAG_DB_MAX, magnitudeDb[i]));
            const x = (omega[i] / TWO_PI) * this.width;
            const y = this.height - ((db - MAG_DB_MIN) / DB_RANGE) * this.height;
            pts.push({ x, y });
        }
        drawPolyline(this.ctx, pts);
    }

    /** Curva de fase envuelta φ ∈ [−π, π] (ec. 5.1). */
    drawPhase(phase: Float64Array, omega: Float64Array): void {
        this.ctx.strokeStyle = '#ffd54f';
        this.ctx.lineWidth = 1.5;
        const pts: { x: number; y: number }[] = [];
        const n = Math.min(phase.length, omega.length);
        for (let i = 0; i < n; i++) {
            const x = (omega[i] / TWO_PI) * this.width;
            const y = this.height / 2 - (phase[i] / TWO_PI) * this.height;
            pts.push({ x, y });
        }
        drawPolyline(this.ctx, pts);
    }

    /** Retardo de grupo τ_g(ω) (ec. 4.5), auto-escalado al máximo absoluto. */
    drawGroupDelay(groupDelay: Float64Array, omega: Float64Array): void {
        let maxAbs = 0;
        for (let i = 0; i < groupDelay.length; i++) {
            const a = Math.abs(groupDelay[i]);
            if (a > maxAbs) maxAbs = a;
        }
        const scale = maxAbs > 0 ? maxAbs : 1;
        this.ctx.strokeStyle = '#a5d6a7';
        this.ctx.lineWidth = 1.5;
        const pts: { x: number; y: number }[] = [];
        const n = Math.min(groupDelay.length, omega.length);
        for (let i = 0; i < n; i++) {
            const x = (omega[i] / TWO_PI) * this.width;
            const y = this.height * (1 - groupDelay[i] / scale);
            pts.push({ x, y });
        }
        drawPolyline(this.ctx, pts);
    }

    /** Dibuja rejilla + las tres curvas (magnitud + fase + retardo de grupo). */
    drawAll(buffers: SpectrumBuffers): void {
        // Sin fondo propio: el canvas es transparente y deja ver el CSS #111.
        // Se limpia para no acumular trazos fantasma entre redibujos.
        this.ctx.clearRect(0, 0, this.width, this.height);
        this.drawGrid();
        this.drawMagnitude(buffers.magnitudeDb, buffers.omega);
        this.drawPhase(buffers.phaseWrapped, buffers.omega);
        this.drawGroupDelay(buffers.groupDelay, buffers.omega);
        this.drawLegend();
    }

    /** Rejilla de referencia: niveles de dB (horizontales) y frecuencias ω (verticales). */
    private drawGrid(): void {
        const ctx = this.ctx;
        ctx.strokeStyle = '#23272e';
        ctx.lineWidth = 1;
        const dbTicks = [0, -20, -40, -60, -80, -100, -120];
        for (const db of dbTicks) {
            const y = this.height - ((db - MAG_DB_MIN) / DB_RANGE) * this.height;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(this.width, y);
            ctx.stroke();
            ctx.fillStyle = '#6e7681';
            ctx.fillText(String(db), this.width - 26, y - 3);
        }
        const freqTicks: { f: number; label: string }[] = [
            { f: 0, label: '0' },
            { f: 0.25, label: 'π/2' },
            { f: 0.5, label: 'π' },
            { f: 0.75, label: '3π/2' },
            { f: 1, label: '2π' },
        ];
        for (const t of freqTicks) {
            const x = t.f * this.width;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.height);
            ctx.stroke();
            const labelX = x > this.width - 24 ? x - 20 : x + 3;
            ctx.fillStyle = '#6e7681';
            ctx.fillText(t.label, labelX, this.height - 3);
        }
    }

    /** Leyenda coloreada de las tres curvas. */
    private drawLegend(): void {
        const entries: { color: string; label: string }[] = [
            { color: '#4fc3f7', label: 'magnitud (dB)' },
            { color: '#ffd54f', label: 'fase (π rad)' },
            { color: '#a5d6a7', label: 'retardo τ_g' },
        ];
        const lx = this.width - 160;
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const y = 12 + i * 16;
            this.ctx.strokeStyle = e.color;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.moveTo(lx, y);
            this.ctx.lineTo(lx + 18, y);
            this.ctx.stroke();
            this.ctx.fillStyle = e.color;
            this.ctx.fillText(e.label, lx + 22, y + 3);
        }
    }
}
