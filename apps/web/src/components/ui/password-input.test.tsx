import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import { createTestI18n } from "../../i18n/test-instance";
import { PasswordInput } from "./password-input";

function renderPasswordInput(
  overrides: Partial<React.ComponentProps<typeof PasswordInput>> = {},
) {
  return render(
    <I18nextProvider i18n={createTestI18n("en")}>
      <PasswordInput
        ariaLabel="Password"
        autoComplete="current-password"
        onChange={() => undefined}
        value="hunter2"
        {...overrides}
      />
    </I18nextProvider>,
  );
}

describe("PasswordInput", () => {
  it("renders an obscured password input by default", () => {
    renderPasswordInput();

    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
  });

  it("toggles the visibility when the button is clicked", () => {
    renderPasswordInput();

    const input = screen.getByLabelText("Password");
    const toggle = screen.getByRole("button", { name: "Show password" });

    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    expect(input).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);

    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("labels the toggle with the localized hide action when visible", () => {
    renderPasswordInput();

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));

    expect(
      screen.getByRole("button", { name: "Hide password" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("forwards value, change, and blur events to the parent", () => {
    let observed = "";
    let blurred = 0;
    render(
      <I18nextProvider i18n={createTestI18n("en")}>
        <PasswordInput
          ariaLabel="Password"
          onBlur={() => {
            blurred += 1;
          }}
          onChange={(value) => {
            observed = value;
          }}
          value=""
        />
      </I18nextProvider>,
    );

    const input = screen.getByLabelText("Password");
    fireEvent.change(input, { target: { value: "new-secret" } });
    fireEvent.blur(input);

    expect(observed).toBe("new-secret");
    expect(blurred).toBe(1);
  });

  it("does not submit the parent form when toggling visibility", () => {
    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    };
    render(
      <I18nextProvider i18n={createTestI18n("en")}>
        <form onSubmit={handleSubmit}>
          <PasswordInput
            ariaLabel="Password"
            onChange={() => undefined}
            value="hunter2"
          />
          <button type="submit">Submit</button>
        </form>
      </I18nextProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));

    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
  });
});
