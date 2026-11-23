// Help → Report a Problem: shows exactly what would be shared (the app's version, the computer,
// and the recent problem log, with folder names removed), and copies it for the user to send.

import { useEffect, useState } from 'react';
import { ace } from './api';

/** What the window knows about the graphics chip (WebGPU), for the report. */
async function gpuText() {
  try {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    const i = a?.info;
    return i ? [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') : 'WebGPU not available';
  } catch { return 'WebGPU not available'; }
}

export async function reportText() { return ace.reportText(await gpuText()); }

export function ReportProblem({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('Collecting…');
  const [copied, setCopied] = useState(false);
  useEffect(() => { void reportText().then(setText); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal report" role="dialog" aria-label="Report a problem">
        <h2>Report a problem</h2>
        <p className="hint">Copy this and send it with a few words about what you were doing. It holds the app’s version, this computer’s system and graphics, and the problems the app noted recently. Folder names are left out, and no video, location or other personal data is included.</p>
        <textarea className="report-text" readOnly value={text} spellCheck={false} />
        <div className="modal-actions">
          <button className="link" onClick={() => void ace.reportReveal()}>Show Log File</button>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={() => { void ace.reportCopy(text).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
    </div>
  );
}
