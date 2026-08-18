import { describe, expect, it, vi } from "vitest";
import {
  buildWranglerCreateCommand,
  tryCreateIndex,
} from "./vectorize-bootstrap-lib.mjs";

describe("vectorize-bootstrap-lib", () => {
  describe("buildWranglerCreateCommand", () => {
    it("pins dimensions and metric to match bge-base-en-v1.5", () => {
      expect(buildWranglerCreateCommand("unimailbox-messages")).toBe(
        "wrangler vectorize create unimailbox-messages --dimensions 768 --metric cosine",
      );
    });

    it("accepts the preview index name", () => {
      expect(buildWranglerCreateCommand("unimailbox-preview-messages")).toBe(
        "wrangler vectorize create unimailbox-preview-messages --dimensions 768 --metric cosine",
      );
    });
  });

  describe("tryCreateIndex", () => {
    it("returns created=true when wrangler exits cleanly", () => {
      const exec = vi.fn();
      const result = tryCreateIndex({ indexName: "foo", exec });
      expect(result).toEqual({ created: true });
      expect(exec).toHaveBeenCalledWith(
        "wrangler vectorize create foo --dimensions 768 --metric cosine",
        { stdio: "inherit" },
      );
    });

    it("returns created=false when stderr matches 'already exists'", () => {
      const exec = vi.fn(() => {
        const error = new Error("create failed");
        // execSync puts stderr on `error.stderr`; cover both shapes.
        error.stderr = "Error: Index already exists.\n";
        throw error;
      });
      expect(tryCreateIndex({ indexName: "foo", exec })).toEqual({
        created: false,
      });
    });

    it("also recognises 'already exists' when the error surfaces only on .message", () => {
      const exec = vi.fn(() => {
        throw new Error("Index already exists with the specified name");
      });
      expect(tryCreateIndex({ indexName: "foo", exec })).toEqual({
        created: false,
      });
    });

    it("re-throws unrelated failures so CI catches real wrangler errors", () => {
      const exec = vi.fn(() => {
        const error = new Error("Authentication required");
        error.stderr = "Authentication required: provide CLOUDFLARE_API_TOKEN.";
        throw error;
      });
      expect(() => tryCreateIndex({ indexName: "foo", exec })).toThrow(
        /Authentication required/,
      );
    });
  });
});
