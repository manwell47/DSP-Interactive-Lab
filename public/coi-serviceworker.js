/* coi-serviceworker.js
 *
 * Adaptación de "coi-serviceworker" (Guido Zuidhof, MIT) para alojamientos
 * estáticos como GitHub Pages, que no permiten cabeceras HTTP personalizadas.
 *
 * GitHub Pages no envía COOP/COEP, por lo que `crossOriginIsolated === false`
 * y el camino SharedArrayBuffer/Atomics (núcleo de esta app) no estaría
 * disponible. Este service worker intercepta las peticiones y REESCRIBE las
 * respuestas añadiendo:
 *
 *   Cross-Origin-Embedder-Policy: require-corp
 *   Cross-Origin-Opener-Policy:   same-origin
 *
 * con lo que el documento (y sus workers/worklet) quedan aislados y el SAB
 * funciona. En el dev server de Vite no hace nada porque ya llega aislado.
 *
 * Registro con ruta RELATIVA (desde el script en el DOM) para funcionar tanto
 * en la raíz como en una subruta de proyecto (/repo/).
 */
if (typeof window === 'undefined') {
    /* ------------------------- Contexto service worker ------------------- */
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener('fetch', (event) => {
        if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
            return;
        }
        const request = new Request(event.request, { cache: 'no-cache' });
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }
                    const newHeaders = new Headers(response.headers);
                    newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
                    newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((error) => {
                    // eslint-disable-next-line no-console
                    console.error('coi-serviceworker fetch error:', error);
                }),
        );
    });
} else {
    /* ---------------------------- Contexto página ------------------------ */
    (function () {
        const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
        window.sessionStorage.setItem('coiReloadedBySelf', 'reload');

        // El dev server de Vite ya envía COOP/COEP: no hacer nada.
        if (window.crossOriginIsolated) {
            return;
        }

        // URL absoluta del propio script (resuelta por el navegador desde el DOM),
        // válida en la raíz y en subrutas de proyecto.
        const scriptEl = document.getElementById('coi-serviceworker');
        const swUrl = new URL(scriptEl ? scriptEl.src : './coi-serviceworker.js', window.location.href).href;

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker
                .register(swUrl)
                .then(() => {
                    if (!reloadedBySelf) {
                        window.location.reload();
                    }
                })
                .catch((error) => {
                    // eslint-disable-next-line no-console
                    console.error('coi-serviceworker register error:', error);
                });
        }
    })();
}
