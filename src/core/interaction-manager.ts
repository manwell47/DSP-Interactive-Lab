/**
 * src/core/interaction-manager.ts
 *
 * Fase 8 — Hilo A: orquestación de la interacción + coalescing UI → worker (M5).
 *
 * Traduce eventos de puntero (down/move/up) y rueda a mutaciones del estado
 * del plano Z (ZPlaneInteraction) y produce, como máximo, UN `SET_Z_PLANE` por
 * frame vía `frame()`: N eventos de puntero dentro de un RAF se consolidan en
 * un único mensaje empaquetado (M4/M5, ARCHITECTURE.md §3.2).
 *
 * La vista lee `state`/`selected` para dibujar; el reloj de frames (RAF) llama
 * a `frame()`; si devuelve un mensaje, `audio-graph.sendWorker()` lo reenvía.
 */
import { packRoots } from './pack';
import { pixelToZ } from './z-plane-layout';
import { ZPlaneInteraction } from './z-plane-interaction';
import type { HitTarget } from './z-plane-interaction';
import type { ZPlaneLayout } from './z-plane-layout';
import type { WorkerRequest, ZPlaneState } from './types';

/** Paso relativo de ganancia por notch de rueda (scroll up → +1.1×). */
const GAIN_STEP = 1.1;

export class InteractionManager {
    private layout: ZPlaneLayout;
    private readonly thresholdPx: number;
    private readonly interaction: ZPlaneInteraction;
    /** Hay un cambio pendiente de enviar al worker (coalescing M5). */
    private dirty = false;

    constructor(layout: ZPlaneLayout, thresholdPx = 12) {
        this.layout = layout;
        this.thresholdPx = thresholdPx;
        this.interaction = new ZPlaneInteraction();
    }

    /** Raíz seleccionada (para el resaltado de la vista). */
    get selected(): HitTarget {
        return this.interaction.selected;
    }

    /** Ganancia actual del usuario. */
    get gain(): number {
        return this.interaction.gain;
    }

    /** Instantánea del estado (para la vista / pruebas). */
    get state(): ZPlaneState {
        return this.interaction.snapshot();
    }

    /** Actualiza el layout tras un resize (M6 solo afecta al SAB, no aquí). */
    setLayout(layout: ZPlaneLayout): void {
        this.layout = layout;
    }

    /** pointerdown: selecciona o crea un polo; marca dirty solo si crea. */
    pointerDown(x: number, y: number): void {
        const before = this.interaction.poles.length;
        this.interaction.beginDrag(this.layout, x, y, this.thresholdPx);
        if (this.interaction.poles.length !== before) this.dirty = true;
    }

    /** pointermove: solo arrastra si hay un arrastre en curso (marca dirty). */
    pointerMove(x: number, y: number): void {
        if (this.interaction.isDragging) {
            this.interaction.dragTo(this.layout, x, y);
            this.dirty = true;
        }
    }

    /** pointerup: termina el arrastre (mantiene la selección). */
    pointerUp(): void {
        this.interaction.endDrag();
    }

    /** Elimina la raíz seleccionada (si la hay). */
    deleteSelected(): void {
        const was = this.interaction.selected;
        this.interaction.deleteSelected();
        if (was) this.dirty = true;
    }

    /** Crea un cero en (x, y) del lienzo (clic derecho) y marca dirty. */
    createZero(x: number, y: number): void {
        this.interaction.createZero(pixelToZ(this.layout, x, y));
        this.dirty = true;
    }

    /** Rueda del ratón: ajusta la ganancia en pasos de 1.1× (up = más fuerte). */
    onWheel(deltaY: number): void {
        const factor = deltaY < 0 ? GAIN_STEP : 1 / GAIN_STEP;
        this.interaction.setGain(this.interaction.gain * factor);
        this.dirty = true;
    }

    /**
     * Bomba de coalescing (M5): devuelve el `SET_Z_PLANE` pendiente (si el
     * estado cambió desde el último frame) y resetea el flag; si no hubo
     * cambios, devuelve null. Como máximo 1 mensaje por llamada.
     */
    frame(): WorkerRequest | null {
        if (!this.dirty) return null;
        this.dirty = false;
        const state = this.interaction.snapshot();
        return {
            type: 'SET_Z_PLANE',
            poles: packRoots(state.poles),
            zeros: packRoots(state.zeros),
            gain: state.gain,
        };
    }
}
