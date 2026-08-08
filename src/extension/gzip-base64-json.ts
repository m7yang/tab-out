function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 32_768
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + chunkSize)))
  }
  return btoa(chunks.join(''))
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function encodeGzipBase64Text(value: string): Promise<string> {
  const compressed = new Blob([value]).stream().pipeThrough(
    new CompressionStream('gzip')
  )
  return bytesToBase64(
    new Uint8Array(await new Response(compressed).arrayBuffer())
  )
}

async function decodeGzipBase64Text(value: string): Promise<string> {
  const compressed = bytesFromBase64(value)
  const bytes = new Uint8Array(compressed.length)
  bytes.set(compressed)
  const decompressed = new Blob([bytes]).stream().pipeThrough(
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
