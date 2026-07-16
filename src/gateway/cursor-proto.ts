import protobuf from 'protobufjs'

// ─────────────────────────────────────────────────────────────────────────────
// Cursor internal-API wire format (reverse-engineered — VALIDATE against a live
// token before relying on it). The endpoint, protobuf field numbers, and the
// checksum algorithm drift between Cursor releases; everything version-sensitive
// is centralized here so it is easy to adjust.
//
// Cursor speaks Connect-RPC over protobuf. A Connect message frame is:
//   [1 byte flags][4 byte big-endian length][payload]
// flags bit 0 (0x01) = payload is gzip-compressed; the trailing frame has
// flags bit 1 (0x02) and a JSON status/trailers payload. We send an
// uncompressed request frame (flags 0x00) and decode response frames the same way.
// ─────────────────────────────────────────────────────────────────────────────

// Minimal request/response schema. Field numbers follow the commonly-documented
// StreamChat shape; adjust here if a Cursor update renumbers them.
const root = protobuf.Root.fromJSON({
  nested: {
    cursor: {
      nested: {
        Message: {
          fields: {
            text: { type: 'string', id: 1 },
            // role: 1 = user, 2 = assistant (Cursor's MessageType enum)
            role: { type: 'int32', id: 2 },
          },
        },
        ChatRequest: {
          fields: {
            messages: { rule: 'repeated', type: 'Message', id: 2 },
            model: { type: 'string', id: 5 },
          },
        },
        ChatResponse: {
          fields: {
            // Streamed text delta. Cursor puts the incremental text in field 1.
            text: { type: 'string', id: 1 },
          },
        },
      },
    },
  },
})

const MessageT = root.lookupType('cursor.Message')
const ChatRequestT = root.lookupType('cursor.ChatRequest')
const ChatResponseT = root.lookupType('cursor.ChatResponse')

export interface CursorChatMessage {
  text: string
  role: 1 | 2
}

// Encode a chat request into a single uncompressed Connect frame.
export function encodeChatRequest(
  model: string,
  messages: CursorChatMessage[],
): Uint8Array {
  const payload = ChatRequestT.encode(
    ChatRequestT.create({ model, messages }),
  ).finish()
  return frame(payload)
}

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = 0x00 // flags: uncompressed message
  new DataView(out.buffer).setUint32(1, payload.length, false) // big-endian length
  out.set(payload, 5)
  return out
}

// Incremental Connect-frame decoder. Feed response bytes; get back decoded text
// deltas as complete frames arrive. Trailer frames (flags & 0x02) are ignored
// for text extraction.
export class CursorFrameDecoder {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged

    const deltas: string[] = []
    while (this.buf.length >= 5) {
      const flags = this.buf[0]
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset + 1,
        4,
      ).getUint32(0, false)
      if (this.buf.length < 5 + len) break // wait for the rest of the frame

      const payload = this.buf.subarray(5, 5 + len)
      this.buf = this.buf.subarray(5 + len)

      const isTrailer = (flags & 0x02) !== 0
      const isGzip = (flags & 0x01) !== 0
      if (isTrailer || isGzip) {
        // Trailers carry JSON status; gzip'd message frames are uncommon for
        // our uncompressed request and are skipped rather than mis-decoded.
        continue
      }
      try {
        const decoded = ChatResponseT.decode(payload) as unknown as {
          text?: string
        }
        if (decoded.text) deltas.push(decoded.text)
      } catch {
        // Non-text control frame — ignore.
      }
    }
    return deltas
  }
}

export { MessageT, ChatResponseT }
