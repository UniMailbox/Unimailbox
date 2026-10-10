// parse-json-body.test.ts — unit tests for parseJsonBody.
// Covers AC1-AC4 from CAP-031's acceptance criteria.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { parseJsonBody } from './parse-json-body';
import { DomainError } from '../../platform/errors';
import { logger } from '../../platform/logger';

// Small schema used by every test below. Keeps the helper boundary sharp
// without coupling to a real route schema.
const schema = z.object({ good: z.boolean() });

describe('parseJsonBody', () => {
  describe('R-INPUT-002 / AC1', () => {
    it('throws DomainError(INVALID_JSON, 400) when the body is not valid JSON', () => {
      expect(() =>
        parseJsonBody('not valid json', schema, {
          event: 'unit.invalid_json',
          actorUserId: 'user-1',
        }),
      ).toThrow(DomainError);

      try {
        parseJsonBody('not valid json', schema, {
          event: 'unit.invalid_json',
          actorUserId: 'user-1',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        const domainErr = err as DomainError;
        expect(domainErr.code).toBe('INVALID_JSON');
        expect(domainErr.httpStatus).toBe(400);
      }
    });
  });

  describe('R-LOG-001 / AC2', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs at warn with { event, actorUserId } and no body field on malformed JSON', () => {
      expect(() =>
        parseJsonBody('not valid json', schema, {
          event: 'unit.invalid_json',
          actorUserId: 'user-42',
        }),
      ).toThrow(DomainError);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [fields] = warnSpy.mock.calls[0] ?? [];
      expect(fields).toMatchObject({
        event: 'unit.invalid_json',
        actorUserId: 'user-42',
      });
      // R-LOG-001: the body bytes MUST NOT appear anywhere in the log fields.
      const serialised = JSON.stringify(fields);
      expect(serialised).not.toContain('not valid json');
      expect(serialised).not.toContain('body');
      expect(serialised).not.toContain('rawBody');
    });

    it('still logs at warn when actorUserId is omitted', () => {
      expect(() =>
        parseJsonBody('not valid json', schema, {
          event: 'unit.invalid_json',
        }),
      ).toThrow(DomainError);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [fields] = warnSpy.mock.calls[0] ?? [];
      expect(fields).toMatchObject({ event: 'unit.invalid_json' });
    });
  });

  describe('R-INPUT-003 / AC3', () => {
    it('re-throws ZodError unchanged when JSON parses but schema fails', () => {
      const caught = (() => {
        try {
          parseJsonBody('{"badField": "x"}', schema, {
            event: 'unit.invalid_json',
            actorUserId: 'user-1',
          });
          return null;
        } catch (e) {
          return e;
        }
      })();

      expect(caught).not.toBeNull();
      // ZodError is a real ZodError, not a DomainError — the existing
      // error middleware will map it to 400 VALIDATION_ERROR.
      expect(caught).toBeInstanceOf(z.ZodError);
      expect(caught).not.toBeInstanceOf(DomainError);
    });
  });

  describe('AC4', () => {
    it('returns the parsed-and-validated object on a happy path', () => {
      const result = parseJsonBody('{"good": true}', schema, {
        event: 'unit.invalid_json',
        actorUserId: 'user-1',
      });
      expect(result).toEqual({ good: true });
    });
  });
});
