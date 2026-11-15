// File extensions and browser MIME types can both lie after renaming a phone photo.
export function photoFormat(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'png';
  const text = offset => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (bytes.length < 16 || text(4) !== 'ftyp') return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const brands = [text(8)];
  for (let offset = 16; offset + 4 <= Math.min(size, bytes.length); offset += 4) brands.push(text(offset));
  // AVIF can also advertise mif1; let the browser handle its AV1 image.
  if (brands.some(brand => ['avif', 'avis'].includes(brand))) return null;
  return brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) ? 'heic' : null;
}

let heicDecoder;
async function convertHEIC(blob) {
  // A separate local worker keeps conversion off the UI thread; no photo is sent out.
  heicDecoder ||= import('../vendor/heic-to/heic-to.js').catch(error => {heicDecoder = null; throw error;});
  return (await heicDecoder).heicTo({blob, type: 'image/jpeg', quality: .92});
}

async function convertBrowserImage(blob) {
  const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
  try {
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
    if (!jpeg) throw new Error('Image encoding failed');
    return jpeg;
  } finally {bitmap.close(); canvas.width = canvas.height = 1;}
}

// Returns an uploadable JPEG/PNG and an already decoded preview URL owned by the caller.
export async function preparePhoto(file, onConvert = () => {}) {
  let format;
  try {
    const buffer = await file.arrayBuffer();
    if (!buffer.byteLength) throw new Error('Empty photo');
    format = photoFormat(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 256)));
    let blob = new Blob([buffer], {type: format ? `image/${format}` : file.type});
    if (format === 'heic') {
      onConvert(); blob = await convertHEIC(blob);
    } else if (!['jpeg', 'png'].includes(format)) {
      if (!file.type.startsWith('image/')) throw new Error('Not a photo');
      blob = await convertBrowserImage(blob);
    }
    const suffix = blob.type === 'image/png' ? 'png' : 'jpg';
    const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
    const photo = new File([blob], `${name}.${suffix}`, {type: blob.type, lastModified: file.lastModified});
    const url = URL.createObjectURL(photo), image = new Image();
    try {
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty image');
      return {file: photo, url};
    } catch (error) {URL.revokeObjectURL(url); throw error;}
  } catch {
    throw new Error(format === 'heic'
      ? `“${file.name}”的 HEIC 照片转换失败，请在“预览”中导出为 JPEG 或 PNG 后重试（只改后缀无效）。`
      : `无法读取“${file.name}”，请确认照片已下载到本机且未损坏；更改后缀不会转换图片格式。`);
  }
}
