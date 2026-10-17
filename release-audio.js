const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = new Set(['audio/webm', 'audio/mp4', 'audio/m4a', 'audio/wav', 'audio/mpeg']);

export function validateAudioInput({ audioBase64, mimeType = 'audio/webm', language = 'es' } = {}) {
  const fail = (status, error) => ({ ok: false, status, error });
  if (typeof audioBase64 !== 'string') return fail(400, 'Audio no valido');
  let encoded = audioBase64.trim();
  if (encoded.startsWith('data:')) {
    const match = /^data:([^,]+);base64,([\s\S]*)$/.exec(encoded);
    if (!match) return fail(400, 'Audio no valido');
    encoded = match[2];
    if (match[1].split(';')[0].toLowerCase() !== String(mimeType).split(';')[0].trim().toLowerCase()) {
      return fail(400, 'El formato del audio no coincide');
    }
  }
  if (encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) return fail(413, 'El audio supera el limite de 25MB');
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
    return fail(400, 'Audio no valido');
  }
  const mime = String(mimeType).split(';')[0].trim().toLowerCase();
  if (!MIME_TYPES.has(mime)) return fail(415, 'Formato de audio no compatible');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
    || (encoded.includes('=') && encoded.length % 4 !== 0)) return fail(400, 'Audio no valido');
  if (buffer.length > MAX_AUDIO_BYTES) return fail(413, 'El audio supera el limite de 25MB');
  const normalizedLanguage = typeof language === 'string' ? language.trim().toLowerCase() : '';
  if (!/^[a-z]{2,3}$/.test(normalizedLanguage)) return fail(400, 'Idioma no valido');
  return { ok: true, buffer, mimeType: mime, language: normalizedLanguage };
}

export function parseAudioTranscript(payloadText, contentType = '') {
  let text = payloadText;
  if (contentType.toLowerCase().includes('application/json') || /^[\s]*[\[{]/.test(payloadText)) {
    try { text = JSON.parse(payloadText)?.text; } catch (_) { return null; }
  }
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

// The deadline includes reading the body, not only receiving HTTP headers.
export async function fetchAudioResponse(fetchImpl, url, options, timeoutMs = 85000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const payloadText = await response.text();
    return { response, payloadText };
  } finally { clearTimeout(timer); }
}
