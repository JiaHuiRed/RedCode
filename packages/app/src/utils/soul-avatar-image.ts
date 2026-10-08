// 261008 Red 解码前检查真实格式与尺寸；只将有界、重编码的 PNG 写入本地媒体库。
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_PIXELS = 16_000_000
const AVATAR_SIZE = 256
const MAX_OUTPUT_BYTES = 256 * 1024

export type SoulAvatarImageInfo = {
  mime: "image/png" | "image/jpeg" | "image/webp"
  width: number
  height: number
}

const invalidImage = (): never => {
  throw new Error("INVALID_IMAGE")
}

const dimensions = (mime: SoulAvatarImageInfo["mime"], width: number, height: number): SoulAvatarImageInfo => {
  if (!width || !height) invalidImage()
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error("IMAGE_DIMENSIONS_EXCEEDED")
  }
  return { mime, width, height }
}

const u16be = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1]
const u24le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
const u16le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8)

const png = (bytes: Uint8Array): SoulAvatarImageInfo => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return invalidImage()
  const width = bytes[16] * 0x1000000 + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19]
  const height = bytes[20] * 0x1000000 + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23]
  return dimensions("image/png", width, height)
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

const jpeg = (bytes: Uint8Array): SoulAvatarImageInfo => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalidImage()
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return invalidImage()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return invalidImage()
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return invalidImage()
    const length = u16be(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return invalidImage()
    if (JPEG_SOF.has(marker)) {
      if (length < 8 || length < 8 + 3 * bytes[offset + 7]) return invalidImage()
      return dimensions("image/jpeg", u16be(bytes, offset + 5), u16be(bytes, offset + 3))
    }
    offset += length
  }
  return invalidImage()
}

const webp = (bytes: Uint8Array): SoulAvatarImageInfo => {
  const riff = [0x52, 0x49, 0x46, 0x46]
  const format = [0x57, 0x45, 0x42, 0x50]
  if (
    bytes.length < 12 ||
    riff.some((value, index) => bytes[index] !== value) ||
    format.some((value, index) => bytes[index + 8] !== value)
  ) return invalidImage()
  const riffSize = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0
  if (riffSize + 8 > bytes.length) return invalidImage()
  let offset = 12
  while (offset + 8 <= Math.min(bytes.length, riffSize + 8)) {
    const size = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0
    const data = offset + 8
    if (data + size > bytes.length || data + size > riffSize + 8) return invalidImage()
    if (bytes[offset] === 0x56 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x38) {
      const type = bytes[offset + 3]
      if (type === 0x58) {
        if (size < 10) return invalidImage()
        return dimensions("image/webp", 1 + u24le(bytes, data + 4), 1 + u24le(bytes, data + 7))
      }
      if (type === 0x4c) {
        if (size < 5 || bytes[data] !== 0x2f) return invalidImage()
        return dimensions(
          "image/webp",
          1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
          1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10),
        )
      }
      if (type === 0x20) {
        if (size < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return invalidImage()
        return dimensions("image/webp", u16le(bytes, data + 6) & 0x3fff, u16le(bytes, data + 8) & 0x3fff)
      }
    }
    offset = data + size + (size & 1)
  }
  return invalidImage()
}

export const inspectSoulAvatar = (bytes: Uint8Array): SoulAvatarImageInfo => {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("IMAGE_FILE_TOO_LARGE")
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return png(bytes)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes)
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return webp(bytes)
  return invalidImage()
}

const decodeImage = async (file: File): Promise<{ image: CanvasImageSource; width: number; height: number; release: () => void }> => {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file)
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
  }
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("IMAGE_PROCESSING_UNAVAILABLE")
  }
  const url = URL.createObjectURL(file)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("IMAGE_DECODE_FAILED"))
    }
    element.src = url
  })
  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  }
}

export const prepareSoulAvatar = async (file: File): Promise<string> => {
  if (file.size > MAX_FILE_BYTES) throw new Error("IMAGE_FILE_TOO_LARGE")
  const info = inspectSoulAvatar(new Uint8Array(await file.arrayBuffer()))
  const decoded = await decodeImage(file)
  try {
    dimensions(info.mime, decoded.width, decoded.height)
    // 261008 Red JPEG EXIF 方向可交换宽高，仍分别检查解码前后的硬上限。
    if (
      (decoded.width !== info.width || decoded.height !== info.height) &&
      (decoded.width !== info.height || decoded.height !== info.width)
    ) throw new Error("INVALID_IMAGE")
    const canvas = document.createElement("canvas")
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const context = canvas.getContext("2d")
    if (!context) throw new Error("IMAGE_PROCESSING_UNAVAILABLE")
    const side = Math.min(decoded.width, decoded.height)
    context.drawImage(decoded.image, (decoded.width - side) / 2, (decoded.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("IMAGE_PROCESSING_FAILED"))), "image/png")
    })
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("IMAGE_PROCESSING_FAILED")))
      reader.onerror = () => reject(new Error("IMAGE_PROCESSING_FAILED"))
      reader.readAsDataURL(blob)
    })
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("IMAGE_PROCESSING_FAILED")
    if (dataUrl.length > MAX_OUTPUT_BYTES) throw new Error("IMAGE_OUTPUT_TOO_LARGE")
    return dataUrl
  } finally {
    decoded.release()
  }
}
