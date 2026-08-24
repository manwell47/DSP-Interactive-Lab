# THEORY_SPECS — Especificación Matemática Formal del Motor de Aprendizaje Interactivo de DSP

| Campo | Valor |
|---|---|
| **Versión** | 1.0 |
| **Estado** | Borrador técnico — pendiente de validación |
| **Dominio** | Procesamiento Digital de Señales (filtros IIR de tiempo discreto) |
| **Referencias base** | Oppenheim & Schafer [1], Julius O. Smith III [2][3], Jackson [4], Itoh [5], Zölzer [6], Proakis & Manolakis [7], Mitra [8] |
| **Alcance** | Especificación matemática pura. Este documento **no** propone código, clases ni arquitectura de software. |

---

## 1. Alcance y Objetivos

Este documento fija el **contrato matemático** que toda implementación posterior del motor de aprendizaje interactivo de DSP debe satisfacer. Los cuatro pilares especificados son:

1. **Transformación Polos/Ceros → Secciones de Segundo Orden (SOS / biquads)**, incluyendo la demostración de por qué la cascada de biquads supera a la Forma Directa I/II de alto orden en error de cuantificación e inestabilidad cuando el orden del filtro satisface $N > 2$.
2. **Cálculo analítico exacto del retardo de grupo** $\tau_g(\omega) = -\dfrac{d\theta(\omega)}{d\omega}$, derivado de la geometría de los vectores polo/cero sobre el círculo unidad, sin diferenciación numérica finita.
3. **Algoritmo discreto de desenvolvimiento de fase** (*phase unwrapping*) para corregir las discontinuidades de $2\pi$ de $\arg\bigl(H(e^{j\omega})\bigr)$.
4. **Criterio de estabilidad y condicionamiento**: restricción de radio de los polos $\vert d_k \vert \le 0.9999$ que garantiza estabilidad BIBO y acota el desbordamiento numérico (*overflow*) en la acumulación en coma flotante.

Todos los resultados son consistentes con la literatura clásica: [1], [2], [3].

---

## 2. Notación y Preliminares

### 2.1 Transformada $z$ y función de transferencia

Sea $h[n]$ la respuesta al impulso de un sistema LTI causal de tiempo discreto. Su transformada $z$ bilateral es

$$
H(z) \;=\; \mathcal{Z}\{h[n]\} \;=\; \sum_{n=-\infty}^{\infty} h[n]\, z^{-n}.
$$

Para un filtro IIR racional, causal y de orden $N$ (denominador) con $M$ ceros ($M \le N$):

$$
H(z) \;=\; \frac{B(z)}{A(z)} \;=\; K\,
\frac{\displaystyle\sum_{i=0}^{M} b_i\, z^{-i}}{\displaystyle\sum_{k=0}^{N} a_k\, z^{-k}}
\;=\; K\,
\frac{\displaystyle\prod_{i=1}^{M}\bigl(1 - c_i\, z^{-1}\bigr)}{\displaystyle\prod_{k=1}^{N}\bigl(1 - d_k\, z^{-1}\bigr)},
\tag{2.1}
$$

donde se ha normalizado $a_0 = 1$ y $b_0 = 1$ absorbiendo la ganancia en $K$. Los escalares

* $d_k = r_k\, e^{j\phi_k}$ son los **polos** (raíces de $A(z)$),
* $c_i = \rho_i\, e^{j\varphi_i}$ son los **ceros** (raíces de $B(z)$),
* $r_k = \vert d_k \vert \in [0,1)$, $\rho_i = \vert c_i \vert \ge 0$ son los módulos,
* $\phi_k, \varphi_i \in (-\pi,\pi]$ son los ángulos.

Para coeficientes reales, polos y ceros complejos aparecen **siempre en pares conjugados**:
$d = r e^{j\theta}$ implica $\bar d = r e^{-j\theta}$, y análogamente para los ceros.

### 2.2 Respuesta en frecuencia

La respuesta en frecuencia se obtiene evaluando $H(z)$ sobre el círculo unidad $z = e^{j\omega}$, con $\omega = 2\pi f/f_s$ la frecuencia angular normalizada ($\omega \in [0, 2\pi)$):

$$
H\bigl(e^{j\omega}\bigr) \;=\; K\,
\frac{\displaystyle\prod_{i=1}^{M}\bigl(1 - c_i\, e^{-j\omega}\bigr)}{\displaystyle\prod_{k=1}^{N}\bigl(1 - d_k\, e^{-j\omega}\bigr)}
\;=\; A(\omega)\, e^{j\theta(\omega)},
\tag{2.2}
$$

con $A(\omega) = \bigl|H(e^{j\omega})\bigr| \ge 0$ la **magnitud** y $\theta(\omega) = \arg H(e^{j\omega})$ la **fase**.

### 2.3 Interpretación geométrica (vectorial)

Cada factor del producto (2.2) tiene interpretación geométrica directa sobre el plano complejo:

$$
1 - d_k\, e^{-j\omega} \;=\; e^{-j\omega}\,\bigl(e^{j\omega} - d_k\bigr),
\tag{2.3}
$$

es decir, **el vector que une el polo $d_k$ con el punto del círculo unidad $e^{j\omega}$** (rotado por el factor común $e^{-j\omega}$). El argumento de este factor es el ángulo de dicho vector, y su módulo es la distancia polo–círculo unidad:

$$
\bigl|1 - d_k\, e^{-j\omega}\bigr| \;=\; \sqrt{1 - 2r_k\cos(\omega - \phi_k) + r_k^2}.
\tag{2.4}
$$

Esta lectura vectorial es la que fundamenta tanto el cálculo analítico del retardo de grupo (Sección 4) como la visualización interactiva del plano Z del motor.

---

## 3. Transformación Polos/Ceros a Coeficientes SOS

### 3.1 Teorema de agrupación de pares conjugados

**Teorema 3.1.** Sea $d = r e^{j\theta}$ un polo complejo ($0 < r < 1$, $\theta \notin \{0,\pi\}$). El par conjugado $\{d, \bar d\} = \{r e^{j\theta}, r e^{-j\theta}\}$ genera el polinomio real de segundo grado

$$
\bigl(1 - d\, z^{-1}\bigr)\bigl(1 - \bar d\, z^{-1}\bigr)
\;=\; 1 - (d + \bar d)\, z^{-1} + d\,\bar d\, z^{-2}
\;=\; 1 - 2r\cos\theta\; z^{-1} + r^2\, z^{-2}.
\tag{3.1}
$$

*Demostración.* Se desarrolla el producto y se usa $d + \bar d = 2r\cos\theta$ y $d\bar d = r^2$ (Euler: $e^{j\theta} + e^{-j\theta} = 2\cos\theta$). $\blacksquare$

### 3.2 Forma canónica de una sección de segundo orden (biquad)

**Definición 3.2.** Una *sección de segundo orden* o *biquad* es la función racional

$$
H_k(z) \;=\; \frac{b_{0k} + b_{1k}\, z^{-1} + b_{2k}\, z^{-2}}{1 + a_{1k}\, z^{-1} + a_{2k}\, z^{-2}}.
\tag{3.2}
$$

**Corolario 3.3 (coeficientes de biquad desde pares conjugados).** Si la sección $k$ se construye con el par de polos $\{r_p e^{\pm j\theta_p}\}$ y el par de ceros $\{\rho_z e^{\pm j\varphi_z}\}$, los coeficientes son:

$$
\boxed{\;
\begin{aligned}
a_{1k} &= -2\, r_p \cos\theta_p, & a_{2k} &= r_p^2,\\[2mm]
b_{0k} &= 1, & b_{1k} &= -2\, \rho_z \cos\varphi_z, & b_{2k} &= \rho_z^2.
\end{aligned}\;}
\tag{3.3}
$$

**Caso degenerado — raíces reales.** Si un polo real $d_0$ (o cero $c_0$) queda sin emparejar (orden impar $N$), se emplea una sección de **primer orden**:

$$
H_0(z) \;=\; \frac{b_{00} + b_{10}\, z^{-1}}{1 + a_{10}\, z^{-1}},
\qquad
a_{10} = -d_0, \quad b_{10} = -c_0.
\tag{3.4}
$$

### 3.3 Distribución de ganancia

La ganancia total se factoriza en las secciones:

$$
K \;=\; \prod_{k=1}^{N_s} K_k, \qquad
H(z) \;=\; \prod_{k=1}^{N_s} H_k(z),
\tag{3.5}
$$

con $N_s = \lceil N/2 \rceil$ el número de secciones. Cada $K_k$ se asigna por regla de escalado (p. ej. escalado $L_\infty$ o $L_2$ por sección) de modo que la ganancia de pico de cada biquad quede normalizada; esto es condición necesaria para el control del desbordamiento de la Sección 6.

### 3.4 Estructura en cascada

```mermaid
flowchart LR
    P[Polos y ceros factorizados] --> G[Agrupar pares conjugados]
    G --> S1[Biquad 1]
    G --> S2[Biquad 2]
    G --> Sn[Biquad Ns]
    S1 --> S2 --> Sn --> Y[Salida en cascada]
```

La respuesta en frecuencia de la cascada es el producto de las respuestas de cada sección:

$$
H\bigl(e^{j\omega}\bigr) \;=\; \prod_{k=1}^{N_s}
\frac{b_{0k} + b_{1k}\, e^{-j\omega} + b_{2k}\, e^{-2j\omega}}
{1 + a_{1k}\, e^{-j\omega} + a_{2k}\, e^{-2j\omega}}.
\tag{3.6}
$$

### 3.5 Por qué la cascada SOS evita el error de cuantificación y la inestabilidad ($N > 2$)

#### 3.5.1 Sensibilidad de las raíces a la cuantificación de coeficientes

**Lema 3.4 (sensibilidad de un polo a los coeficientes).** Sea $A(z) = \prod_{k=1}^{N}(z - d_k) = z^N + a_1 z^{N-1} + \cdots + a_N$ el polinomio mónico del denominador. La sensibilidad de la raíz $d_i$ respecto al coeficiente $a_k$ es

$$
\frac{\partial d_i}{\partial a_k}
\;=\;
\frac{d_i^{\,N-k}}{\displaystyle\prod_{\substack{j=1 \\ j \ne i}}^{N}\bigl(d_i - d_j\bigr)}.
\tag{3.7}
$$

*Demostración (bosquejo).* Diferenciando implícitamente la identidad $A\bigl(d_i(\mathbf a), \mathbf a\bigr) = 0$ respecto de $a_k$:

$$
0 \;=\;
\underbrace{\frac{\partial A}{\partial z}\Big|_{z=d_i}}_{\displaystyle -\prod_{j \ne i}(d_i - d_j)}
\frac{\partial d_i}{\partial a_k}
\;+\;
\underbrace{\frac{\partial A}{\partial a_k}\Big|_{z=d_i}}_{d_i^{\,N-k}},
$$

de donde se despeja (3.7). $\blacksquare$

**Consecuencia inmediata.** El desplazamiento de un polo ante una perturbación de coeficientes $\delta a_k$ (p. ej. redondeo a $B$ bits, $\vert\delta a_k\vert \sim 2^{-B}$) queda acotado en magnitud por

$$
\vert \delta d_i \vert
\;\le\;
\frac{1}{\displaystyle\prod_{\substack{j=1 \\ j \ne i}}^{N}\vert d_i - d_j \vert}
\sum_{k=1}^{N} \vert d_i \vert^{\,N-k}\, \vert \delta a_k \vert.
\tag{3.8}
$$

El denominador $\prod_{j \ne i}\vert d_i - d_j \vert$ **colapsa cuando los polos se agrupan** (clustering), que es precisamente la situación típica de filtros selectivos de alto orden (p. ej. Chebyshev, elípticos, resonadores). En un biquad ($N=2$), el denominador tiene un único factor $\vert d_i - d_j \vert = 2r\sin\theta$, que nunca se anula para $\theta \notin \{0,\pi\}$; por tanto, **la perturbación queda localizada y acotada por sección**.

**Ilustración numérica (orden de magnitud, $N=8$, float32, $\vert\delta a_k\vert \approx 2^{-24} \approx 6\times10^{-8}$):**

| Estructura | Producto de separaciones de polos | $\vert\delta d_i\vert$ típico | Resultado |
|---|---|---|---|
| Forma Directa II, polos agrupados ($\Delta r \sim 0.02$) | $\sim (0.02)^7 \sim 10^{-12}$ | $\sim 10^{-12} \cdot 6\times10^{-8} / \text{esc.} \sim 10^{5}$ | Polos pueden escapar del círculo unidad → **inestable** |
| Cascada SOS (biquads aislados) | $\sim 2r\sin\theta \sim 0.1$ | $\sim 6\times10^{-8}/0.1 \sim 10^{-7}$ | Polos permanecen con margen → **estable** |

(Los valores exactos dependen del filtro; la tabla es una estimación de orden de magnitud del argumento cualitativo.)

#### 3.5.2 Margen de estabilidad ante cuantificación

En Forma Directa, la cuantificación de $a_k$ puede desplazar un polo fuera del círculo unidad, volviendo el filtro **inestable** (divergencia exponencial). En cascada SOS:

1. Cada biquad tiene solo dos polos, y el desplazamiento de cada uno es local (Sección 3.5.1).
2. Con la restricción de radio $r_p \le 0.9999$ (Sección 6), el margen $1 - r_p = 10^{-4}$ es varios órdenes de magnitud mayor que el paso de cuantificación de float32 ($2^{-24} \approx 6\times10^{-8}$), de modo que **ningún polo puede cruzar el círculo unidad por efecto del redondeo de $a_{1k}, a_{2k}$**.

#### 3.5.3 Ruido de redondeo (round-off noise)

Sea $\sigma_k^2$ la potencia de ruido de redondeo inyectada por la sección $k$ (multiplicaciones redondeadas a $B$ bits, con varianza por multiplicación $\sigma^2 = 2^{-2B}/12$). En la cascada, el ruido de la sección $k$ se filtra por las secciones posteriores $k+1, \dots, N_s$, cuyo producto de respuestas actúa como filtro conformador:

$$
S_y(\omega) \;=\; \sum_{k=1}^{N_s} \sigma_k^2\,
\Bigl|\prod_{m=k+1}^{N_s} H_m\bigl(e^{j\omega}\bigr)\Bigr|^2.
\tag{3.9}
$$

Con el **escalado por sección** (Sección 3.3) se controlan los niveles internos, evitando dos problemas de la Forma Directa de alto orden: (i) los nodos internos de la Forma Directa II pueden alcanzar valores enormes mientras la salida es pequeña, provocando **cancelación catastrófica** y pérdida total de precisión; (ii) el ruido de redondeo se propaga a través de un único acumulador de orden $N$ con ganancias elevadas. En cascada SOS, el ruido de cada sección se atenúa por las secciones siguientes y los niveles internos se mantienen acotados (Jackson [4], Oppenheim & Schafer [1, cap. 9]).

**Conclusión formal (Sección 3).** Para $N > 2$, la cascada de biquads con escalado por sección y ordenación de pares (Sección 3.6) minimiza la sensibilidad de polos (Lema 3.4), garantiza el margen de estabilidad y reduce el ruido de redondeo respecto a la Forma Directa I/II de alto orden. Es por ello el estándar de las librerías de DSP (p. ej. `scipy.signal.sosfilt`).

### 3.6 Emparejamiento y ordenación de pares (regla de Jackson)

Para minimizar el ruido de redondeo y el pico de ganancia interna:

1. **Emparejamiento (pairing):** cada par de polos se empareja con el par de ceros **geométricamente más cercano** (mínima distancia polo–cero).
2. **Ordenación (ordering):** las secciones se ordenan en orden **decreciente de resonancia** (los polos más cercanos al círculo unidad, mayor $Q$, primero), seguidos de los menos resonantes.

Referencias: Jackson [4], Proakis & Manolakis [7], Zölzer [6].

---

## 4. Cálculo Analítico Exacto del Retardo de Grupo

### 4.1 Definición

**Definición 4.1.** El *retardo de grupo* de un filtro con fase (desenvuelta) $\theta(\omega) = \arg H(e^{j\omega})$ es

$$
\tau_g(\omega) \;\equiv\; -\frac{d\theta(\omega)}{d\omega}.
\tag{4.1}
$$

### 4.2 Derivación geométrica a partir de los vectores polo/cero

Tomando logaritmo de (2.2) y separando la parte imaginaria:

$$
\theta(\omega) \;=\; \arg K + \sum_{i=1}^{M} \arg\bigl(1 - c_i\, e^{-j\omega}\bigr) - \sum_{k=1}^{N} \arg\bigl(1 - d_k\, e^{-j\omega}\bigr).
\tag{4.2}
$$

**Lema 4.2 (derivada de la fase de un vector polo–círculo unidad).** Para un polo $d = r e^{j\phi}$, $0 \le r < 1$, defínase

$$
\psi_d(\omega) \;=\; \arg\bigl(1 - d\, e^{-j\omega}\bigr)
\;=\; \operatorname{atan2}\!\bigl(-\, r\sin(\omega - \phi),\; 1 - r\cos(\omega - \phi)\bigr).
\tag{4.3}
$$

Entonces

$$
\frac{d\psi_d}{d\omega}
\;=\;
\frac{r\cos(\omega - \phi) - r^2}{1 - 2r\cos(\omega - \phi) + r^2}.
\tag{4.4}
$$

*Demostración.* Con $u = \phi - \omega$, se tiene $1 - r e^{ju} = X(u) - jY(u)$ con $X = 1 - r\cos u$, $Y = r\sin u$ y $\psi = \operatorname{atan2}(-Y, X)$. Usando la regla de la derivada del arcotangente de un cociente:

$$
\frac{d\psi}{du} \;=\; \frac{X\,(-Y') - (-Y)\, X'}{X^2 + Y^2}
\;=\; \frac{-r\cos u + r^2}{1 - 2r\cos u + r^2},
$$

y como $d\omega = -du$ con $u = \phi - \omega$, se obtiene (4.4) teniendo en cuenta $\cos(\phi - \omega) = \cos(\omega - \phi)$. $\blacksquare$

El denominador de (4.4) es $\bigl|1 - d e^{-j\omega}\bigr|^2$ (Sección 2.3, ec. 2.4), **estrictamente positivo** para $r < 1$: la fórmula es continua y no singular en toda la banda $\omega \in [0, 2\pi)$, incluso en resonancias agudas con $r \to 0.9999$.

### 4.3 Fórmula cerrada del retardo de grupo

Aplicando (4.1)–(4.4), con polos $d_k = r_k e^{j\phi_k}$ y ceros $c_i = \rho_i e^{j\varphi_i}$:

$$
\boxed{\;
\tau_g(\omega)
\;=\;
\sum_{k=1}^{N}
\frac{r_k\cos(\omega - \phi_k) - r_k^2}{1 - 2r_k\cos(\omega - \phi_k) + r_k^2}
\;-\;
\sum_{i=1}^{M}
\frac{\rho_i\cos(\omega - \varphi_i) - \rho_i^2}{1 - 2\rho_i\cos(\omega - \varphi_i) + \rho_i^2}.
\;}
\tag{4.5}
$$

Los **polos contribuyen positivamente** (retardo) y los **ceros negativamente** (adelanto de fase). Evaluar (4.5) cuesta $O(N + M)$ operaciones por frecuencia, es **exacto** (sin error de discretización) y no requiere conocer $\theta(\omega)$ explícitamente.

### 4.4 Identidades de verificación

1. **Polo real $a$** en $H(z) = 1/(1 - a z^{-1})$: de (4.5),
   $$
   \tau_g(\omega) = \frac{a\cos\omega - a^2}{1 - 2a\cos\omega + a^2},
   \qquad
   \tau_g(0) = \frac{a}{1 - a}.
   \tag{4.6}
   $$
2. **Cero en $z = 1$** ($H(z) = 1 - z^{-1}$, $\rho = 1, \varphi = 0$):
   $$
   \tau_g(\omega) = \frac{1}{2}, \quad \forall \omega \in (0, 2\pi).
   \tag{4.7}
   $$
3. **Par de polos conjugados** $r e^{\pm j\theta}$ en resonancia $\omega = \theta$. La ec. (4.5) da **exactamente** (ambos polos del par contribuyen):
   $$
   \tau_g(\theta)
   \;=\;
   \underbrace{\frac{r}{1 - r}}_{\text{polo en } +\theta}
   \;+\;
   \frac{r\cos(2\theta) - r^2}{1 - 2r\cos(2\theta) + r^2}.
   \tag{4.8a}
   $$
   En el límite $\theta \to 0$ (resonancia casi en DC, $\cos 2\theta \to 1$) se recupera la forma simplificada
   $$
   \tau_g(\theta) \;\xrightarrow[\theta\to0]{}\; \frac{2r}{1 - r},
   \tag{4.8b}
   $$
   que es una **cota superior** de $\tau_g$ (cada polo del par contribuye a lo sumo $r/(1-r)$ en su propia resonancia).
   **Advertencia de implementación:** el motor debe evaluar siempre la ec. (4.5) exacta, nunca la cota (4.8b). P. ej., con $r = 0.9$, $\theta = \pi/4$: $\tau_g(\theta) = 8.5525$, mientras que la cota $2r/(1-r) = 18$ solo se alcanza en el límite $\theta \to 0$.
4. **Identidad integral (argumento).** La variación total de fase alrededor del círculo unidad es
   $$
   \int_{0}^{2\pi} \tau_g(\omega)\, d\omega
   \;=\; 2\pi\,\bigl(M - N_z^{\text{int}}\bigr)
   \;=\; 2\pi \cdot \#\{\text{ceros estrictamente fuera del círculo unidad}\},
   \tag{4.9}
   $$
   donde $M$ es el número total de ceros y $N_z^{\text{int}}$ el de ceros en el interior del círculo unidad (principio del argumento; véase [1], [2]).
   *Justificación (núcleo de Poisson).* Para una raíz $d = \rho e^{j\varphi}$, el factor $(1 - d\,e^{-j\omega})$ tiene retardo $\tau = \tfrac{1}{2}\bigl(P_\rho(\omega-\varphi) - 1\bigr)$, con $P_\rho$ el núcleo de Poisson. Como $\int_0^{2\pi} P_\rho = 2\pi$ para $\rho < 1$, cada **raíz interior** (polo o cero) integra a $0$; cada **cero exterior** ($\rho > 1$) añade $+2\pi$. Los polos son siempre interiores ($r \le 0.9999$, Sección 6), luego $\int \tau_g = 2\pi (M - N_z^{\text{int}})$. Consecuencia: un filtro de **fase mínima** (todos los ceros interiores) integra a $0$; cada cero no mínimo aporta $+2\pi$.

### 4.5 Por qué NO usar diferenciación numérica finita

La aproximación por diferencias finitas

$$
\tau_g(\omega) \;\approx\; -\frac{\theta(\omega + \Delta\omega) - \theta(\omega - \Delta\omega)}{2\,\Delta\omega}
\tag{4.10}
$$

presenta tres deficiencias que la hacen inaceptable para el motor:

1. **Amplificación de ruido de fase.** El ruido numérico de $\theta(\omega)$ (procedente de $\operatorname{atan2}$ y del desenvolvimiento, Sección 5) se divide por $\Delta\omega$; en resonancias agudas (fase muy pendiente) el cociente produce picos espurios.
2. **Sensibilidad a la malla.** Requiere $\Delta\omega$ pequeño pero con cancelación de dos términos casi iguales (error de cancelación catastrófica en coma flotante); el error $\sim \vert \theta^{(3)}\vert \Delta\omega^2$ se degrada justo donde más se necesita precisión.
3. **Dependencia del desenvolvimiento.** (4.10) solo es válida con fase desenvuelta; un fallo de desenvolvimiento (Sección 5) corrompe la derivada numérica por completo.

La fórmula analítica (4.5) elimina las tres fuentes de error: es exacta, continua y evaluable en cualquier frecuencia, y **no depende de la fase desenvuelta** (solo de la geometría polo/cero). Referencia: Smith [3, cap. "Phase Response" y "Group Delay"].

---

## 5. Algoritmo de Desenvolvimiento de Fase (Phase Unwrapping)

### 5.1 Problema

La fase principal calculada con $\operatorname{atan2}$ toma valores en $(-\pi, \pi]$:

$$
\phi_n \;=\; \arg H\bigl(e^{j\omega_n}\bigr) \;=\; \operatorname{atan2}\!\bigl(\Im H(e^{j\omega_n}),\; \Re H(e^{j\omega_n})\bigr) \in (-\pi, \pi],
\tag{5.1}
$$

y presenta **saltos de $2\pi$** en cada cruce del corte de rama. La fase desenvuelta $\theta_u(\omega)$ es la función **continua** tal que

$$
\theta_u(\omega) \;=\; \phi(\omega) + 2\pi\, m(\omega), \qquad m(\omega) \in \mathbb{Z}.
\tag{5.2}
$$

### 5.2 Algoritmo discreto (desenvolvimiento incremental)

Sea una malla uniforme $\omega_n = n\,\Delta\omega$, $n = 0, 1, \dots, L-1$, con $\Delta\omega = 2\pi/L$, y $\phi_n$ la fase envuelta de (5.1).

**Algoritmo 5.1 (desenvolvimiento por diferencia de fase envuelta).**

1. **Inicialización:** $\theta_u[0] = \phi_0$.
2. Para $n = 1, 2, \dots, L-1$:
   $$
   \delta_n \;=\; \phi_n - \phi_{n-1},
   \tag{5.3}
   $$
   $$
   q_n \;=\; \operatorname{round}\!\left(\frac{\delta_n}{2\pi}\right)
   \;\equiv\; \Bigl\lfloor \frac{\delta_n}{2\pi} + \frac{1}{2} \Bigr\rfloor,
   \tag{5.4}
   $$
   $$
   \theta_u[n] \;=\; \theta_u[n-1] + \delta_n - 2\pi\, q_n.
   \tag{5.5}
   $$

El paso (5.5) corrige el salto: si $\delta_n$ se aproxima a $+2\pi$ o $-2\pi$, $q_n = \pm 1$ y se resta/suma $2\pi$, obteniéndose el incremento verdadero $\delta_n - 2\pi q_n \in (-\pi, \pi]$.

### 5.3 Condición de validez (límite de la malla)

El algoritmo es correcto si el incremento de fase **verdadera** entre muestras adyacentes cae en $(-\pi, \pi]$, es decir,

$$
\bigl| \theta_u[n] - \theta_u[n-1] \bigr| \;\le\; \pi.
\tag{5.6}
$$

Como la fase cambia a razón $\vert \tau_g(\omega) \vert$, la condición se traduce en un límite sobre la resolución de la malla:

$$
\boxed{\;
\Delta\omega \;\le\; \frac{\pi}{\displaystyle\max_{\omega \in [0, 2\pi)} \bigl| \tau_g(\omega) \bigr| }.
\;}
\tag{5.7}
$$

Para el motor, donde los polos pueden acercarse a $r = 0.9999$ (Sección 6) con $\max \vert \tau_g \vert \lesssim 2r/(1-r) \sim 2\times10^{4}$ muestras (cota superior, ec. 4.8b), se requiere $\Delta\omega \lesssim \pi / 2\times10^{4} \approx 1.6\times10^{-4}$, es decir $L \gtrsim 2\pi/\Delta\omega \approx 4\times10^{4}$ puntos de malla. Alternativamente, se usa la integración del retardo de grupo (Sección 5.4), que es inmune a este límite.

### 5.4 Alternativa robusta: integración del retardo de grupo (recomendada)

Puesto que (4.5) proporciona $\tau_g(\omega)$ **analítico y desenvuelto por construcción**, la fase desenvuelta se obtiene por integración:

$$
\theta_u(\omega) \;=\; \theta_u(0) - \int_{0}^{\omega} \tau_g(\omega')\, d\omega',
\tag{5.8}
$$

discretizada en la malla uniforme por integración trapezoidal:

$$
\theta_u[n] \;=\; \theta_u[n-1] - \frac{\Delta\omega}{2}\Bigl(\tau_g(\omega_{n-1}) + \tau_g(\omega_n)\Bigr).
\tag{5.9}
$$

Esta vía **no presenta ambigüedad de $2\pi$** y, por construcción, es consistente con el retardo de grupo mostrado en la UI (los dos paneles se validan mutuamente). Se recomienda: (i) usar Algoritmo 5.1 sobre $\operatorname{atan2}$ para la fase *bruta*; (ii) usar (5.9) como comprobación cruzada, exigiendo discrepancia residual $\lesssim 10^{-6}$ rad.

### 5.5 Caso límite: ceros sobre el círculo unidad

Si un cero reside exactamente sobre el círculo unidad ($\rho = 1$), la fase presenta una **discontinuidad genuina de $\pm\pi$** (cambio de signo de la magnitud), no un artefacto de corte de rama. El Algoritmo 5.1 no debe "desenvolver" ese salto; el motor debe tratarlo explícitamente (p. ej. reportando el salto de $\pi$ como tal o desplazando el cero a $\rho = 1 - \varepsilon$). Referencia del algoritmo: Itoh [5], Oppenheim & Schafer [1, p. 321 y Apéndice].

---

## 6. Estabilidad y Condicionamiento

### 6.1 Criterio BIBO de estabilidad

**Teorema 6.1 (estabilidad BIBO de sistemas racionales causales).** Un sistema LTI causal con función de transferencia racional $H(z) = B(z)/A(z)$ es **BIBO-estable** (toda entrada acotada produce salida acotada) si y solo si

$$
\sum_{n=0}^{\infty} \bigl| h[n] \bigr| < \infty,
\tag{6.1}
$$

lo cual es equivalente a que **todos los polos estén estrictamente en el interior del círculo unidad**:

$$
\bigl| d_k \bigr| < 1, \qquad \forall k = 1, \dots, N.
\tag{6.2}
$$

*Demostración.* Descomposición en fracciones simples: si los polos $d_k$ son simples, $h[n] = \sum_k A_k\, d_k^{\,n}\, u[n]$; entonces (6.1) se satisface sii $\vert d_k \vert < 1$. El caso de polos múltiples se sigue por el mismo argumento (términos $n^{m} d_k^n$ siguen siendo sumables sii $\vert d_k \vert < 1$). Véase [1, cap. 2] y [2]. $\blacksquare$

### 6.2 Restricción de radio de diseño

**Restricción 6.2 (constraint de diseño).** En el motor, todo polo queda restringido a

$$
\boxed{\;
\vert d_k \vert \;=\; r_k \;\le\; 0.9999, \qquad \forall k.
\;}
\tag{6.3}
$$

Los ceros, en cambio, no se restringen (pueden situarse en cualquier punto del plano, incluido el círculo unidad).

### 6.3 Justificación (i): margen de estabilidad frente a cuantificación

Con la cuantificación de los coeficientes del biquad (3.3), el módulo del polo se desplaza. Como $a_{2k} = r_p^2$, una perturbación $\delta a_{2k}$ produce

$$
\delta r_p \;=\; \frac{\delta a_{2k}}{2 r_p} \;\approx\; \frac{\delta a_{2k}}{2}.
\tag{6.4}
$$

Para float32, $\vert\delta a_{2k}\vert \approx 2^{-24} \approx 5.96\times10^{-8}$ y por tanto $\vert\delta r_p\vert \approx 3\times10^{-8}$, que es **~3300 veces menor** que el margen $1 - r_p = 10^{-4}$ impuesto por (6.3). El polo, incluso en el peor caso de redondeo, permanece en $r_p \le 0.9999 + 3\times10^{-8} < 1$, garantizando la estabilidad BIBO (6.2) de forma estructural.

### 6.4 Justificación (ii): acotación del desbordamiento numérico (overflow)

**Lema 6.3 (ganancia de pico de un par de polos).** Para el par conjugado $r e^{\pm j\theta}$ con $r < 1$, la ganancia de pico de la sección (3.2) es

$$
G_{\max} \;=\; \max_{\omega}\; \Bigl| \frac{1}{1 + a_1 e^{-j\omega} + a_2 e^{-2j\omega}} \Bigr|
\;=\; \frac{1}{(1 - r)^2},
\tag{6.5}
$$

alcanzada en $\omega = \theta$ (resonancia).

*Demostración.* En resonancia el denominador es $(1 - r e^{-j\theta})^2$ (Sección 3.5.1), cuyo módulo en $\omega = \theta$ es $(1-r)^2$. $\blacksquare$

Con la restricción (6.3):

$$
G_{\max} \;=\; \frac{1}{(1 - r_p)^2} \;\le\; \frac{1}{(10^{-4})^2} \;=\; 10^{8} \;\approx\; 160\ \text{dB}.
\tag{6.6}
$$

**Razonamiento de overflow.** La dinámica de una señal de audio en coma flotante tiene un rango útil del orden de 120–140 dB (piso de ruido de float32 ≈ $-138$ dB). Un pico de resonancia de $10^8$ (160 dB) **ya excede** ese rango útil, por lo que el motor debe normalizar la ganancia (escalado por sección, Sección 3.3) hasta ganancia de pico unitaria. Con esa normalización:

1. Cada nodo interno de la cascada SOS mantiene una amplitud acotada por un factor pequeño de la entrada (los estados crecen como $\sim \tau_g \lesssim 2r/(1-r) \le 2\times10^{4}$ muestras, cota superior ec. 4.8b), y
2. en float32, la acumulación $S = \sum x_i$ con $\vert S \vert < 3.4\times10^{38}$ no desborda, pero la precisión relativa se degrada cuando la magnitud se acerca al máximo.

El límite (6.3) **acota la ganancia de pico y la pendiente de fase a valores manejables**; sin él, permitir $r \to 1$ haría $G_{\max}$ y $\tau_g$ crecer sin límite, y el factor de normalización se volvería mal condicionado (o, en Forma Directa de alto orden, los nodos internos con cancelación parcial desbordarían float32). En float64 ($\approx 1.8\times10^{308}$) el margen es aún mayor, y (6.3) queda como margen de seguridad frente a la combinación de picos de varias secciones en alineación.

### 6.5 Justificación (iii): condicionamiento

La sensibilidad (3.8) crece cuando $r \to 1$ (el denominador $\vert 1 - 2r\cos(\omega-\phi) + r^2\vert$ tiende a 0 y el número de condición de la correspondencia coeficiente→polo diverge). El techo (6.3) mantiene acotado el número de condición de toda la cadena de conversión polo/cero → SOS → evaluación, garantizando que pequeños errores de redondeo en las entradas del usuario no produzcan cambios grandes en la respuesta del filtro.

### 6.6 Factor de calidad asociado

Para $r \to 1$, el factor de calidad del par de polos se aproxima por (ancho de banda de 3 dB $\Delta\omega_{3\text{dB}} \approx 2(1-r)$, derivado en el Apéndice A):

$$
Q \;\approx\; \frac{\theta}{2\,(1 - r)}.
\tag{6.7}
$$

Con (6.3), en el peor caso $\theta = \pi/2$: $Q \lesssim \pi/(4\times10^{-4}) \approx 7.85\times10^{3}$, consistente con $G_{\max} \sim Q^2 \sim 10^8$ (ec. 6.6). Referencia de la relación ancho de banda–radio: Smith [2], Zölzer [6].

---

## 7. Resumen de Invariantes de Diseño (Contrato)

Toda implementación del motor debe satisfacer:

| # | Invariante | Ecuación |
|---|---|---|
| I1 | Todos los polos en el interior del círculo unidad | $\vert d_k \vert \le 0.9999$ | (6.3) |
| I2 | Pares conjugados reales en biquads | $a_{1k} = -2r_p\cos\theta_p$, $a_{2k} = r_p^2$ | (3.3) |
| I3 | Ceros en biquads | $b_{1k} = -2\rho_z\cos\varphi_z$, $b_{2k} = \rho_z^2$ | (3.3) |
| I4 | Orden impar → sección de primer orden | $a_{10} = -d_0$ | (3.4) |
| I5 | Escalado por sección (ganancia de pico ≤ 1) | $K = \prod_k K_k$ | (3.5) |
| I6 | Retardo de grupo analítico | $\tau_g(\omega) = \text{(4.5)}$, sin diferencias finitas | (4.5) |
| I7 | Fase desenvuelta por Algoritmo 5.1 o integración (5.9) | $\vert\delta\vert \le \pi$ o $\Delta\omega \le \pi/\max\vert\tau_g\vert$ | (5.5), (5.7) |
| I8 | Emparejamiento y ordenación de Jackson | polos más resonantes primero | §3.6 |
| I9 | El producto de las secciones SOS reproduce $H(z)$ exactamente | $\prod_k H_k(z) = B(z)/A(z)$ | (3.5) |

---

## 8. Lista de Validación (Checklist matemático)

Antes de aprobar este documento como base de implementación, se deben verificar numéricamente (sin código, con un cálculo simbólico o numérico independiente):

- [ ] **V1 — Ecuación del biquad:** para $r = 0.9$, $\theta = \pi/4$: $a_1 = -2(0.9)(\sqrt{2}/2) \approx -1.27279$, $a_2 = 0.81$.
- [ ] **V2 — Identidad de cascada (I9):** $\prod_k H_k(z) = B(z)/A(z)$ por convolución polinómica, con coeficientes en doble precisión (residuo $< 10^{-12}$).
- [ ] **V3 — Retardo de grupo, polo real:** con $a = 0.5$, $\tau_g(0) = a/(1-a) = 1$ (ec. 4.6).
- [ ] **V4 — Retardo de grupo, cero en $z=1$:** $\tau_g = 1/2$ en todo $\omega$ (ec. 4.7).
- [ ] **V5 — Resonancia de par conjugado:** con $r = 0.9$, $\theta = \pi/4$: $\tau_g(\theta) = 8.5525$ muestras (ec. 4.8a exacta); el límite $\theta \to 0$ de (4.8b) da $2r/(1-r) = 18$.
- [ ] **V6 — Identidad integral:** $\int_0^{2\pi} \tau_g\, d\omega = 2\pi(M - N_z^{\text{int}}) = 2\pi \cdot \#\{\text{ceros fuera del círculo}\}$ (ec. 4.9); fase mínima → 0.
- [ ] **V7 — Consistencia fase/retardo:** $\theta_u[n] - \theta_u[n-1] = -\tau_g(\omega_n)\,\Delta\omega$ dentro de $10^{-6}$ rad (ec. 5.9 vs. Algoritmo 5.1).
- [ ] **V8 — Estabilidad:** con polos en $r = 0.9999$ y cuantificación float32 de $a_{1k}, a_{2k}$, verificar $r_{\text{efectivo}} < 1$ (ec. 6.4).
- [ ] **V9 — Ganancia de pico:** para $r = 0.9999$, verificar $G_{\max} \approx 10^{8}$ (ec. 6.6) y su normalización a 0 dB por el escalado I5.

---

## 9. Referencias Académicas

**[1]** A. V. Oppenheim, R. W. Schafer, *Discrete-Time Signal Processing*, 3rd ed., Prentice Hall, 2010. — Cap. 2 (transformada $z$, estabilidad BIBO), Cap. 5 (respuesta en frecuencia, fase, retardo de grupo), Cap. 9 (efectos de longitud de palabra finita, ruido de redondeo), p. 321 y Apéndice (desenvolvimiento de fase), principio del argumento.

**[2]** J. O. Smith III, *Introduction to Digital Filters with Audio Applications*, W3K Publishing, 2007. — Factorización de filtros, SOS/biquads, estabilidad, interpretación geométrica polo–círculo unidad, retardo de grupo. Disponible en https://ccrma.stanford.edu/~jos/filters/

**[3]** J. O. Smith III, *Spectral Audio Signal Processing*, W3K Publishing, 2011. — Capítulos de respuesta de fase y retardo de grupo: fórmulas analíticas del retardo de grupo a partir de los vectores polo/cero.

**[4]** L. B. Jackson, *Digital Filters and Signal Processing*, 3rd ed., Kluwer Academic, 1996. — Emparejamiento y ordenación de pares para minimizar ruido de redondeo en cascadas SOS; escalado de nodos.

**[5]** K. Itoh, *Analysis of the phase unwrapping algorithm*, Applied Optics, vol. 21, no. 14, pp. 2470, 1982. — Algoritmo discreto de desenvolvimiento de fase (base del `unwrap` de MATLAB/NumPy).

**[6]** U. Zölzer, *DAFX: Digital Audio Effects*, 2nd ed., Wiley, 2011. — Filtros resonadores digitales, relación radio–$Q$–ancho de banda, escalado de ganancia.

**[7]** J. G. Proakis, D. G. Manolakis, *Digital Signal Processing: Principles, Algorithms, and Applications*, 4th ed., Pearson, 2007. — Realizaciones en cascada SOS, efectos de cuantificación.

**[8]** S. K. Mitra, *Digital Signal Processing: A Computer-Based Approach*, 4th ed., McGraw-Hill, 2011. — Realizaciones de filtros, sensibilidad de coeficientes, escalado.

---

## Apéndice A — Ancho de banda de 3 dB y factor de calidad

Para el par de polos $r e^{\pm j\theta}$, cerca de la resonancia $\omega \approx \theta$:

$$
\bigl|1 - r e^{-j\omega}\bigr|^2 = 1 - 2r\cos(\omega-\theta) + r^2 \approx (1-r)^2 + r\,(\omega-\theta)^2.
\tag{A.1}
$$

Igualando al valor de media potencia $(1-r)^2/2$:

$$
(\omega - \theta)^2 \;=\; \frac{(1-r)^2}{2r},
\qquad
\Delta\omega_{3\text{dB}} \;\approx\; \frac{1 - r}{\sqrt{r}} \;\approx\; 1 - r \quad (r \to 1),
\tag{A.2}
$$

de donde, para el par completo, $Q = \theta / \Delta\omega_{3\text{dB}} \approx \theta/(2(1-r))$, que es la ecuación (6.7). La aproximación es válida para $r \to 1$ (polos cercanos al círculo unidad), que es el régimen acotado por la Restricción 6.2.
