/**
 * src/core/dsp-worker.ts
 *
 * Fase 7 — Hilo B: DSP Worker (ARCHITECTURE.md §3, §9).
 *
 * Procesa WorkerRequest (UI → worker) y emite WorkerResponse (worker → UI):
 *   - SET_Z_PLANE        : sintetiza SOS (SosSynthesizer), calcula el espectro
 *                          (SpectrumEngine.computeInto) y las respuestas
 *                          temporales (computeTimeDomain) sobre un SharedArrayBuffer,
 *                          publica la versión con Atomics (§9.1) y encadena
 *                          SPECTRUM_VERSION + COEFFICIENTS.
 *   - SET_SPECTRUM_LENGTH: reasigna el SAB (M6) y repuebla omega.
 *   - PING               : responde PONG (heartbeat, §3.2).
 *
 * El layout del SAB es fijo: 8 búferes Float64Array(L) contiguos
 * (omega, magnitudeDb, phaseWrapped, phaseUnwrapped, groupDelay, impulse,
 * step, scratch) seguidos de 1 Int32Array(1) con la versión atómica:
 *   bytes = 8·L·8 + 4.
 *
 * El hilo main actúa de relay hacia el AudioWorkletProcessor (§3.2): recibe
 * COEFFICIENTS y lo reenvía como AudioNodeMessage.SET_COEFFICIENTS.
 *
 * La clase es un "port-like": recibe un puerto { postMessage } opcional para
 * pruebas; en un Web Worker real (hilo B) se auto-enlaza a globalThis.
 */
import { SAB_BUFFER_KEYS, createSabViews, fillOmega, sabByteLength } from './sab-layout';
import { SosSynthesizer } from './SosSynthesizer';
import { unpackRoots } from './pack';
import { SpectrumEngine } from './spectrum';
import {
    DEFAULT_SPECTRUM_LENGTH,
} from './types';
import type {
    BufferKey,
    SosCoefficients,
    SpectrumBuffers,
    WorkerRequest,
    WorkerResponse,
    ZPlaneState,
} from './types';

/** Puerto mínimo del worker (en pruebas: mock; en producción: globalThis). */
export interface DspWorkerPort {
    postMessage(message: WorkerResponse): void;
}

export class DspWorker {
    private readonly port: DspWorkerPort;
    private readonly synth = new SosSynthesizer();
    private readonly engine = new SpectrumEngine();

    /** Vistas Float64Array sobre el SAB (una por clave de búfer, §8). */
    private readonly bufferViews = new Map<BufferKey, Float64Array>();
    /** Vista Int32 de la versión atómica (§9.1). */
    private versionView!: Int32Array;

    private sab!: SharedArrayBuffer;
    private len: number;

    /**
     * @param port   puerto de salida (por defecto globalThis.postMessage).
     * @param length L inicial (DEFAULT_SPECTRUM_LENGTH).
     */
    constructor(port?: DspWorkerPort, length: number = DEFAULT_SPECTRUM_LENGTH) {
        this.port = port ?? this.defaultPort();
        this.len = length;
        this.allocate();

        // En un Web Worker real (hilo B) existe globalThis.postMessage/onmessage.
        const g = globalThis as { postMessage?: unknown; onmessage?: unknown };
        if (typeof g.postMessage === 'function') {
            g.onmessage = (e: { data: unknown }) => this.handleRequest(e.data as WorkerRequest);
        }
    }

    /** SAB compartido con el renderer (UI lee vía Atomics, §9.1). */
    get sharedBuffer(): SharedArrayBuffer {
        return this.sab;
    }

    /** Longitud espectral actual L. */
    get length(): number {
        return this.len;
    }

    /** Versión atómica publicada (Atomics.load, §9.1). */
    get version(): number {
        return Atomics.load(this.versionView, 0);
    }

    /** Vista SAB de un búfer por clave (para lectura del renderer / pruebas). */
    view(key: BufferKey): Float64Array {
        const v = this.bufferViews.get(key);
        if (!v) throw new Error(`DspWorker: clave de búfer desconocida: ${key}`);
        return v;
    }

    /** Despacho de WorkerRequest (UI → worker, §3.2). */
    handleRequest(req: WorkerRequest): void {
        switch (req.type) {
            case 'PING':
                this.port.postMessage({ type: 'PONG' });
                break;
            case 'SET_SPECTRUM_LENGTH':
                this.setLength(req.length);
                break;
            case 'SET_Z_PLANE':
                this.compute(req);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Internos
    // -----------------------------------------------------------------------

    private defaultPort(): DspWorkerPort {
        return {
            postMessage: (message: WorkerResponse) => {
                const p = (globalThis as { postMessage?: (m: unknown) => void }).postMessage;
                if (p) p(message);
            },
        };
    }

    private setLength(length: number): void {
        if (length === this.len) return;
        this.len = length;
        this.allocate();
        this.port.postMessage({ type: 'SPECTRUM_VERSION', version: this.version, sharedBuffer: this.sab });
    }

    /**
     * Asigna el SAB (una sola vez por sesión salvo resize) y repuebla omega,
     * reutilizando el layout canónico de sab-layout.ts (§9.1).
     */
    private allocate(): void {
        const L = this.len;
        this.sab = new SharedArrayBuffer(sabByteLength(L));
        const views = createSabViews(this.sab);
        this.bufferViews.clear();
        for (const key of SAB_BUFFER_KEYS) {
            this.bufferViews.set(key, views.buffers.get(key)!);
        }
        this.versionView = views.versionView;

        // omega[n] = n·2π/L (fijo; el motor lee este búfer pero no lo escribe).
        fillOmega(views.buffers.get('omega')!, L);
    }

    /** SET_Z_PLANE: síntesis SOS + espectro + respuestas temporales + handshake §9.1. */
    private compute(req: Extract<WorkerRequest, { type: 'SET_Z_PLANE' }>): void {
        const state: ZPlaneState = {
            poles: unpackRoots(req.poles),
            zeros: unpackRoots(req.zeros),
            gain: req.gain,
        };
        const sos: SosCoefficients = this.synth.compute(state);

        const spectrum = this.spectrumBuffers();
        const version = this.engine.computeInto(sos, spectrum);
        this.engine.computeTimeDomain(sos, {
            impulse: this.view('impulse'),
            step: this.view('step'),
            length: this.len,
        });

        // §9.1: escribir buffers → store versión → notify (happens-before).
        Atomics.store(this.versionView, 0, version);
        Atomics.notify(this.versionView, 0);

        this.port.postMessage({ type: 'SPECTRUM_VERSION', version, sharedBuffer: this.sab });
        this.port.postMessage({ type: 'COEFFICIENTS', sos });
    }

    private spectrumBuffers(): SpectrumBuffers {
        return {
            omega: this.view('omega'),
            magnitudeDb: this.view('magnitudeDb'),
            phaseWrapped: this.view('phaseWrapped'),
            phaseUnwrapped: this.view('phaseUnwrapped'),
            groupDelay: this.view('groupDelay'),
            length: this.len,
        };
    }
}

// ---------------------------------------------------------------------------
// Punto de entrada del Web Worker real (hilo B).
// En un Web Worker del navegador existe globalThis.postMessage (también
// enlazable vía globalThis.onmessage), pero NO en Node (pruebas): por eso se
// auto-insta a DspWorker solo dentro del worker. En Node los tests construyen
// DspWorker explícitamente y este bloque se omite.
// ---------------------------------------------------------------------------
if (typeof (globalThis as { postMessage?: unknown }).postMessage === 'function') {
    new DspWorker();
}
