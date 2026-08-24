/**
 * src/core/iir-sos-filter.ts
 *
 * Fase 5 — IirSosFilter (ARCHITECTURE.md §7.2; invariantes I9, M3):
 *   Filtro IIR en tiempo real como cascada de secciones SOS (biquads) en
 *   forma directa I (DF-I). Uso previsto: AudioWorkletProcessor (hilo C).
 *
 * Garantías:
 *   - I9 : la cascada SOS reproduce la respuesta de la forma directa
 *          (verificado por T-V2-filter con álgebra polinómica).
 *   - M3 : cero asignaciones en process()/processSample()/setSos() y en las
 *          rampas lineales (todos los búferes se preasignan en el constructor;
 *          verificado por T-M3 con el harness de conteo de asignaciones).
 *
 * Convención de signos (ec. 3.3):
 *   H_k(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 *   y[n] = b0·x[n] + b1·x[n-1] + b2·x[n-2] − a1·y[n-1] − a2·y[n-2]
 *
 * La sección de primer orden (I4, solo N impar) se representa internamente
 * como un biquad con b2 = a2 = 0, unificando el bucle de procesado.
 */
import { MAX_BIQUADS } from './types';
import type { IirSosFilter as IirSosFilterContract } from './types';
import type { SosCoefficients } from './types';

/** Número máximo de secciones SOS que puede alojar el filtro:
 *  MAX_BIQUADS biquads + 1 sección de primer orden (I4). */
const MAX_SECTIONS = MAX_BIQUADS + 1;

/** Coeficientes por sección: b0, b1, b2, a1, a2 (ec. 3.3). */
const COEF_STRIDE = 5;
/** Estado DF-I por sección: x[n-2], x[n-1], y[n-2], y[n-1]. */
const STATE_STRIDE = 4;

export class IirSosFilter implements IirSosFilterContract {
    /** Coeficientes de las secciones (DF-I), preasignados. */
    private readonly coef: Float64Array = new Float64Array(MAX_SECTIONS * COEF_STRIDE);
    /** Estado por sección (x2, x1, y2, y1), preasignado. */
    private readonly state: Float64Array = new Float64Array(MAX_SECTIONS * STATE_STRIDE);
    /** Instantánea de coeficientes al inicio de una rampa lineal. */
    private readonly rampStart: Float64Array = new Float64Array(MAX_SECTIONS * COEF_STRIDE);
    /** Objetivo de coeficientes de una rampa lineal. */
    private readonly rampTarget: Float64Array = new Float64Array(MAX_SECTIONS * COEF_STRIDE);

    private numSections = 0;
    private totalGain = 1;
    private rampActive = false;
    private rampSections = 0;
    private rampGainStart = 1;
    private rampGainTarget = 1;

    /**
     * Carga una configuración SOS. Conserva el estado (no resetea la memoria
     * del filtro): un cambio de coeficientes a boca de bloque no produce
     * silencios ni zumbidos; el anti-click lo gestiona ParameterSmoother.
     */
    setSos(sos: SosCoefficients): void {
        let idx = 0;
        for (const s of sos.sections) {
            const c = idx * COEF_STRIDE;
            this.coef[c] = s.b0;
            this.coef[c + 1] = s.b1;
            this.coef[c + 2] = s.b2;
            this.coef[c + 3] = s.a1;
            this.coef[c + 4] = s.a2;
            idx++;
        }
        if (sos.firstOrderSection) {
            const s = sos.firstOrderSection;
            const c = idx * COEF_STRIDE;
            this.coef[c] = s.b0;
            this.coef[c + 1] = s.b1;
            this.coef[c + 2] = 0; // sección de primer orden: sin término z⁻²
            this.coef[c + 3] = s.a1;
            this.coef[c + 4] = 0;
            idx++;
        }
        this.numSections = idx;
        this.totalGain = sos.totalGain;
        this.rampActive = false;
    }

    /** Pone a cero la memoria del filtro (sin asignación). */
    resetState(): void {
        this.state.fill(0);
    }

    /** Procesa un bloque completo (I/O Float32, estado float64). */
    process(input: Float32Array, output: Float32Array): void {
        const n = Math.min(input.length, output.length);
        for (let i = 0; i < n; i++) {
            output[i] = this.filterSample(input[i]) * this.totalGain;
        }
    }

    /** Procesa una sola muestra y devuelve y[n]. */
    processSample(x: number): number {
        return this.filterSample(x) * this.totalGain;
    }

    /**
     * Inicia una rampa lineal hacia `target` sin asignar memoria. Las secciones
     * presentes solo en el filtro actual se mantienen constantes; las secciones
     * nuevas parten de la sección identidad (H = 1), evitando clics.
     */
    beginLinearRamp(target: SosCoefficients): void {
        const targetSections = target.sections.length + (target.firstOrderSection ? 1 : 0);
        this.rampSections = Math.max(this.numSections, targetSections);

        // Instantánea de los coeficientes actuales
        for (let k = 0; k < this.numSections; k++) {
            const c = k * COEF_STRIDE;
            for (let j = 0; j < COEF_STRIDE; j++) this.rampStart[c + j] = this.coef[c + j];
        }
        // Secciones nuevas: parten de la sección identidad (H = 1)
        for (let k = this.numSections; k < this.rampSections; k++) {
            const c = k * COEF_STRIDE;
            this.rampStart[c] = 1;
            this.rampStart[c + 1] = 0;
            this.rampStart[c + 2] = 0;
            this.rampStart[c + 3] = 0;
            this.rampStart[c + 4] = 0;
        }

        // Objetivo de la rampa
        let idx = 0;
        for (const s of target.sections) {
            const c = idx * COEF_STRIDE;
            this.rampTarget[c] = s.b0;
            this.rampTarget[c + 1] = s.b1;
            this.rampTarget[c + 2] = s.b2;
            this.rampTarget[c + 3] = s.a1;
            this.rampTarget[c + 4] = s.a2;
            idx++;
        }
        if (target.firstOrderSection) {
            const s = target.firstOrderSection;
            const c = idx * COEF_STRIDE;
            this.rampTarget[c] = s.b0;
            this.rampTarget[c + 1] = s.b1;
            this.rampTarget[c + 2] = 0;
            this.rampTarget[c + 3] = s.a1;
            this.rampTarget[c + 4] = 0;
            idx++;
        }
        // Secciones presentes solo en el actual: se mantienen constantes
        for (let k = targetSections; k < this.rampSections; k++) {
            const c = k * COEF_STRIDE;
            for (let j = 0; j < COEF_STRIDE; j++) this.rampTarget[c + j] = this.rampStart[c + j];
        }

        this.rampGainStart = this.totalGain;
        this.rampGainTarget = target.totalGain;
        this.rampActive = true;
    }

    /**
     * Procesa una muestra durante la rampa lineal con progreso α ∈ [0, 1].
     * Interpola coeficientes y ganancia en los búferes preasignados; en α = 0
     * reproduce exactamente el filtro actual y en α = 1 el objetivo.
     */
    processSampleLinear(x: number, alpha: number): number {
        const n = this.rampSections;
        for (let k = 0; k < n; k++) {
            const c = k * COEF_STRIDE;
            for (let j = 0; j < COEF_STRIDE; j++) {
                this.coef[c + j] = this.rampStart[c + j] + alpha * (this.rampTarget[c + j] - this.rampStart[c + j]);
            }
        }
        this.numSections = n;
        const g = this.rampGainStart + alpha * (this.rampGainTarget - this.rampGainStart);
        return this.filterSample(x) * g;
    }

    /** Finaliza la rampa: fija los coeficientes objetivo como estado estable. */
    endLinearRamp(): void {
        for (let k = 0; k < this.rampSections; k++) {
            const c = k * COEF_STRIDE;
            for (let j = 0; j < COEF_STRIDE; j++) this.coef[c + j] = this.rampTarget[c + j];
        }
        this.numSections = this.rampSections;
        this.totalGain = this.rampGainTarget;
        this.rampActive = false;
    }

    /**
     * Cascada DF-I: pasa la muestra por cada sección en orden.
     * y = b0·v + b1·x1 + b2·x2 − a1·y1 − a2·y2 (ec. 3.3), con desplazamiento
     * de memoria al final de cada sección.
     */
    private filterSample(x: number): number {
        let v = x;
        const ns = this.numSections;
        for (let k = 0; k < ns; k++) {
            const c = k * COEF_STRIDE;
            const s = k * STATE_STRIDE;
            const x1 = this.state[s + 1];
            const x2 = this.state[s];
            const y1 = this.state[s + 3];
            const y2 = this.state[s + 2];
            const y = this.coef[c] * v + this.coef[c + 1] * x1 + this.coef[c + 2] * x2
                - this.coef[c + 3] * y1 - this.coef[c + 4] * y2;
            this.state[s + 1] = v; // nuevo x[n-1]
            this.state[s] = x1;    // nuevo x[n-2]
            this.state[s + 3] = y; // nuevo y[n-1]
            this.state[s + 2] = y1; // nuevo y[n-2]
            v = y;
        }
        return v;
    }
}
