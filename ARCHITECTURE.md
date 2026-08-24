# ARCHITECTURE — Especificación de Software del DSP Interactive Learning Engine v1.2

| Campo | Valor |
|---|---|
| **Versión** | 1.0 |
| **Estado** | Especificación arquitectónica — aprobada como diseño |
| **Fuente de verdad matemática** | [`THEORY_SPECS.md`](THEORY_SPECS.md) — v1.0 aprobada |
| **Obligación de cumplimiento** | Invariantes **I1–I9** y ecuaciones 2.2, 3.3, 3.6, 4.5, 5.1–5.9, 6.3–6.6 de THEORY_SPECS.md |
| **Alcance** | Arquitectura, estructuras de datos, flujo de datos entre hilos, memoria y estrategia de pruebas. **No** incluye código de implementación funcional. |

---

## 1. Propósito y Cumplimiento

Este documento especifica la arquitectura del motor de aprendizaje interactivo de DSP. Su requisito funcional no negociable es que **toda salida (espectro, retardo de grupo, fase desenvuelta, audio) derive exclusivamente de las ecuaciones aprobadas en [`THEORY_SPECS.md`](THEORY_SPECS.md)** y satisfaga los invariantes:

| Invariante | Fuente | Responsable |
|---|---|---|
| **I1** — $\vert d_k \vert \le 0.9999$ | ec. 6.3 | `SosSynthesizer` |
| **I2** — $a_{1k} = -2r_p\cos\theta_p$, $a_{2k} = r_p^2$ | ec. 3.3 | `SosSynthesizer` |
| **I3** — $b_{1k} = -2\rho_z\cos\varphi_z$, $b_{2k} = \rho_z^2$ | ec. 3.3 | `SosSynthesizer` |
| **I4** — orden impar → sección de 1.er orden | ec. 3.4 | `SosSynthesizer` |
| **I5** — escalado de ganancia por sección | ec. 3.5 | `SosSynthesizer` |
| **I6** — retardo de grupo analítico (sin diferencias finitas) | ec. 4.5 | `SpectrumEngine` |
| **I7** — fase desenvuelta (Alg. 5.1 / ec. 5.9) | ec. 5.5, 5.9 | `SpectrumEngine` |
| **I8** — emparejamiento y ordenación de Jackson | §3.6 | `SosSynthesizer` |
| **I9** — $\prod_k H_k(z) = B(z)/A(z)$ en audio | ec. 3.5 | `IirSosProcessor` |

---

## 2. Vista General de la Arquitectura

La aplicación web se divide en **tres dominios de ejecución** (hilos) con responsabilidades disjuntas:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  (A) UI THREAD  — main thread, DOM/Canvas, 60 FPS                       │
│      Entrada del usuario, renderizado de los 4 paneles, orquestación     │
│      del grafo de audio (WebAudio). NUNCA hace matemática DSP.           │
├──────────────────────────────────────────────────────────────────────────┤
│  (B) DSP MATH ENGINE  — Web Worker dedicado, fuera del hilo de UI        │
│      Cálculo inmutable de SOS (I1–I5, I8) y vectores espectrales          │
│      (I6, I7). NUNCA toca el DOM ni la salida de audio.                  │
├──────────────────────────────────────────────────────────────────────────┤
│  (C) AUDIO THREAD  — AudioWorkletGlobalScope, callback process()         │
│      Filtrado IIR en tiempo real (I9) + parameter smoothing anti-click.   │
│      Presupuesto: < 1 ms por bloque de 128 muestras a 48 kHz.            │
└──────────────────────────────────────────────────────────────────────────┘
```

**Regla de oro:** el hilo (A) **no calcula**, el hilo (B) **no renderiza ni reproduce**, el hilo (C) **no asigna memoria** (Sección 8). Esta separación es la que permite sincronización visual absoluta (arrastrar un polo → espectro, tiempo, ecuaciones y audio actualizados) sin caídas de frames ni glitches de audio.

---

## 3. Modelo de Hilos y Pipeline de Datos

### 3.1 Diagrama de flujo entre hilos

```
                       ┌────────────────────────────────────────────┐
                       │  (A) UI THREAD  (main)                     │
                       │                                            │
                       │  ┌──────────────┐     ┌─────────────────┐  │
   pointer/wheel       │  │ InputCapture │     │ Renderer        │  │
   (60 FPS max) ───────┼─▶│ (raw events) │     │ Canvas2D/WebGL  │  │
                       │  └──────┬───────┘     │ @60fps, doble    │  │
                       │         │ coalesce    │ búfer, decima   │  │
                       │  ┌──────▼─────────┐   └────────▲────────┘  │
                       │  │ Interaction    │            │           │
                       │  │ Manager (1 msg │            │ 8. lee SAB│
                       │  │ por RAF)       │            │           │
                       │  └──────┬─────────┘            │           │
                       │         │ 1. SET_Z_PLANE       │           │
                       │         │ (transferible)       │           │
                       │  ┌──────▼─────────┐   ┌────────┴────────┐  │
                       │  │ AudioGraph     │   │ SharedArrayBuf  │  │
                       │  │ (WebAudio:     │   │ (espectral)     │  │
                       │  │  node.port)    │   │ Atomics version │  │
                       │  └──────┬─────────┘   └─────────────────┘  │
                       └─────────┼──────────────────────────────────┘
                   2. SET_Z_PLANE │          3. escribe buffers
                                 ▼            + Atomics version++
                       ┌────────────────────────────────────────────┐
                       │  (B) DSP MATH ENGINE  (Web Worker)         │
                       │                                            │
                       │  ┌────────────────┐   ┌──────────────────┐ │
                       │  │ SosSynthesizer │   │ SpectrumEngine   │ │
                       │  │ I1–I5, I8      │   │ I6, I7           │ │
                       │  │ compute()      │   │ computeInto(SAB) │ │
                       │  │ inmutable      │   │ ec. 3.6, 4.5,    │ │
                       │  │                │   │ Alg. 5.1, ec.5.9 │ │
                       │  └───────┬────────┘   └──────────────────┘ │
                       │          │ 4. SosCoefficients              │
                       │          ▼                                 │
                       │  ┌────────────────┐                        │
                       │  │ BufferPool     │ (zero-allocation)      │
                       │  └────────────────┘                        │
                       └───────────────────┬────────────────────────┘
                      5. AudioNodeMessage  │ SET_COEFFICIENTS + ramp
                        (relay vía main)   ▼
                       ┌────────────────────────────────────────────┐
                       │  (C) AUDIO THREAD  (AudioWorkletProcessor) │
                       │                                            │
                       │  ┌───────────────┐   ┌───────────────────┐ │
                       │  │ MessageQueue  │   │ ParameterSmoother │ │
                       │  │ (coeff target)│──▶│ rampa/crossfade   │ │
                       │  └───────┬───────┘   │ (anti-click)      │ │
                       │          │           └─────────▲─────────┘ │
                       │  ┌───────▼─────────────────────┴─────────┐ │
                       │  │ IirSosProcessor  (cascada, I9)        │ │
                       │  │ ec. de diferencias por sección        │ │
                       │  └───────┬───────────────────────────────┘ │
                       │          │ 6. frames de audio              │
                       │          ▼                                 │
                       │  Grafo de salida (Gain → Destination)      │
                       └────────────────────────────────────────────┘
```

### 3.2 Secuencia de mensajes (arrastre de un polo en el plano Z)

| # | Origen → Destino | Mensaje / acción | Carga | Cumple |
|---|---|---|---|---|
| 1 | UI → Worker | `SET_Z_PLANE` (1 por frame, coalescido) | `PackedComplexArray` transferible | I1 (clamp en B) |
| 2 | UI → Worker | mismo buffer transferido (sin copia) | — | §8 |
| 3 | Worker | `SpectrumEngine.computeInto` escribe SAB | `Float64Array` | I6, I7 |
| 4 | Worker | `SPECTRUM_VERSION` (mensaje diminuto) | `number` | §9 |
| 5 | Worker → UI (relay) → AudioWorklet.port | `SET_COEFFICIENTS` + `SmoothingRamp` | `BiquadCoefficients[]` | I2–I5, §7.3 |
| 6 | AudioWorklet | procesa con rampa anti-click | — | I9 |
| 7 | UI Renderer | lee SAB por versión (Atomics) y renderiza @60fps | — | §9 |

**Números clave:** render 60 FPS → 16.7 ms/frame; audio bloque 128 muestras @48 kHz → 2.67 ms; el worker responde en ≪ 1 ms (O(N+M) por frecuencia, sin GC). El cuello de botella no existe por diseño: (A) nunca bloquea, (C) nunca asigna.

---

## 4. Estructuras de Datos e Interfaces (TypeScript)

Todos los tipos de dominio son **inmutables** en la API pública. Las representaciones de alto rendimiento (empaquetadas / preasignadas) son tipos **separados** para no contaminar la API con detalles de memoria.

### 4.1 Tipos inmutables del dominio

```ts
/** Número complejo inmutable (polos y ceros del plano Z). */
export interface Complex {
  readonly re: number;
  readonly im: number;
}

/** Par conjugado r·e^{±jθ} — invariantes I2, I3 (ec. 3.3). */
export interface ConjugatePair {
  readonly plus: Complex;   // r·e^{+jθ}
  readonly minus: Complex;  // r·e^{-jθ}
}

/** Coeficientes de una sección biquad — ec. 3.3 (I2, I3). */
export interface BiquadCoefficients {
  readonly b0: number; // = 1 (o K_k si se absorbe ganancia de sección)
  readonly b1: number; // = -2·ρ_z·cos(φ_z)
  readonly b2: number; // = ρ_z²
  readonly a1: number; // = -2·r_p·cos(θ_p)
  readonly a2: number; // = r_p²
  readonly k: number;  // ganancia de sección K_k (I5); típicamente 1 tras normalizar
}

/** Coeficientes SOS completos — invariantes I1–I5, I8. */
export interface SosCoefficients {
  readonly sections: readonly BiquadCoefficients[];   // N_s = ceil(N/2) biquads
  readonly firstOrderSection: BiquadCoefficients | null; // I4 (solo N impar)
  readonly totalGain: number;   // K = ∏ K_k  (ec. 3.5)
  readonly order: number;       // N
}

/** Estado inmutable del plano Z — invariante I1 (radio clamp 0.9999). */
export interface ZPlaneState {
  readonly poles: readonly Complex[];
  readonly zeros: readonly Complex[];
  readonly gain: number; // K del usuario
}
```

### 4.2 Búferes reutilizables (zero-allocation)

```ts
/** Búferes espectrales preasignados — invariantes I6, I7. */
export interface SpectrumBuffers {
  readonly omega: Float64Array;         // ω_n = n·Δω, n = 0..L-1 (fijo)
  readonly magnitudeDb: Float64Array;   // 20·log10|H(e^{jω})|  (ec. 3.6)
  readonly phaseWrapped: Float64Array;  // φ_n = atan2 (ec. 5.1)
  readonly phaseUnwrapped: Float64Array;// θ_u[n]  (Alg. 5.1 / ec. 5.9)
  readonly groupDelay: Float64Array;    // τ_g(ω)  (ec. 4.5)
  readonly length: number;              // L
}

/** Búferes de dominio temporal (respuesta al impulso y escalón). */
export interface TimeDomainBuffers {
  readonly impulse: Float64Array; // h[n] = H(δ[n])
  readonly step: Float64Array;    // s[n]
  readonly length: number;        // Nt
}
```

**Elección de longitud espectral L.** Para satisfacer la condición de validez del desenvolvimiento (ec. 5.7, §5.3 de THEORY_SPECS), con el peor caso $r = 0.9999 \Rightarrow \max|\tau_g| \approx 2\times10^{4}$:

$$
\Delta\omega = \frac{2\pi}{L} \le \frac{\pi}{\max|\tau_g|} \approx 1.57\times10^{-4}
\quad\Longrightarrow\quad
L \ge 2\pi/1.57\times10^{-4} \approx 4\times10^{4}.
$$

Se fija **L = 65536** (margen ~1.6×), configurable y reallocable por mensaje `SET_SPECTRUM_LENGTH`. El renderizado **decima** a la anchura del panel (máximo o media por bin de píxel), no pinta 65536 puntos.

### 4.3 Mensajería entre hilos

```ts
/** Fuente de audio seleccionable (inspector de audio de la UI). */
export type AudioSourceId = 'white-noise' | 'sine' | 'user-sample' | 'none';

/** Especificación de la rampa anti-click (Sección 7.3). */
export interface SmoothingRamp {
  readonly samples: number;      // R: longitud de la rampa en muestras
  readonly mode: 'linear' | 'crossfade';
}

/** Mensajes dirigidos al AudioWorkletProcessor (hilo C). */
export type AudioNodeMessage =
  | { readonly type: 'SET_COEFFICIENTS';
      readonly coefficients: readonly BiquadCoefficients[];
      readonly ramp: SmoothingRamp }
  | { readonly type: 'SET_SOURCE'; readonly source: AudioSourceId; readonly ramp: SmoothingRamp }
  | { readonly type: 'SET_GAIN';   readonly gain: number;  readonly ramp: SmoothingRamp }
  | { readonly type: 'SET_BYPASS'; readonly bypass: boolean; readonly ramp: SmoothingRamp }
  | { readonly type: 'PLAY';       readonly start: boolean };

/** Mensajes UI → DSP Worker (hilo B). */
export type WorkerRequest =
  | { readonly type: 'SET_Z_PLANE'; readonly poles: PackedComplexArray; readonly zeros: PackedComplexArray; readonly gain: number }
  | { readonly type: 'SET_SPECTRUM_LENGTH'; readonly length: number }
  | { readonly type: 'PING' };

/** Mensajes DSP Worker → UI (hilo B). */
export type WorkerResponse =
  | { readonly type: 'SPECTRUM_VERSION'; readonly version: number } // + acceso SAB
  | { readonly type: 'COEFFICIENTS';     readonly sos: SosCoefficients };
```

### 4.4 Primitivas zero-allocation

```ts
/** Representación empaquetada (re, im) entrelazados: sin objetos por polo. */
export interface PackedComplexArray {
  readonly data: Float64Array; // [re0, im0, re1, im1, …]
  readonly count: number;      // número de elementos válidos
}

/** Claves de pool de búferes preasignados (Sección 8). */
export type BufferKey =
  | 'omega' | 'magnitudeDb' | 'phaseWrapped' | 'phaseUnwrapped' | 'groupDelay'
  | 'impulse' | 'step' | 'scratch';

/** Pool de búferes Float64Array preasignados (GC-safe). */
export interface BufferPool {
  readonly acquire(key: BufferKey): Float64Array; // devuelve búfer residente
  readonly release(key: BufferKey): void;         // marca libre (no GC)
  readonly resizeAll(length: number): void;       // reasigna todos (raro)
}
```

### 4.5 Contratos de los módulos DSP (mapeo a invariantes)

```ts
/** Sintetizador SOS — I1, I2, I3, I4, I5, I8. Puro e inmutable. */
export interface SosSynthesizer {
  /** No muta la entrada; devuelve un nuevo SosCoefficients. */
  compute(state: ZPlaneState): SosCoefficients;
}

/** Motor espectral — I6, I7; ec. 3.6, 4.5, 5.9; Alg. 5.1. */
export interface SpectrumEngine {
  /** Escribe en buffers reutilizados; devuelve versión atómica. */
  computeInto(sos: SosCoefficients, buffers: SpectrumBuffers): number;
}

/** Filtro IIR en tiempo real (AudioWorklet) — I9. Sin asignación. */
export interface IirSosFilter {
  readonly process(input: Float32Array, output: Float32Array): void;
}
```

---

## 5. Fronteras de Módulos y Responsabilidades

```
src/
  core/                     // DSP MATH ENGINE — puro, sin DOM/Audio (hilo B)
    types.ts                // interfaces §4.1, §4.5
    complex.ts              // Complex, PackedComplexArray, ConjugatePair
    sos.ts                  // SosSynthesizer        (I1–I5, I8, ec. 3.3–3.5)
    spectrum.ts             // SpectrumEngine        (I6, I7, ec. 3.6, 4.5)
    group-delay.ts          // τ_g analítico         (ec. 4.5)
    phase-unwrap.ts         // Alg. 5.1 + integración (ec. 5.9)
    buffers.ts              // SpectrumBuffers, BufferPool  (§4.2, §8)
  worker/
    dsp-worker.ts           // hub de mensajes WorkerRequest/WorkerResponse
  audio/                    // AUDIO THREAD (hilo C)
    iir-sos-processor.ts    // AudioWorkletProcessor (I9, §7)
    parameter-smoother.ts   // rampa/crossfade anti-click (§7.3)
    iir-sos-filter.ts       // núcleo puro del biquad (testeable sin WebAudio)
  ui/                       // UI THREAD (hilo A)
    input-capture.ts        // eventos crudos (pointer/wheel)
    interaction-manager.ts  // coalescing 1 msg/RAF
    z-plane-view.ts         // Canvas 2D plano Z
    spectrum-view.ts        // mag/fase/τg (lee SAB)
    time-view.ts            // h[n], s[n]
    inspector-view.ts       // H(z), ecuación en diferencias, audio
    renderer.ts             // bucle RAF @60fps, doble búfer
    audio-graph.ts          // grafo WebAudio + relay a node.port
  tests/                    // suite unitaria (§10)
    sos.test.ts
    group-delay.test.ts
    phase-unwrap.test.ts
    stability.test.ts
    audio-processor.test.ts
    buffer-pool.test.ts
```

> **Nota de implementación (Fases 7–8).** Para máxima testabilidad sin navegador (harness de
> Node, §10.2), los módulos de hilo se implementan como **núcleos port-like** dentro de
> `src/core/` y el layout de arriba se mantiene como objetivo de despliegue para los
> envoltorios finos de UI:
>
> - `src/core/dsp-worker.ts` → hilo B (`WorkerRequest`/`WorkerResponse` + SAB/Atomics, §9.1).
> - `src/core/iir-sos-processor.ts` → hilo C (`AudioNodeMessage`, `process()`, generadores
>   internos; se auto-registra como `'iir-sos-processor'` si existe `registerProcessor`).
> - `src/core/z-plane-layout.ts` → hilo A: transformación pura píxel ↔ plano Z (circunferencia
>   unidad inscrita, volteo del eje Y).
> - `src/core/z-plane-interaction.ts` → hilo A: máquina de estado de interacción (hit-testing,
>   arrastre con clamp visual a $|z| \le 1$, crear/borrar, ganancia; el worker re-clampea a
>   `MAX_POLE_RADIUS`, I1).
> - `src/core/pack.ts` → `packRoots`/`unpackRoots`: serialización única `Complex[]` ↔
>   `PackedComplexArray` (la UI empaqueta 1×/frame; el worker desempaqueta).
> - `src/core/interaction-manager.ts` → hilo A: orquesta puntero/rueda y **coalescing M5**
>   (≤ 1 `SET_Z_PLANE` por frame vía `frame()`).
> - `src/core/z-plane-view.ts` → hilo A: render Canvas 2D contra `ZPlaneDraw` (subconjunto
>   mínimo de `CanvasRenderingContext2D`, testeable con contexto mock sin DOM).
> - `src/core/audio-graph.ts` → hilo A: relay worker → main → `node.port` (§3.2) reenviando
>   solo `COEFFICIENTS` → `SET_COEFFICIENTS`.
>
> Los núcleos de hilo aceptan puertos `{ postMessage }` opcionales (mock en pruebas; en
> producción se auto-enlazan a `globalThis` / `node.port`). La vía de mensajería completa
> (worker → main → `node.port`) se orquesta en `src/core/audio-graph.ts` (hilo A, §3.2).

---

## 6. Motor Matemático DSP (Hilo B)

### 6.1 `SosSynthesizer.compute` — pipeline inmutable

Secuencia estricta, cada paso verifica su invariante:

```
ZPlaneState (inmutable)
   │  1. Clamp de radio          → I1: r_k = min(r_k, 0.9999)          (ec. 6.3)
   ▼
   │  2. Emparejamiento de pares → I8: pares conjugados + ceros cercanos (§3.6)
   ▼
   │  3. Coeficientes de biquad  → I2, I3: ec. 3.3  (a1,a2 | b1,b2)
   ▼
   │  4. Sección de 1.er orden   → I4: ec. 3.4 si N impar (polo real)
   ▼
   │  5. Distribución de ganancia→ I5: ec. 3.5, normalización de pico por sección
   ▼
   │  6. Ordenación              → I8: secciones por resonancia decreciente
   ▼
SosCoefficients (nuevo, inmutable)
```

Garantías: la entrada **nunca se muta**; el resultado es un objeto nuevo (los coeficientes son pocos — decenas de números — por lo que la inmutabilidad no penaliza la memoria).

### 6.2 `SpectrumEngine.computeInto` — pipeline espectral

Escribe en `SpectrumBuffers` preasignados (sin asignación):

1. **Magnitud (dB)** — ec. 3.6: $\vert H(e^{j\omega})\vert = \prod_k \bigl|\frac{b_{0k}+b_{1k}e^{-j\omega}+b_{2k}e^{-2j\omega}}{1+a_{1k}e^{-j\omega}+a_{2k}e^{-2j\omega}}\bigr|$; acumular en **log** para evitar overflow (relacionado con I5).
2. **Fase envuelta** — ec. 5.1: $\phi_n = \operatorname{atan2}\bigl(\Im,\Re\bigr)$.
3. **Retardo de grupo analítico** — ec. 4.5 (I6): $\tau_g(\omega) = \sum_{k}\frac{r_k\cos(\omega-\phi_k)-r_k^2}{1-2r_k\cos(\omega-\phi_k)+r_k^2} - \sum_{i}\frac{\rho_i\cos(\omega-\varphi_i)-\rho_i^2}{1-2\rho_i\cos(\omega-\varphi_i)+\rho_i^2}$. Se deriva de **polos/ceros**, no de la fase numérica → inmune al ruido de resonancia y sin diferenciación finita.
4. **Fase desenvuelta** — I7: Algoritmo 5.1 (ec. 5.3–5.5) con verificación por integración del retardo de grupo (ec. 5.9); discrepancia residual exigida $< 10^{-6}$ rad.
5. **Respuestas temporales** — $h[n]$ y $s[n]$ por recursión de la cascada sobre impulso/escalón en `TimeDomainBuffers`.

### 6.3 Regla de decisión sobre L (ec. 5.7)

El worker recalcula $L$ óptimo con $\max|\tau_g|$ actual: si $2\pi/L > \pi/\max|\tau_g|$, eleva L al siguiente power-of-two ≥ $4\times10^{4}$ (por defecto 65536) antes de desenvolver (evita falsos saltos de $2\pi$).

---

## 7. Hilo de Audio (Hilo C) — `IirSosProcessor`

### 7.1 Procesamiento por sección (invariante I9)

Cada biquad se ejecuta con su ecuación en diferencias (ec. 3.2 evaluada en $z^{-1}$):

$$
y_k[n] = b_{0k}\,x_k[n] + b_{1k}\,x_k[n-1] + b_{2k}\,x_k[n-2] - a_{1k}\,y_k[n-1] - a_{2k}\,y_k[n-2],
$$

y la cascada encadena $y_k = x_{k+1}$. El estado por sección (4 muestras de retardo) se mantiene en `Float64Array` preasignados de tamaño `4·N_s` (Sección 8). El procesamiento es un bucle **sin asignación, sin cierres, sin ramas por bloque**.

### 7.2 `process()` — presupuesto de tiempo real

- Tamaño de bloque WebAudio: 128 frames @ 48 kHz → 2.67 ms.
- Presupuesto objetivo: **≤ 0.5 ms** por bloque (holgura 5×).
- La carga es O(N_s · 128); con $N_s \le 32$ biquads es despreciable.

### 7.3 Parameter Smoothing anti-click (evitar *clicks*/zipper)

Cuando llega `SET_COEFFICIENTS`, aplicar los nuevos coeficientes de golpe produciría una discontinuidad en la salida (click). Dos mecanismos según `SmoothingRamp.mode`:

**a) `linear` — interpolación de coeficientes (drag continuo de polo).** Durante R muestras se mezclan coeficientes viejos y nuevos con $\alpha = \min(1,\, n/R)$, $n$ la muestra dentro de la rampa:

$$
b_{jk}(\alpha) = (1-\alpha)\,b_{jk}^{\text{old}} + \alpha\,b_{jk}^{\text{new}}, \qquad
a_{jk}(\alpha) = (1-\alpha)\,a_{jk}^{\text{old}} + \alpha\,a_{jk}^{\text{new}}.
$$

El estado IIR es **continuo** entre bloques (no se reinicia), de modo que la salida es continua y sin clics. R típico: 128–512 muestras (2.7–10.7 ms).

**b) `crossfade` — fundido de potencia igual (bypass A/B, cambio de fuente).** Se ejecutan en paralelo el filtro viejo (A) y el nuevo (B) durante R muestras con ley de potencia igual (evita huecos/zonas muertas):

$$
y[n] = \cos\!\Big(\frac{\pi}{2}\alpha\Big)\, y_A[n] \;+\; \sin\!\Big(\frac{\pi}{2}\alpha\Big)\, y_B[n], \qquad \alpha = \min\bigl(1, n/R\bigr).
$$

Al final de la rampa, la ruta A se descarta (búferes reciclados, sin GC).

**Estado de rampa:** el `ParameterSmoother` mantiene `rampRemaining`, coeficientes objetivo y el acumulador $\alpha$; consume un mensaje por bloque y descarta mensajes obsoletos (solo cuenta el último), de modo que durante un arrastre a 60 fps el coste es constante.

### 7.4 Fuentes de audio y bypass

- `white-noise` / `sine`: generados **dentro del AudioWorklet** (sin nodos WebAudio intermedios) para evitar latencia de despacho.
- `user-sample`: buffer Float32Array transferido al worklet (copia única al cargar).
- `SET_BYPASS`: crossfade (b) entre la cascada y la línea directa $y = x$.

---

## 8. Gestión de Memoria Zero-Allocation

**Objetivo:** mientras se arrastra un polo en el plano Z, **ningún hilo debe pausarse por Garbage Collection**; el render y el audio deben fluir sin micro-stutters.

### 8.1 Reglas globales

| # | Regla | Ámbito |
|---|---|---|
| M1 | Todos los vectores espectrales y temporales se preasignan una vez (`BufferPool`), con longitud fija L/Nt. | Worker, UI |
| M2 | Los polos/ceros viajan como `PackedComplexArray` (Float64Array empaquetado), **no** como arrays de objetos `Complex`. | Worker |
| M3 | El `process()` del AudioWorklet **no asigna nada**: estado y scratch preasignados, cero closures por muestra. | Audio |
| M4 | Los datos espectrales se comparten Worker↔UI por `SharedArrayBuffer` (cero copias); solo se transfiere un contador de versión. | Worker↔UI |
| M5 | Los mensajes de eventos de arrastre se **coalescen a 1 por frame** (RAF): a 60 fps se emiten ≤ 60 mensajes/s. | UI |
| M6 | `resizeAll(L)` es la única operación de (re)asignación masiva y ocurre solo al cambiar L (raro, fuera del hot path). | Worker |

### 8.2 Ciclo de vida del pool

```
acquire(key) ──► devuelve Float64Array residente (nunca se destruye)
release(key) ──► marca el búfer como libre (el ArrayBuffer permanece vivo)
resizeAll(L) ──► reasigna los 8 búferes (omega, mag, faseW, faseU, τg, h, s, scratch)
```

El `BufferPool` vive **una instancia por worker y una por UI**, y sus `ArrayBuffer` subyacentes son los que se exponen vía SAB al renderer (una sola asignación de memoria compartida por sesión).

### 8.3 Medición obligatoria

La suite (Sección 10) debe **verificar M3 con un contador de asignaciones** en `process()` (p. ej. interceptando `ArrayBuffer`/`performance` en un harness de Node): cualquier asignación en el hot path es un fallo de test.

---

## 9. Concurrencia y Sincronización

### 9.1 Handshake espectral Worker↔UI (SAB + Atomics)

El worker escribe en el SAB y publica la versión con ordenamiento estricto; el renderer la lee antes de dibujar (happens-before vía Atomics):

```
Worker:  escribir buffers[SAB] → Atomics.store(version, v+1) → Atomics.notify(version, 1)
UI:      v = Atomics.load(version)  (si cambió) → leer buffers[SAB] → dibujar
```

### 9.2 Transporte al AudioWorklet

El worker **no** habla directamente con el worklet; el hilo main actúa de **relay** (único punto de orquestación): `worker → main: AudioNodeMessage → node.port.postMessage(...)`. Los `Float64Array` de coeficientes se transfieren (transfer) o se leen de un SAB de coeficientes con un contador de generación monotónico (`gen++`); el `ParameterSmoother` solo aplica la generación más reciente.

### 9.3 Requisito de despliegue (COOP/COEP)

`SharedArrayBuffer` requiere **aislamiento entre orígenes**. La app debe servirse con cabeceras:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Sin ellas, el runtime degrada automáticamente a `postMessage` con copia (correcto pero con más memoria).

---

## 10. Mapeo de Tests Unitarios a la Checklist V1–V9

Cada caso de la checklist de validación de [`THEORY_SPECS.md`](THEORY_SPECS.md) tiene un test **uno-a-uno** en `tests/`. Framework: Vitest + harness de Node para el worklet (sin WebAudio real).

| Test | Checklist | Módulo bajo prueba | Afirmación |
|---|---|---|---|
| `T-V1` | V1 | `sos.ts` | Con $r=0.9,\ \theta=\pi/4$: $a_1 \approx -1.27279$, $a_2 = 0.81$ (I2) |
| `T-V2` | V2 | `sos.ts` | $\prod_k H_k(z) = B(z)/A(z)$ por convolución polinómica, residuo $< 10^{-12}$ (I9) |
| `T-V3` | V3 | `group-delay.ts` | Polo real $a=0.5$: $\tau_g(0) = a/(1-a) = 1$ (ec. 4.6) |
| `T-V4` | V4 | `group-delay.ts` | Cero en $z=1$: $\tau_g = 1/2$ en todo $\omega$ (ec. 4.7) |
| `T-V5` | V5 | `group-delay.ts` | Par conjugado $r=0.9,\ \theta=\pi/4$: $\tau_g(\theta) = 2r/(1-r) = 18$ (ec. 4.8) |
| `T-V6` | V6 | `group-delay.ts` | $\int_0^{2\pi}\tau_g\,d\omega = 2\pi\,(N - N_z^{\text{int}})$ (ec. 4.9) |
| `T-V7` | V7 | `phase-unwrap.ts` | $\theta_u[n]-\theta_u[n-1] = -\tau_g(\omega_n)\Delta\omega$ con discrepancia $< 10^{-6}$ rad (ec. 5.9 vs Alg. 5.1) |
| `T-V8` | V8 | `stability.test.ts` | Tras cuantificar $a_{1k},a_{2k}$ a float32 con $r=0.9999$: $r_{\text{efectivo}} < 1$ (ec. 6.4) |
| `T-V9` | V9 | `sos.ts` | Con $r=0.9999$: $G_{\max} \approx 10^{8}$ (ec. 6.6) y normalización I5 a 0 dB |

### 10.1 Tests adicionales de invariantes y no funcionales

| Test | Invariante / requisito | Afirmación |
|---|---|---|
| `T-I1` | I1 | Cualquier polo con $r > 0.9999$ se **clampea** a 0.9999 en `SosSynthesizer.compute` |
| `T-I4` | I4 | Orden impar (p. ej. N=3) produce exactamente 1 biquad + 1 sección de 1.er orden |
| `T-I8` | I8 | Secciones ordenadas por radio decreciente (resonancia decreciente) |
| `T-SMOOTH` | §7.3 | Cambio brusco de coeficientes con rampa R: energía de salida continua, sin muestra |Δy| > umbral (no-click) |
| `T-M3` | §8 (M3) | `process()` ejecuta **0 asignaciones** (contador de alocaciones en harness) |
| `T-UNWRAP-L` | ec. 5.7 | Con $r=0.9999$ y $L=65536$, no aparecen saltos falsos de $2\pi$ en `phaseUnwrapped` |
| `T-BYPASS` | §7.4 | `SET_BYPASS` con crossfade: salida ≈ entrada al final de la rampa (residuo < -80 dB) |
| `T-V7-engine` | I6, I7 | `SpectrumEngine`: `phaseUnwrapped` consistente con $-\int\tau_g$ ($<10^{-6}$ rad) y cross-check de `magnitudeDb`/`phaseWrapped` contra `evaluateSosAt` |
| `T-V2-filter` | I9, M3 | `IirSosFilter`: la respuesta al impulso de la cascada coincide con la forma directa y `process()` es cero-asignación |
| `T-TIME-1` | §6.2(5) | `computeTimeDomain`: $h[0] = \text{totalGain}$ y $s[n] = \sum_{k\le n} h[k]$ (cross-check con `IirSosFilter`) |
| `T-TIME-2` | §6.2(5), I5 | El escalón asienta a la ganancia DC en dos configuraciones (tol. rel. $10^{-6}$) |
| `T-TIME-3` | §8 (M1) | `computeTimeDomain()` ejecuta **0 asignaciones** |
| `T-POOL-1/2` | §8 (M1) | `BufferPool.acquire/release` residente: misma identidad y **0 asignaciones** |
| `T-POOL-3/4` | §8 (M6) | `resizeAll(L')` reasigna (la identidad cambia); `resizeAll(L)` con la misma longitud conserva identidad |
| `T-FUZZ` | §10.2, I1, I9 | ≥ 10⁴ configuraciones aleatorias (LCG reproducible): estabilidad I1 y cascada = forma directa con tol. rel. $10^{-6}$ |
| `T-WORKER-1` | §3.2 | `DspWorker` (hilo B): `PING` → `PONG` (heartbeat del contrato de mensajería) |
| `T-WORKER-2` | §9.1, I6, I7 | `SET_Z_PLANE` → `SPECTRUM_VERSION` + `COEFFICIENTS`; espectro escrito en el SAB (magnitudeDb finito, $\omega_n = n\cdot 2\pi/L$) y `Atomics.load(version)` coincide con el mensaje (handshake §9.1) |
| `T-WORKER-3` | I1 | Polo $r=1.5$ → $\sqrt{\lvert a_2\rvert} \approx 0.9999$ en el SOS encadenado por `COEFFICIENTS` (clamp I1 en la vía del worker) |
| `T-WORKER-4` | §8 (M6) | `SET_SPECTRUM_LENGTH(1024)` → reasigna el SAB ($64\cdot L+4$ bytes), repuebla $\omega_n$ y emite nuevo `SPECTRUM_VERSION` |
| `T-PROC-1` | §7.4 | `IirSosProcessor` (hilo C): `SET_BYPASS` inmediato → passthrough exacto de la entrada ($y = x$) |
| `T-PROC-2` | §7.3, I5 | `SET_COEFFICIENTS` → el escalón asienta a la ganancia DC (I5) vía la rampa del `ParameterSmoother` |
| `T-PROC-3` | §7.4 | Fuente senoidal + `PLAY` → salida senoidal no nula (generador interno del worklet) |
| `T-PROC-4` | §8 (M3) | `IirSosProcessor.process()` ejecuta **0 asignaciones** (harness de conteo) |
| `T-PROC-5` | §7.4 | `SET_BYPASS` con crossfade → residuo relativo $< -80$ dB al final de la rampa |
| `T-LAYOUT-1..3` | §9 | `ZPlaneLayout` (hilo A): centro/radio inscrito, mapeo $z=1$ → $(c_x+r, c_y)$, round-trip píxel ↔ plano Z, volteo del eje Y (píxel arriba del centro → parte imaginaria positiva) |
| `T-INT-1..5` | §9, I1 | `ZPlaneInteraction`: hit-testing (umbral en píxeles), crear polo con clamp a $\lvert z\rvert \le 1$, arrastre de cero **sin** clamp, borrar seleccionado, `setGain`/`snapshot` |
| `T-MGR-1..5` | §3.2 (M5), I1 | `InteractionManager`: N movimientos → **1** `SET_Z_PLANE`/frame (coalescing), sin cambios → `null`, pack correcto vía `unpackRoots`, arrastre exterior → $\lvert z\rvert \le 1$, rueda → ganancia (paso 1.1×) |
| `T-VIEW-1..2` | §9 | `ZPlaneView` (Canvas 2D): circunferencia unidad en $(c_x, c_y, r)$, cruz × de polo y ○ de cero en el píxel proyectado (contexto mock registrador) |
| `T-RELAY-1..3` | §3.2 | `AudioGraphRelay`: `COEFFICIENTS` → `SET_COEFFICIENTS` (mismo SOS + rampa por defecto); setters → mensajes al nodo; `SPECTRUM_VERSION`/`PONG` **no** se relean (lectura directa del SAB, §9.1) |

### 10.2 Estrategia

- **Tests numéricos:** tolerancias relativas $10^{-9}$ (float64) para las identidades cerradas V1–V6; $10^{-6}$ rad para fase (V7) por la integración numérica.
- **Harness del worklet:** se inyecta un `AudioWorkletGlobalScope` ficticio (queue/port mock) y se invoca `process(input, output)` directamente; así el núcleo `iir-sos-filter.ts` es testeable sin navegador.
- **Fuzz/propiedad:** generación aleatoria de polos dentro del círculo unidad y verificación de I9 (cascada = forma directa) y de estabilidad (I1) para ≥ 10⁴ casos — implementado como `T-FUZZ` en `phase6_fuzz.test.ts` (LCG con seed fijo ⇒ reproducible).

---

## 11. Matriz de Cumplimiento (I1–I9)

| Invariante | Ecuación | Componente que lo garantiza | Test de verificación |
|---|---|---|---|
| I1 | 6.3 | `SosSynthesizer.compute` (clamp) + `ZPlaneInteraction` (clamp visual UI) | `T-I1`, `T-V8`, `T-FUZZ`, `T-WORKER-3`, `T-INT-2`, `T-MGR-4` |
| I2 | 3.3 | `SosSynthesizer.compute` | `T-V1` |
| I3 | 3.3 | `SosSynthesizer.compute` | `T-V1` |
| I4 | 3.4 | `SosSynthesizer.compute` | `T-I4` |
| I5 | 3.5 | `SosSynthesizer.compute` (normalización) | `T-V9`, `T-TIME-2`, `T-PROC-2` |
| I6 | 4.5 | `SpectrumEngine` (τ_g analítico) | `T-V3…T-V6`, `T-V7-engine`, `T-WORKER-2` |
| I7 | 5.5, 5.9 | `SpectrumEngine` (unwrap + integración) | `T-V7`, `T-V7-engine`, `T-UNWRAP-L`, `T-WORKER-2` |
| I8 | §3.6 | `SosSynthesizer.compute` (pairing/ordering) | `T-I8` |
| I9 | 3.5 | `IirSosFilter` (cascada) | `T-V2`, `T-V2-filter`, `T-SMOOTH`, `T-FUZZ`, `T-PROC-2` |

---

## 12. Restricciones de Despliegue y Supuestos

1. **SharedArrayBuffer** requiere `COOP`/`COEP` (Sección 9.3); sin ellas, fallback a copia (correcto, más memoria).
2. `AudioWorklet` requiere contexto `AudioContext({ latencyHint: 'interactive' })` y `crossOriginIsolated === true` para SAB de audio.
3. Muestreo de referencia $f_s = 48$ kHz; el motor usa frecuencias **normalizadas** $\omega = 2\pi f/f_s$ (independiente de $f_s$).
4. Tamaño máximo de filtro soportado: $N \le 64$ (32 biquads), suficiente para el plano Z interactivo; el presupuesto de audio (§7.2) lo cubre con holgura.
5. El documento **no** prescribe frameworks de UI; el contrato se limita a los módulos `ui/` (hilo A) definidos en §5.

---

*Este documento es la especificación de software del motor. Ninguna implementación funcional debe desviarse de las ecuaciones de [`THEORY_SPECS.md`](THEORY_SPECS.md) ni de los invariantes I1–I9 recogidos aquí.*
