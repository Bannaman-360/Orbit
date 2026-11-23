import { describe, expect, it } from 'vitest';
import { logLine, makeLimiter, scrub } from './diagnosticsText';

describe('problem log', () => {
  it('keeps file names, drops the folders around them', () => {
    expect(scrub('Could not read /Users/sam/Movies/Rides/GX010001.MP4', '/Users/sam')).toBe('Could not read …/GX010001.MP4');
    expect(scrub('Card at /Volumes/GOPRO/DCIM/100GOPRO/GS010004.360 gone', '/Users/sam')).toBe('Card at …/GS010004.360 gone');
    expect(scrub('open "C:\\Users\\Sam\\Videos\\ride.mp4" failed', 'C:\\Users\\Sam')).toBe('open "…\\ride.mp4" failed');
    expect(scrub('at render (file:///Applications/Action%20Cam%20Editor.app/Contents/Resources/app.asar/out/renderer/index.js:12:5)', '/Users/sam')).toBe('at render (index.js:12:5)');
  });
  it('folder names with spaces go too', () => {
    expect(scrub('reading /Users/sam/Movies/Secret Trip/GX010001.MP4 now', '/Users/sam')).toBe('reading …/GX010001.MP4 now');
    expect(scrub('at C:\\Users\\Sam\\My Videos\\ride.mp4', 'C:\\Users\\Sam')).toBe('at …\\ride.mp4');
    expect(scrub('at D:\\Rides 2026\\Day 1\\ride.mp4', '')).toBe('at …\\ride.mp4');
  });
  it('never lets the home folder or the user name through', () => {
    const s = scrub('home is /Users/sam and the log is /Users/sam/Library/Logs/x.log', '/Users/sam');
    expect(s).not.toContain('sam');
  });
  it('leaves ordinary text alone', () => {
    expect(scrub('GPU device lost: destroyed (1/2 frames)', '/Users/sam')).toBe('GPU device lost: destroyed (1/2 frames)');
  });
  it('writes one line per event, indenting the rest of a stack', () => {
    const l = logLine('error', 'window', 'Boom\nat a (/Users/sam/x/y.js:1:2)', '/Users/sam', new Date(0));
    expect(l).toBe('1970-01-01T00:00:00.000Z ERROR [window] Boom\n    at a (…/y.js:1:2)\n');
  });
  it('skips repeats and caps a flood', () => {
    const ok = makeLimiter(3, 1000);
    expect(ok('a', 0)).toBe(true);
    expect(ok('a', 500)).toBe(false);
    expect(ok('a', 1600)).toBe(true);
    expect(ok('b', 1700)).toBe(true);
    expect(ok('c', 1800)).toBe(false);
    expect(ok('d', 70_000)).toBe(true);
  });
});
