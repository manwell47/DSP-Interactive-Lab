/**
 * src/tests/phase9_ui.test.ts
 *
 * Fase 9 — Hilo A: envoltorios de despliegue web (ARCHITECTURE.md §5, §9, §12):
 *   T-SAB-1..2    : sab-layout — tamaño del SAB (8·8·L+4), vistas por clave,
 *                   inferencia de L, fillOmega, validación.
 *   T-SPEC-1..5   : SpectrumView — curvas de magnitud (dB), fase y retardo de
 *                   grupo sobre la cuadrícula ω∈[0,2π) + drawAll + clamp dB.
 *   T-TIME-1..2   : TimeView — respuestas al impulso y escalón (escala simétrica).
 *   T-INSP-1..3   : InspectorView — formato H(z) por secciones, recursión y[n],
 *                   fmt/signed + estado de control de audio.
 *   T-RENDER-1..3 : Renderer — bucle RAF con detección de versión atómica (§9.1):
 *                   dibuja solo cuando la versión cambia; stop detiene el bucle.
 *   T-CAPT-1..5   : InputCapture — traducción de coordenadas con origen, rueda
 *                   (ganancia 1.1), teclado (Delete/Backspace), clic derecho
 *                   (crear cero → createZero).
 *   T-APP-1..6    : DspApp — orquestación main-thread completa: relay de
 *                   COEFFICIENTS, coalescing SET_Z_PLANE, SAB + versión + RAF,
 *                   setters de audio, resize.
 */
import { describe, it, expect } from 'vitest';
import { makeLayout } from '../core/z-plane-layout';
import type { ZPlaneLayout } from '../core/z-plane-layout';
import { InteractionManager } from '../core/interaction-manager';
import { ZPlaneView } from '../core/z-plane-view';
import type { ZPlaneDraw } from '../core/z-plane-view';
import { DEFAULT_RAMP } from '../core/audio-graph';
import { unpackRoots } from '../core/pack';
import { SAB_BUFFER_KEYS, createSabViews, fillOmega, sabByteLength } from '../core/sab-layout';
import type { SabViews } from '../core/sab-layout';
import { SpectrumView } from '../ui/spectrum-view';
import { TimeView } from '../ui/time-view';
import { InspectorView, fmt, signed } from '../ui/inspector-view';
import { Renderer } from '../ui/renderer';
import { InputCapture } from '../ui/input-capture';
import { DspApp } from '../ui/app';
import type {
    AudioNodeMessage,
    SosCoefficients,
    SpectrumBuffers,
    TimeDomainBuffers,
    WorkerRequest,
    WorkerResponse,
} from '../core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWO_PI = 2 * Math.PI;

/** Layout de referencia 400×300 con margen 10 → cx=200, cy=150, radius=140. */
const LAYOUT: ZPlaneLayout = makeLayout(400, 300, 10);

/** SOS vacío mínimo (el relay solo reenvía por identidad). */
const EMPTY_SOS: SosCoefficients = { sections: [], firstOrderSection: null, totalGain: 1, order: 0 };

/** SOS de 2.º orden con polo conjugado r=0.6 (a1=-1.2, a2=0.36) para el inspector. */
const SOS_2: SosCoefficients = {
    sections: [{ b0: 1, b1: 0, b2: 0, a1: -1.2, a2: 0.36, k: 1 }],
    firstOrderSection: null,
    totalGain: 1,
    order: 2,
};

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

/** Cuenta operaciones de un tipo concreto. */
function countOps(ctx: MockCtx, type: string): number {
    return ctx.ops.filter((o) => o.type === type).length;
}

/** Gestor + layout de referencia para pruebas de InputCapture. */
function makeManager(): { manager: InteractionManager; layout: ZPlaneLayout } {
    const layout = makeLayout(400, 300, 10);
    return { manager: new InteractionManager(layout), layout };
}

/** RAF simulado: `schedule` acumula callbacks; `tick` ejecuta el pendiente. */
function makeRaf() {
    let scheduled = 0;
    let pending: (() => void) | null = null;
    return {
        get scheduled() { return scheduled; },
        schedule: (cb: () => void) => { scheduled += 1; pending = cb; return scheduled; },
        tick: () => { const cb = pending; pending = null; if (cb) cb(); },
    };
}

// ---------------------------------------------------------------------------
// T-SAB — sab-layout: tamaño, vistas por clave, inferencia de L, fillOmega
// ---------------------------------------------------------------------------

describe('SabLayout (§9.1, layout del SharedArrayBuffer)', () => {
    it('T-SAB-1 — tamaño 8·8·L+4, vistas por clave en orden físico, versionView y fillOmega', () => {
        expect(sabByteLength(256)).toBe(8 * 8 * 256 + 4); // 16388

        const sab = new SharedArrayBuffer(sabByteLength(256));
        const views = createSabViews(sab);
        expect(views.length).toBe(256);
        expect(views.buffers.size).toBe(8);
        expect(views.versionView.length).toBe(1);
        expect(SAB_BUFFER_KEYS).toHaveLength(8);

        // Orden físico: cada búfer de 8·L bytes, versión Int32 al final.
        let offset = 0;
        for (const key of SAB_BUFFER_KEYS) {
            const v = views.buffers.get(key)!;
            expect(v.length).toBe(256);
            expect(v.byteOffset).toBe(offset);
            expect(v.byteLength).toBe(8 * 256);
            offset += 8 * 256;
        }
        expect(views.versionView.byteOffset).toBe(8 * 8 * 256);

        // fillOmega: ω[n] = n·2π/L.
        const omega = views.buffers.get('omega')!;
        fillOmega(omega, 256);
        expect(omega[0]).toBe(0);
        expect(omega[1]).toBeCloseTo((2 * Math.PI) / 256, 9);
        expect(omega[255]).toBeCloseTo((2 * Math.PI * 255) / 256, 9);
    });

    it('T-SAB-2 — createSabViews lanza en SAB con tamaño no válido y acepta el válido', () => {
        expect(() => createSabViews(new SharedArrayBuffer(100))).toThrow();
        // 8·8·L+4 con L=256 es 16388; 16384 no es un layout válido.
        expect(() => createSabViews(new SharedArrayBuffer(16384))).toThrow();
        const ok = createSabViews(new SharedArrayBuffer(sabByteLength(32)));
        expect(ok.length).toBe(32);
    });
});

// ---------------------------------------------------------------------------
// T-SPEC — SpectrumView: magnitud dB, fase, retardo de grupo, drawAll
// ---------------------------------------------------------------------------

describe('SpectrumView (§5, vistas de espectro en Canvas)', () => {
    it('T-SPEC-1 — drawMagnitude: x=(ω/2π)·w, y=h−((dB−MIN)/(MAX−MIN))·h', () => {
        const ctx = new MockCtx();
        const view = new SpectrumView(ctx, 200, 100);
        const omega = new Float64Array([0, Math.PI, TWO_PI]);
        const db = new Float64Array([-120, -60, 20]);
        view.drawMagnitude(db, omega);
        expect(hasOp(ctx, 'moveTo', 0, 100)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 100, 57.142857)).toBe(true); // 100 − (60/140)·100
        expect(hasOp(ctx, 'lineTo', 200, 0)).toBe(true);
        expect(countOps(ctx, 'stroke')).toBe(1);
    });

    it('T-SPEC-2 — drawPhase: y = h/2 − (φ/2π)·h (fase en [−π, π])', () => {
        const ctx = new MockCtx();
        const view = new SpectrumView(ctx, 200, 100);
        const omega = new Float64Array([0, Math.PI, TWO_PI]);
        const phase = new Float64Array([-Math.PI, 0, Math.PI]);
        view.drawPhase(phase, omega);
        expect(hasOp(ctx, 'moveTo', 0, 100)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 100, 50)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 200, 0)).toBe(true);
    });

    it('T-SPEC-3 — drawGroupDelay: auto-escala a max|τ_g| con y = h·(1 − τ/max)', () => {
        const ctx = new MockCtx();
        const view = new SpectrumView(ctx, 200, 100);
        const omega = new Float64Array([0, Math.PI, TWO_PI]);
        const gd = new Float64Array([0, 25, 50]);
        view.drawGroupDelay(gd, omega);
        expect(hasOp(ctx, 'moveTo', 0, 100)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 100, 50)).toBe(true);   // 100 − (25/50)·100
        expect(hasOp(ctx, 'lineTo', 200, 0)).toBe(true);    // 100 − (50/50)·100
    });

    it('T-SPEC-4 — drawAll dibuja rejilla + 3 curvas + leyenda', () => {
        const ctx = new MockCtx();
        const view = new SpectrumView(ctx, 200, 100);
        const buffers: SpectrumBuffers = {
            omega: new Float64Array([0, Math.PI, TWO_PI]),
            magnitudeDb: new Float64Array([-120, -60, 20]),
            phaseWrapped: new Float64Array([-Math.PI, 0, Math.PI]),
            phaseUnwrapped: new Float64Array([-Math.PI, 0, Math.PI]),
            groupDelay: new Float64Array([0, 25, 50]),
            length: 3,
        };
        view.drawAll(buffers);
        // Rejilla (7 niveles dB + 5 frecuencias) + 3 curvas + 3 muestras de leyenda
        expect(countOps(ctx, 'beginPath')).toBe(7 + 5 + 3 + 3);
        expect(countOps(ctx, 'stroke')).toBe(7 + 5 + 3 + 3);
        // Curvas en sus píxeles característicos
        expect(hasOp(ctx, 'lineTo', 100, 57.142857)).toBe(true); // magnitud
        expect(hasOp(ctx, 'lineTo', 100, 50)).toBe(true);         // fase y retardo
        // Etiquetas de rejilla (dB y frecuencia) y de leyenda
        expect(ctx.ops.some((o) => o.type === 'fillText' && o.args[0] === '-60')).toBe(true);
        expect(ctx.ops.some((o) => o.type === 'fillText' && o.args[0] === 'π')).toBe(true);
        expect(ctx.ops.some((o) => o.type === 'fillText' && o.args[0] === 'magnitud (dB)')).toBe(true);
    });

    it('T-SPEC-5 — la magnitud se clampea a [MAG_DB_MIN, MAG_DB_MAX]', () => {
        const ctx = new MockCtx();
        const view = new SpectrumView(ctx, 200, 100);
        const omega = new Float64Array([0, TWO_PI]);
        const db = new Float64Array([-200, 40]); // por debajo de −120 y por encima de 20
        view.drawMagnitude(db, omega);
        expect(hasOp(ctx, 'moveTo', 0, 100)).toBe(true); // −200 → −120 → y=100
        expect(hasOp(ctx, 'lineTo', 200, 0)).toBe(true); //   40  →  20  → y=0
    });
});

// ---------------------------------------------------------------------------
// T-TIME — TimeView: impulso y escalón (escala simétrica)
// ---------------------------------------------------------------------------

describe('TimeView (§5, dominio temporal)', () => {
    it('T-TIME-1 — drawImpulse: escala simétrica y = h/2 − (v/scale)·(h/2)', () => {
        const ctx = new MockCtx();
        const view = new TimeView(ctx, 200, 100);
        const h = new Float64Array([0, 1, 0]);
        view.drawImpulse(h);
        expect(hasOp(ctx, 'moveTo', 0, 50)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 100, 0)).toBe(true);
        expect(hasOp(ctx, 'lineTo', 200, 50)).toBe(true);
    });

    it('T-TIME-2 — drawAll dibuja eje cero + impulso + escalón + leyenda', () => {
        const ctx = new MockCtx();
        const view = new TimeView(ctx, 200, 100);
        const buffers: TimeDomainBuffers = {
            impulse: new Float64Array([0, 1, 0]),
            step: new Float64Array([0, 1, 1]),
            length: 3,
        };
        view.drawAll(buffers);
        // Ejes (bordes + eje cero) + 2 curvas + 2 muestras de leyenda
        expect(countOps(ctx, 'beginPath')).toBe(6);
        expect(countOps(ctx, 'stroke')).toBe(6);
        expect(hasOp(ctx, 'moveTo', 0, 50)).toBe(true);   // eje cero y ambas curvas
        expect(hasOp(ctx, 'lineTo', 100, 0)).toBe(true);  // impulso (pico) y escalón (subida)
        expect(hasOp(ctx, 'lineTo', 200, 50)).toBe(true); // impulso: vuelve a 0
        expect(hasOp(ctx, 'lineTo', 200, 0)).toBe(true);  // escalón: asienta en 1 → y=0
        expect(ctx.ops.some((o) => o.type === 'fillText' && o.args[0] === 'impulso h[n]')).toBe(true);
        expect(ctx.ops.some((o) => o.type === 'fillText' && o.args[0] === 'escalón s[n]')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T-INSP — InspectorView: formato H(z), recursión y[n], control de audio
// ---------------------------------------------------------------------------

describe('InspectorView (§5, inspector matemático y de audio)', () => {
    it('T-INSP-1 — formatTransfer renderiza H(z) por secciones con totalGain', () => {
        expect(InspectorView.formatTransfer(SOS_2)).toBe(
            'H(z) = 1 · (1 + 0 z^-1 + 0 z^-2 / 1 - 1.2 z^-1 + 0.36 z^-2)',
        );
    });

    it('T-INSP-2 — formatEquation renderiza la recursión de cada sección', () => {
        expect(InspectorView.formatEquation(SOS_2)).toBe(
            'sección 0: y[n] = 1 x[n] + 0 x[n-1] + 0 x[n-2] + 1.2 y[n-1] - 0.36 y[n-2]',
        );
    });

    it('T-INSP-3 — fmt/signed y el estado de control de audio con sus setters', () => {
        expect(fmt(1.2)).toBe('1.2');
        expect(fmt(0.36)).toBe('0.36');
        expect(fmt(1)).toBe('1');
        expect(fmt(0)).toBe('0');
        expect(fmt(-0.0000000005)).toBe('0'); // |x| < 1e-9 → '0'
        expect(signed(-1.2)).toBe('- 1.2');
        expect(signed(0.36)).toBe('+ 0.36');
        expect(signed(0)).toBe('+ 0');

        const inspector = new InspectorView();
        expect(inspector.source).toBe('white-noise');
        expect(inspector.gain).toBe(1);
        expect(inspector.bypass).toBe(false);
        expect(inspector.playing).toBe(false);

        inspector.source = 'sine';
        inspector.gain = 0.5;
        inspector.bypass = true;
        inspector.playing = true;
        expect(inspector.source).toBe('sine');
        expect(inspector.gain).toBe(0.5);
        expect(inspector.bypass).toBe(true);
        expect(inspector.playing).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T-RENDER — Renderer: bucle RAF con detección de versión atómica (§9.1)
// ---------------------------------------------------------------------------

describe('Renderer (§9.1, bucle RAF con versión SAB)', () => {
    it('T-RENDER-1 — dibuja solo cuando la versión atómica cambia', () => {
        const versionView = new Int32Array(new SharedArrayBuffer(4));
        let draws = 0;
        const raf = makeRaf();
        const r = new Renderer({ schedule: raf.schedule, versionView, draw: () => { draws += 1; } });

        r.start(); // lastVersion = 0; programa 1 frame
        expect(draws).toBe(0);
        expect(raf.scheduled).toBe(1);

        raf.tick(); // versión sin cambios → no dibuja; reprograma
        expect(draws).toBe(0);
        expect(raf.scheduled).toBe(2);

        Atomics.store(versionView, 0, 4);
        raf.tick(); // 4 ≠ 0 → dibuja
        expect(draws).toBe(1);

        raf.tick(); // 4 == 4 → no dibuja
        expect(draws).toBe(1);
    });

    it('T-RENDER-2 — stop detiene el bucle (sin dibujos ni reprogramación)', () => {
        const versionView = new Int32Array(new SharedArrayBuffer(4));
        let draws = 0;
        const raf = makeRaf();
        const r = new Renderer({ schedule: raf.schedule, versionView, draw: () => { draws += 1; } });

        r.start();
        raf.tick(); // drena el callback programado y reprograma
        const scheduledBeforeStop = raf.scheduled;
        r.stop();
        Atomics.store(versionView, 0, 9);
        raf.tick(); // callback pendiente: running=false → nada
        expect(draws).toBe(0);
        expect(raf.scheduled).toBe(scheduledBeforeStop);
    });

    it('T-RENDER-3 — setVersionView cambia el búfer observado', () => {
        const v1 = new Int32Array(new SharedArrayBuffer(4));
        const v2 = new Int32Array(new SharedArrayBuffer(4));
        let draws = 0;
        const raf = makeRaf();
        const r = new Renderer({ schedule: raf.schedule, versionView: v1, draw: () => { draws += 1; } });
        r.setVersionView(v2);

        r.start(); // lastVersion = Atomics.load(v2) = 0
        Atomics.store(v2, 0, 1);
        raf.tick(); // v2 cambió → dibuja
        expect(draws).toBe(1);

        Atomics.store(v1, 0, 99);
        raf.tick(); // sigue observando v2 (sin cambios) → no dibuja
        expect(draws).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// T-CAPT — InputCapture: origen, rueda, teclado, clic derecho (createZero)
// ---------------------------------------------------------------------------

describe('InputCapture (§5, captura de eventos → manager)', () => {
    it('T-CAPT-1 — pointerDown traduce coordenadas por el origen → polo en (0.5, 0.3)', () => {
        const { manager } = makeManager();
        const cap = new InputCapture(manager, { x: 50, y: 60 });
        cap.onPointerDown({ clientX: 320, clientY: 168, button: 0 });
        const s = manager.state;
        // Polo complejo + su conjugado (filtro real, I2/I3).
        expect(s.poles).toHaveLength(2);
        expect(s.poles[0].re).toBeCloseTo(0.5, 9); // (320−50−200)/140
        expect(s.poles[0].im).toBeCloseTo(0.3, 9); // (150−(168−60))/140
        expect(s.poles[1].re).toBeCloseTo(0.5, 9);
        expect(s.poles[1].im).toBeCloseTo(-0.3, 9);
    });

    it('T-CAPT-2 — onWheel ajusta la ganancia en pasos de 1.1× (arriba = más fuerte)', () => {
        const { manager } = makeManager();
        const cap = new InputCapture(manager);
        expect(manager.gain).toBe(1);
        cap.onWheel({ deltaY: -100 });
        expect(manager.gain).toBeCloseTo(1.1, 9);
        cap.onWheel({ deltaY: 100 });
        expect(manager.gain).toBeCloseTo(1, 9);
    });

    it('T-CAPT-3 — onKeyDown Delete elimina la raíz seleccionada', () => {
        const { manager } = makeManager();
        const cap = new InputCapture(manager);
        cap.onPointerDown({ clientX: 270, clientY: 108, button: 0 }); // crea polo y lo selecciona
        expect(manager.state.poles).toHaveLength(2); // polo complejo + conjugado
        cap.onKeyDown('Delete');
        expect(manager.state.poles).toHaveLength(0); // Delete borra el par
        expect(manager.selected).toBeNull();
    });

    it('T-CAPT-4 — clic derecho (button 2) crea un cero y marca dirty (SET_Z_PLANE)', () => {
        const { manager } = makeManager();
        const cap = new InputCapture(manager);
        cap.onPointerDown({ clientX: 270, clientY: 108, button: 2 });
        // Cero complejo + su conjugado (filtro real, I2/I3).
        expect(manager.state.zeros).toHaveLength(2);
        expect(manager.state.zeros[0].re).toBeCloseTo(0.5, 9);
        expect(manager.state.zeros[0].im).toBeCloseTo(0.3, 9);
        expect(manager.state.zeros[1].re).toBeCloseTo(0.5, 9);
        expect(manager.state.zeros[1].im).toBeCloseTo(-0.3, 9);
        const msg = manager.frame();
        expect(msg?.type).toBe('SET_Z_PLANE');
        if (msg && msg.type === 'SET_Z_PLANE') {
            expect(unpackRoots(msg.zeros)).toHaveLength(2);
        }
    });

    it('T-CAPT-5 — onKeyDown Backspace también borra la selección', () => {
        const { manager } = makeManager();
        const cap = new InputCapture(manager);
        cap.onPointerDown({ clientX: 270, clientY: 108, button: 0 });
        expect(manager.state.poles).toHaveLength(2); // polo complejo + conjugado
        cap.onKeyDown('Backspace');
        expect(manager.state.poles).toHaveLength(0); // Backspace borra el par
        expect(manager.selected).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// T-APP — DspApp: orquestación main-thread completa
// ---------------------------------------------------------------------------

/** Harness completo de la app: puertos, contextos y RAF simulados. */
function makeApp() {
    const workerMessages: WorkerRequest[] = [];
    const nodeMessages: AudioNodeMessage[] = [];
    const zCtx = new MockCtx();
    const spectrumCtx = new MockCtx();
    const timeCtx = new MockCtx();
    let appOnMessage: ((e: { data: WorkerResponse }) => void) | null = null;
    const raf = makeRaf();
    const workerPort = {
        postMessage: (m: WorkerRequest) => void workerMessages.push(m),
        get onmessage() { return appOnMessage; },
        set onmessage(f: ((e: { data: WorkerResponse }) => void) | null) { appOnMessage = f; },
    };
    const nodePort = { postMessage: (m: AudioNodeMessage) => void nodeMessages.push(m) };
    const app = new DspApp({
        workerPort,
        nodePort,
        schedule: raf.schedule,
        zCtx,
        spectrumCtx,
        timeCtx,
        width: 400,
        height: 300,
        margin: 10,
    });
    return {
        app,
        workerMessages,
        nodeMessages,
        zCtx,
        spectrumCtx,
        timeCtx,
        raf,
        emitWorker: (msg: WorkerResponse) => appOnMessage?.({ data: msg }),
    };
}

describe('DspApp (§5, orquestación main-thread)', () => {
    it('T-APP-1 — COEFFICIENTS del worker → SET_COEFFICIENTS al nodo (rampa por defecto)', () => {
        const h = makeApp();
        h.emitWorker({ type: 'COEFFICIENTS', sos: EMPTY_SOS });
        expect(h.nodeMessages).toHaveLength(1);
        expect(h.nodeMessages[0]).toEqual({
            type: 'SET_COEFFICIENTS',
            sos: EMPTY_SOS,
            ramp: DEFAULT_RAMP,
        });
        expect(h.workerMessages).toHaveLength(0);
    });

    it('T-APP-2 — pointerDown → SET_Z_PLANE empaquetado (polo 0.5+0.3j) y dibujo inmediato', () => {
        const h = makeApp();
        h.app.onPointerDown(270, 108);
        expect(h.workerMessages).toHaveLength(1);
        const msg = h.workerMessages[0];
        expect(msg.type).toBe('SET_Z_PLANE');
        if (msg.type === 'SET_Z_PLANE') {
            expect(msg.gain).toBe(1);
            const poles = unpackRoots(msg.poles);
            // Polo complejo + su conjugado (filtro real, I2/I3).
            expect(poles).toHaveLength(2);
            expect(poles[0].re).toBeCloseTo(0.5, 9);
            expect(poles[0].im).toBeCloseTo(0.3, 9);
            expect(poles[1].re).toBeCloseTo(0.5, 9);
            expect(poles[1].im).toBeCloseTo(-0.3, 9);
        }
        // Dibujo inmediato del plano Z: circunferencia unidad inscrita.
        expect(hasOp(h.zCtx, 'arc', 200, 150, 140, 0, TWO_PI)).toBe(true);
    });

    it('T-APP-3 — SPECTRUM_VERSION con SAB real → versión atómica → draw en RAF', () => {
        const h = makeApp();
        const sab = new SharedArrayBuffer(sabByteLength(64));
        const views = createSabViews(sab);
        fillOmega(views.buffers.get('omega')!, 64);
        const mag = views.buffers.get('magnitudeDb')!;
        mag[0] = -120; mag[32] = -60; mag[63] = 20;
        const phase = views.buffers.get('phaseWrapped')!;
        phase[0] = -Math.PI; phase[63] = Math.PI;
        const gd = views.buffers.get('groupDelay')!;
        gd[0] = 0; gd[63] = 50;

        h.emitWorker({ type: 'SPECTRUM_VERSION', version: 0, sharedBuffer: sab });
        h.app.start(); // lastVersion = 0
        Atomics.store(views.versionView, 0, 4);
        h.raf.tick(); // la versión cambió → draw() dibuja espectro y tiempo
        expect(h.spectrumCtx.ops.some((o) => o.type === 'moveTo')).toBe(true);
        expect(h.timeCtx.ops.some((o) => o.type === 'moveTo')).toBe(true);
        // SPECTRUM_VERSION no se relea al nodo ni reenvía al worker.
        expect(h.nodeMessages).toHaveLength(0);
        expect(h.workerMessages).toHaveLength(0);
        h.app.stop();
    });

    it('T-APP-4 — setters de audio → mensajes al nodo (fuente, ganancia, bypass, play)', () => {
        const h = makeApp();
        h.app.setSource('sine');
        h.app.setGain(0.5);
        h.app.setBypass(true);
        h.app.setPlaying(true);
        expect(h.nodeMessages[0]).toEqual({ type: 'SET_SOURCE', source: 'sine', ramp: DEFAULT_RAMP });
        expect(h.nodeMessages[1]).toEqual({ type: 'SET_GAIN', gain: 0.5, ramp: DEFAULT_RAMP });
        expect(h.nodeMessages[2]).toEqual({ type: 'SET_BYPASS', bypass: true, ramp: DEFAULT_RAMP });
        expect(h.nodeMessages[3]).toEqual({ type: 'PLAY', start: true });
    });

    it('T-APP-5 — onWheel → SET_Z_PLANE con ganancia ×1.1 (coalescing M5)', () => {
        const h = makeApp();
        h.app.onWheel(-100);
        expect(h.workerMessages).toHaveLength(1);
        const msg = h.workerMessages[0];
        expect(msg.type).toBe('SET_Z_PLANE');
        if (msg.type === 'SET_Z_PLANE') expect(msg.gain).toBeCloseTo(1.1, 9);
    });

    it('T-APP-6 — resize(200,100,0) → radio 50 y pointerDown(150,50) → polo (1, 0)', () => {
        const h = makeApp();
        h.app.resize(200, 100, 0);
        h.app.onPointerDown(150, 50);
        expect(hasOp(h.zCtx, 'arc', 100, 50, 50, 0, TWO_PI)).toBe(true);
        const msg = h.workerMessages[0];
        expect(msg.type).toBe('SET_Z_PLANE');
        if (msg.type === 'SET_Z_PLANE') {
            const poles = unpackRoots(msg.poles);
            expect(poles).toHaveLength(1);
            expect(poles[0].re).toBeCloseTo(1, 9);
            expect(poles[0].im).toBeCloseTo(0, 9);
        }
    });
});
