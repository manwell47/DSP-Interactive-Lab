/**
 * src/core/audio-graph.ts
 *
 * Fase 8 — Hilo A: relay worker → main → node.port (ARCHITECTURE.md §3.2).
 *
 * El DSP Worker (hilo B) publica el espectro en el SharedArrayBuffer (leído
 * directamente por la UI, §9.1) y encadena mensajes WorkerResponse al main.
 * Este relay:
 *   - reenvía SOLO `COEFFICIENTS` al AudioWorkletProcessor (hilo C) como
 *     AudioNodeMessage.SET_COEFFICIENTS con la rampa anti-click por defecto;
 *   - NUNCA relea SPECTRUM_VERSION/PONG (el espectro se lee del SAB; PONG es
 *     solo heartbeat del main);
 *   - expone setters de audio (fuente, ganancia, bypass, play) hacia el nodo y
 *     `sendWorker` para las solicitudes UI → worker (p. ej. el SET_Z_PLANE
 *     coalescido del InteractionManager).
 *
 * El main actúa como único puente entre el worker y el nodo de audio: no
 * calcula DSP (§2: A no calcula).
 */
import type {
    AudioNodeMessage,
    AudioSourceId,
    SmoothingRamp,
    WorkerRequest,
    WorkerResponse,
} from './types';

/** Rampa anti-click por defecto para los cambios de audio (§7.3). */
export const DEFAULT_RAMP: SmoothingRamp = { samples: 256, mode: 'crossfade' };

/** Puertos mínimo del worker (hilo B) y del nodo de audio (hilo C). */
export interface AudioGraphPorts {
    readonly workerPort: { postMessage(message: WorkerRequest): void };
    readonly nodePort: { postMessage(message: AudioNodeMessage): void };
}

export class AudioGraphRelay {
    private readonly workerPort: AudioGraphPorts['workerPort'];
    private readonly nodePort: AudioGraphPorts['nodePort'];

    constructor(ports: AudioGraphPorts) {
        this.workerPort = ports.workerPort;
        this.nodePort = ports.nodePort;
    }

    /** Entrada de mensajes del worker (hilo B → main). */
    onWorkerMessage(message: WorkerResponse): void {
        if (message.type === 'COEFFICIENTS') {
            this.nodePort.postMessage({
                type: 'SET_COEFFICIENTS',
                sos: message.sos,
                ramp: DEFAULT_RAMP,
            });
        }
        // SPECTRUM_VERSION: la UI lee el SAB directamente (§9.1).
        // PONG: heartbeat del main; no se reenvía al nodo.
    }

    /** Reenvía una solicitud de la UI al worker (p. ej. SET_Z_PLANE). */
    sendWorker(request: WorkerRequest): void {
        this.workerPort.postMessage(request);
    }

    /** Selecciona la fuente de audio del nodo (hilo C). */
    setSource(source: AudioSourceId): void {
        this.nodePort.postMessage({ type: 'SET_SOURCE', source, ramp: DEFAULT_RAMP });
    }

    /** Fija la ganancia de reproducción del nodo (hilo C). */
    setGain(gain: number): void {
        this.nodePort.postMessage({ type: 'SET_GAIN', gain, ramp: DEFAULT_RAMP });
    }

    /** Activa/desactiva el bypass del filtro en el nodo (hilo C). */
    setBypass(bypass: boolean): void {
        this.nodePort.postMessage({ type: 'SET_BYPASS', bypass, ramp: DEFAULT_RAMP });
    }

    /** Inicia/detiene la reproducción en el nodo (hilo C). */
    setPlaying(start: boolean): void {
        this.nodePort.postMessage({ type: 'PLAY', start });
    }
}
