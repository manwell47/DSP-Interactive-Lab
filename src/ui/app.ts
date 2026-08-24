/**
 * src/ui/app.ts
 *
 * Fase 9 — Hilo A: DspApp — orquestación completa del main thread.
 *
 * Conecta los núcleos de Fases 8/9 en el navegador sin calcular DSP
 * (§2 regla de oro: A no calcula, B no renderiza, C no asigna):
 *   - InteractionManager : edición del plano Z y coalescing 1 SET_Z_PLANE por
 *     frame (M5). DspApp.onPointerDown/onWheel/deleteSelected llaman a
 *     `forward()` (frame() → relay.sendWorker) y redibujan.
 *   - AudioGraphRelay : relay worker → main → node.port (solo COEFFICIENTS).
 *   - Renderer (RAF) : sondea la versión atómica del SAB (§9.1) y llama a
 *     draw() solo cuando cambia.
 *   - InspectorView : estado de control de audio (fuente, ganancia, bypass, play).
 *   - sab-layout : convierte el SAB del worker en vistas Float64 cuando llega
 *     un SPECTRUM_VERSION con sharedBuffer.
 *
 * Port-like: todos los puertos/contextos se inyectan (main.ts usa globalThis
 * en el navegador; las pruebas usan mocks).
 */
import { makeLayout } from '../core/z-plane-layout';
import { InteractionManager } from '../core/interaction-manager';
import { AudioGraphRelay } from '../core/audio-graph';
import { ZPlaneView } from '../core/z-plane-view';
import type { ZPlaneDraw } from '../core/z-plane-view';
import { createSabViews } from '../core/sab-layout';
import type { SabViews } from '../core/sab-layout';
import { InspectorView } from './inspector-view';
import { SpectrumView } from './spectrum-view';
import { TimeView } from './time-view';
import { Renderer } from './renderer';
import type {
    AudioNodeMessage,
    AudioSourceId,
    SpectrumBuffers,
    TimeDomainBuffers,
    WorkerRequest,
    WorkerResponse,
} from '../core/types';

/** Puertos mínimos del worker (hilo B) — port-like para pruebas. */
export interface WorkerLike {
    postMessage(message: WorkerRequest): void;
    onmessage?: ((e: { data: WorkerResponse }) => void) | null;
}

/** Puertos mínimos del nodo de audio (hilo C). */
export interface NodeLike {
    postMessage(message: AudioNodeMessage): void;
}

/** Puertos/contextos inyectables de la app (sin dependencias del DOM). */
export interface DspAppPorts {
    readonly workerPort: WorkerLike;
    readonly nodePort: NodeLike;
    readonly schedule: (cb: () => void) => unknown;
    readonly zCtx: ZPlaneDraw;
    readonly spectrumCtx: ZPlaneDraw;
    readonly timeCtx: ZPlaneDraw;
    readonly width: number;
    readonly height: number;
    readonly margin?: number;
    /** Tamaño propio del lienzo de espectro (fallback: width/height del plano Z). */
    readonly spectrumWidth?: number;
    readonly spectrumHeight?: number;
    /** Tamaño propio del lienzo temporal (fallback: width/height del plano Z). */
    readonly timeWidth?: number;
    readonly timeHeight?: number;
}

export class DspApp {
    readonly manager: InteractionManager;
    readonly relay: AudioGraphRelay;
    readonly inspector: InspectorView;
    readonly zView: ZPlaneView;
    readonly spectrumView: SpectrumView;
    readonly timeView: TimeView;
    private readonly renderer: Renderer;
    private sab: SabViews | null = null;
    private readonly spectrumWidth: number;
    private readonly spectrumHeight: number;
    private readonly timeWidth: number;
    private readonly timeHeight: number;

    constructor(ports: DspAppPorts) {
        const layout = makeLayout(ports.width, ports.height, ports.margin ?? 8);
        this.manager = new InteractionManager(layout);
        this.relay = new AudioGraphRelay({
            workerPort: { postMessage: (m) => ports.workerPort.postMessage(m) },
            nodePort: ports.nodePort,
        });
        this.inspector = new InspectorView();
        this.zView = new ZPlaneView(ports.zCtx, layout);
        // Cada vista de análisis usa el tamaño de SU lienzo (no el del plano Z);
        // en las pruebas (sin per-view) se cae al width/height compartido.
        this.spectrumWidth = ports.spectrumWidth ?? ports.width;
        this.spectrumHeight = ports.spectrumHeight ?? ports.height;
        this.timeWidth = ports.timeWidth ?? ports.width;
        this.timeHeight = ports.timeHeight ?? ports.height;
        this.spectrumView = new SpectrumView(ports.spectrumCtx, this.spectrumWidth, this.spectrumHeight);
        this.timeView = new TimeView(ports.timeCtx, this.timeWidth, this.timeHeight);

        // Entrada de mensajes del worker (hilo B → main).
        ports.workerPort.onmessage = (e) => this.onWorkerMessage(e.data);

        // Bucle RAF: sin SAB todavía, observa un Int32 local (versión -1).
        const fallback = new Int32Array(new SharedArrayBuffer(4));
        this.renderer = new Renderer({
            schedule: ports.schedule,
            versionView: fallback,
            draw: () => this.draw(),
        });
    }

    // -----------------------------------------------------------------------
    // Ciclo de vida
    // -----------------------------------------------------------------------

    /** Arranca el bucle de render (RAF). */
    start(): void {
        this.renderer.start();
    }

    /** Detiene el bucle de render. */
    stop(): void {
        this.renderer.stop();
    }

    // -----------------------------------------------------------------------
    // Entrada de usuario (coordenadas del lienzo del plano Z)
    // -----------------------------------------------------------------------

    /** pointerdown: izquierdo (0) selecciona/crea polo; derecho (2) crea cero. */
    onPointerDown(x: number, y: number, button = 0): void {
        if (button === 2) this.manager.createZero(x, y);
        else this.manager.pointerDown(x, y);
        this.forward();
        this.draw();
    }

    /** pointermove: arrastra la raíz en curso. */
    onPointerMove(x: number, y: number): void {
        this.manager.pointerMove(x, y);
        this.forward();
        this.draw();
    }

    /** pointerup: finaliza el arrastre. */
    onPointerUp(): void {
        this.manager.pointerUp();
    }

    /** Rueda del ratón: ganancia en pasos de 1.1×. */
    onWheel(deltaY: number): void {
        this.manager.onWheel(deltaY);
        this.forward();
        this.draw();
    }

    /** Delete/Backspace: borra la raíz seleccionada. */
    deleteSelected(): void {
        this.manager.deleteSelected();
        this.forward();
        this.draw();
    }

    // -----------------------------------------------------------------------
    // Control de audio (UI → inspector + nodo)
    // -----------------------------------------------------------------------

    setSource(source: AudioSourceId): void {
        this.inspector.source = source;
        this.relay.setSource(source);
    }

    setGain(gain: number): void {
        this.inspector.gain = gain;
        this.relay.setGain(gain);
    }

    setBypass(bypass: boolean): void {
        this.inspector.bypass = bypass;
        this.relay.setBypass(bypass);
    }

    setPlaying(start: boolean): void {
        this.inspector.playing = start;
        this.relay.setPlaying(start);
    }

    // -----------------------------------------------------------------------
    // Resize
    // -----------------------------------------------------------------------

    /** Re-layout completo (plano Z + tamaño de las vistas de espectro/tiempo). */
    resize(
        width: number,
        height: number,
        margin?: number,
        views?: {
            spectrum?: { width: number; height: number };
            time?: { width: number; height: number };
        },
    ): void {
        const layout = makeLayout(width, height, margin ?? 8);
        this.manager.setLayout(layout);
        this.zView.setLayout(layout);
        this.spectrumView.setSize(
            views?.spectrum?.width ?? this.spectrumWidth,
            views?.spectrum?.height ?? this.spectrumHeight,
        );
        this.timeView.setSize(
            views?.time?.width ?? this.timeWidth,
            views?.time?.height ?? this.timeHeight,
        );
        this.draw();
    }

    // -----------------------------------------------------------------------
    // Worker → main
    // -----------------------------------------------------------------------

    /** Entrada de WorkerResponse: fija el SAB y delega en el relay. */
    onWorkerMessage(message: WorkerResponse): void {
        if (message.type === 'SPECTRUM_VERSION' && message.sharedBuffer) {
            this.sab = createSabViews(message.sharedBuffer);
            this.renderer.setVersionView(this.sab.versionView);
        }
        this.relay.onWorkerMessage(message);
    }

    // -----------------------------------------------------------------------
    // Internos
    // -----------------------------------------------------------------------

    /** Redibuja el estado completo (plano Z + espectro + tiempo si hay SAB). */
    draw(): void {
        this.zView.draw(this.manager.state, this.manager.selected);
        if (this.sab) {
            this.spectrumView.drawAll(this.spectrumBuffers());
            this.timeView.drawAll(this.timeBuffers());
        }
    }

    /** Coalescing M5: un único SET_Z_PLANE por frame hacia el worker. */
    private forward(): void {
        const msg = this.manager.frame();
        if (msg) this.relay.sendWorker(msg);
    }

    private spectrumBuffers(): SpectrumBuffers {
        const sab = this.sab!;
        return {
            omega: sab.buffers.get('omega')!,
            magnitudeDb: sab.buffers.get('magnitudeDb')!,
            phaseWrapped: sab.buffers.get('phaseWrapped')!,
            phaseUnwrapped: sab.buffers.get('phaseUnwrapped')!,
            groupDelay: sab.buffers.get('groupDelay')!,
            length: sab.length,
        };
    }

    private timeBuffers(): TimeDomainBuffers {
        const sab = this.sab!;
        return {
            impulse: sab.buffers.get('impulse')!,
            step: sab.buffers.get('step')!,
            length: sab.length,
        };
    }
}
