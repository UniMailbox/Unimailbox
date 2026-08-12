// platform/ids — CAP-001 stub.
// ADR-005: all externally visible IDs are UUID v4 strings. Generated via the
// Web Crypto API so domain code is portable to test runners and Workers.
export interface IdGenerator {
  uuid(): string;
}

export const systemIds: IdGenerator = {
  uuid: (): string => crypto.randomUUID(),
};

export {};