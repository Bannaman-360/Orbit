// The app's own line icons (24×24, drawn with the current text colour). Weight and size come
// from the theme.

const P: Record<string, string> = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  import: 'M12 3v11M8 10l4 4 4-4M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15',
  card: 'M8.500 3.500h8A1.500 1.500 0 0 1 18 5v14a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 6 19V6ZM9.500 4.500V8M12 4v4M14.500 4v4M12 11v6M9.500 14.500 12 17l2.500-2.500',
  check: 'm5 12.500 4.500 4.500L19 7.500',
  jumps: 'M2 19h5M17 19h5M5 19c2-9 12-9 14 0M12 5v4M9.500 6.500 12 9l2.500-2.500',
  speedline: 'M3 8h4c5 0 4 9 8.500 9 3.500 0 3-6 5.500-6M3 4v16.500h18',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  undo: 'M8 5 4 9l4 4M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm16 5 4 4-4 4M20 9H10a6 6 0 0 0 0 12h3',
  text: 'M5 7V5h14v2M12 5v14M9 19h6',
  gauge: 'M4.5 18a9 9 0 1 1 15 0M12 14l4-5M12 14.5a.6.6 0 1 0 0-1.2.6.6 0 0 0 0 1.2Z',
  track: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  frame: 'M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 15.5Z',
  camera: 'M4 9a2 2 0 0 1 2-2h2l1.6-2.4h4.8L16 7h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM12 16a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z',
  export: 'M12 15V4M8 7.5 12 3.500l4 4M6.500 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5',
  workspaces: 'M4 6.500A2.500 2.500 0 0 1 6.500 4h11A2.500 2.500 0 0 1 20 6.500v11a2.500 2.500 0 0 1-2.500 2.500h-11A2.500 2.500 0 0 1 4 17.500ZM9.500 4v16M9.500 13H20',
  customize: 'M4 8h9M17 8h3M4 16h3M11 16h9M15 10.200a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400ZM9 18.200a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400Z',
  play: 'M8 5.500v13l11-6.500Z', pause: 'M8.500 5.500v13M15.500 5.500v13',
  prev: 'M15.500 6.500v11L7 12Z', next: 'M8.500 6.500v11L17 12Z',
  start: 'M6 6v12M18.500 6.500v11L9 12Z', end: 'M18 6v12M5.500 6.500v11L15 12Z',
  fullscreen: 'M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5', exitfull: 'M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5',
  split: 'M12 3v18M8.500 8 4.500 12l4 4M15.500 8l4 4-4 4', delLeft: 'M19 5v14M15 12H5M9 8l-4 4 4 4', delRight: 'M5 5v14M9 12h10M15 8l4 4-4 4',
  detach: 'M4 10v4h3l4 3.500v-11L7 10ZM15 9.500a3.500 3.500 0 0 1 0 5M17.700 7a7 7 0 0 1 0 10',
  trash: 'M5 7h14M9.500 7V4.500h5V7M7 7l.8 12a1.500 1.500 0 0 0 1.500 1.500h5.400a1.500 1.500 0 0 0 1.500-1.500L17 7M10.300 11v5.500M13.700 11v5.500',
  quality: 'M4 17.500V14M9 17.500V11M14 17.500V8M19 17.500V5', zoom: 'M11 17.500a6.500 6.500 0 1 0 0-13 6.500 6.500 0 0 0 0 13ZM20 20l-4.300-4.300M8.500 11h5M11 8.500v5',
  keyframe: 'm12 4 7 8-7 8-7-8Z', delKey: 'm12 4 7 8-7 8-7-8ZM9.500 12h5', lock: 'M6.500 11h11A1.500 1.500 0 0 1 19 12.500v6a1.500 1.500 0 0 1-1.500 1.500h-11A1.500 1.500 0 0 1 5 18.500v-6A1.500 1.500 0 0 1 6.500 11ZM8 11V8a4 4 0 0 1 8 0v3M12 14.500v2', compare: 'M4 6.500A1.500 1.500 0 0 1 5.500 5h13A1.500 1.500 0 0 1 20 6.500v11a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 17.500ZM12 3v18M14.500 15.500l3-3M14.500 11l3-3', duplicate: 'M8 8h11v11H8ZM5 15V5h10', save: 'M5 5h11l3 3v11H5ZM8 5v5h7V5M8 19v-5h8v5', open: 'M4 7.500A1.500 1.500 0 0 1 5.500 6h4l2 2.500h7A1.500 1.500 0 0 1 20 10v7.500a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 17.500Z',
  media: 'M4 6.500A1.500 1.500 0 0 1 5.500 5h13A1.500 1.500 0 0 1 20 6.500v11a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 17.500ZM8 5v14M16 5v14M4 9.500h4M4 14.500h4M16 9.500h4M16 14.500h4',
  viewer: 'M4 7A2 2 0 0 1 6 5h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2ZM9 20.500h6', timeline: 'M4 7h10M8 12h12M4 17h7M17 4v16',
  reframe: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM4 12h16M12 4c3 2.300 3 13.700 0 16M12 4c-3 2.300-3 13.700 0 16', stabilize: 'M4 12h3l2.500-6 4 12 2.500-6H20',
  color: 'M12 20a8 8 0 1 1 8-8c0 3-2.500 3-4 3s-2 1-1.500 2.500S14 20 12 20ZM8 11.500h.01M10.500 8h.01M15 8.500h.01', effects: 'm12 4 1.800 5.200L19 11l-5.200 1.800L12 18l-1.800-5.200L5 11l5.200-1.800ZM18.500 16v4M16.500 18h4',
  clip: 'M4 8h16v10H4ZM4 8l2-3.500h3L7 8M11 8l2-3.500h3L14 8', selection: 'M5 4l13 7-5.500 1.500L10 18Z', custom: 'M5 5h6v6H5ZM13 5h6v6h-6ZM5 13h6v6H5ZM16 13v6M13 16h6',
  float: 'M8 9.500A1.500 1.500 0 0 1 9.500 8h9A1.500 1.500 0 0 1 20 9.500v8a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 8 17.500ZM5 15.500v-9A1.500 1.500 0 0 1 6.500 5h9',
  close: 'M6.500 6.500l11 11M17.500 6.500l-11 11', more: 'M6 12h.01M12 12h.01M18 12h.01', plus: 'M12 5v14M5 12h14', eye: 'M3 12s3.500-6 9-6 9 6 9 6-3.500 6-9 6-9-6-9-6ZM12 14.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5Z', eyeoff: 'M4 4l16 16M9.500 6.500A9 9 0 0 1 12 6c5.500 0 9 6 9 6a15 15 0 0 1-2.700 3.200M6 8.500A15 15 0 0 0 3 12s3.500 6 9 6a9 9 0 0 0 3.300-.6',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01', expand: 'M8 9.500 12 5.500l4 4M8 14.500l4 4 4-4', collapse: 'M8 5.500l4 4 4-4M8 18.500l4-4 4 4',
  palette: 'M12 20a8 8 0 1 1 8-8c0 3-2.500 3-4 3s-2 1-1.500 2.500S14 20 12 20ZM8 11.500h.01M10.500 8h.01M15 8.500h.01', slider: 'M4 12h4M14 12h6M11 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', button: 'M4 9.500A1.500 1.500 0 0 1 5.500 8h13A1.500 1.500 0 0 1 20 9.500v5a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 14.500ZM8.500 12h7',
  keyboard: 'M3.500 8A1.500 1.500 0 0 1 5 6.500h14A1.500 1.500 0 0 1 20.500 8v8a1.500 1.500 0 0 1-1.500 1.500H5A1.500 1.500 0 0 1 3.500 16ZM7 10h.01M10.300 10h.01M13.700 10h.01M17 10h.01M8 14h8', toolbar: 'M4 6.500A1.500 1.500 0 0 1 5.500 5h13A1.500 1.500 0 0 1 20 6.500v11a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 17.500ZM4 10h16M7 7.500h.01M10 7.500h.01', themes: 'M5 5h14v9H5ZM12 14v3M9.500 20.500h5V17h-5Z',
  info: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 11v5M12 8h.01', label: 'M4 12l7-7h8v8l-7 7ZM15.500 8.500h.01', transition: 'M4 6h9v12H4ZM11 6l9 12V6Z', loop: 'M7 7h9a4 4 0 0 1 0 8M17 17H8a4 4 0 0 1 0-8M9.500 4.500 7 7l2.500 2.500M14.500 14.500 17 17l-2.500 2.500', sections: 'M5 5h14v5H5ZM5 14h14v5H5Z', chevron: 'm7 10 5 5 5-5',
};
export type IconName = keyof typeof P;
const FILLED = new Set(['play', 'prev', 'next', 'start', 'end', 'keyframe']);
/** For colourful icons. */
const HUE: Record<string, string> = {
  import: '#0a84ff', card: '#0a84ff', music: '#ff375f', text: '#bf5af2', gauge: '#30b0c7', track: '#00c7be', camera: '#ff9f0a', export: '#0a84ff', split: '#ff9f0a', delLeft: '#ff9f0a', delRight: '#ff9f0a', detach: '#30d158', trash: '#ff453a', undo: '#8e8e93', redo: '#8e8e93', keyframe: '#ffcc33', play: '#30d158', pause: '#30d158', customize: '#bf5af2', workspaces: '#5e5ce6', fullscreen: '#64d2ff', duplicate: '#5e5ce6', save: '#0a84ff', open: '#0a84ff', frame: '#64d2ff', zoom: '#64d2ff', quality: '#30d158', transition: '#ff375f',
};

export function Icon({ name, size, className = '' }: { name: string; size?: number; className?: string }) {
  const d = P[name] ?? P.more;
  return (
    <svg className={`icon-svg${name === 'grip' || name === 'more' ? ' dots' : ''} ${className}`} style={{ ...(size ? { width: size, height: size } : {}), ...(HUE[name] ? ({ '--hue': HUE[name] } as React.CSSProperties) : {}) }} viewBox="0 0 24 24" aria-hidden>
      <path d={d} fill={FILLED.has(name) ? 'currentColor' : 'none'} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
