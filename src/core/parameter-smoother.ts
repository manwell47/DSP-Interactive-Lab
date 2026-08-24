/**
 * src/core/parameter-smoother.ts
 *
 * Fase 5 — ParameterSmoother (ARCHITECTURE.md §7.3):
 *   Suaviza cambios de parámetros de audio para evitar clics (discontinuidades
 *   en la forma de onda). Soporta dos estrategias:
 *
 *    §7.3a rampa lineal   : interpolación de coeficientes/gain de la ranura
 *                           activa a lo largo de R muestras (sin clics; la
 *                           pendiente por muestra queda acotada — T-SMOOTH).
 *    §7.3b crossfade      : dos ranuras de filtro (slotA/slotB) que se mezclan
 *                           con ley de potencia igual (cos/sin) — T-BYPASS.
 *
 * Además:
 *   - bypass             : paso directo y = x (identidad), con crossfade hacia/
 *                          desde el filtro (§7.4).
 *   - commit diferido    : si llega setCoefficients/setBypass durante una rampa
 *                          en curso, se encola y se aplica al terminar.
 *   - M3                 : cero asignaciones en process()/setCoefficients()/
 *                          setBypass() (búferes preasignados en los filtros).
 *
 * Verificado por T-SMOOTH, T-BYPASS y T-M3-smoother.
 */
import { IirSosFilter } from './iir-sos-filter';
import type { SosCoefficients, SmoothingRamp } from './types';

export class ParameterSmoother {
    /** Dos ranuras de filtro para el crossfade (§7.3b). */
    private readonly slotA = new IirSosFilter();
    private readonly slotB = new IirSosFilter();

    /** Ranura estable activa (false → slotA, true → slotB). */
    private useB = false;
    /** Modo identidad: la salida es la entrada (y = x). */
    private bypass = false;
    /** Modo de la rampa en curso. */
    private mode: 'linear' | 'crossfade' = 'linear';
    /** Progreso de la rampa. */
    private R = 0;
    private pos = 0;
    private rampActive = false;
    /** true cuando la rampa en curso es hacia/desde bypass (usa el mezclador). */
    private fadingToBypass = false;

    // Estado del crossfade entre ranuras / bypass
    private crossOldIsB = false;
    private crossOldIsBypass = false;
    private crossNewIsB = false;
    private crossTargetBypass = false;
    /** Ranura que aloja el filtro mientras se está en bypass (§7.4). */
    private bypassFilterIsB = false;

    // Commit diferido (0 = ninguno, 1 = sos, 2 = bypass)
    private pendingKind: 0 | 1 | 2 = 0;
    private pendingSos: SosCoefficients | null = null;
    private pendingBypass = false;
    private pendingRamp: SmoothingRamp = { samples: 0, mode: 'linear' };

    /**
     * Cambia los coeficientes con rampa anti-click. Si hay una rampa en curso,
     * el cambio se difiere y se aplica al terminar (sin solapamiento).
     */
    setCoefficients(sos: SosCoefficients, ramp: SmoothingRamp): void {
        if (this.rampActive) {
            this.pendingKind = 1;
            this.pendingSos = sos;
            this.pendingRamp = ramp;
            return;
        }
        this.startSos(sos, ramp);
    }

    /** Activa/desactiva el bypass con rampa anti-click. */
    setBypass(b: boolean, ramp: SmoothingRamp): void {
        if (this.rampActive) {
            this.pendingKind = 2;
            this.pendingBypass = b;
            this.pendingRamp = ramp;
            return;
        }
        this.startBypass(b, ramp);
    }

    /** Procesa un bloque completo (I/O Float32, estado float64). */
    process(input: Float32Array, output: Float32Array): void {
        const n = Math.min(input.length, output.length);
        for (let i = 0; i < n; i++) output[i] = this.processSample(input[i]);
    }

    /** Procesa una muestra y devuelve y[n] (sin asignación). */
    processSample(x: number): number {
        if (this.bypass && !this.rampActive) return x;

        if (this.rampActive) {
            const alpha = this.R > 0 ? Math.min(1, this.pos / this.R) : 1;
            let y: number;
            if (this.mode === 'linear' && !this.fadingToBypass) {
                // §7.3a: interpolación de coeficientes + ganancia
                y = this.activeSlot().processSampleLinear(x, alpha);
            } else {
                // §7.3b/§7.4: mezcla de la ranura vieja y la nueva
                // (ley de potencia igual para crossfade; lineal para rampa lineal)
                const c = this.mode === 'crossfade' ? Math.cos((Math.PI / 2) * alpha) : 1 - alpha;
                const s = this.mode === 'crossfade' ? Math.sin((Math.PI / 2) * alpha) : alpha;
                const yOld = this.crossOldIsBypass ? x : this.oldSlot().processSample(x);
                const yNew = this.crossTargetBypass ? x : this.newSlot().processSample(x);
                y = c * yOld + s * yNew;
            }
            this.pos++;
            if (this.pos >= this.R) this.finishRamp();
            return y;
        }

        return this.activeSlot().processSample(x);
    }

    // -----------------------------------------------------------------------
    // Internos
    // -----------------------------------------------------------------------

    private activeSlot(): IirSosFilter {
        return this.useB ? this.slotB : this.slotA;
    }

    private oldSlot(): IirSosFilter {
        return this.crossOldIsB ? this.slotB : this.slotA;
    }

    private newSlot(): IirSosFilter {
        return this.crossNewIsB ? this.slotB : this.slotA;
    }

    private startSos(sos: SosCoefficients, ramp: SmoothingRamp): void {
        this.mode = ramp.mode;
        this.R = ramp.samples;
        this.pos = 0;
        if (ramp.samples <= 0) {
            // Cambio inmediato: sin rampa (el estado de la ranura se conserva)
            this.activeSlot().setSos(sos);
            this.bypass = false;
            this.rampActive = false;
            return;
        }
        this.rampActive = true;
        this.fadingToBypass = false;
        if (ramp.mode === 'linear' && !this.bypass) {
            // §7.3a: rampa lineal de coeficientes sobre la ranura activa
            this.activeSlot().beginLinearRamp(sos);
            return;
        }
        // §7.3b (crossfade) o salida de bypass con rampa: la ranura nueva
        // (opuesta a la activa) recibe el nuevo filtro y parte de cero
        if (this.bypass) {
            this.crossOldIsBypass = true;  // el sonido actual es la identidad
            this.crossNewIsB = !this.useB; // ranura libre
        } else {
            this.crossOldIsB = this.useB;
            this.crossOldIsBypass = false;
            this.crossNewIsB = !this.useB;
        }
        this.crossTargetBypass = false;
        this.newSlot().setSos(sos);
        this.newSlot().resetState();
    }

    private startBypass(b: boolean, ramp: SmoothingRamp): void {
        this.mode = ramp.mode;
        this.R = ramp.samples;
        this.pos = 0;
        if (ramp.samples <= 0) {
            // Conmutación inmediata (el filtro queda congelado en su ranura)
            this.bypass = b;
            this.rampActive = false;
            return;
        }
        this.rampActive = true;
        this.fadingToBypass = true;
        if (b) {
            // Hacia bypass: la ranura activa sigue sonando, el destino es identidad
            this.crossOldIsB = this.useB;
            this.crossOldIsBypass = false;
            this.crossTargetBypass = true;
        } else {
            // Salir de bypass: la identidad es la "vieja" y el filtro almacenado
            // en bypassFilterIsB la "nueva" (se reanuda desde su estado congelado)
            this.crossOldIsBypass = true;
            this.crossNewIsB = this.bypassFilterIsB;
            this.crossTargetBypass = false;
        }
    }

    /** Termina la rampa y consolida el estado; aplica cualquier commit diferido. */
    private finishRamp(): void {
        this.rampActive = false;
        if (this.mode === 'linear' && !this.fadingToBypass) {
            this.activeSlot().endLinearRamp();
        } else if (this.crossTargetBypass) {
            this.bypass = true;
            this.bypassFilterIsB = this.crossOldIsB;
        } else {
            this.useB = this.crossNewIsB;
            this.bypass = false;
        }

        // Commit diferido: encadena la siguiente rampa sin interrupción
        if (this.pendingKind === 1 && this.pendingSos) {
            this.pendingKind = 0;
            this.startSos(this.pendingSos, this.pendingRamp);
        } else if (this.pendingKind === 2) {
            this.pendingKind = 0;
            this.startBypass(this.pendingBypass, this.pendingRamp);
        }
    }
}
