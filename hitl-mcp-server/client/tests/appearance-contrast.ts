import type { Page } from '@playwright/test';

/** Checks rendered text against composited ancestor backgrounds, including opacity. */
export async function unreadableText(page: Page) {
  return page.evaluate(() => {
    type Color = [number, number, number, number];
    const parse = (value: string): Color => {
      const n = value.match(/[\d.]+/g)?.map(Number);
      if (!n || n.length < 3) throw new Error(`Unsupported color: ${value}`);
      return [n[0], n[1], n[2], n[3] ?? 1];
    };
    const over = (front: Color, back: Color): Color => [
      ...front.slice(0, 3).map((n, i) => n * front[3] + back[i] * (1 - front[3])), 1,
    ] as Color;
    const luminance = (color: Color) => color.slice(0, 3).map(n => {
      const v = n / 255;
      return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const issues: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.top >= innerHeight || rect.bottom <= 0) continue;
      const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
      if (!text || ['SCRIPT', 'STYLE', 'OPTION'].includes(el.tagName)) continue;
      const chain: Element[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) chain.unshift(node);
      let background: Color = [255, 255, 255, 1];
      const layers: { back: Color; opacity: number }[] = [];
      for (const node of chain) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none') issues.push(`Manual background review needed: ${node.className}`);
        layers.push({ back: background, opacity: Number(style.opacity) });
        background = over(parse(style.backgroundColor), background);
      }
      let foreground = over(parse(getComputedStyle(el).color), background);
      for (const layer of layers.reverse()) {
        foreground = over([foreground[0], foreground[1], foreground[2], layer.opacity], layer.back);
        background = over([background[0], background[1], background[2], layer.opacity], layer.back);
      }
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      if (ratio < 4.5) issues.push(`${el.tagName}.${el.className}: ${text.slice(0, 45)} (${ratio.toFixed(2)}:1)`);
    }
    return issues;
  });
}
