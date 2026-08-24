/**
 * src/main.ts
 *
 * Fase 10 — Hilo A (navegador): bootstrap de la app DSP.
 *
 * Este es el ÚNICO punto de entrada del navegador. Conecta los núcleos
 * port-like de las Fases 5–9 con los contextos reales del navegador, sin
 * modificar la pureza del núcleo (que sigue testeándose en Node):
 *
 *   - Hilo C (audio): AudioContext + audioWorklet.addModule(iir-sos-processor)
 *     → AudioWorkletNode('iir-sos-processor') → destination.
 *   - Hilo B (DSP):   new Worker(dsp-worker.ts, { type: 'module' }); el
 *     DspWorker se auto-enlaza a globalThis.onmessage/postMessage dentro del
 *     worker y gestiona el SharedArrayBuffer (sab-layout, §9.1).
 *   - Hilo A (UI):    construye DspApp con puertos reales (workerPort,
 *     node.port, requestAnimationFrame, contextos 2D) y enlaza los listeners
 *     DOM (pointer/wheel/keyboard) a los métodos públicos de DspApp.
 *
 * El wrapper `workerPort` permite que DspApp reciba los mensajes del worker
 * (SPECTRUM_VERSION → SAB, COEFFICIENTS → relay al nodo) mientras `main.ts`
 * observa el mismo flujo para: (1) renderizar el inspector (H(z) y ecuaciones)
 * y (2) ejecutar el handshake inicial PING → PONG → SET_Z_PLANE que puebla el
 * SAB para el primer dibujo.
 *
 * Estado inicial de audio: el AudioWorkletProcessor arranca con `source =
 * 'none'` (silencio) por diseño, así que al arrancar se sincronizan los
 * controles del DOM (fuente, ganancia, bypass) con el nodo para que Play
 * produzca sonido desde el primer momento.
 *
 * Requisito de despliegue: servir con cabeceras COOP/COEP
 * (vite.config.ts server/preview) para que crossOriginIsolated === true y el
 * camino SharedArrayBuffer funcione (ARCHITECTURE.md §9.3, §12.1).
 */
import { DspApp } from './ui/app';
import type { DspAppPorts, NodeLike, WorkerLike } from './ui/app';
import { InspectorView } from './ui/inspector-view';
import { packRoots } from './core/pack';
import type { ZPlaneDraw } from './core/z-plane-view';
import type { AudioSourceId, WorkerRequest, WorkerResponse } from './core/types';

// ---------------------------------------------------------------------------
// Helpers DOM (tipados con lib DOM del tsconfig.browser.json)
// ---------------------------------------------------------------------------

function getEl<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`main.ts: elemento #${id} no encontrado`);
    return el as T;
}

function getCanvas(id: string): HTMLCanvasElement {
    return getEl<HTMLCanvasElement>(id);
}

/**
 * Dimensiona el canvas a su tamaño CSS × devicePixelRatio y devuelve el
 * contexto con el transform de DPR aplicado. Las vistas dibujan en píxeles
 * CSS (ancho/alto del layout), así que el trazado queda nítido en pantallas
 * HiDPI sin cambiar la geometría que usa DspApp.
 *
 * Se devuelve como la superficie mínima ZPlaneDraw (fillStyle: string): el
 * DspApp solo dibuja a través de esa interfaz port-like.
 */
function setupCanvas(canvas: HTMLCanvasElement): ZPlaneDraw {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(`main.ts: contexto 2D no disponible en #${canvas.id}`);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx as unknown as ZPlaneDraw;
}

async function boot(): Promise<void> {
    const status = getEl<HTMLSpanElement>('status');
    const isolated = crossOriginIsolated === true;
    if (isolated) {
        status.textContent = 'SAB habilitado (crossOriginIsolated = true)';
        status.classList.add('ok');
    } else {
        status.textContent = 'Aviso: sin aislamiento cruzado — SharedArrayBuffer no disponible';
        status.classList.add('warn');
    }

    const zCanvas = getCanvas('zplane');
    const spectrumCanvas = getCanvas('spectrum');
    const timeCanvas = getCanvas('time');

    // -----------------------------------------------------------------------
    // Hilo C — audio: AudioWorkletProcessor (iir-sos-processor.ts)
    // -----------------------------------------------------------------------
    let audio: AudioContext | null = null;
    let audioNode: AudioWorkletNode | null = null;
    let nodePort: NodeLike = { postMessage: () => { } };
    try {
        audio = new AudioContext({ latencyHint: 'interactive' });
        await audio.audioWorklet.addModule(
            new URL('./core/iir-sos-processor.ts', import.meta.url),
        );
        audioNode = new AudioWorkletNode(audio, 'iir-sos-processor');
        audioNode.connect(audio.destination);
        nodePort = { postMessage: (m) => audioNode!.port.postMessage(m) };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[main] audio no disponible:', err);
    }

    // -----------------------------------------------------------------------
    // Hilo B — DSP Worker (dsp-worker.ts, tipo módulo)
    // -----------------------------------------------------------------------
    let worker: Worker | null = null;
    let workerPort: WorkerLike = { postMessage: () => { }, onmessage: null };
    try {
        worker = new Worker(
            new URL('./core/dsp-worker.ts', import.meta.url),
            { type: 'module' },
        );
        worker.onerror = (ev) => {
            // eslint-disable-next-line no-console
            console.error('[main] error del worker:', ev.message ?? ev);
        };
        // Wrapper port-like para DspApp: el worker real no implementa WorkerLike
        // por tipos (postMessage acepta any). DspApp asigna workerPort.onmessage.
        workerPort = {
            postMessage: (m: WorkerRequest) => worker!.postMessage(m),
            onmessage: null,
        };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[main] worker no disponible:', err);
    }

    // -----------------------------------------------------------------------
    // Hilo A — UI: contextos 2D + RAF + DspApp
    // -----------------------------------------------------------------------
    const zCtx = setupCanvas(zCanvas);
    const spectrumCtx = setupCanvas(spectrumCanvas);
    const timeCtx = setupCanvas(timeCanvas);

    const ports: DspAppPorts = {
        workerPort,
        nodePort,
        schedule: (cb) => requestAnimationFrame(cb),
        zCtx,
        spectrumCtx,
        timeCtx,
        width: zCanvas.clientWidth,
        height: zCanvas.clientHeight,
        margin: 8,
        // Cada vista usa su propio tamaño de lienzo (no el del plano Z), para
        // que espectro y tiempo se dibujen sin recortes ni distorsión.
        spectrumWidth: spectrumCanvas.clientWidth,
        spectrumHeight: spectrumCanvas.clientHeight,
        timeWidth: timeCanvas.clientWidth,
        timeHeight: timeCanvas.clientHeight,
    };
    const app = new DspApp(ports);

    const inspectorTransfer = getEl<HTMLPreElement>('inspector-transfer');
    const inspectorEquation = getEl<HTMLPreElement>('inspector-equation');

    // -----------------------------------------------------------------------
    // Estado inicial de audio: el worklet arranca con source='none' (silencio).
    // Sincronizar los controles del DOM con el nodo para que Play suene desde
    // el primer arranque y el inspector refleje la fuente seleccionada.
    // -----------------------------------------------------------------------
    const sourceSelect = getEl<HTMLSelectElement>('source');
    const gainInput = getEl<HTMLInputElement>('gain');
    const bypassInput = getEl<HTMLInputElement>('bypass');
    app.setSource(sourceSelect.value as AudioSourceId);
    app.setGain(Number(gainInput.value));
    app.setBypass(bypassInput.checked);

    // -----------------------------------------------------------------------
    // Flujo worker → main: DspApp (SAB + relay) y, en paralelo, el panel
    // inspector y el handshake inicial. Asignar DESPUÉS de construir DspApp
    // para que workerPort.onmessage ya sea el manejador interno de la app.
    // -----------------------------------------------------------------------
    if (worker) {
        worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
            const msg = e.data;
            workerPort.onmessage?.(e);
            if (msg.type === 'COEFFICIENTS') {
                inspectorTransfer.textContent = InspectorView.formatTransfer(msg.sos);
                inspectorEquation.textContent = InspectorView.formatEquation(msg.sos);
            } else if (msg.type === 'PONG') {
                // Worker vivo: puebla el SAB con el estado vacío (H(z) = gain),
                // desencadenando SPECTRUM_VERSION → el renderer dibuja el primer frame.
                worker.postMessage({
                    type: 'SET_Z_PLANE',
                    poles: packRoots([]),
                    zeros: packRoots([]),
                    gain: 1,
                });
            }
        };

        app.start();

        // Handshake: detecta al worker y pide el primer espectro.
        worker.postMessage({ type: 'PING' });
    } else {
        app.start();
    }

    // -----------------------------------------------------------------------
    // Entrada de usuario (coordenadas relativas al canvas del plano Z)
    // -----------------------------------------------------------------------
    const origin = (): { x: number; y: number } => {
        const r = zCanvas.getBoundingClientRect();
        return { x: r.left, y: r.top };
    };

    zCanvas.addEventListener('pointerdown', (e) => {
        void audio?.resume();
        e.preventDefault();
        const o = origin();
        app.onPointerDown(e.clientX - o.x, e.clientY - o.y, e.button);
        try {
            zCanvas.setPointerCapture(e.pointerId);
        } catch {
            // puntero ya liberado o no capturable: ignorar
        }
    });
    zCanvas.addEventListener('pointermove', (e) => {
        const o = origin();
        app.onPointerMove(e.clientX - o.x, e.clientY - o.y);
    });
    zCanvas.addEventListener('pointerup', () => app.onPointerUp());
    zCanvas.addEventListener('pointercancel', () => app.onPointerUp());
    zCanvas.addEventListener(
        'wheel',
        (e) => {
            e.preventDefault();
            app.onWheel(e.deltaY);
        },
        { passive: false },
    );
    // El botón derecho crea ceros (clic derecho en el plano Z) y no debe abrir
    // el menú contextual del navegador. También se suprime en espectro/tiempo.
    for (const canvas of [zCanvas, spectrumCanvas, timeCanvas]) {
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            app.deleteSelected();
        }
    });

    // -----------------------------------------------------------------------
    // Control de audio (inspector → nodo vía DspApp/relay)
    // -----------------------------------------------------------------------

    // Pista importada (MP3/WAV): AudioBuffer decodificado + AudioBufferSourceNode
    // conectado a la entrada del worklet. El worklet solo consume el canal de
    // entrada cuando la fuente es 'user-sample' (§7.4, corrección v1.2.1).
    let importedBuffer: AudioBuffer | null = null;
    let bufferSource: AudioBufferSourceNode | null = null;
    const trackName = getEl<HTMLSpanElement>('track-name');
    const trackFile = getEl<HTMLInputElement>('track-file');
    const playButton = getEl<HTMLButtonElement>('play');
    let playing = false;

    /** Detiene y desconecta la reproducción de la pista importada (si hay). */
    function stopImportedTrack(): void {
        if (bufferSource) {
            try {
                bufferSource.stop();
            } catch {
                // ya terminada: ignorar
            }
            bufferSource.disconnect();
            bufferSource = null;
        }
    }

    /** Arranca la pista importada desde el principio (si hay una cargada). */
    function startImportedTrack(): void {
        if (!audio || !audioNode || !importedBuffer || bufferSource) return;
        const src = audio.createBufferSource();
        src.buffer = importedBuffer;
        src.connect(audioNode);
        src.onended = () => {
            bufferSource = null;
            // Si terminó sola (no por Stop del usuario): apagar el botón Play.
            if (playing && sourceSelect.value === 'user-sample') {
                playing = false;
                app.setPlaying(false);
                playButton.textContent = '▶ Play';
            }
        };
        src.start();
        bufferSource = src;
    }

    // Carga de archivo MP3/WAV → decodeAudioData → AudioBuffer.
    trackFile.addEventListener('change', async () => {
        const file = trackFile.files?.[0];
        if (!file || !audio) return;
        try {
            const decoded = await audio.decodeAudioData(await file.arrayBuffer());
            stopImportedTrack();
            importedBuffer = decoded;
            trackName.textContent = `🎵 ${file.name}`;
            sourceSelect.value = 'user-sample';
            app.setSource('user-sample');
            if (playing) startImportedTrack(); // reanuda con la nueva pista
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[main] no se pudo decodificar la pista:', err);
            trackName.textContent = '⚠️ No se pudo decodificar el archivo';
        }
        trackFile.value = ''; // permite recargar el mismo archivo
    });

    sourceSelect.addEventListener('change', () => {
        app.setSource(sourceSelect.value as AudioSourceId);
        if (sourceSelect.value === 'user-sample') {
            if (playing) startImportedTrack();
        } else {
            stopImportedTrack();
        }
    });

    gainInput.addEventListener('input', () => app.setGain(Number(gainInput.value)));

    bypassInput.addEventListener('change', () => app.setBypass(bypassInput.checked));

    playButton.addEventListener('click', () => {
        void audio?.resume();
        playing = !playing;
        app.setPlaying(playing);
        playButton.textContent = playing ? '⏸ Stop' : '▶ Play';
        if (sourceSelect.value === 'user-sample') {
            if (playing) startImportedTrack();
            else stopImportedTrack();
        }
    });

    // -----------------------------------------------------------------------
    // Resize: re-dimensionar los canvas y re-layout del plano Z
    // -----------------------------------------------------------------------
    function resize(): void {
        setupCanvas(zCanvas);
        setupCanvas(spectrumCanvas);
        setupCanvas(timeCanvas);
        app.resize(
            zCanvas.clientWidth,
            zCanvas.clientHeight,
            8,
            {
                spectrum: {
                    width: spectrumCanvas.clientWidth,
                    height: spectrumCanvas.clientHeight,
                },
                time: {
                    width: timeCanvas.clientWidth,
                    height: timeCanvas.clientHeight,
                },
            },
        );
    }
    window.addEventListener('resize', resize);
}

void boot();
