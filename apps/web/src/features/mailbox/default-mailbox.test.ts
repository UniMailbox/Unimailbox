import type { MailboxListItem } from '@unimailbox/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  rememberMailbox,
  selectDefaultMailbox,
} from '../../infrastructure/preferences/default-mailbox';
const user = { userId: 'user-a', email: 'a@example.com' };
const items = [
  {
    id: 'shared',
    address: 'shared@example.com',
    status: 'active',
    ownerUserId: 'other',
    domainId: 'd',
    localPart: 'shared',
    displayName: '',
  },
  {
    id: 'own',
    address: 'a@example.com',
    status: 'active',
    ownerUserId: user.userId,
    domainId: 'd',
    localPart: 'a',
    displayName: '',
  },
];
beforeEach(() => localStorage.clear());
describe('default mailbox selection', () => {
  it('prefers the login address on the first visit', () =>
    expect(selectDefaultMailbox(items, user)?.id).toBe('own'));
  it('restores a last-used shared mailbox and isolates different users', () => {
    rememberMailbox(user.userId, 'shared');
    expect(selectDefaultMailbox(items, user)?.id).toBe('shared');
    expect(selectDefaultMailbox(items, { ...user, userId: 'user-b' })?.id).toBe('own');
  });
  it('ignores removed or disabled remembered mailboxes', () => {
    rememberMailbox(user.userId, 'shared');
    expect(
      selectDefaultMailbox(
        items.map((item) => (item.id === 'shared' ? { ...item, status: 'disabled' } : item)),
        user,
      )?.id,
    ).toBe('own');
    expect(selectDefaultMailbox([], user)).toBeUndefined();
  });
});

it('gives the configured account default priority over temporary switching and falls back when access disappears', () => {
  const own = {
    id: 'own',
    address: 'member@example.com',
    status: 'active',
    ownerUserId: 'user',
  } as MailboxListItem;
  const shared = {
    id: 'shared',
    address: 'team@example.com',
    status: 'active',
    ownerUserId: 'other',
  } as MailboxListItem;
  const user = { userId: 'user', email: 'member@example.com' };
  rememberMailbox(user.userId, own.id);
  expect(selectDefaultMailbox([own, shared], user, shared.id)?.id).toBe(shared.id);
  expect(selectDefaultMailbox([own], user, shared.id)?.id).toBe(own.id);
  rememberMailbox(user.userId, shared.id);
  expect(selectDefaultMailbox([own, shared], user, null)?.id).toBe(own.id);
});
