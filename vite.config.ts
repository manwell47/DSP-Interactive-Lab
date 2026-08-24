/**
 * vite.config.ts
 *
 * Fase 10 — Configuración de Vite para el bundle del navegador.
 *
 * - `base: './'` : el build (dist/) funciona servido desde cualquier ruta.
 * - Cabeceras COOP/COEP (ARCHITECTURE.md §9.3, §12.1): obligatorias para que
 *   crossOriginIsolated === true y el camino SharedArrayBuffer funcione en el
 *   dev server y en el preview del build.
 *
 * Vitest sigue usando vitest.config.ts (tiene precedencia sobre vite.config.ts),
 * por lo que este archivo NO afecta a los tests (entorno node).
 */
import { defineConfig } from 'vite';

const crossOriginHeaders: Record<string, string> = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
    base: './',
    server: {
        headers: crossOriginHeaders,
    },
    preview: {
        headers: crossOriginHeaders,
    },
});
