import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ERROR_CODES } from '@unimailbox/contracts';
import { setLanguage, useT } from './locale';
import { errorMessages, errorMessage } from './error-messages';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { ApiError } from '../api/errors';
import { SelectField } from '../../components/ui/SelectField';
afterEach(() => setLanguage('en'));
it('translates already-mounted UI and errors by code without showing server text', () => {
  function Example() {
    const t = useT();
    return (
      <>
        <h1>{t('Inbox')}</h1>
        <ErrorPanel code="INVALID_CREDENTIALS" message="raw provider details" />
        <p>
          {t('Images up to {images} · files up to {files}.', { images: '5 MB', files: '64 MB' })}
        </p>
      </>
    );
  }
  const apiError = new ApiError('INVALID_CREDENTIALS', 'raw provider details', 401, 'request-1');
  render(<Example />);
  expect(screen.getByRole('heading')).toHaveTextContent('Inbox');
  act(() => setLanguage('zh-CN'));
  expect(screen.getByRole('heading')).toHaveTextContent('收件箱');
  expect(screen.getByRole('alert')).toHaveTextContent('邮箱或密码不正确。');
  expect(screen.queryByText('raw provider details')).toBeNull();
  expect(screen.getByText('图片最大 5 MB · 文件最大 64 MB。')).toBeInTheDocument();
  expect(apiError.message).toBe('邮箱或密码不正确。');
  expect(apiError.code).toBe('INVALID_CREDENTIALS');
  expect(apiError.requestId).toBe('request-1');
  expect(document.documentElement.lang).toBe('zh-CN');
});
it('covers every shared code in both locales and safely falls back for future/invalid codes', () => {
  for (const code of Object.values(ERROR_CODES)) {
    expect(errorMessages[code].en).toBeTruthy();
    expect(errorMessages[code]['zh-CN']).toMatch(/[\u4e00-\u9fff]/);
  }
  expect(errorMessage('FUTURE_SECRET_ERROR', 'zh-CN')).toBe(errorMessages.INTERNAL['zh-CN']);
});
it('updates the closed select label when language changes without changing its API value', () => {
  const onValueChange = vi.fn();
  render(
    <SelectField
      label="Unknown recipient policy"
      value="reject"
      onValueChange={onValueChange}
      options={[
        { value: 'reject', label: 'Reject unknown recipients' },
        { value: 'store', label: 'Store unknown recipients' },
      ]}
    />,
  );
  expect(screen.getByRole('combobox')).toHaveTextContent('Reject unknown recipients');
  act(() => setLanguage('zh-CN'));
  expect(screen.getByRole('combobox', { name: '未知收件人策略' })).toHaveTextContent(
    '拒收未知收件人的邮件',
  );
  expect(screen.getByRole('combobox')).toHaveAttribute('data-state', 'closed');
  act(() => setLanguage('en'));
  expect(screen.getByRole('combobox')).toHaveTextContent('Reject unknown recipients');
  expect(onValueChange).not.toHaveBeenCalled();
});
