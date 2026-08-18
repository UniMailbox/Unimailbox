import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export type PasswordInputProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  autoComplete?: string;
  placeholder?: string;
  id?: string;
  name?: string;
  ariaLabel: string;
  invalid?: boolean;
  dir?: "ltr" | "rtl" | "auto";
};

/**
 * Controlled password input with a visibility toggle. The toggle is rendered
 * inside a `.password-field` wrapper so a single border surrounds both the
 * input and the button; the parent remains responsible for any `FieldError`.
 */
export function PasswordInput({
  value,
  onChange,
  onBlur,
  autoComplete,
  placeholder,
  id,
  name,
  ariaLabel,
  invalid,
  dir,
}: PasswordInputProps) {
  const { t } = useTranslation("common");
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field" data-invalid={invalid ? "true" : undefined}>
      <input
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        dir={dir}
        id={id}
        name={name}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={visible ? "text" : "password"}
        value={value}
      />
      <button
        aria-label={
          visible ? t("actions.hidePassword") : t("actions.showPassword")
        }
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
        type="button"
      >
        {visible ? (
          <EyeOff aria-hidden="true" size={16} />
        ) : (
          <Eye aria-hidden="true" size={16} />
        )}
      </button>
    </div>
  );
}
