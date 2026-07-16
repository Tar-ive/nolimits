// Wire codec for exa.api_server_pb.ApiServerService/GetChatMessage, ported from
// the proven Python codec (scripts/devin_codec.py). Pure protobuf wire + Connect
// streaming framing (5-byte header: 1 flag byte + uint32 BE length; flag&0x01 =
// gzip-compressed, flag&0x02 = end-of-stream JSON trailer). No protobuf runtime.
import zlib from 'node:zlib'

// ---------------------------------------------------------------- wire read
function readVarint(b: Buffer, i: number): [number, number] {
  let shift = 0
  let val = 0
  while (true) {
    const byte = b[i]
    i += 1
    val += (byte & 0x7f) * 2 ** shift // avoid 32-bit bitshift overflow
    if (!(byte & 0x80)) return [val, i]
    shift += 7
  }
}

type Field = { fno: number; wt: number; val: number | Buffer }

export function parse(b: Buffer): Field[] {
  const out: Field[] = []
  let i = 0
  const n = b.length
  while (i < n) {
    let tag: number
    ;[tag, i] = readVarint(b, i)
    const fno = Math.floor(tag / 8)
    const wt = tag & 7
    if (fno === 0) throw new Error('field 0')
    if (wt === 0) {
      let v
      ;[v, i] = readVarint(b, i)
      out.push({ fno, wt, val: v })
    } else if (wt === 1) {
      out.push({ fno, wt, val: b.subarray(i, i + 8) }); i += 8
    } else if (wt === 5) {
      out.push({ fno, wt, val: b.subarray(i, i + 4) }); i += 4
    } else if (wt === 2) {
      let ln
      ;[ln, i] = readVarint(b, i)
      out.push({ fno, wt, val: b.subarray(i, i + ln) }); i += ln
    } else {
      throw new Error(`bad wiretype ${wt} at ${i}`)
    }
  }
  return out
}

const firstBuf = (f: Field[], fno: number): Buffer | null => {
  for (const x of f) if (x.fno === fno && x.wt === 2) return x.val as Buffer
  return null
}
const firstInt = (f: Field[], fno: number): number | null => {
  for (const x of f) if (x.fno === fno && x.wt === 0) return x.val as number
  return null
}
const allBuf = (f: Field[], fno: number): Buffer[] =>
  f.filter((x) => x.fno === fno && x.wt === 2).map((x) => x.val as Buffer)

// ---------------------------------------------------------------- wire write
function varint(n: number): Buffer {
  const out: number[] = []
  while (true) {
    let b = n % 128
    n = Math.floor(n / 128)
    out.push(b | (n ? 0x80 : 0))
    if (!n) return Buffer.from(out)
  }
}
const tag = (fno: number, wt: number) => varint(fno * 8 + wt)
const fVarint = (fno: number, n: number) => Buffer.concat([tag(fno, 0), varint(n)])
function fString(fno: number, s: string | Buffer): Buffer {
  const data = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf-8')
  return Buffer.concat([tag(fno, 2), varint(data.length), data])
}
const fMsg = (fno: number, payload: Buffer) =>
  Buffer.concat([tag(fno, 2), varint(payload.length), payload])

// ---------------------------------------------------------------- Connect framing
function decompress(b: Buffer): Buffer {
  if (b[0] === 0x1f && b[1] === 0x8b) return zlib.gunzipSync(b)
  try {
    return zlib.inflateSync(b)
  } catch {
    return b
  }
}

export function deframe(raw: Buffer, streaming = true): Buffer[] {
  if (!streaming) return [raw]
  const frames: Buffer[] = []
  let i = 0
  while (i + 5 <= raw.length) {
    const flag = raw[i]
    const ln = raw.readUInt32BE(i + 1)
    let payload = raw.subarray(i + 5, i + 5 + ln)
    i += 5 + ln
    if (flag & 0x02) continue // end-of-stream trailer
    if (flag & 0x01) payload = decompress(payload)
    frames.push(payload)
  }
  return frames
}

function frame(payload: Buffer, end = false): Buffer {
  const header = Buffer.alloc(5)
  header[0] = end ? 0x02 : 0x00
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}
const trailer = (json = '{}') => frame(Buffer.from(json, 'utf-8'), true)

// ---------------------------------------------------------------- request decode
// ChatMessageSource: the proto enum labels 2=SYSTEM, but EMPIRICALLY (both CLI and
// IDE) source=2 is the ASSISTANT turn (carries tool_calls + model text). 1=user,
// 4=tool result, 3/5=system. Trust the observed usage, not the enum label.
const ROLE: Record<number, string> = { 1: 'user', 2: 'assistant', 4: 'tool', 3: 'system', 5: 'system' }

export interface DevinMessage { role: string; content: string; toolCallId?: string }
export interface DevinTool { name: string; description: string; schema: string }
export interface DevinRequest {
  model: string
  system: string
  messages: DevinMessage[]
  tools: DevinTool[]
}

export function decodeRequest(pb: Buffer): DevinRequest {
  const f = parse(pb)
  const messages: DevinMessage[] = []
  for (const m of allBuf(f, 3)) {
    const mf = parse(m)
    const role = firstInt(mf, 2) ?? 1
    // assistant turns have no source==assistant enum; they carry tool_calls(6)
    // and empty/absent tool_call_id — treat source 3/unknown as assistant.
    messages.push({
      role: ROLE[role] ?? 'user',
      content: (firstBuf(mf, 3) ?? Buffer.alloc(0)).toString('utf-8'),
      toolCallId: firstBuf(mf, 7)?.toString('utf-8'),
    })
  }
  const tools: DevinTool[] = allBuf(f, 10).map((t) => {
    const tf = parse(t)
    return {
      name: (firstBuf(tf, 1) ?? Buffer.alloc(0)).toString('utf-8'),
      description: (firstBuf(tf, 2) ?? Buffer.alloc(0)).toString('utf-8'),
      schema: (firstBuf(tf, 3) ?? Buffer.alloc(0)).toString('utf-8'),
    }
  })
  return {
    model: (firstBuf(f, 21) ?? Buffer.alloc(0)).toString('utf-8'),
    system: (firstBuf(f, 2) ?? Buffer.alloc(0)).toString('utf-8'),
    messages,
    tools,
  }
}

// ---------------------------------------------------------------- response encode
// GetChatMessageResponse: message_id=1, timestamp=2, delta_text=3, stop_reason=5,
// delta_tool_calls=6 (repeated ChatToolCall{id=1,name=2,arguments_json=3}),
// delta_thinking=9, request_id=17.
export interface UpstreamResult {
  reasoning: string
  content: string
  toolCalls: { id: string; name: string; args: string }[]
  ok: boolean
}

function envelope(messageId: string, tsSec: number): Buffer {
  const ts = Buffer.concat([fVarint(1, tsSec), fVarint(2, 0)])
  return Buffer.concat([fString(1, messageId), fMsg(2, ts)])
}

export function buildResponseStream(messageId: string, tsSec: number, r: UpstreamResult): Buffer {
  const out: Buffer[] = []
  if (r.reasoning) {
    out.push(frame(Buffer.concat([envelope(messageId, tsSec), fString(9, r.reasoning)])))
  }
  if (r.content) {
    out.push(frame(Buffer.concat([envelope(messageId, tsSec), fString(3, r.content)])))
  }
  for (const tc of r.toolCalls) {
    const call = Buffer.concat([fString(1, tc.id), fString(2, tc.name), fString(3, tc.args)])
    out.push(frame(Buffer.concat([envelope(messageId, tsSec), fMsg(6, call)])))
  }
  // stop_reason: 10 = FUNCTION_CALL if tool calls, else 1 = STOP
  const stop = r.toolCalls.length ? 10 : 1
  out.push(frame(Buffer.concat([envelope(messageId, tsSec), fVarint(5, stop)])))
  out.push(
    trailer(r.ok ? '{}' : '{"error":{"code":"internal","message":"gateway error"}}'),
  )
  return Buffer.concat(out)
}
