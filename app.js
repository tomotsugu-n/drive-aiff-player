const statusEl = document.getElementById("status");
const detailsEl = document.getElementById("details");
const filenameEl = document.getElementById("filename");
const installButton = document.getElementById("installButton");
const authButton = document.getElementById("authButton");
const player = document.getElementById("player");

let driveState = null;
let tokenClient = null;
let currentObjectUrl = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setDetails(value) {
  detailsEl.textContent = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
}

function getDriveStateOrNull() {
  const params = new URLSearchParams(location.search);
  const raw = params.get("state");
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  if (parsed.action !== "open") {
    throw new Error(`未対応のactionです: ${parsed.action || "(なし)"}`);
  }
  if (!Array.isArray(parsed.ids) || parsed.ids.length === 0) {
    throw new Error("開くファイルIDが渡されていません。");
  }
  return parsed;
}

function initGoogleAuth() {
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initGoogleAuth, 100);
    return;
  }

  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes("PASTE_WEB")) {
    setStatus("config.js に Web OAuth Client ID を設定してください。");
    installButton.disabled = true;
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.install"
    ].join(" "),
    callback: async (response) => {
      if (response.error) {
        setStatus(`Google認証エラー: ${response.error}`);
        return;
      }

      installButton.hidden = true;
      authButton.hidden = true;

      if (driveState) {
        await openFromDrive(response.access_token);
      } else {
        setStatus(
          "Google Driveへのインストール権限を許可しました。\n" +
          "Driveを再読み込みして、AIFFを右クリック →「アプリで開く」を確認してください。"
        );
      }
    },
    error_callback: (e) => {
      console.error(e);
      setStatus("Google認証ウィンドウを開けませんでした。");
    }
  });

  installButton.onclick = () => {
    setStatus("Google Driveへのインストール権限を確認しています…");
    tokenClient.requestAccessToken({ prompt: "consent" });
  };

  authButton.onclick = () => {
    setStatus("Google Driveへのアクセスを確認しています…");
    tokenClient.requestAccessToken({ prompt: "" });
  };

  if (driveState) {
    installButton.hidden = true;
    authButton.hidden = false;
    setStatus("Google DriveからAIFFを受け取りました。アクセスを確認しています…");
    tokenClient.requestAccessToken({ prompt: "" });
  }
}

async function openFromDrive(accessToken) {
  const fileId = driveState.ids[0];
  const resourceKey = driveState.resourceKeys?.[fileId];

  const headers = { Authorization: `Bearer ${accessToken}` };
  if (resourceKey) {
    headers["X-Goog-Drive-Resource-Keys"] = `${fileId}/${resourceKey}`;
  }

  try {
    setStatus("ファイル情報を取得しています…");

    const metaUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    metaUrl.searchParams.set("fields", "id,name,mimeType,size,capabilities/canDownload");
    metaUrl.searchParams.set("supportsAllDrives", "true");

    const metaRes = await fetch(metaUrl, { headers });
    if (!metaRes.ok) throw new Error(await apiError(metaRes, "メタデータ取得"));
    const meta = await metaRes.json();

    filenameEl.textContent = meta.name || "AIFF";
    setDetails({ driveState, file: meta });

    if (meta.capabilities?.canDownload === false) {
      throw new Error("このファイルにはダウンロード権限がありません。");
    }

    setStatus("AIFFをGoogle Driveから読み込んでいます…");

    const mediaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers }
    );
    if (!mediaRes.ok) throw new Error(await apiError(mediaRes, "ファイル取得"));

    const aiff = await mediaRes.arrayBuffer();

    setStatus("AIFFをブラウザ再生用に展開しています…");
    const wav = aiffToWavBlob(aiff);

    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(wav);
    player.src = currentObjectUrl;
    player.hidden = false;

    try {
      await player.play();
      setStatus("再生中");
    } catch {
      setStatus("読み込み完了。▶︎ を押すと再生します。");
    }
  } catch (e) {
    console.error(e);
    setStatus(`エラー:\n${e.message || e}`);
    authButton.hidden = false;
    authButton.textContent = "もう一度Google Driveへ接続";
  }
}

async function apiError(res, label) {
  let body = "";
  try { body = await res.text(); } catch {}
  return `${label}エラー (${res.status})${body ? `\n${body}` : ""}`;
}

function fourCC(v, o) {
  return String.fromCharCode(
    v.getUint8(o), v.getUint8(o + 1),
    v.getUint8(o + 2), v.getUint8(o + 3)
  );
}

function readExtended80(v, offset) {
  const raw = v.getUint16(offset, false);
  const sign = (raw & 0x8000) ? -1 : 1;
  const exponent = raw & 0x7fff;
  const hi = v.getUint32(offset + 2, false);
  const lo = v.getUint32(offset + 6, false);

  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  if (exponent === 0x7fff) return Infinity;

  const mantissa = hi * Math.pow(2, -31) + lo * Math.pow(2, -63);
  return sign * mantissa * Math.pow(2, exponent - 16383);
}

function writeAscii(v, offset, s) {
  for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
}

function aiffToWavBlob(buffer) {
  const v = new DataView(buffer);

  if (v.byteLength < 12 || fourCC(v, 0) !== "FORM") {
    throw new Error("AIFFファイルとして認識できません。");
  }

  const formType = fourCC(v, 8);
  if (formType === "AIFC") {
    throw new Error("AIFC（圧縮AIFF）はこの最小版では未対応です。");
  }
  if (formType !== "AIFF") {
    throw new Error(`未対応のFORMタイプです: ${formType}`);
  }

  let comm = null;
  let ssnd = null;
  let p = 12;

  while (p + 8 <= v.byteLength) {
    const id = fourCC(v, p);
    const size = v.getUint32(p + 4, false);
    const start = p + 8;

    if (id === "COMM" && size >= 18) {
      comm = {
        channels: v.getUint16(start, false),
        frames: v.getUint32(start + 2, false),
        bits: v.getUint16(start + 6, false),
        sampleRate: Math.round(readExtended80(v, start + 8))
      };
    } else if (id === "SSND" && size >= 8) {
      const offset = v.getUint32(start, false);
      ssnd = {
        start: start + 8 + offset,
        size: Math.max(0, size - 8 - offset)
      };
    }

    p = start + size + (size & 1);
  }

  if (!comm || !ssnd) throw new Error("AIFFのCOMM/SSNDチャンクを見つけられません。");
  if (![8, 16, 24, 32].includes(comm.bits)) {
    throw new Error(`${comm.bits}-bit PCM AIFFは未対応です。`);
  }

  const bytesPerSample = comm.bits / 8;
  const blockAlign = comm.channels * bytesPerSample;
  const framesAvailable = Math.floor(ssnd.size / blockAlign);
  const frameCount = Math.min(comm.frames, framesAvailable);
  const dataSize = frameCount * blockAlign;

  if (frameCount <= 0) throw new Error("音声サンプルがありません。");

  const out = new ArrayBuffer(44 + dataSize);
  const w = new DataView(out);

  writeAscii(w, 0, "RIFF");
  w.setUint32(4, 36 + dataSize, true);
  writeAscii(w, 8, "WAVE");
  writeAscii(w, 12, "fmt ");
  w.setUint32(16, 16, true);
  w.setUint16(20, 1, true);
  w.setUint16(22, comm.channels, true);
  w.setUint32(24, comm.sampleRate, true);
  w.setUint32(28, comm.sampleRate * blockAlign, true);
  w.setUint16(32, blockAlign, true);
  w.setUint16(34, comm.bits, true);
  writeAscii(w, 36, "data");
  w.setUint32(40, dataSize, true);

  let src = ssnd.start;
  let dst = 44;
  const sampleCount = frameCount * comm.channels;

  for (let i = 0; i < sampleCount; i++) {
    if (comm.bits === 8) {
      w.setUint8(dst, v.getInt8(src) + 128);
    } else {
      for (let b = 0; b < bytesPerSample; b++) {
        w.setUint8(dst + b, v.getUint8(src + bytesPerSample - 1 - b));
      }
    }
    src += bytesPerSample;
    dst += bytesPerSample;
  }

  return new Blob([out], { type: "audio/wav" });
}

try {
  driveState = getDriveStateOrNull();
  setDetails(driveState || { mode: "install" });

  if (driveState) {
    filenameEl.textContent = "Google DriveからAIFFを開いています…";
  }

  initGoogleAuth();
} catch (e) {
  console.error(e);
  filenameEl.textContent = "AIFFを開けませんでした";
  setStatus(`エラー:\n${e.message || e}`);
}
