// Runs in a separate local document. Only SVG strings cross into the viewer;
// they are displayed as inert images, never inserted into the app's DOM.
let mermaidReady;
let plantumlReady;
function script(path) {
    return new Promise((resolve, reject) => {
        const element = document.createElement('script');
        element.src = path;
        element.onload = resolve;
        element.onerror = () => reject(new Error('The bundled diagram engine could not load.'));
        document.head.append(element);
    });
}

async function render(kind, source, id) {
    if (source.length > 50000) throw new Error('Diagram exceeds the 50,000 character limit.');
    if (kind === 'mermaid') {
        mermaidReady ||= script('./vendor/mermaid.min.js').then(() => {
            window.mermaid.initialize({
                startOnLoad: false, securityLevel: 'strict', theme: 'default',
                suppressErrorRendering: true, maxTextSize: 50000, maxEdges: 500,
                // Mermaid 12 uses the root option. SVG text labels preserve
                // line breaks without emitting HTML <br> tags inside SVG XML.
                htmlLabels: false,
            });
            return window.mermaid;
        });
        const engine = await mermaidReady;
        const { svg } = await engine.render(`diagram-${id}`, source);
        return svg;
    }
    plantumlReady ||= Promise.all([
        script('./vendor/plantuml/viz-global.js'),
        script('./vendor/plantuml/themes.js'),
        script('./vendor/plantuml/emoji.js'),
        script('./vendor/plantuml/openiconic.js'),
        script('./vendor/plantuml/plantuml.js'),
    ]).then(() => window.PlantUML);
    // Includes can load scripts in the upstream engine. Only bundled resources
    // are supported; never turn a document directive into a resource request.
    if (/!\s*(include|import)|%\s*(load|filename|dirpath|getenv)|!theme[^\n]*\sfrom\s/i.test(source)) {
        throw new Error('External includes are unavailable. Use a self-contained diagram.');
    }
    const engine = await plantumlReady;
    return new Promise((resolve, reject) => {
        engine.renderToString(source.split(/\r\n|\n|\r/), resolve, error => reject(new Error(String(error))));
    });
}

window.addEventListener('message', async event => {
    if (event.source !== parent || event.data?.type !== 'render-diagram') return;
    const { id, kind, source } = event.data;
    try {
        const svg = await render(kind, source, id);
        parent.postMessage({ type: 'diagram-result', id, svg }, '*');
    } catch (error) {
        parent.postMessage({ type: 'diagram-result', id, error: error.message || String(error) }, '*');
    }
});
parent.postMessage({ type: 'diagram-ready' }, '*');
