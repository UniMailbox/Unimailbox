export function parseJsonc(src: string): unknown {
  const withoutComments = stripJsoncComments(src);
  let normalized = '';
  let i = 0;

  while (i < withoutComments.length) {
    const ch = withoutComments[i];
    if (ch === '"') {
      normalized += ch;
      i++;
      while (i < withoutComments.length) {
        const c = withoutComments[i];
        if (c === '\\' && i + 1 < withoutComments.length) {
          normalized += c + withoutComments[i + 1];
          i += 2;
          continue;
        }
        normalized += c;
        i++;
        if (c === '"') break;
      }
      continue;
    }

    if (ch === ',') {
      let next = i + 1;
      while (next < withoutComments.length && /\s/.test(withoutComments.charAt(next))) next++;
      const nextChar = withoutComments.charAt(next);
      if (nextChar === '}' || nextChar === ']') {
        i++;
        continue;
      }
    }

    normalized += ch;
    i++;
  }

  return JSON.parse(normalized);
}

// CAP-039 D5: a proper character-based JSONC comment stripper. The
// previous regex-based stripper matched `/*` and `*/` inside JSON
// strings, which broke wrangler configs that legitimately contain
// `"run_worker_first": ["/api/*"]` (block-comment opener inside a
// string) and `"crons": ["*/2 * * * *"]` (block-comment closer inside
// a string). The regex ate everything between them. This walker skips
// comments only outside strings and correctly preserves escape
// sequences in strings.
function stripJsoncComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // String literal — copy verbatim, honouring escapes so the embedded
    // `"` / `\` sequences survive intact.
    if (ch === '"') {
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\' && i + 1 < src.length) {
          out += c + src[i + 1];
          i += 2;
          continue;
        }
        out += c;
        if (c === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment — skip until newline (preserve the newline).
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // Block comment — replace with whitespace so two tokens cannot be
    // silently merged (for example, `5/* gap */0` must not become `50`).
    if (ch === '/' && src[i + 1] === '*') {
      out += ' ';
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i + 1 >= src.length) {
        throw new SyntaxError('Unterminated block comment in JSONC');
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
