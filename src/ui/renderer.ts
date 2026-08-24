/**
 * src/ui/renderer.ts
 *
 * Fase 9 — Hilo A: bucle de render con detección de versión atómica (§9.1).
 *
 * El DSP Worker (hilo B) escribe el espectro en el SAB y publica la versión en
 * el Int32 con Atomics.store/notify. El renderer la sondea cada frame (RAF) y
 * llama a `draw()` SOLO cuando la versión cambia (coalescing de dibujo: no se
 * redibuja sin datos nuevos).
 *
 * El programador de frames (`schedule`) es inyectable para testear sin DOM:
 * en producción es requestAnimationFrame; en pruebas, un RAF simulado.
 */
export interface RendererOptions {
    /** Programa el siguiente frame (RAF en producción). */
    readonly schedule: (cb: () => void) => unknown;
    /** Int32Array de versión atómica del SAB (§9.1). */
    readonly versionView: Int32Array;
    /** Dibuja el estado completo (plano Z + espectro + tiempo). */
    readonly draw: () => void;
}

export class Renderer {
    private readonly schedule: (cb: () => void) => unknown;
    private readonly draw: () => void;
    private versionView: Int32Array;
    private lastVersion = -1;
    private running = false;

    constructor(options: RendererOptions) {
        this.schedule = options.schedule;
        this.draw = options.draw;
        this.versionView = options.versionView;
    }

    /** Cambia el Int32Array observado (tras recibir un nuevo SAB). */
    setVersionView(versionView: Int32Array): void {
        this.versionView = versionView;
    }

    /** ¿Está el bucle en marcha? */
    get isRunning(): boolean {
        return this.running;
    }

    /** Arranca el bucle: sincroniza la versión base y programa un frame. */
    start(): void {
        this.running = true;
        this.lastVersion = Atomics.load(this.versionView, 0);
        this.scheduleNext();
    }

    /** Detiene el bucle (no cancela el frame pendiente; simplemente no dibuja). */
    stop(): void {
        this.running = false;
    }

    /** Un frame: redibuja si la versión cambió y reprograma el siguiente. */
    tick(): void {
        if (!this.running) return;
        const v = Atomics.load(this.versionView, 0);
        if (v !== this.lastVersion) {
            this.lastVersion = v;
            this.draw();
        }
        this.scheduleNext();
    }

    private scheduleNext(): void {
        this.schedule(() => this.tick());
    }
}
