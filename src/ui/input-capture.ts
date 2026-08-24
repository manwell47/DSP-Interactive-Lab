/**
 * src/ui/input-capture.ts
 *
 * Fase 9 — Hilo A: adaptador de eventos de entrada → InteractionManager.
 *
 * Traduce eventos del DOM (pointer/wheel/keyboard) a coordenadas del lienzo
 * del plano Z restando el `origin` del canvas (posición del <canvas> en la
 * página):
 *   - clic izquierdo (button 0): seleccionar o crear un POLO.
 *   - clic derecho  (button 2): crear un CERO (createZero) — vía usable de ceros.
 *   - arrastre: mover la raíz seleccionada.
 *   - rueda: ajustar la ganancia en pasos de 1.1× (arriba = más fuerte).
 *   - Delete/Backspace: borrar la raíz seleccionada.
 *
 * No toca el DOM directamente (tsconfig lib = ES2020): `main.ts` enlaza los
 * listeners del navegador con esta clase.
 */
import type { InteractionManager } from '../core/interaction-manager';

/** Evento de puntero mínimo (compatible estructural con PointerEvent). */
export interface PointerEventLike {
    readonly clientX: number;
    readonly clientY: number;
    readonly button: number;
}

/** Evento de rueda mínimo (compatible estructural con WheelEvent). */
export interface WheelEventLike {
    readonly deltaY: number;
}

export class InputCapture {
    private readonly manager: InteractionManager;
    private readonly origin: { x: number; y: number };

    constructor(manager: InteractionManager, origin: { x: number; y: number } = { x: 0, y: 0 }) {
        this.manager = manager;
        this.origin = origin;
    }

    /** pointerdown: izquierdo crea/selecciona polo; derecho crea cero. */
    onPointerDown(e: PointerEventLike): void {
        const x = e.clientX - this.origin.x;
        const y = e.clientY - this.origin.y;
        if (e.button === 2) this.manager.createZero(x, y);
        else this.manager.pointerDown(x, y);
    }

    /** pointermove: arrastra la raíz en curso (si la hay). */
    onPointerMove(e: PointerEventLike): void {
        this.manager.pointerMove(e.clientX - this.origin.x, e.clientY - this.origin.y);
    }

    /** pointerup: finaliza el arrastre (mantiene la selección). */
    onPointerUp(): void {
        this.manager.pointerUp();
    }

    /** Rueda del ratón: ajusta la ganancia en pasos de 1.1×. */
    onWheel(e: WheelEventLike): void {
        this.manager.onWheel(e.deltaY);
    }

    /** Teclado: Delete/Backspace borran la raíz seleccionada. */
    onKeyDown(key: string): void {
        if (key === 'Delete' || key === 'Backspace') this.manager.deleteSelected();
    }
}
