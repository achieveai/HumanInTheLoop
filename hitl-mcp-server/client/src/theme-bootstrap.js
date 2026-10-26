// Runs in the head before styles/content. Native injection supplies only an enum.
if (window === window.top && window.__HITL_THEME__ === 'dark') {
    document.documentElement.dataset.hitlTheme = 'dark';
}
