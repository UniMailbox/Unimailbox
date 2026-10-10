import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LocalDateTime, formatLocalDateTime, toUtcIsoTimestamp } from './LocalDateTime';

afterEach(() => cleanup());

describe('LocalDateTime', () => {
  it('treats a database timestamp without a zone as UTC', () => {
    const value = '2026-02-02 00:00:00';
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date('2026-02-02T00:00:00Z'));

    expect(formatLocalDateTime(value)).toBe(expected);
    expect(toUtcIsoTimestamp(value)).toBe('2026-02-02T00:00:00.000Z');
  });

  it('keeps RFC 3339 instants and the original UTC value available on the element', () => {
    const value = '2026-02-02T00:00:00Z';
    render(<LocalDateTime value={value} data-testid="timestamp" />);

    const element = screen.getByTestId('timestamp');
    expect(element.tagName).toBe('TIME');
    expect(element.textContent).toBe(formatLocalDateTime(value));
    expect(element).toHaveAttribute('dateTime', '2026-02-02T00:00:00.000Z');
    expect(element).toHaveAttribute('title', `UTC ${value}`);
  });

  it('falls back to the original value for invalid timestamps', () => {
    render(<LocalDateTime value="not-a-timestamp" data-testid="timestamp" />);

    const element = screen.getByTestId('timestamp');
    expect(element.textContent).toBe('not-a-timestamp');
    expect(element).toHaveAttribute('dateTime', 'not-a-timestamp');
  });
});
