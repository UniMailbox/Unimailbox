/* Adapted from satnaing/shadcn-admin theme-switch/theme-provider; MIT attribution in docs/rebuild/licenses. */
import { useEffect, useState, type ReactElement } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import { Button } from './ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/shadcn/dropdown-menu';
type Theme = 'light' | 'dark' | 'system';
function readTheme(): Theme {
  try {
    const value = localStorage.getItem('unimailbox-theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(theme: Theme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
export function ThemeSwitch(): ReactElement {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (): void => applyTheme(theme);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Sun className="dark:hidden" />
          <Moon className="hidden dark:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(['light', 'dark', 'system'] as const).map((value) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => {
              setTheme(value);
              try {
                localStorage.setItem('unimailbox-theme', value);
              } catch {
                /* Preference unavailable; current theme still applies. */
              }
            }}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
            {theme === value ? <Check className="ms-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function initializeTheme(): void {
  applyTheme(readTheme());
}
