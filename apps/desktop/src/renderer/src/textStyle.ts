// How overlay text is set: font stacks, the font string for a size, colours with opacity.

import type { Overlay, OverlayFont } from '@ace/project';

/** Font stacks: macOS fonts first, Windows equivalents after. */
export const FONT_STACK: Record<OverlayFont, string> = {
  sans: '-apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif',
  condensed: '"Avenir Next Condensed", "DIN Condensed", "Bahnschrift SemiCondensed", "Arial Narrow", sans-serif',
  heavy: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
  impact: 'Impact, Haettenschweiler, "Arial Narrow", sans-serif',
  futura: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif',
  avenir: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
  gill: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif',
  optima: 'Optima, Candara, "Segoe UI", sans-serif',
  serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
  didot: 'Didot, "Bodoni 72", "Bodoni MT", Georgia, serif',
  baskerville: 'Baskerville, "Baskerville Old Face", Georgia, serif',
  rockwell: 'Rockwell, "Rockwell Nova", "American Typewriter", Georgia, serif',
  copperplate: 'Copperplate, "Copperplate Gothic Light", "Copperplate Gothic", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  typewriter: '"American Typewriter", "Courier New", Courier, monospace',
  marker: '"Marker Felt", "Ink Free", "Comic Sans MS", cursive',
  chalk: '"Chalkboard SE", Chalkduster, "Segoe Print", cursive',
  script: '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive',
};

export const font = (o: Overlay, px: number, weight?: number) =>
  `${o.italic ? 'italic ' : ''}${weight ?? (o.bold ? (o.font === 'heavy' ? 900 : 700) : 400)} ${Math.max(1, px)}px ${FONT_STACK[o.font]}`;

export const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

