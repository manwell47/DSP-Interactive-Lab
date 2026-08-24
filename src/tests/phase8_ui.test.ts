/**
 * src/tests/phase8_ui.test.ts
 *
 * Fase 8 — Hilo A: UI interactiva del plano Z (ARCHITECTURE.md §3, §9):
 *   T-LAYOUT-1..3 : ZPlaneLayout — transformación pura píxel ↔ plano Z
 *                   (centro/radio inscrito, mapeo unitario, volteo de eje Y).
 *   T-INT-1..5    : ZPlaneInteraction — hit-testing, arrastre con clamp a la
 *                   circunferencia unidad (I1 visual), crear/borrar, ganancia.
 *   T-MGR-1..5    : InteractionManager — coalescing 1 SET_Z_PLANE por frame (M5),
 *                   paquete correcto (pack/unpack), clamp en arrastre, rueda.
 *   T-VIEW-1      : ZPlaneView — dibujo Canvas 2D (eje, circunferencia, polos ×,
 *                   ceros ○) contra un contexto mock registrador.
 *   T-RELAY-1..3  : AudioGraphRelay — relay worker → main → node.port (§3.2):
 *                   COEFFICIENTS → SET_COEFFICIENTS; setters; no-relay de
 *                   SPECTRUM_VERSION/PONG (lectura directa del SAB, §9.1).
 */
import { describe, it, expect } from 'vitest';
import { makeLayout, pixelToZ, zPixelDistance, zToPixel } from '../core/z-plane-layout';
import type { ZPlaneLayout } from '../core/z-plane-layout';
import { ZPlaneInteraction } from '../core/z-plane-interaction';
import { InteractionManager } from '../core/interaction-manager';
import { ZPlaneView } from '../core/z-plane-view';
import type { ZPlaneDraw } from '../core/z-plane-view';
import { AudioGraphRelay, DEFAULT_RAMP } from '../core/audio-graph';
import { packRoots, unpackRoots } from '../core/pack';
import type {
    AudioNodeMessage,
    SosCoefficients,
    WorkerRequest,
    WorkerResponse,
    ZPlaneState,
} from '../core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Layout de referencia 400×300 con margen 10 → cx=200, cy=150, radius=140. */
const LAYOUT: ZPlaneLayout = makeLayout(400, 300, 10);

/** SOS vacío mínimo (el relay solo reenvía por identidad). */
const EMPTY_SOS: SosCoefficients = { sections: [], firstOrderSection: null, totalGain: 1, order: 0 };

/** Puertos simulados del relay (worker + node). */
function makeRelayPorts() {
    const workerMessages: WorkerRequest[] = [];
    const nodeMessages: AudioNodeMessage[] = [];
    return {
        workerMessages,
        nodeMessages,
        workerPort: { postMessage: (m: WorkerRequest) => void workerMessages.push(m) },
        nodePort: { postMessage: (m: AudioNodeMessage) => void nodeMessages.push(m) },
    };
}

/** Contexto Canvas 2D mock que registra operaciones con precisión numérica. */
interface Op {
    type: string;
    args: (number | string)[];
}
class MockCtx implements ZPlaneDraw {
    fillStyle = '';
    strokeStyle = '';
    lineWidth = 0;
    readonly ops: Op[] = [];
    private rec(type: string, ...args: (number | string)[]) {
        this.ops.push({ type, args });
    }
    clearRect(x: number, y: number, w: number, h: number) { this.rec('clearRect', x, y, w, h); }
    fillRect(x: number, y: number, w: number, h: number) { this.rec('fillRect', x, y, w, h); }
    beginPath() { this.rec('beginPath'); }
    arc(x: number, y: number, radius: number, start: number, end: number) {
        this.rec('arc', x, y, radius, start, end);
    }
    moveTo(x: number, y: number) { this.rec('moveTo', x, y); }
    lineTo(x: number, y: number) { this.rec('lineTo', x, y); }
    stroke() { this.rec('stroke'); }
    fill() { this.rec('fill'); }
    fillText(text: string, x: number, y: number) { this.rec('fillText', text, x, y); }
}

/** ¿Existe una operación de tipo `type` con argumentos ≈ args (tol 1e-6)? */
function hasOp(ctx: MockCtx, type: string, ...args: number[]): boolean {
    return ctx.ops.some(
        (o) =>
            o.type === type &&
            o.args.length === args.length &&
            args.every((a, i) => Math.abs((o.args[i] as number) - a) < 1e-6),
    );
}

// ---------------------------------------------------------------------------
// T-LAYOUT — ZPlaneLayout: transformación píxel ↔ plano Z
// ---------------------------------------------------------------------------

describe('ZPlaneLayout (§9, transformación píxel↔plano Z)', () => {
    it('T-LAYOUT-1 — centro/radio y mapeo de la circunferencia unidad + round-trip', () => {
        expect(LAYOUT.cx).toBe(200);
        expect(LAYOUT.cy).toBe(150);
        expect(LAYOUT.radius).toBe(140);

        // z = 1+0j (borde derecho de la circunferencia) → (cx+radius, cy)
        const px = zToPixel(LAYOUT, { re: 1, im: 0 });
        expect(px.x).toBeCloseTo(340, 9);
        expect(px.y).toBeCloseTo(150, 9);

        // Round-trip: pixelToZ(zToPixel(z)) ≈ z
        for (const z of [{ re: 0.9, im: 0.5 }, { re: -0.5, im: -0.7 }, { re: 0, im: 0 }]) {
            const back = pixelToZ(LAYOUT, zToPixel(LAYOUT, z).x, zToPixel(LAYOUT, z).y);
            expect(back.re).toBeCloseTo(z.re, 9);
            expect(back.im).toBeCloseTo(z.im, 9);
        }

        // Distancia entre dos puntos en píxeles (útil para hit-testing)
        expect(zPixelDistance(0, 0, 3, 4)).toBeCloseTo(5, 9);
    });

    it('T-LAYOUT-2 — radio = min(w,h)/2 − margen (circunferencia inscrita)', () => {
        const a = makeLayout(200, 100, 0);
        expect(a.cx).toBe(100);
        expect(a.cy).toBe(50);
        expect(a.radius).toBe(50); // min(200,100)/2 = 50

        const b = makeLayout(200, 100, 8);
        expect(b.radius).toBe(42); // 50 − 8
    });

    it('T-LAYOUT-3 — volteo de eje Y: píxel por encima del centro → parte imaginaria positiva', () => {
        // z = +0.5j se dibuja por ENCIMA del centro (y = cy − 0.5·radius = 80 < 150)
        const px = zToPixel(LAYOUT, { re: 0, im: 0.5 });
        expect(px.x).toBeCloseTo(200, 9);
        expect(px.y).toBeCloseTo(150 - 0.5 * 140, 9);
        expect(px.y).toBeLessThan(LAYOUT.cy);

        // Inverso: pixel (200, 80) → im = (150−80)/140 = +0.5
        const z = pixelToZ(LAYOUT, 200, 80);
        expect(z.re).toBeCloseTo(0, 9);
        expect(z.im).toBeCloseTo(0.5, 9);
    });
});

// ---------------------------------------------------------------------------
// T-INT — ZPlaneInteraction: estado de interacción del plano Z
// ---------------------------------------------------------------------------

describe('ZPlaneInteraction (§interacción del plano Z)', () => {
    it('T-INT-1 — hit-testing: dentro/ fuera del umbral (píxeles)', () => {
        // polo (0.5, 0.3) → pixel (270, 108)
        const inter = new ZPlaneInteraction({
            poles: [{ re: 0.5, im: 0.3 }, { re: 0.5, im: -0.3 }],
            zeros: [],
            gain: 1,
        });
        expect(inter.hitTest(LAYOUT, 270, 108, 10)).toEqual({ kind: 'pole', index: 0 });
        // a 20 px (fuera del umbral 10) → null
        expect(inter.hitTest(LAYOUT, 290, 108, 10)).toBeNull();

        // cero (−0.5, −0.3) → pixel (130, 192)
        const inter2 = new ZPlaneInteraction({ poles: [], zeros: [{ re: -0.5, im: -0.3 }], gain: 1 });
        expect(inter2.hitTest(LAYOUT, 130, 192, 10)).toEqual({ kind: 'zero', index: 0 });
    });

    it('T-INT-2 — beginDrag en vacío crea un polo (clampeado a |z| ≤ 1)', () => {
        const inter = new ZPlaneInteraction(); // vacío
        const t = inter.beginDrag(LAYOUT, 270, 108, 10); // → (0.5, 0.3), interior
        expect(t).toEqual({ kind: 'pole', index: 0 });
        // Filtro real (I2/I3): una raíz compleja crea su par conjugado.
        expect(inter.poles.length).toBe(2);
        expect(inter.poles[0].re).toBeCloseTo(0.5, 6);
        expect(inter.poles[0].im).toBeCloseTo(0.3, 6);
        expect(inter.poles[1].re).toBeCloseTo(0.5, 6);
        expect(inter.poles[1].im).toBeCloseTo(-0.3, 6);

        // click MUY exterior → polo clampeado a la circunferencia unidad (r = 1)
        const inter2 = new ZPlaneInteraction();
        inter2.beginDrag(LAYOUT, 400, 10, 10); // re=(400−200)/140≈1.43, im=(150−10)/140=1
        const r = Math.hypot(inter2.poles[0].re, inter2.poles[0].im);
        expect(r).toBeCloseTo(1, 6);
    });

    it('T-INT-3 — seleccionar y arrastrar un cero (sin clamp); el polo sí se clampea', () => {
        // cero (−0.5, −0.3) → pixel (130, 192)
        const inter = new ZPlaneInteraction({ poles: [], zeros: [{ re: -0.5, im: -0.3 }], gain: 1 });
        expect(inter.beginDrag(LAYOUT, 130, 192, 10)).toEqual({ kind: 'zero', index: 0 });
        inter.dragTo(LAYOUT, 300, 100); // → re=(300−200)/140≈0.714, im=(150−100)/140≈0.357
        expect(inter.zeros[0].re).toBeCloseTo(0.714285714, 6);
        expect(inter.zeros[0].im).toBeCloseTo(0.357142857, 6);
        // los ceros NO se clampean: exterior → |z| > 1
        inter.dragTo(LAYOUT, 400, 10);
        expect(Math.hypot(inter.zeros[0].re, inter.zeros[0].im)).toBeGreaterThan(1);

        // polo (0.5, 0.3) → pixel (270, 108); arrastre exterior → clamp a r=1
        const interP = new ZPlaneInteraction({ poles: [{ re: 0.5, im: 0.3 }], zeros: [], gain: 1 });
        interP.beginDrag(LAYOUT, 270, 108, 10);
        interP.dragTo(LAYOUT, 400, 10);
        expect(Math.hypot(interP.poles[0].re, interP.poles[0].im)).toBeCloseTo(1, 6);
    });

    it('T-INT-4 — deleteSelected elimina el polo/cero seleccionado y limpia la selección', () => {
        const inter = new ZPlaneInteraction({
            poles: [{ re: 0.5, im: 0.3 }, { re: 0.5, im: -0.3 }],
            zeros: [],
            gain: 1,
        });
        inter.beginDrag(LAYOUT, 270, 108, 10); // selecciona polo 0
        inter.deleteSelected();
        // Borrar una raíz compleja elimina también su conjugado (el par).
        expect(inter.poles.length).toBe(0);
        expect(inter.selected).toBeNull();

        const inter2 = new ZPlaneInteraction({ poles: [], zeros: [{ re: -0.5, im: -0.3 }], gain: 1 });
        inter2.beginDrag(LAYOUT, 130, 192, 10);
        inter2.deleteSelected();
        expect(inter2.zeros.length).toBe(0);
    });

    it('T-INT-5 — setGain y snapshot reflejan el estado', () => {
        const inter = new ZPlaneInteraction({ poles: [], zeros: [], gain: 1 });
        inter.setGain(2.5);
        expect(inter.gain).toBe(2.5);
        const snap = inter.snapshot();
        expect(snap.gain).toBe(2.5);
        expect(snap.poles).toEqual([]);
        expect(snap.zeros).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// T-MGR — InteractionManager: coalescing 1 SET_Z_PLANE por frame (M5)
// ---------------------------------------------------------------------------

describe('InteractionManager (M5, coalescing UI → worker)', () => {
    it('T-MGR-1 — N movimientos → 1 frame → exactamente 1 SET_Z_PLANE', () => {
        const mgr = new InteractionManager(LAYOUT, 10);
        mgr.pointerDown(100, 100); // crea polo + comienza arrastre
        for (let i = 0; i < 5; i++) mgr.pointerMove(100 + i * 10, 100);

        const req = mgr.frame();
        expect(req).not.toBeNull();
        expect(req!.type).toBe('SET_Z_PLANE');
        // coalescido: el siguiente frame no produce ningún mensaje
        expect(mgr.frame()).toBeNull();
    });

    it('T-MGR-2 — sin cambios → frame() devuelve null', () => {
        const mgr = new InteractionManager(LAYOUT, 10);
        expect(mgr.frame()).toBeNull();
    });

    it('T-MGR-3 — el SET_Z_PLANE emitido contiene el pack correcto (unpack)', () => {
        const mgr = new InteractionManager(LAYOUT, 10);
        mgr.pointerDown(270, 108); // crea polo en (0.5, 0.3)
        mgr.pointerUp();
        const req = mgr.frame() as Extract<WorkerRequest, { type: 'SET_Z_PLANE' }>;
        expect(req.type).toBe('SET_Z_PLANE');
        const poles = unpackRoots(req.poles);
        // El polo complejo viaja con su conjugado (filtro real, I2/I3).
        expect(poles.length).toBe(2);
        expect(poles[0].re).toBeCloseTo(0.5, 6);
        expect(poles[0].im).toBeCloseTo(0.3, 6);
        expect(poles[1].re).toBeCloseTo(0.5, 6);
        expect(poles[1].im).toBeCloseTo(-0.3, 6);
        expect(unpackRoots(req.zeros)).toEqual([]);
        expect(req.gain).toBe(1);
    });

    it('T-MGR-4 — arrastre exterior → polo con |z| ≤ 1 (clamp en la vía UI)', () => {
        const mgr = new InteractionManager(LAYOUT, 10);
        mgr.pointerDown(100, 100);
        mgr.pointerMove(400, 10);
        mgr.pointerUp();
        const state = mgr.state;
        // El polo complejo arrastrado va en par conjugado (ambos clampeados).
        expect(state.poles.length).toBe(2);
        expect(Math.hypot(state.poles[0].re, state.poles[0].im)).toBeLessThanOrEqual(1);
        expect(state.poles[1].im).toBeCloseTo(-state.poles[0].im, 6);
    });

    it('T-MGR-5 — onWheel ajusta la ganancia (paso 1.1) y la emite en el frame', () => {
        const mgr = new InteractionManager(LAYOUT, 10);
        mgr.onWheel(-1); // rueda arriba → más fuerte
        expect(mgr.gain).toBeCloseTo(1.1, 9);
        mgr.onWheel(1); // rueda abajo → más débil
        expect(mgr.gain).toBeCloseTo(1, 9);
        const req = mgr.frame() as Extract<WorkerRequest, { type: 'SET_Z_PLANE' }>;
        expect(req.gain).toBeCloseTo(1, 9);
    });
});

// ---------------------------------------------------------------------------
// T-VIEW — ZPlaneView: dibujo Canvas 2D (hilo A)
// ---------------------------------------------------------------------------

describe('ZPlaneView (Canvas 2D, hilo A)', () => {
    it('T-VIEW-1 — circunferencia unidad en (cx, cy, radius) y cruz de polo en el píxel proyectado', () => {
        const ctx = new MockCtx();
        const view = new ZPlaneView(ctx, LAYOUT);
        // polo (0.5, 0) → pixel (270, 150); cruz con media longitud s = 8
        const state: ZPlaneState = { poles: [{ re: 0.5, im: 0 }], zeros: [], gain: 1 };
        view.draw(state);

        // limpieza + fondo
        expect(hasOp(ctx, 'clearRect', 0, 0, 400, 300)).toBe(true);

        // circunferencia unidad inscrita
        expect(hasOp(ctx, 'arc', 200, 150, 140, 0, 2 * Math.PI)).toBe(true);

        // cruz × del polo proyectado en (270, 150): dos diagonales
        expect(hasOp(ctx, 'moveTo', 270 - 8, 150 - 8)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 270 + 8, 150 + 8)).toBe(true);
        expect(hasOp(ctx, 'moveTo', 270 + 8, 150 - 8)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 270 - 8, 150 + 8)).toBe(true);
    });

    it('T-VIEW-2 — el cero se dibuja como circunferencia ○ en su píxel proyectado', () => {
        const ctx = new MockCtx();
        const view = new ZPlaneView(ctx, LAYOUT);
        // cero (0, 0.5) → pixel (200, 80); radio de marca = 8
        const state: ZPlaneState = { poles: [], zeros: [{ re: 0, im: 0.5 }], gain: 1 };
        view.draw(state);
        expect(hasOp(ctx, 'arc', 200, 80, 8, 0, 2 * Math.PI)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T-RELAY — AudioGraphRelay: worker → main → node.port (§3.2)
// ---------------------------------------------------------------------------

describe('AudioGraphRelay (relay worker → main → node.port, §3.2)', () => {
    it('T-RELAY-1 — COEFFICIENTS → SET_COEFFICIENTS (mismo SOS + rampa por defecto)', () => {
        const p = makeRelayPorts();
        const relay = new AudioGraphRelay(p);
        relay.onWorkerMessage({ type: 'COEFFICIENTS', sos: EMPTY_SOS });
        expect(p.nodeMessages).toHaveLength(1);
        const m = p.nodeMessages[0];
        expect(m.type).toBe('SET_COEFFICIENTS');
        if (m.type === 'SET_COEFFICIENTS') {
            expect(m.sos).toBe(EMPTY_SOS);
            expect(m.ramp).toEqual(DEFAULT_RAMP);
        }
    });

    it('T-RELAY-2 — setters (fuente, ganancia, bypass, play) y reenvío UI → worker', () => {
        const p = makeRelayPorts();
        const relay = new AudioGraphRelay(p);
        relay.setSource('sine');
        relay.setGain(0.5);
        relay.setBypass(true);
        relay.setPlaying(true);
        relay.sendWorker({ type: 'PING' });

        expect(p.nodeMessages).toEqual([
            { type: 'SET_SOURCE', source: 'sine', ramp: DEFAULT_RAMP },
            { type: 'SET_GAIN', gain: 0.5, ramp: DEFAULT_RAMP },
            { type: 'SET_BYPASS', bypass: true, ramp: DEFAULT_RAMP },
            { type: 'PLAY', start: true },
        ]);
        expect(p.workerMessages).toEqual([{ type: 'PING' }]);
    });

    it('T-RELAY-3 — SPECTRUM_VERSION/PONG no se relean al nodo (lectura directa del SAB, §9.1)', () => {
        const p = makeRelayPorts();
        const relay = new AudioGraphRelay(p);
        relay.onWorkerMessage({ type: 'SPECTRUM_VERSION', version: 5 });
        relay.onWorkerMessage({ type: 'PONG' });
        expect(p.nodeMessages).toHaveLength(0);
    });
});
