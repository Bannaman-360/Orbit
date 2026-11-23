import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ace } from './api';
import './styles.css';

/**
 * If drawing the editor ever fails, this shows what to do instead of leaving an empty window:
 * try again, or start fresh (the last session is kept, not deleted), and copy a problem report.
 */
class Recover extends Component<{ children: ReactNode }, { error: string | null; copied: boolean }> {
  state = { error: null as string | null, copied: false };
  static getDerivedStateFromError(e: unknown) {
    return { error: String(e instanceof Error ? e.message : e), copied: false };
  }
  componentDidCatch(e: unknown, info: ErrorInfo) {
    ace.logError('window', `${e instanceof Error ? e.stack ?? e.message : String(e)}\n${info.componentStack ?? ''}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const fresh = async () => { await ace.autosaveAside(); location.reload(); };
    const copy = async () => { await ace.reportCopy(await ace.reportText('')); this.setState({ copied: true }); };
    return (
      <div className="recover" role="alertdialog" aria-label="Something went wrong">
        <div className="recover-card">
          <h1>Something went wrong</h1>
          <p>The editor hit a problem it couldn’t recover from. Try again first. If it happens again, start fresh: your last session is kept, not deleted.</p>
          <div className="recover-actions">
            <button className="primary" onClick={() => location.reload()}>Try again</button>
            <button onClick={() => void fresh()}>Start fresh</button>
            <button className="link" onClick={() => void copy()}>{this.state.copied ? 'Report copied' : 'Copy a problem report'}</button>
          </div>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<Recover><App /></Recover>);
