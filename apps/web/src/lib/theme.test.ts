import { beforeEach, describe, expect, it } from "vitest";
import {
  applyThemeColor,
  DEFAULT_THEME_COLOR,
  normalizeThemeColor,
  resolveInitialThemeColor,
  themePalette,
  THEME_COLOR_TOKENS,
} from "./theme";

describe("theme color preferences", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.head.innerHTML = '<meta name="theme-color" content="#11231d">';
  });

  it("normalizes full hexadecimal colors and rejects unsafe values", () => {
    expect(normalizeThemeColor(" #2563EB ")).toBe("#2563eb");
    expect(normalizeThemeColor("#fff")).toBeNull();
    expect(normalizeThemeColor("red")).toBeNull();
    expect(resolveInitialThemeColor("not-a-color")).toBe(DEFAULT_THEME_COLOR);
  });

  it("derives readable interface shades while retaining the selected color", () => {
    const palette = themePalette("#f59e0b");

    expect(palette.themeColor).toBe("#f59e0b");
    expect(palette.forest).not.toBe(palette.themeColor);
    expect(palette.mint).toMatch(/^#[0-9a-f]{6}$/u);
    expect(themePalette("#888888").forest).toMatch(/^#([0-9a-f]{2})\1\1$/u);
  });

  it("exposes the brand tokens written by applyThemeColor for test fixtures", () => {
    expect(THEME_COLOR_TOKENS).toContain("--theme-color");
    expect(THEME_COLOR_TOKENS).toContain("--forest");
    expect(THEME_COLOR_TOKENS).toContain("--forest-deep");
    expect(THEME_COLOR_TOKENS).toContain("--mint");
    expect(THEME_COLOR_TOKENS).toContain("--theme-focus");
    expect(THEME_COLOR_TOKENS).toContain("--theme-focus-soft");
    // Semantic error / success / info / warn tokens are intentionally absent —
    // they should not change when the user picks a new brand colour.
    expect(THEME_COLOR_TOKENS).not.toContain("--danger");
    expect(THEME_COLOR_TOKENS).not.toContain("--danger-soft");
    expect(THEME_COLOR_TOKENS).not.toContain("--success");
    expect(THEME_COLOR_TOKENS).not.toContain("--success-soft");
  });

  it("applies the brand palette to document variables and browser chrome", () => {
    applyThemeColor("#2563eb");

    expect(
      document.documentElement.style.getPropertyValue("--theme-color"),
    ).toBe("#2563eb");
    expect(document.documentElement.style.getPropertyValue("--forest")).toMatch(
      /^#[0-9a-f]{6}$/u,
    );
    expect(
      document.documentElement.style.getPropertyValue("--forest-deep"),
    ).toBe(themePalette("#2563eb").forestDeep);
    expect(document.documentElement.style.getPropertyValue("--mint")).toBe(
      themePalette("#2563eb").mint,
    );
    expect(
      document.documentElement.style.getPropertyValue("--theme-focus"),
    ).toBe(themePalette("#2563eb").focus);
    expect(
      document.documentElement.style.getPropertyValue("--theme-focus-soft"),
    ).toBe(themePalette("#2563eb").focusSoft);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe(themePalette("#2563eb").forestDeep);
  });

  it("keeps the shadcn bridge tokens aligned with the brand palette", () => {
    applyThemeColor("#2563eb");

    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      themePalette("#2563eb").forest,
    );
    expect(
      document.documentElement.style.getPropertyValue("--primary-foreground"),
    ).toBe("#ffffff");
    expect(document.documentElement.style.getPropertyValue("--secondary")).toBe(
      themePalette("#2563eb").focusSoft,
    );
    expect(
      document.documentElement.style.getPropertyValue("--secondary-foreground"),
    ).toBe(themePalette("#2563eb").forestDeep);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      themePalette("#2563eb").mint,
    );
    expect(
      document.documentElement.style.getPropertyValue("--accent-foreground"),
    ).toBe(themePalette("#2563eb").forestDeep);
    expect(document.documentElement.style.getPropertyValue("--ring")).toBe(
      themePalette("#2563eb").focus,
    );
  });

  it("does not recolour semantic error or success tokens when the brand changes", () => {
    document.documentElement.style.setProperty("--danger", "#a3342d");
    document.documentElement.style.setProperty("--success-text", "#17553f");
    const dangerBefore =
      document.documentElement.style.getPropertyValue("--danger");
    const successTextBefore =
      document.documentElement.style.getPropertyValue("--success-text");

    applyThemeColor("#ff0000");

    expect(document.documentElement.style.getPropertyValue("--danger")).toBe(
      dangerBefore,
    );
    expect(
      document.documentElement.style.getPropertyValue("--success-text"),
    ).toBe(successTextBefore);
  });
});
