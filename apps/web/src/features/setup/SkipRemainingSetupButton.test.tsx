// apps/web — SkipRemainingSetupButton tests.
//
// CAP-063: the visual contract — every wizard step that renders the
// button MUST render it identically. The button-level test owns that
// visual contract; per-step tests just verify the button is rendered
// (with the right enabled/disabled state for that step).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkipRemainingSetupButton } from './SkipRemainingSetupButton';

afterEach(() => {
  cleanup();
});

describe('SkipRemainingSetupButton', () => {
  it('renders the contract — testid, label, variant=secondary, type=button', () => {
    render(<SkipRemainingSetupButton onSkip={() => undefined} submitting={false} />);
    const button = screen.getByTestId('setup-skip-remaining');
    expect(button).toBeInTheDocument();
    expect(button.textContent).toBe('Skip remaining setup');
    // The Button primitive uses variantClass['secondary'] === 'btn btn-secondary'.
    expect(button.className).toContain('btn-secondary');
    // The Button primitive defaults type='button'.
    expect(button.getAttribute('type')).toBe('button');
    expect(button).toBeEnabled();
  });

  it('is disabled when the disabled prop is true (AdministratorStep gate)', () => {
    render(
      <SkipRemainingSetupButton onSkip={() => undefined} submitting={false} disabled={true} />,
    );
    expect(screen.getByTestId('setup-skip-remaining')).toBeDisabled();
  });

  it('is disabled while submitting even when disabled=false', () => {
    render(<SkipRemainingSetupButton onSkip={() => undefined} submitting={true} />);
    const button = screen.getByTestId('setup-skip-remaining');
    expect(button).toBeDisabled();
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('invokes onSkip exactly once per click', async () => {
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(<SkipRemainingSetupButton onSkip={onSkip} submitting={false} />);
    await user.click(screen.getByTestId('setup-skip-remaining'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onSkip when disabled', async () => {
    const onSkip = vi.fn();
    const user = userEvent.setup();
    render(
      <SkipRemainingSetupButton onSkip={onSkip} submitting={false} disabled={true} />,
    );
    await user.click(screen.getByTestId('setup-skip-remaining'));
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('wraps the button in wizard-actions so the visual sits below the primary CTA', () => {
    const { container } = render(<SkipRemainingSetupButton onSkip={() => undefined} submitting={false} />);
    expect(container.querySelector('.wizard-actions')).not.toBeNull();
  });
});