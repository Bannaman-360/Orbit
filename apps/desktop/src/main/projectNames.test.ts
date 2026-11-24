import { describe, expect, it } from 'vitest';
import { projectFileName, uniqueName } from './projectNames';

describe('project names', () => {
  it('keeps ordinary names', () => expect(projectFileName('Whistler day 2')).toBe('Whistler day 2'));
  it('removes characters a file name cannot have', () => expect(projectFileName('A/B: run? "best"')).toBe('A B run best'));
  it('never returns an empty or reserved name', () => {
    expect(projectFileName('   ')).toBe('Untitled project');
    expect(projectFileName('...')).toBe('Untitled project');
    expect(projectFileName('CON')).toBe('CON project');
  });
  it('numbers names already taken, ignoring case', () => {
    expect(uniqueName('Ride', [], '.acproj')).toBe('Ride.acproj');
    expect(uniqueName('Ride', ['ride.ACPROJ', 'Ride 2.acproj'], '.acproj')).toBe('Ride 3.acproj');
  });
});
