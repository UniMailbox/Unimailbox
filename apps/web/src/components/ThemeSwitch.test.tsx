import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initializeTheme, ThemeSwitch } from './ThemeSwitch';
afterEach(() => {
  localStorage.removeItem('unimailbox-theme');
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});
describe('theme preference', () => {
  it('persists a user choice and reapplies it before the next render', async () => {
    render(<ThemeSwitch />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Change theme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('unimailbox-theme')).toBe('dark');
    document.documentElement.classList.remove('dark');
    initializeTheme();
    expect(document.documentElement).toHaveClass('dark');
  });
  it('honors an explicit light preference even when the system is dark', () => {
    const original = window.matchMedia.bind(window);
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...original(query),
      matches: true,
    }));
    localStorage.setItem('unimailbox-theme', 'light');
    initializeTheme();
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
