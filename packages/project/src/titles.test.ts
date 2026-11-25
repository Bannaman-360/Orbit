import { describe, expect, it } from 'vitest';
import { applyTitleTemplate, cleanTextPath, fixOverlay, newTextOverlay, newTitleOverlay, titleTime, TITLE_TEMPLATES } from './overlays';

describe('motion titles', () => {
  it('has about twenty templates with unique ids in every category', () => {
    expect(TITLE_TEMPLATES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(TITLE_TEMPLATES.map((t) => t.id)).size).toBe(TITLE_TEMPLATES.length);
    for (const c of ['lower', 'card', 'end', 'place']) expect(TITLE_TEMPLATES.some((t) => t.category === c)).toBe(true);
  });
  it('a new title takes its template’s words and look', () => {
    const o = newTitleOverlay('lt-bar', 0, 4e6);
    expect(o.title).toBe('lt-bar');
    expect(o.text).toBe('Your name');
    expect(o.subtitle).toBe('Rider · Team');
    expect(o.align).toBe('left');
  });
  it('changing template keeps typed words and the place within a category', () => {
    const o = { ...newTitleOverlay('lt-bar', 0, 4e6), text: 'Sam', x: 0.2 };
    const p = applyTitleTemplate(o, 'lt-box');
    expect(p.text).toBe('Sam');
    expect(p.x).toBeUndefined();
    const q = applyTitleTemplate(o, 'tc-punch');
    expect(q.text).toBe('Sam');
    expect(q.x).toBe(0.5);
    const untouched = applyTitleTemplate(newTitleOverlay('lt-bar', 0, 1), 'tc-drop');
    expect(untouched.text).toBe('DROP IN');
  });
  it('plain text turns into a title and back', () => {
    const t = newTextOverlay(0, 1e6, 'Hello');
    expect(applyTitleTemplate(t, 'tc-spread').text).toBe('Hello');
    expect(applyTitleTemplate({ ...t, title: 'tc-spread' }, null).title).toBeUndefined();
  });
  it('times in and out, shortened for short titles', () => {
    const o = { startUs: 0, endUs: 4e6 };
    expect(titleTime(o, 0).tin).toBe(0);
    expect(titleTime(o, 2e6)).toMatchObject({ tin: 1, tout: 1 });
    expect(titleTime(o, 4e6).tout).toBe(0);
    expect(titleTime({ startUs: 0, endUs: 0.75e6 }, 0.375e6).tin).toBeGreaterThan(0.6);
  });
  it('loading drops unknown templates and bad paths', () => {
    expect(fixOverlay({ title: 'nope' }).title).toBeUndefined();
    expect(fixOverlay({ title: 'tc-drop' }).title).toBe('tc-drop');
    expect(cleanTextPath({ kind: 'arc', bend: 5 })).toEqual({ kind: 'arc', bend: 1 });
    expect(cleanTextPath({ kind: 'freehand', bend: 0, points: [[0, 0]] })).toBeUndefined();
    expect(cleanTextPath({ kind: 'freehand', bend: 0, points: [[-2, 0], [0.2, 0.1]] })!.points).toEqual([[-0.5, 0], [0.2, 0.1]]);
    expect(fixOverlay({ path: { kind: 'spiral', bend: 0 } as never }).path).toBeUndefined();
  });
});
