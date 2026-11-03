// Server-sent-events framing for the provider streams: bytes in, whole events out. The caller owns the size cap.
export interface SseEvent {
  event: string | null;
  data: string;
}

export class SseParser {
  private buf = '';
  private readonly dec = new TextDecoder();

  /** Feed one chunk (any split, including inside a UTF-8 character or a JSON string); returns the events it completed. */
  push(chunk: Uint8Array): SseEvent[] {
    let text = this.buf + this.dec.decode(chunk, { stream: true });
    // A trailing CR may be the first half of a CRLF split across chunks: hold it back.
    const held = text.endsWith('\r') ? '\r' : '';
    if (held) text = text.slice(0, -1);
    text = text.replace(/\r\n?/g, '\n');
    const blocks = text.split('\n\n');
    this.buf = (blocks.pop() ?? '') + held;
    const out: SseEvent[] = [];
    for (const block of blocks) {
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(line[i + 1] === ' ' ? i + 2 : i + 1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (event !== null || data.length > 0) out.push({ event, data: data.join('\n') });
    }
    return out;
  }
}
