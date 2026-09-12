// Shared progressive enhancement for every Markdown surface. Watching inserted
// blocks also covers lazy review modes, expanded diff runs and changing previews.
const selector = 'pre > code';

function diagramKind(code) {
    if (code.classList.contains('language-mermaid')) return 'mermaid';
    if (code.classList.contains('language-plantuml') || code.classList.contains('language-puml')) return 'plantuml';
    // Some Markdown producers mislabel diagrams as CSS/Perl or omit the
    // language. Recognise an explicit declaration, never keywords buried in
    // ordinary source code. Keep the original text and fence metadata intact.
    const declaration = code.textContent.split(/\r\n|\n|\r/)
        .map(line => line.trim()).find(line => line && !line.startsWith('%%')) || '';
    if (/^(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\s*;?$/.test(declaration)
        || /^(?:sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram)\s*;?$/.test(declaration)) return 'mermaid';
    return null;
}
let renderer;
let rendererReady;
let nextId = 0;
let queue = Promise.resolve();
let expanded;

function engineFrame() {
    if (rendererReady) return rendererReady;
    rendererReady = new Promise((resolve, reject) => {
        renderer = document.createElement('iframe');
        renderer.className = 'diagram-engine';
        renderer.title = 'Diagram rendering engine';
        renderer.setAttribute('aria-hidden', 'true');
        renderer.tabIndex = -1;
        // Opaque origin prevents this frame from accessing the parent or Tauri.
        renderer.setAttribute('sandbox', 'allow-scripts');
        const timer = setTimeout(() => { cleanup(); reject(new Error('Diagram engine timed out.')); }, 15000);
        const ready = event => {
            if (event.source === renderer?.contentWindow && event.data?.type === 'diagram-ready') {
                cleanup(); resolve(renderer);
            }
        };
        function cleanup() { clearTimeout(timer); window.removeEventListener('message', ready); }
        window.addEventListener('message', ready);
        renderer.src = new URL('./diagram-renderer.html', import.meta.url).href;
        document.body.append(renderer);
    });
    return rendererReady;
}

async function renderSvg(kind, source) {
    try {
        const frame = await engineFrame();
        return await new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { cleanup(); reject(new Error('Diagram rendering timed out.')); }, 20000);
            function cleanup() { clearTimeout(timer); window.removeEventListener('message', receive); }
            function receive(event) {
                if (event.source !== frame.contentWindow || event.data?.type !== 'diagram-result' || event.data.id !== id) return;
                cleanup();
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.svg);
            }
            window.addEventListener('message', receive);
            frame.contentWindow.postMessage({ type: 'render-diagram', id, kind, source }, '*');
        });
    } catch (error) {
        renderer?.remove(); renderer = null; rendererReady = null;
        throw error;
    }
}

function button(label, text, action) {
    const element = document.createElement('button');
    element.type = 'button'; element.textContent = text;
    element.setAttribute('aria-label', label); element.title = label;
    element.addEventListener('click', event => { event.stopPropagation(); action(); });
    return element;
}

function controls(image, viewport, toolbar) {
    let scale = 1;
    const output = document.createElement('output');
    output.textContent = '100%'; output.setAttribute('aria-label', 'Diagram zoom');
    const zoom = value => {
        scale = Math.max(Number.EPSILON, Math.min(8, value));
        image.style.width = `${image.naturalWidth * scale}px`;
        image.style.maxWidth = 'none';
        output.textContent = scale < 0.01 ? '<1%' : `${Math.round(scale * 100)}%`;
    };
    const fit = () => zoom(Math.min(1,
        (viewport.clientWidth - 24) / image.naturalWidth,
        (viewport.clientHeight - 24) / image.naturalHeight));
    toolbar.append(
        button('Zoom out', '−', () => zoom(scale / 1.25)), output,
        button('Zoom in', '+', () => zoom(scale * 1.25)),
        button('Fit diagram', 'Fit', fit),
        button('Actual size', '100%', () => zoom(1)),
    );
    // Native scrolling supports touch panning and keyboard navigation at any zoom.
    viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Diagram; scroll to pan');
    requestAnimationFrame(() => {
        if (viewport.clientWidth && image.naturalWidth) fit();
    });
}

function expand(image, trigger) {
    expanded?.dialog.close();
    const dialog = document.createElement('dialog');
    dialog.className = 'diagram-dialog'; dialog.setAttribute('aria-label', 'Expanded diagram');
    const toolbar = document.createElement('div'); toolbar.className = 'diagram-toolbar';
    const viewport = document.createElement('div'); viewport.className = 'diagram-viewport';
    const copy = image.cloneNode(); copy.removeAttribute('style');
    viewport.append(copy); controls(copy, viewport, toolbar);
    toolbar.append(button('Close expanded diagram', 'Close', () => dialog.close()));
    dialog.append(toolbar, viewport); document.body.append(dialog);
    expanded = { dialog, trigger };
    dialog.addEventListener('close', () => {
        dialog.remove();
        if (expanded?.dialog === dialog) expanded = null;
        if (trigger.isConnected) trigger.focus();
    });
    dialog.showModal();
}

function enhance(code) {
    const pre = code.parentElement;
    if (!pre || pre.closest('.diagram-viewer')) return;
    const kind = diagramKind(code);
    if (!kind) return;
    const source = code.textContent;
    const viewer = document.createElement('div'); viewer.className = 'diagram-viewer';
    viewer.dataset.diagramKind = kind;
    // Fence metadata may be on <code> or promoted to <pre> by the diff renderer.
    for (const attribute of ['data-source-start', 'data-source-end', 'data-source-side']) {
        const value = pre.getAttribute(attribute) ?? code.getAttribute(attribute);
        if (value !== null) viewer.setAttribute(attribute, value);
        pre.removeAttribute(attribute); code.removeAttribute(attribute);
    }
    // Keep diff/selection styling and source coordinates on the same block.
    viewer.classList.add(...pre.classList);
    const status = document.createElement('p'); status.className = 'diagram-status';
    status.textContent = `Rendering ${kind === 'mermaid' ? 'Mermaid' : 'PlantUML'} diagram…`;
    status.setAttribute('role', 'status');
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Diagram source';
    details.append(summary);
    pre.replaceWith(viewer); details.append(pre); viewer.append(status, details);
    queue = queue.then(async () => {
        if (!viewer.isConnected) return;
        try {
            const svg = await renderSvg(kind, source);
            if (!viewer.isConnected) return;
            const image = document.createElement('img');
            image.alt = `${kind === 'mermaid' ? 'Mermaid' : 'PlantUML'} diagram. Text description is in Diagram source.`;
            // Mermaid emits percentage widths; resolve its viewBox so 100%
            // means actual size and zoom can recover large diagrams crisply.
            const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
            const root = xml.documentElement;
            if (root.localName !== 'svg') throw new Error('The renderer returned an invalid image.');
            const bounds = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
            if (bounds?.length === 4 && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
                root.setAttribute('width', String(bounds[2])); root.setAttribute('height', String(bounds[3]));
                root.style.maxWidth = 'none';
            }
            const title = root.querySelector('title, desc')?.textContent;
            if (title) image.alt = title;
            image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
            await image.decode();
            if (!viewer.isConnected) return;
            const viewport = document.createElement('div'); viewport.className = 'diagram-viewport';
            const toolbar = document.createElement('div'); toolbar.className = 'diagram-toolbar';
            viewport.append(image); controls(image, viewport, toolbar);
            const expandButton = button('Expand diagram', 'Expand', () => expand(image, expandButton));
            toolbar.append(expandButton);
            status.replaceWith(toolbar, viewport);
        } catch (error) {
            status.className = 'diagram-error';
            status.textContent = `Could not render ${kind} diagram. ${error.message}`;
            details.open = true;
        }
    });
}

function scan(root) {
    if (!(root instanceof Element) || root.closest('.diagram-viewer, .diagram-dialog')) return;
    if (root.matches(selector)) enhance(root);
    root.querySelectorAll(selector).forEach(enhance);
}

const style = document.createElement('link');
style.rel = 'stylesheet'; style.href = new URL('./diagrams.css', import.meta.url).href;
document.head.append(style);
new MutationObserver(records => {
    if (expanded && !expanded.trigger.isConnected) expanded.dialog.close();
    for (const record of records) for (const node of record.addedNodes) scan(node);
}).observe(document.documentElement, { childList: true, subtree: true });
scan(document.documentElement);
