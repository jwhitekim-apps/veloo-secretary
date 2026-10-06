// 입력 페이지(capture.html)가 쓰는 순수 로직. 브라우저와 노드 테스트에서 모두 실행되므로 DOM은 모르고,
// 네트워크와 저장소는 인자로 받는다. 서버가 받는 형식은 docs/shortcut.md의 요청 형식과 같다.

export const MAX_WIDTH = 1600;
export const JPEG_QUALITY = 0.85;
export const INTAKE_URL = '/api/intake?async=1&format=text';
const SECRET_KEY = 'intakeSecret';

// 가로가 max보다 크면 비율을 지켜 줄이고, 작으면 확대하지 않고 그대로 둔다.
export function fitWithin(width, height, max = MAX_WIDTH) {
  if (!(width > 0) || !(height > 0)) throw new Error('invalid image size');
  if (width <= max) return { width: Math.round(width), height: Math.round(height) };
  return { width: max, height: Math.max(1, Math.round((height * max) / width)) };
}

// canvas.toDataURL의 결과("data:image/jpeg;base64,...")에서 base64 부분만 꺼낸다.
export function stripDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

// 서버 계약: { text } 또는 { image, mimeType }. 보낼 것이 없으면 null.
export function buildBody({ text = '', jpegBase64 = '' } = {}) {
  if (jpegBase64) return { image: jpegBase64, mimeType: 'image/jpeg' };
  const trimmed = text.trim();
  return trimmed ? { text: trimmed } : null;
}

// 붙여넣기 항목(DataTransferItem의 kind, type)에서 이미지를 먼저 찾고, 없으면 글인지 본다.
export function classifyPaste(items) {
  const list = Array.from(items ?? []);
  const imageIndex = list.findIndex((i) => i.kind === 'file' && String(i.type).startsWith('image/'));
  if (imageIndex >= 0) return { kind: 'image', index: imageIndex };
  if (list.some((i) => i.kind === 'string' && i.type === 'text/plain')) return { kind: 'text' };
  return { kind: 'none' };
}

// 글을 붙여넣을 때 포커스가 이미 글자를 받는 칸(입력칸, 글상자)에 있으면 브라우저가 알아서 넣게 둔다.
// 그렇지 않을 때만 페이지가 입력창으로 옮겨 준다. 비밀값 입력칸의 붙여넣기를 가로채지 않으려는 구분이다.
export function isTextField(tagName) {
  return /^(INPUT|TEXTAREA)$/i.test(String(tagName ?? ''));
}

// 서버 응답을 화면에 보일 결과로 바꾼다. kind: accepted | unauthorized | error
export function interpretResponse(status, bodyText = '') {
  if (status >= 200 && status < 300) {
    return { kind: 'accepted', message: '접수했습니다. 결과는 카톡으로 갑니다.' };
  }
  const detail = bodyText.trim().slice(0, 120);
  if (status === 401) return { kind: 'unauthorized', message: '인증에 실패했습니다. 비밀값을 다시 입력해 주세요.' };
  if (status === 400) return { kind: 'error', message: `요청이 올바르지 않습니다${detail ? `: ${detail}` : ''}` };
  return { kind: 'error', message: `서버 오류(${status})${detail ? `: ${detail}` : ''}` };
}

export function interpretNetworkError(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return { kind: 'error', message: `전송하지 못했습니다(네트워크): ${reason}` };
}

// 한 번 보내고 결과를 돌려준다. 어떤 실패도 던지지 않고 결과(kind)로 알린다.
export async function sendToIntake(body, secret, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(INTAKE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return interpretNetworkError(error);
  }
  return interpretResponse(response.status, await response.text().catch(() => ''));
}

// 앞의 작업이 끝나기 전에는 새 작업을 시작하지 않는다. 건너뛰면 { skipped: true }를 돌려준다.
export function exclusive(task) {
  let running = false;
  return async (...args) => {
    if (running) return { skipped: true };
    running = true;
    try {
      return { skipped: false, value: await task(...args) };
    } finally {
      running = false;
    }
  };
}

// 비밀값 저장소(localStorage). 시크릿 모드나 정책으로 막혀 있으면 읽기와 쓰기가 던지므로 모두 감싼다.
export function readSecret(storage) {
  try {
    return storage?.getItem(SECRET_KEY) || '';
  } catch {
    return '';
  }
}

export function saveSecret(storage, secret) {
  try {
    storage.setItem(SECRET_KEY, secret);
    return true;
  } catch {
    return false;
  }
}

export function forgetSecret(storage) {
  try {
    storage?.removeItem(SECRET_KEY);
  } catch {
    // 지울 수 없어도 다음 전송에서 서버가 다시 거부하므로 계속 진행한다.
  }
}
