// HTTP error envelope — CAP-001 stub.
// Real envelope shape lands with the platform/errors module and the
// DomainError → status code table in .claude/rules/architecture.md §API conventions.
export interface HttpErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export {};