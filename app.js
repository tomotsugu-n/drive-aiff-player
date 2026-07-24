(() => {
"use strict";
const REQUIRED_SCOPE = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.install"
].join(" ");

const els = {
  filename: document.getElementById("filename"),
  filemeta: document.getElementById("filemeta"),
  seek: document.getElementById("seek"),
  currentTime: document.getElementById("currentTime"),
  duration: document.getElementById("duration"),
  remainingTime: document.getElementById("remainingTime"),
  playPause: document.getElementById("playPause"),
  restart: document.getElementById("restart"),
  back15: document.getElementById("back15"),
  forward15: document.getElementById("forward15"),
  mute: document.getElementById("mute"),
  speakerIcon: document.getElementById("speakerIcon"),
  volume: document.getElementById("volume"),
  status: document.getElementById("status"),
  audio: document.getElementById("audio")
};

let tokenClient = null;
let driveState = null;
let objectUrl = null;
let lastVolume = 0.8;

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function parseDriveState() {
  const raw = new URLSearchParams(window.location.search).get("state");
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Google Drive™ から渡された情報を読み取れませんでした。"); }
  if (parsed.action !== "open" || !Array.isArray(parsed.ids) || parsed.ids.length === 0) {
    throw new Error("Google Drive™ からAIFFファイルが渡されていません。");
  }
  return parsed;
}

function initGoogleAuth() {
  if (!window.google?.accounts?.oauth2) {
    window.setTimeout(initGoogleAuth, 100);
    return;
  }
  if (typeof GOOGLE_CLIENT_ID !== "string" || !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes("PASTE_")) {
    setStatus("OAuth Client ID が設定されていません。", true);
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: REQUIRED_SCOPE,
    callback: async (response) => {
      if (response.error) {
        setStatus(`Google認証エラー: ${response.error}`, true);
        return;
      }
      try { await loadDriveFile(response.access_token); }
      catch (error) {
        console.error(error);
        setStatus(error.message || String(error), true);
      }
    },
    error_callback: (error) => {
      console.error(error);
      setStatus("Google認証を開始できませんでした。", true);
    }
  });

  // Google Identity Services requires token requests to originate from
  // a user gesture. Do not request a token automatically here.
  els.playPause.disabled = false;
  setStatus("▶ を押してAIFFを読み込みます。");
}

async function loadDriveFile(accessToken) {
  const fileId = driveState.ids[0];
  const resourceKey = driveState.resourceKeys?.[fileId];
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (resourceKey) headers["X-Goog-Drive-Resource-Keys"] = `${fileId}/${resourceKey}`;

  setStatus("Google Drive™ からAIFFを読み込んでいます…");

  const metaUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  metaUrl.searchParams.set("fields","id,name,mimeType,size,audioMediaMetadata,capabilities/canDownload");
  metaUrl.searchParams.set("supportsAllDrives","true");

  const metaResponse = await fetch(metaUrl,{headers});
  if (metaResponse.status === 401) {
    tokenClient.requestAccessToken({prompt:"consent"});
    return;
  }
  if (!metaResponse.ok) throw new Error(`ファイル情報の取得に失敗しました (${metaResponse.status})。`);
  const meta = await metaResponse.json();

  if (meta.capabilities?.canDownload === false) {
    throw new Error("このファイルを読み取る権限がありません。");
  }

  els.filename.textContent = meta.name || "AIFF";
  els.filemeta.textContent = buildMetadataLabel(meta);

  const mediaResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    {headers}
  );
  if (!mediaResponse.ok) throw new Error(`AIFFファイルの取得に失敗しました (${mediaResponse.status})。`);

  const aiffBuffer = await mediaResponse.arrayBuffer();
  const wavBlob = aiffToWavBlob(aiffBuffer);

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(wavBlob);
  els.audio.src = objectUrl;
  els.audio.volume = Number(els.volume.value);

  enableControls();
  setStatus("読み込み完了。▶ を押すと再生します。");
}

function buildMetadataLabel(meta) {
  const parts = ["AIFF"];
  const sr = meta.audioMediaMetadata?.sampleRate;
  if (sr) {
    const khz = Number(sr)/1000;
    parts.push(`${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`);
  }
  const channels = meta.audioMediaMetadata?.channelCount;
  if (channels === 1) parts.push("Mono");
  else if (channels === 2) parts.push("Stereo");
  else if (channels > 2) parts.push(`${channels} ch`);
  return parts.join("  |  ");
}

function enableControls() {
  [els.seek,els.playPause,els.restart,els.back15,els.forward15,els.mute,els.volume]
    .forEach(el => el.disabled = false);
}

function updateSeekVisual() {
  const max = Number(els.seek.max) || 1000;
  const value = Number(els.seek.value) || 0;
  els.seek.style.setProperty("--progress",`${(value/max)*100}%`);
  const vol = Number(els.volume.value) || 0;
  els.volume.style.setProperty("--progress",`${vol*100}%`);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds/60);
  const secs = Math.floor(seconds%60);
  return `${mins}:${String(secs).padStart(2,"0")}`;
}

els.audio.addEventListener("loadedmetadata",() => {
  els.duration.textContent = formatTime(els.audio.duration);
  els.remainingTime.textContent = `-${formatTime(els.audio.duration)}`;
});

els.audio.addEventListener("timeupdate",() => {
  if (!Number.isFinite(els.audio.duration) || els.audio.duration <= 0) return;
  const ratio = els.audio.currentTime/els.audio.duration;
  els.seek.value = String(Math.round(ratio*Number(els.seek.max)));
  els.currentTime.textContent = formatTime(els.audio.currentTime);
  els.duration.textContent = formatTime(els.audio.duration);
  els.remainingTime.textContent = `-${formatTime(Math.max(0,els.audio.duration-els.audio.currentTime))}`;
  updateSeekVisual();
});

els.audio.addEventListener("play",() => {
  els.playPause.classList.add("is-playing");
  els.playPause.title = "一時停止";
});
els.audio.addEventListener("pause",() => {
  els.playPause.classList.remove("is-playing");
  els.playPause.title = "再生";
});
els.audio.addEventListener("ended",() => {
  els.playPause.classList.remove("is-playing");
});

els.playPause.addEventListener("click", async () => {
  // Before the Drive file has been loaded, this click is the required
  // user gesture that starts Google OAuth/token acquisition.
  if (!els.audio.src) {
    if (!tokenClient) {
      setStatus("Google認証の準備中です。少し待ってもう一度押してください。");
      return;
    }
    setStatus("Google Drive™ に接続しています…");
    tokenClient.requestAccessToken({ prompt: "" });
    return;
  }

  if (els.audio.paused) {
    try {
      await els.audio.play();
    } catch (error) {
      console.error(error);
      setStatus("▶ をもう一度押すと再生できます。");
    }
  } else {
    els.audio.pause();
  }
});
els.restart.addEventListener("click",() => { els.audio.currentTime = 0; });
els.back15.addEventListener("click",() => { els.audio.currentTime = Math.max(0,els.audio.currentTime-15); });
els.forward15.addEventListener("click",() => {
  const duration = Number.isFinite(els.audio.duration) ? els.audio.duration : els.audio.currentTime+15;
  els.audio.currentTime = Math.min(duration,els.audio.currentTime+15);
});
els.seek.addEventListener("input",() => {
  if (!Number.isFinite(els.audio.duration) || els.audio.duration <= 0) return;
  els.audio.currentTime = (Number(els.seek.value)/Number(els.seek.max))*els.audio.duration;
  updateSeekVisual();
});
els.volume.addEventListener("input",() => {
  const value = Number(els.volume.value);
  els.audio.volume = value;
  els.audio.muted = value === 0;
  if (value > 0) lastVolume = value;
  els.speakerIcon.textContent = value === 0 ? "×" : "◖";
  updateSeekVisual();
});
els.mute.addEventListener("click",() => {
  if (els.audio.muted || els.audio.volume === 0) {
    els.audio.muted = false;
    els.audio.volume = lastVolume || 0.8;
    els.volume.value = String(els.audio.volume);
    els.speakerIcon.textContent = "◖";
  } else {
    lastVolume = els.audio.volume;
    els.audio.muted = true;
    els.volume.value = "0";
    els.speakerIcon.textContent = "×";
  }
  updateSeekVisual();
});

window.addEventListener("beforeunload",() => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
updateSeekVisual();

try {
  driveState = parseDriveState();
  if (!driveState) {
    setStatus("Google Drive™ でAIFFを右クリック →「アプリで開く」→ このプレイヤーを選択してください。");
  } else {
    initGoogleAuth();
  }
} catch (error) {
  console.error(error);
  setStatus(error.message || String(error),true);
}

function fourCC(view,offset) {
  return String.fromCharCode(view.getUint8(offset),view.getUint8(offset+1),view.getUint8(offset+2),view.getUint8(offset+3));
}
function readExtended80(view,offset) {
  const rawExponent = view.getUint16(offset,false);
  const sign = rawExponent & 0x8000 ? -1 : 1;
  const exponent = rawExponent & 0x7fff;
  const high = view.getUint32(offset+2,false);
  const low = view.getUint32(offset+6,false);
  if (exponent === 0 && high === 0 && low === 0) return 0;
  if (exponent === 0x7fff) return Infinity;
  const mantissa = high*Math.pow(2,-31) + low*Math.pow(2,-63);
  return sign*mantissa*Math.pow(2,exponent-16383);
}
function writeAscii(view,offset,text) {
  for (let i=0;i<text.length;i+=1) view.setUint8(offset+i,text.charCodeAt(i));
}
function aiffToWavBlob(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || fourCC(view,0) !== "FORM") throw new Error("AIFFファイルとして認識できません。");
  const formType = fourCC(view,8);
  if (formType === "AIFC") throw new Error("AIFC（圧縮AIFF）は現在未対応です。");
  if (formType !== "AIFF") throw new Error("AIFFファイルとして認識できません。");

  let comm = null, ssnd = null, position = 12;
  while (position+8 <= view.byteLength) {
    const id = fourCC(view,position);
    const size = view.getUint32(position+4,false);
    const start = position+8;
    if (id === "COMM" && size >= 18) {
      comm = {
        channels:view.getUint16(start,false),
        frames:view.getUint32(start+2,false),
        bits:view.getUint16(start+6,false),
        sampleRate:Math.round(readExtended80(view,start+8))
      };
    }
    if (id === "SSND" && size >= 8) {
      const offset = view.getUint32(start,false);
      ssnd = {start:start+8+offset,size:Math.max(0,size-8-offset)};
    }
    position = start+size+(size&1);
  }

  if (!comm || !ssnd) throw new Error("AIFFの音声データを読み取れませんでした。");
  if (![8,16,24,32].includes(comm.bits)) throw new Error(`${comm.bits}-bit AIFFは現在未対応です。`);

  const bytesPerSample = comm.bits/8;
  const blockAlign = comm.channels*bytesPerSample;
  const framesAvailable = Math.floor(ssnd.size/blockAlign);
  const frameCount = Math.min(comm.frames,framesAvailable);
  const dataSize = frameCount*blockAlign;
  if (frameCount <= 0) throw new Error("AIFFに再生可能な音声データがありません。");

  const output = new ArrayBuffer(44+dataSize);
  const wav = new DataView(output);
  writeAscii(wav,0,"RIFF");
  wav.setUint32(4,36+dataSize,true);
  writeAscii(wav,8,"WAVE");
  writeAscii(wav,12,"fmt ");
  wav.setUint32(16,16,true);
  wav.setUint16(20,1,true);
  wav.setUint16(22,comm.channels,true);
  wav.setUint32(24,comm.sampleRate,true);
  wav.setUint32(28,comm.sampleRate*blockAlign,true);
  wav.setUint16(32,blockAlign,true);
  wav.setUint16(34,comm.bits,true);
  writeAscii(wav,36,"data");
  wav.setUint32(40,dataSize,true);

  let sourceOffset = ssnd.start, outputOffset = 44;
  const sampleCount = frameCount*comm.channels;
  for (let i=0;i<sampleCount;i+=1) {
    if (comm.bits === 8) wav.setUint8(outputOffset,view.getInt8(sourceOffset)+128);
    else {
      for (let byte=0;byte<bytesPerSample;byte+=1) {
        wav.setUint8(outputOffset+byte,view.getUint8(sourceOffset+bytesPerSample-1-byte));
      }
    }
    sourceOffset += bytesPerSample;
    outputOffset += bytesPerSample;
  }
  return new Blob([output],{type:"audio/wav"});
}
})();