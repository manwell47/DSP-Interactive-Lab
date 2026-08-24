/**
 * src/core/iir-sos-processor.ts
 *
 * Fase 7 — Hilo C: AudioWorkletProcessor (ARCHITECTURE.md §7).
 *
 * Procesa AudioNodeMessage (main → worklet, vía node.port) y ejecuta el
 * filtrado IIR en tiempo real sobre bloques de 128 muestras:
 *   - SET_COEFFICIENTS : cambia los coeficientes SOS con rampa anti-click
 *                        (ParameterSmoother.setCoefficients, §7.3).
 *   - SET_SOURCE       : fuente interna (white-noise / sine / user-sample).
 *   - SET_GAIN         : ganancia de salida (rampa lineal).
 *   - SET_BYPASS       : paso directo con crossfade hacia/desde el filtro (§7.4).
 *   - PLAY             : arranca/para el sonido.
 *
 * process() es cero-asignación (M3, §8): escribe en el búfer de salida
 * preasignado y usa generadores escalares (LCG para ruido, fase para seno).
 *
 * La clase es un "port-like" (núcleo puro testeable en Node): en un
 * AudioWorkletGlobalScope real se auto-registra como 'iir-sos-processor'
 * mediante un envoltorio que extiende AudioWorkletProcessor.
 */
import { ParameterSmoother } from './parameter-smoother';
import { REFERENCE_SAMPLE_RATE } from './types';
import type { AudioNodeMessage, AudioSourceId } from './types';

/** Frecuencia por defecto del generador senoidal (Hz). */
const DEFAULT_SINE_FREQUENCY = 440;
const TWO_PI = 2 * Math.PI;

/** Semilla del LCG de ruido blanco (Numerical Recipes). */
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 4294967296;

/**
 * Log de consola seguro en el AudioWorkletGlobalScope. El tsconfig Node no
 * incluye lib DOM, así que `console` no está tipado; se accede vía globalThis.
 */
function workletWarn(...args: unknown[]): void {
    const c = (globalThis as { console?: { warn(...a: unknown[]): void } }).console;
    c?.warn('[worklet]', ...args);
}

/** Puerto del AudioWorkletProcessor (node.port en el hilo C). */
export interface IirSosProcessorPort {
    postMessage(message: unknown): void;
    onmessage: ((event: { data: AudioNodeMessage }) => void) | null;
}

export interface IirSosProcessorOptions {
    /** Frecuencia de muestreo (fs); por defecto globalThis.sampleRate o 48 kHz. */
    readonly sampleRate?: number;
    /** Puerto de mensajes; por defecto globalThis.port (AudioWorkletGlobalScope). */
    readonly port?: IirSosProcessorPort;
}

export class IirSosProcessor {
    private readonly smoother = new ParameterSmoother();
    private readonly sampleRate: number;

    /** Fuente interna seleccionada (§7.4). */
    private source: AudioSourceId = 'none';
    /** Ganancia de salida (ya rampeada al aplicarse el mensaje). */
    private gain = 1;
    /** PLAY: el generador está activo. */
    private playing = false;

    /** Acumulador de fase del seno (Hz → rad). */
    private phase = 0;
    /** Estado del LCG de ruido blanco. */
    private lcgState = 0x9e3779b9;
    /** Ya se registró el primer bloque process() (log único de diagnóstico). */
    private loggedProcess = false;

    constructor(options: IirSosProcessorOptions = {}) {
        const g = globalThis as { sampleRate?: number; port?: IirSosProcessorPort };
        this.sampleRate = options.sampleRate ?? g.sampleRate ?? REFERENCE_SAMPLE_RATE;
        const port = options.port ?? g.port;
        if (port && typeof port.onmessage !== 'function') {
            port.onmessage = (event: { data: AudioNodeMessage }) => this.onMessage(event.data);
        }
    }

    /** Despacho de AudioNodeMessage (main → worklet, §3.2). */
    onMessage(msg: AudioNodeMessage): void {
        switch (msg.type) {
            case 'SET_COEFFICIENTS':
                this.smoother.setCoefficients(msg.sos, msg.ramp);
                break;
            case 'SET_SOURCE':
                this.source = msg.source;
                this.dbg('onMessage SET_SOURCE ->', msg.source);
                break;
            case 'SET_GAIN':
                this.gain = msg.gain;
                this.dbg('onMessage SET_GAIN ->', msg.gain);
                break;
            case 'SET_BYPASS':
                this.smoother.setBypass(msg.bypass, msg.ramp);
                break;
            case 'PLAY':
                this.playing = msg.start;
                this.dbg('onMessage PLAY ->', msg.start);
                break;
        }
    }

    /** Log de diagnóstico SOLO en el AudioWorkletGlobalScope real (no en tests Node). */
    private dbg(...args: unknown[]): void {
        if (typeof (globalThis as { registerProcessor?: unknown }).registerProcessor === 'function') {
            workletWarn(...args);
        }
    }

    /**
     * Procesa un bloque de 128 muestras en mono y escribe la señal IDÉNTICA en
     * TODOS los canales de salida (outCh = 2 → L y R), de modo que suene en ambos
     * altavoces. El canal de entrada del grafo (p. ej. una pista MP3/WAV
     * decodificada → AudioBufferSourceNode) SOLO se usa cuando la fuente es
     * 'user-sample'; si la entrada es estéreo (inCh = 2) se hace downmix L+R/2 a
     * mono. Los generadores internos (white-noise / sine) NUNCA dependen del
     * canal de entrada: en algunos navegadores un AudioWorkletNode entrega un
     * canal mudo (a ceros) aunque no haya conexiones aguas arriba, lo que
     * silenciaba el ruido (§7.4, corrección v1.2.1). 'none' es silencio. La
     * señal se genera UNA vez por muestra (no por canal) para que L y R queden en
     * fase. Cero asignaciones (M3).
     */
    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        _parameters: Record<string, Float32Array>,
    ): boolean {
        const outChannels = outputs[0];
        if (!outChannels || outChannels.length === 0) return true;
        const input = inputs[0]?.[0];
        const input2 = inputs[0]?.[1];
        const n = outChannels[0].length;

        const useInput = this.source === 'user-sample' && input !== undefined;
        if (!this.loggedProcess) {
            this.loggedProcess = true;
            this.dbg(
                'process: primer bloque — source =', this.source,
                'playing =', this.playing,
                'useInput =', useInput,
                'sampleRate =', this.sampleRate,
                'outCh =', outputs[0]?.length ?? 0,
                'inCh =', inputs[0]?.length ?? 0,
            );
        }
        for (let i = 0; i < n; i++) {
            const x = useInput
                ? input2 !== undefined
                    ? (input[i] + input2[i]) * 0.5
                    : input[i]
                : this.sampleSource();
            const y = this.playing ? this.smoother.processSample(x) * this.gain : 0;
            for (let ch = 0; ch < outChannels.length; ch++) {
                outChannels[ch][i] = y;
            }
        }
        return true;
    }

    /** Muestra siguiente del generador interno (escalar, sin asignación). */
    private sampleSource(): number {
        switch (this.source) {
            case 'white-noise': {
                this.lcgState = (Math.imul(LCG_A, this.lcgState) + LCG_C) >>> 0;
                return (this.lcgState / LCG_M) * 2 - 1; // bipolar [-1, 1)
            }
            case 'sine': {
                this.phase += (TWO_PI * DEFAULT_SINE_FREQUENCY) / this.sampleRate;
                if (this.phase >= TWO_PI) this.phase -= TWO_PI;
                return Math.sin(this.phase);
            }
            case 'user-sample':
            case 'none':
            default:
                return 0; // 'none': silencio; 'user-sample' sin canal de entrada
        }
    }
}

// ---------------------------------------------------------------------------
// Auto-registro en un AudioWorkletGlobalScope real (hilo C).
// En Node (pruebas) registerProcessor no existe y este bloque se omite.
// ---------------------------------------------------------------------------
if (typeof (globalThis as { registerProcessor?: unknown }).registerProcessor === 'function') {
    const G = globalThis as unknown as {
        registerProcessor(name: string, ctor: new () => unknown): void;
        AudioWorkletProcessor: new () => { port: IirSosProcessorPort };
        sampleRate: number;
    };
    if (typeof G.AudioWorkletProcessor === 'function') {
        class IirSosProcessorNode extends G.AudioWorkletProcessor {
            private readonly impl: IirSosProcessor;

            constructor() {
                super();
                this.impl = new IirSosProcessor({ sampleRate: G.sampleRate, port: this.port });
            }

            process(
                inputs: Float32Array[][],
                outputs: Float32Array[][],
                parameters: Record<string, Float32Array>,
            ): boolean {
                return this.impl.process(inputs, outputs, parameters);
            }
        }
        workletWarn('registrando iir-sos-processor…');
        G.registerProcessor('iir-sos-processor', IirSosProcessorNode);
        workletWarn('registrado iir-sos-processor, sampleRate =', G.sampleRate);
    }
}
