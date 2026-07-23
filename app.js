const statusEl = document.getElementById("status");
const filenameEl = document.getElementById("filename");
const installButton = document.getElementById("installButton");
const authButton = document.getElementById("authButton");
const mimeButton = document.getElementById("mimeButton");
const driveUrlInput = document.getElementById("driveUrl");
const mimeResult = document.getElementById("mimeResult");
const player = document.getElementById("player");

let driveState = null;
let tokenClient = null;
let currentObjectUrl = null;
let lastToken = null;
let authPurpose = "install";

function setStatus(text) { statusEl.textContent = text; }

function parseFileId(value) {
  value = value.trim();
  let m = value.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  try {
    const u = new URL(value);
    const id = u.searchParams.get("id");
    if (id) return id;
  } catch (_) {}
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  return null;
}

function getDriveStateOrNull() {
  const raw = new URLSearchParams(location.search).get("state");
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed.action !== "open" || !Array.isArray(parsed.ids) || !parsed.ids.length) {
    throw new Error("Driveから渡されたファイル情報を認識できません。");
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
    installButton.disabled = mimeButton.disabled = true;
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
      lastToken = response.access_token;

      if (authPurpose === "mime") {
        await inspectMime(lastToken);
      } else if (driveState) {
        await openFromDrive(lastToken);
      } else {
        setStatus("Google Driveへの権限を許可しました。");
      }
    }
  });

  installButton.onclick = () => {
    authPurpose = "install";
    tokenClient.requestAccessToken({ prompt: "consent" });
  };

  mimeButton.onclick = async () => {
    if (!parseFileId(driveUrlInput.value)) {
      mimeResult.textContent = "Drive URLまたはFile IDを認識できません。";
      return;
    }
    if (lastToken) {
      await inspectMime(lastToken);
    } else {
      authPurpose = "mime";
      tokenClient.requestAccessToken({ prompt: "" });
    }
  };

  authButton.onclick = () => {
    authPurpose = "open";
    tokenClient.requestAccessToken({ prompt: "" });
  };

  if (driveState) {
    installButton.hidden = true;
    authButton.hidden = false;
    authPurpose = "open";
    tokenClient.requestAccessToken({ prompt: "" });
  }
}

async function inspectMime(token) {
  const fileId = parseFileId(driveUrlInput.value);
  mimeResult.textContent = "確認中…";

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,fileExtension,size");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    mimeResult.textContent = `Drive API error ${res.status}\n${await res.text()}`;
    return;
  }

  const meta = await res.json();
  mimeResult.textContent =
    `name: ${meta.name || ""}\n` +
    `mimeType: ${meta.mimeType || ""}\n` +
    `fileExtension: ${meta.fileExtension || ""}\n` +
    `fileId: ${meta.id || ""}`;
}

async function openFromDrive(accessToken) {
  const fileId = driveState.ids[0];
  const headers = { Authorization: `Bearer ${accessToken}` };

  try {
    const metaUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    metaUrl.searchParams.set("fields", "id,name,mimeType,size");
    metaUrl.searchParams.set("supportsAllDrives", "true");

    const metaRes = await fetch(metaUrl, { headers });
    if (!metaRes.ok) throw new Error(await metaRes.text());
    const meta = await metaRes.json();
    filenameEl.textContent = meta.name || "AIFF";

    const mediaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers }
    );
    if (!mediaRes.ok) throw new Error(await mediaRes.text());

    const aiff = await mediaRes.arrayBuffer();
    const wav = aiffToWavBlob(aiff);
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(wav);
    player.src = currentObjectUrl;
    player.hidden = false;
    setStatus("読み込み完了。▶︎ を押すと再生します。");
  } catch (e) {
    setStatus(`エラー:\n${e.message || e}`);
  }
}

function fourCC(v, o) {
  return String.fromCharCode(v.getUint8(o),v.getUint8(o+1),v.getUint8(o+2),v.getUint8(o+3));
}
function readExtended80(v, offset) {
  const raw=v.getUint16(offset,false), sign=(raw&0x8000)?-1:1, exp=raw&0x7fff;
  const hi=v.getUint32(offset+2,false), lo=v.getUint32(offset+6,false);
  if(exp===0&&hi===0&&lo===0)return 0;
  return sign*(hi*Math.pow(2,-31)+lo*Math.pow(2,-63))*Math.pow(2,exp-16383);
}
function writeAscii(v,o,s){for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));}
function aiffToWavBlob(buffer) {
  const v=new DataView(buffer);
  if(v.byteLength<12||fourCC(v,0)!=="FORM"||fourCC(v,8)!=="AIFF")
    throw new Error("非圧縮AIFFとして認識できません。");
  let comm=null,ssnd=null,p=12;
  while(p+8<=v.byteLength){
    const id=fourCC(v,p),size=v.getUint32(p+4,false),start=p+8;
    if(id==="COMM"&&size>=18)comm={channels:v.getUint16(start,false),frames:v.getUint32(start+2,false),bits:v.getUint16(start+6,false),sampleRate:Math.round(readExtended80(v,start+8))};
    else if(id==="SSND"&&size>=8){const off=v.getUint32(start,false);ssnd={start:start+8+off,size:Math.max(0,size-8-off)};}
    p=start+size+(size&1);
  }
  if(!comm||!ssnd||![8,16,24,32].includes(comm.bits))throw new Error("未対応AIFFです。");
  const bps=comm.bits/8,align=comm.channels*bps,frames=Math.min(comm.frames,Math.floor(ssnd.size/align)),dataSize=frames*align;
  const out=new ArrayBuffer(44+dataSize),w=new DataView(out);
  writeAscii(w,0,"RIFF");w.setUint32(4,36+dataSize,true);writeAscii(w,8,"WAVE");writeAscii(w,12,"fmt ");
  w.setUint32(16,16,true);w.setUint16(20,1,true);w.setUint16(22,comm.channels,true);w.setUint32(24,comm.sampleRate,true);
  w.setUint32(28,comm.sampleRate*align,true);w.setUint16(32,align,true);w.setUint16(34,comm.bits,true);writeAscii(w,36,"data");w.setUint32(40,dataSize,true);
  let src=ssnd.start,dst=44;
  for(let i=0;i<frames*comm.channels;i++){
    if(comm.bits===8)w.setUint8(dst,v.getInt8(src)+128);
    else for(let b=0;b<bps;b++)w.setUint8(dst+b,v.getUint8(src+bps-1-b));
    src+=bps;dst+=bps;
  }
  return new Blob([out],{type:"audio/wav"});
}

try {
  driveState = getDriveStateOrNull();
  initGoogleAuth();
} catch (e) {
  setStatus(`エラー:\n${e.message || e}`);
}
