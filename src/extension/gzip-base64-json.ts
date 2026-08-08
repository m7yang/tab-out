export async function encodeGzipBase64Text(value: string): Promise<string> {
  const compressed = new Blob([value]).stream().pipeThrough(
    new CompressionStream('gzip')
  )
  return (await new Response(compressed).bytes()).toBase64()
}

async function decodeGzipBase64Text(value: string): Promise<string> {
  const decompressed = new Blob([Uint8Array.fromBase64(value)]).stream().pipeThrough(
    new DecompressionStream('gzip')
  )
  return new Response(decompressed).text()
}

export function encodeGzipBase64Json(value: unknown): Promise<string> {
  return encodeGzipBase64Text(JSON.stringify(value))
}

export async function decodeGzipBase64Json(value: string): Promise<unknown> {
  return JSON.parse(await decodeGzipBase64Text(value))
}
