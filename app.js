(() => {
  "use strict";

  // Drive UI integration requires drive.install so the app can appear
  // in Drive's "Open with" / "New" menus.
  // drive.readonly is required to read and download the selected file.
  const DRIVE_SCOPE = [
    "https://www.googleapis.com/auth/drive.install",
    "https://www.googleapis.com/auth/drive.readonly"
  ].join(" ");

  const el = {
    filename: document.getElementById("filename"),
    metadata: document.getElementById("metadata"),
    seek: document.getElementById("seek"),
    elapsed: document.getElementById("elapsed"),
    total: document.getElementById("total"),
    remaining: document.getElementById("remaining"),
    play: document.getElementById("play"),
    restart: document.getElementById("restart"),
    back15: document.getElementById("back15"),
    forward15: document.getElementById("forward15"),
    mute: document.getElementById("mute"),
    volume: document.getElementById("volume"),
    status: document.getElementById("status"),
    audio: document.getElementById("audio")
  };

  let driveState = null;
  let tokenClient = null;
  let objectUrl = null;
  let fileLoaded = false;
  let authReady = false;
  let lastVolume = Number(el.volume.value) || 0.8;

  function setStatus(message, error = false) {
    el.status.textContent = message;
    el.status.classList.toggle("error", error);
  }

  function parseDriveState() {
    const raw = new URLSearchParams(window.location.search).get("state");
    if (!raw) return null;

    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new Error("Google Drive™ から渡されたファイル情報を読み取れません。");
    }

    if (
      state.action !== "open" ||
      !Array.isArray(state.ids) ||
      state.ids.length === 0
    ) {
      throw new Error("Google Drive™ からAIFFファイルが渡されていません。");
    }

    return state;
  }

  function initAuthWhenLibraryReady() {
    if (!window.google?.accounts?.oauth2) {
      window.setTimeout(initAuthWhenLibraryReady, 100);
      return;
    }

    if (
      typeof GOOGLE_CLIENT_ID !== "string" ||
      !GOOGLE_CLIENT_ID ||
      GOOGLE_CLIENT_ID.includes("PASTE_")
    ) {
      setStatus("OAuth Client ID が設定されていません。", true);
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,

      callback: async (response) => {
        if (response.error) {
          setStatus(`Google認証エラー: ${response.error}`, true);
          return;
        }

        try {
          await loadSelectedDriveFile(response.access_token);
        } catch (error) {
          console.error(error);
          setStatus(error?.message || String(error), true);
        }
      },

      error_callback: (error) => {
        console.error("Google Identity Services:", error);

        const type = error?.type || "";
        if (type === "popup_failed_to_open") {
          setStatus(
            "Google認証ウィンドウを開けませんでした。ポップアップ許可を確認してください。",
            true
          );
        } else if (type === "popup_closed") {
          setStatus("Google認証がキャンセルされました。", true);
        } else {
          setStatus("Google認証を開始できませんでした。", true);
        }
      }
    });

    authReady = true;

    if (driveState && !fileLoaded) {
      setStatus("▶ を押すとAIFFを読み込みます。");
    }
  }

  async function loadSelectedDriveFile(accessToken) {
    const fileId = driveState.ids[0];
    const resourceKey = driveState.resourceKeys?.[fileId];

    const headers = {
      Authorization: `Bearer ${accessToken}`
    };

    if (resourceKey) {
      headers["X-Goog-Drive-Resource-Keys"] = `${fileId}/${resourceKey}`;
    }

    setStatus("Google Drive™ からAIFFを読み込んでいます…");

    const metadataUrl = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
    );
    metadataUrl.searchParams.set("fields", "id,name,mimeType,size");
    metadataUrl.searchParams.set("supportsAllDrives", "true");

    const metadataResponse = await fetch(metadataUrl, { headers });

    if (!metadataResponse.ok) {
      throw await driveApiError(metadataResponse, "ファイル情報の取得");
    }

    const metadata = await metadataResponse.json();

    if (
      metadata.mimeType &&
      metadata.mimeType !== "audio/aiff" &&
      metadata.mimeType !== "audio/x-aiff" &&
      metadata.mimeType !== "application/octet-stream"
    ) {
      throw new Error(`AIFFではないファイルです (${metadata.mimeType})。`);
    }

    el.filename.textContent = metadata.name || "AIFF";

    const mediaUrl =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
      "?alt=media&supportsAllDrives=true";

    const mediaResponse = await fetch(mediaUrl, { headers });

    if (!mediaResponse.ok) {
      throw await driveApiError(mediaResponse, "AIFFファイルの取得");
    }

    const aiffBuffer = await mediaResponse.arrayBuffer();

    const info = readAiffInfo(aiffBuffer);
    el.metadata.textContent = formatAiffInfo(info);

    const wavBlob = aiffToWavBlob(aiffBuffer);

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

    objectUrl = URL.createObjectURL(wavBlob);
    el.audio.src = objectUrl;
    el.audio.volume = Number(el.volume.value);
    fileLoaded = true;

    enablePlaybackControls();
    setStatus("読み込み完了。");

    try {
      await el.audio.play();
    } catch {
      setStatus("読み込み完了。▶ を押すと再生します。");
    }
  }

  async function driveApiError(response, label) {
    let details = "";

    try {
      const data = await response.json();
      details =
        data?.error?.message ||
        data?.error?.errors?.[0]?.message ||
        "";
    } catch {
      try {
        details = await response.text();
      } catch {}
    }

    const suffix = details ? `: ${details}` : "";
    return new Error(`${label}に失敗しました (${response.status})${suffix}`);
  }

  function enablePlaybackControls() {
    el.seek.disabled = false;
    el.restart.disabled = false;
    el.back15.disabled = false;
    el.forward15.disabled = false;
    el.mute.disabled = false;
    el.volume.disabled = false;
  }

  function formatAiffInfo(info) {
    const parts = ["AIFF"];

    if (info.sampleRate) {
      const kHz = info.sampleRate / 1000;
      parts.push(
        `${Number.isInteger(kHz) ? kHz.toFixed(0) : kHz.toFixed(1)} kHz`
      );
    }

    if (info.bits) {
      parts.push(`${info.bits}-bit`);
    }

    if (info.channels === 1) {
      parts.push("Mono");
    } else if (info.channels === 2) {
      parts.push("Stereo");
    } else if (info.channels > 2) {
      parts.push(`${info.channels} ch`);
    }

    return parts.join("  |  ");
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function updateRangeVisual(range) {
    const min = Number(range.min) || 0;
    const max = Number(range.max) || 1;
    const value = Number(range.value) || 0;
    const percentage = ((value - min) / (max - min)) * 100;

    range.style.setProperty("--progress", `${percentage}%`);
  }

  function updateTimeDisplay() {
    const duration = el.audio.duration;
    const current = el.audio.currentTime;

    el.elapsed.textContent = formatTime(current);
    el.total.textContent = formatTime(duration);

    if (Number.isFinite(duration)) {
      el.remaining.textContent = `-${formatTime(Math.max(0, duration - current))}`;

      if (!el.seek.matches(":active")) {
        el.seek.value = String(
          Math.round((current / Math.max(duration, 0.001)) * 1000)
        );
        updateRangeVisual(el.seek);
      }
    }
  }

  el.play.addEventListener("click", async () => {
    if (!driveState) {
      setStatus(
        "Google Drive™ でAIFFを右クリック →「アプリで開く」から起動してください。",
        true
      );
      return;
    }

    if (!fileLoaded) {
      if (!authReady || !tokenClient) {
        setStatus(
          "Google認証の準備中です。少し待ってからもう一度押してください。"
        );
        return;
      }

      setStatus("Google Drive™ に接続しています…");

      tokenClient.requestAccessToken({ prompt: "" });
      return;
    }

    if (el.audio.paused) {
      try {
        await el.audio.play();
      } catch (error) {
        console.error(error);
        setStatus(
          "再生を開始できませんでした。もう一度▶を押してください。",
          true
        );
      }
    } else {
      el.audio.pause();
    }
  });

  el.restart.addEventListener("click", () => {
    el.audio.currentTime = 0;
  });

  el.back15.addEventListener("click", () => {
    el.audio.currentTime = Math.max(0, el.audio.currentTime - 15);
  });

  el.forward15.addEventListener("click", () => {
    if (!Number.isFinite(el.audio.duration)) return;

    el.audio.currentTime = Math.min(
      el.audio.duration,
      el.audio.currentTime + 15
    );
  });

  el.seek.addEventListener("input", () => {
    if (!Number.isFinite(el.audio.duration)) return;

    const ratio = Number(el.seek.value) / 1000;
    el.audio.currentTime = ratio * el.audio.duration;
    updateRangeVisual(el.seek);
  });

  el.volume.addEventListener("input", () => {
    const value = Number(el.volume.value);

    el.audio.volume = value;
    el.audio.muted = value === 0;

    if (value > 0) {
      lastVolume = value;
    }

    el.mute.textContent = value === 0 ? "MUTE" : "VOL";
    updateRangeVisual(el.volume);
  });

  el.mute.addEventListener("click", () => {
    if (el.audio.muted || el.audio.volume === 0) {
      el.audio.muted = false;
      el.audio.volume = lastVolume || 0.8;
      el.volume.value = String(el.audio.volume);
      el.mute.textContent = "VOL";
    } else {
      lastVolume = el.audio.volume;
      el.audio.muted = true;
      el.volume.value = "0";
      el.mute.textContent = "MUTE";
    }

    updateRangeVisual(el.volume);
  });

  el.audio.addEventListener("loadedmetadata", updateTimeDisplay);
  el.audio.addEventListener("timeupdate", updateTimeDisplay);

  el.audio.addEventListener("play", () => {
    el.play.classList.add("is-playing");
    el.play.setAttribute("aria-label", "一時停止");
  });

  el.audio.addEventListener("pause", () => {
    el.play.classList.remove("is-playing");
    el.play.setAttribute("aria-label", "再生");
  });

  el.audio.addEventListener("ended", () => {
    el.play.classList.remove("is-playing");
  });

  window.addEventListener("beforeunload", () => {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  });

  updateRangeVisual(el.seek);
  updateRangeVisual(el.volume);

  try {
    driveState = parseDriveState();

    if (!driveState) {
      setStatus(
        "Google Drive™ でAIFFを右クリック →「アプリで開く」から起動してください。"
      );
    } else {
      setStatus("認証を準備しています…");
      initAuthWhenLibraryReady();
    }
  } catch (error) {
    console.error(error);
    setStatus(error?.message || String(error), true);
  }

  function fourCC(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
  }

  function readExtended80(view, offset) {
    const rawExponent = view.getUint16(offset, false);
    const sign = rawExponent & 0x8000 ? -1 : 1;
    const exponent = rawExponent & 0x7fff;

    const high = view.getUint32(offset + 2, false);
    const low = view.getUint32(offset + 6, false);

    if (exponent === 0 && high === 0 && low === 0) {
      return 0;
    }

    if (exponent === 0x7fff) {
      return Infinity;
    }

    const mantissa =
      high * Math.pow(2, -31) +
      low * Math.pow(2, -63);

    return sign * mantissa * Math.pow(2, exponent - 16383);
  }

  function readAiffInfo(buffer) {
    const view = new DataView(buffer);

    if (
      view.byteLength < 12 ||
      fourCC(view, 0) !== "FORM" ||
      fourCC(view, 8) !== "AIFF"
    ) {
      throw new Error("非圧縮AIFFとして認識できません。");
    }

    let position = 12;

    while (position + 8 <= view.byteLength) {
      const id = fourCC(view, position);
      const size = view.getUint32(position + 4, false);
      const start = position + 8;

      if (id === "COMM" && size >= 18) {
        return {
          channels: view.getUint16(start, false),
          frames: view.getUint32(start + 2, false),
          bits: view.getUint16(start + 6, false),
          sampleRate: Math.round(readExtended80(view, start + 8))
        };
      }

      position = start + size + (size & 1);
    }

    throw new Error("AIFFのCOMMチャンクが見つかりません。");
  }

  function writeAscii(view, offset, value) {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  function aiffToWavBlob(buffer) {
    const view = new DataView(buffer);

    if (view.byteLength < 12 || fourCC(view, 0) !== "FORM") {
      throw new Error("AIFFファイルとして認識できません。");
    }

    const formType = fourCC(view, 8);

    if (formType === "AIFC") {
      throw new Error("AIFC（圧縮AIFF）は現在未対応です。");
    }

    if (formType !== "AIFF") {
      throw new Error("AIFFファイルとして認識できません。");
    }

    let comm = null;
    let ssnd = null;
    let position = 12;

    while (position + 8 <= view.byteLength) {
      const id = fourCC(view, position);
      const size = view.getUint32(position + 4, false);
      const start = position + 8;

      if (id === "COMM" && size >= 18) {
        comm = {
          channels: view.getUint16(start, false),
          frames: view.getUint32(start + 2, false),
          bits: view.getUint16(start + 6, false),
          sampleRate: Math.round(readExtended80(view, start + 8))
        };
      } else if (id === "SSND" && size >= 8) {
        const offset = view.getUint32(start, false);

        ssnd = {
          start: start + 8 + offset,
          size: Math.max(0, size - 8 - offset)
        };
      }

      position = start + size + (size & 1);
    }

    if (!comm || !ssnd) {
      throw new Error("AIFFの音声データを読み取れません。");
    }

    if (![8, 16, 24, 32].includes(comm.bits)) {
      throw new Error(`${comm.bits}-bit AIFFは現在未対応です。`);
    }

    const bytesPerSample = comm.bits / 8;
    const blockAlign = comm.channels * bytesPerSample;
    const framesAvailable = Math.floor(ssnd.size / blockAlign);
    const frameCount = Math.min(comm.frames, framesAvailable);
    const dataSize = frameCount * blockAlign;

    if (frameCount <= 0) {
      throw new Error("AIFFに再生可能な音声データがありません。");
    }

    const output = new ArrayBuffer(44 + dataSize);
    const wav = new DataView(output);

    writeAscii(wav, 0, "RIFF");
    wav.setUint32(4, 36 + dataSize, true);
    writeAscii(wav, 8, "WAVE");
    writeAscii(wav, 12, "fmt ");
    wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true);
    wav.setUint16(22, comm.channels, true);
    wav.setUint32(24, comm.sampleRate, true);
    wav.setUint32(28, comm.sampleRate * blockAlign, true);
    wav.setUint16(32, blockAlign, true);
    wav.setUint16(34, comm.bits, true);
    writeAscii(wav, 36, "data");
    wav.setUint32(40, dataSize, true);

    let source = ssnd.start;
    let target = 44;
    const samples = frameCount * comm.channels;

    for (let i = 0; i < samples; i += 1) {
      if (comm.bits === 8) {
        wav.setUint8(target, view.getInt8(source) + 128);
      } else {
        for (let byte = 0; byte < bytesPerSample; byte += 1) {
          wav.setUint8(
            target + byte,
            view.getUint8(source + bytesPerSample - 1 - byte)
          );
        }
      }

      source += bytesPerSample;
      target += bytesPerSample;
    }

    return new Blob([output], { type: "audio/wav" });
  }
})();
