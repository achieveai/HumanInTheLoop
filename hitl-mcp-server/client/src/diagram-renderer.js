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

function authoredColors(source) {
    return /classDef\b|\bstyle\s+\w|%%\{\s*init|theme:|skinparam|!theme|#[0-9a-f]{3,8}\b/i.test(source);
}

async function render(kind, source, id, theme, colors) {
    if (source.length > 50000) throw new Error('Diagram exceeds the 50,000 character limit.');
    if (theme === 'dark' && !['surface', 'raised', 'text', 'accent', 'muted', 'selected', 'warning', 'warning-bg']
        .every(name => /^#[0-9a-f]{6}$/i.test(colors?.[name] || ''))) throw new Error('Invalid diagram palette');
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
        const dark = theme === 'dark' && !authoredColors(source);
        engine.initialize({
            startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
            suppressErrorRendering: true, maxTextSize: 50000, maxEdges: 500, htmlLabels: false,
            ...(dark ? { themeVariables: {
                background: colors.surface, primaryColor: colors.selected, primaryTextColor: colors.text,
                primaryBorderColor: colors.accent, lineColor: colors.muted, textColor: colors.text,
                secondaryColor: colors.raised, tertiaryColor: colors.raised,
                actorBkg: colors.raised, actorTextColor: colors.text, actorBorder: colors.accent,
                signalColor: colors.text, signalTextColor: colors.text,
                noteBkgColor: colors['warning-bg'], noteTextColor: colors.warning, noteBorderColor: colors.warning,
            } } : {}),
        });
        const { svg } = await engine.render(`diagram-${id}`, source);
        return { svg, lightBacking: !dark };
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
    // Apply defaults only to unstyled source. The bundled theme presets use
    // bright actor fills whose small white labels fail our contrast target.
    const dark = theme === 'dark' && !authoredColors(source);
    const palette = [
        `skinparam backgroundColor ${colors?.surface}`,
        `skinparam defaultFontColor ${colors?.text}`,
        `skinparam arrowColor ${colors?.muted}`,
        'skinparam shadowing false',
        `skinparam activityStartColor ${colors?.muted}`,
        `skinparam activityEndColor ${colors?.muted}`,
        ...['participant', 'actor', 'class', 'object', 'state', 'activity', 'component', 'rectangle', 'node', 'database', 'note']
            .flatMap(kind => [
                `skinparam ${kind}BackgroundColor ${colors?.raised}`,
                `skinparam ${kind}FontColor ${colors?.text}`,
                `skinparam ${kind}BorderColor ${colors?.accent}`,
            ]),
        `skinparam sequenceLifeLineBorderColor ${colors?.muted}`,
        `skinparam sequenceGroupBackgroundColor ${colors?.raised}`,
        `skinparam sequenceGroupHeaderFontColor ${colors?.text}`,
        `skinparam sequenceDividerBackgroundColor ${colors?.raised}`,
        `skinparam sequenceDividerFontColor ${colors?.text}`,
    ].join('\n');
    const renderedSource = dark ? source.replace(/(@start\w+[^\r\n]*)(\r?\n)/i,
        (_match, start, newline) => `${start}${newline}${palette}\n`) : source;
    return new Promise((resolve, reject) => {
        engine.renderToString(renderedSource.split(/\r\n|\n|\r/),
            svg => resolve({ svg, lightBacking: !dark }),
            error => reject(new Error(String(error))));
    });
}

window.addEventListener('message', async event => {
    if (event.source !== parent || event.data?.type !== 'render-diagram') return;
    const { id, kind, source, theme = 'light', palette } = event.data;
    try {
        if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid diagram theme');
        const result = await render(kind, source, id, theme, palette);
        parent.postMessage({ type: 'diagram-result', id, ...result }, '*');
    } catch (error) {
        parent.postMessage({ type: 'diagram-result', id, error: error.message || String(error) }, '*');
    }
});
parent.postMessage({ type: 'diagram-ready' }, '*');
