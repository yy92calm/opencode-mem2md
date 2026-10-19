/**
 * Lightweight client-side classification — heavyweight semantic analysis
 * (titles, narratives, profiles) is now done server-side by the Worker.
 *
 * Client only decides:
 *   - is this worth uploading at all? (trivial filter)
 */

export function isTrivial(tool: string, input: unknown, response: string): boolean {
  if (!response || response.trim().length < 50) return true;

  const inputStr = JSON.stringify(input || {});
  if (tool === 'read' && inputStr.length < 100) return true;

  if (tool === 'bash') {
    const cmd = String((input as any)?.command || '').toLowerCase().trim();
    // skip pure inspection commands
    if (/^(ls|cat|echo|pwd|whoami|date|which|type)\b/.test(cmd)) return true;
  }

  return false;
}

/**
 * Best-effort string conversion of any tool input/output for upload.
 * Truncates large payloads to keep raw_conversations table lean.
 */
export function safeStringify(value: unknown, maxLen = 4000): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, maxLen);
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? s.slice(0, maxLen) + '…[truncated]' : s;
  } catch {
    return String(value).slice(0, maxLen);
  }
}

/**
 * OpenCode V2 tool results carry `content` as a string or a list of content
 * parts ({type:'text'} | {type:'file'}). Flatten to a single string for the
 * trivial filter and upload.
 */
export function toolContentToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return safeStringify(content);
  return content
    .map((part: any) => {
      if (part == null) return '';
      if (typeof part === 'string') return part;
      if (part.type === 'text') return String(part.text ?? '');
      if (part.type === 'file') return `[file: ${part.uri ?? ''}]`;
      return safeStringify(part, 500);
    })
    .filter(Boolean)
    .join('\n');
}
