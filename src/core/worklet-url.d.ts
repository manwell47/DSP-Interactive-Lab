/**
 * src/core/worklet-url.d.ts
 *
 * Declaración de tipos para el import '?worker&url' de Vite:
 *   import workletUrl from './core/iir-sos-processor.ts?worker&url';
 *
 * Vite empaqueta el módulo como un worker chunk (módulo ES, extensión .js)
 * autocontenido y `workletUrl` es su URL. Se usa con audioWorklet.addModule()
 * porque GitHub Pages sirve los assets .ts como 'video/mp2t' (no JavaScript),
 * lo que hacía fallar el worklet de audio en el despliegue.
 *
 * tsconfig.browser.json usa `"types": []`, así que vite/client no se incluye
 * automáticamente; esta declaración mínima cubre el patrón sin arrastrar el
 * resto de tipos de Vite.
 */
declare module '*?worker&url' {
    const src: string;
    export default src;
}
