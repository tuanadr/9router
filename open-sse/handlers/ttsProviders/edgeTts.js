// Microsoft Edge / Bing TTS (no auth) — via Bing translator endpoint
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import WebSocket from "ws";
import { UA } from "./_base.js";

const REFRESH_MS = 5 * 60 * 1000; // token TTL ~1h, refresh early
const VOICES_TTL = 24 * 60 * 60 * 1000;
const EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_TTS_CHROMIUM_FULL_VERSION = "143.0.3650.75";
const EDGE_TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const EDGE_TTS_WS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_TTS_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const WINDOWS_FILE_TIME_EPOCH_SECONDS = 11644473600;
const EDGE_TTS_TIMEOUT_MS = 60_000;
const EDGE_TTS_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EDGE_TTS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const cache = { token: null, tokenTime: 0 };
let _voicesCache = null;
let _voicesCacheTime = 0;

async function getToken() {
  const now = Date.now();
  if (cache.token && now - cache.tokenTime < REFRESH_MS) return cache.token;
  const res = await fetch("https://www.bing.com/translator", {
    headers: { "User-Agent": UA, "Accept-Language": "vi,en-US;q=0.9,en;q=0.8" },
  });
  if (!res.ok) throw new Error(`Bing translator fetch failed: ${res.status}`);
  const rawCookies = res.headers.getSetCookie?.() || [];
  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");
  const html = await res.text();
  const match = html.match(/params_AbusePreventionHelper\s*=\s*\[([^,]+),([^,]+),/);
  if (!match) throw new Error("Failed to parse Bing token");
  cache.token = { key: match[1], token: match[2].replace(/"/g, ""), cookie };
  cache.tokenTime = now;
  return cache.token;
}

async function ttsRequest(text, voiceId, token) {
  const parts = voiceId.split("-");
  const xmlLang = parts.slice(0, 2).join("-");
  const gender = voiceId.toLowerCase().includes("male") ? "Male" : "Female";
  const ssml = `<speak version='1.0' xml:lang='${xmlLang}'><voice xml:lang='${xmlLang}' xml:gender='${gender}' name='${voiceId}'><prosody rate='0.00%'>${text}</prosody></voice></speak>`;
  const body = new URLSearchParams();
  body.append("ssml", ssml);
  body.append("token", token.token);
  body.append("key", token.key);
  return fetch("https://www.bing.com/tfettts?isVertical=1&&IG=1&IID=translator.5023&SFX=1", {
    method: "POST",
    body: body.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      "Origin": "https://www.bing.com",
      "Referer": "https://www.bing.com/translator",
      "User-Agent": UA,
      ...(token.cookie ? { "Cookie": token.cookie } : {}),
    },
  });
}

function edgeTtsConnectId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function edgeTtsMuid() {
  return edgeTtsConnectId().toUpperCase();
}

function edgeTtsDateString() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${EDGE_TTS_DAYS[date.getUTCDay()]} ${EDGE_TTS_MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function edgeTtsSecMsGec() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  const winSeconds = unixSeconds + WINDOWS_FILE_TIME_EPOCH_SECONDS;
  const rounded = winSeconds - (winSeconds % 300);
  const ticks = BigInt(rounded) * 10_000_000n;
  return crypto
    .createHash("sha256")
    .update(`${ticks}${EDGE_TTS_TRUSTED_CLIENT_TOKEN}`)
    .digest("hex")
    .toUpperCase();
}

function edgeTtsWebSocketUrl() {
  const params = new URLSearchParams({
    TrustedClientToken: EDGE_TTS_TRUSTED_CLIENT_TOKEN,
    ConnectionId: edgeTtsConnectId(),
    "Sec-MS-GEC": edgeTtsSecMsGec(),
    "Sec-MS-GEC-Version": `1-${EDGE_TTS_CHROMIUM_FULL_VERSION}`,
  });
  return `${EDGE_TTS_WS_URL}?${params.toString()}`;
}

export function buildEdgeTtsSpeechConfigMessage({ wordBoundaries = false, sentenceBoundaries = false } = {}) {
  return (
    `X-Timestamp:${edgeTtsDateString()}\r\n` +
    "Content-Type:application/json; charset=utf-8\r\n" +
    "Path:speech.config\r\n\r\n" +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: sentenceBoundaries ? "true" : "false",
              wordBoundaryEnabled: wordBoundaries ? "true" : "false",
            },
            outputFormat: EDGE_TTS_OUTPUT_FORMAT,
          },
        },
      },
    }) +
    "\r\n"
  );
}

function buildEdgeTtsSsmlMessage(text, voiceId, rate = "+0%") {
  const escapedText = xmlEscape(removeIncompatibleCharacters(text));
  if (!escapedText.trim()) throw new Error("Edge TTS text is empty after sanitization");
  const ssml =
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${edgeTtsSsmlVoiceName(voiceId)}'>` +
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${escapedText}</prosody>` +
    "</voice>" +
    "</speak>";
  return (
    `X-RequestId:${edgeTtsConnectId()}\r\n` +
    "Content-Type:application/ssml+xml\r\n" +
    `X-Timestamp:${edgeTtsDateString()}Z\r\n` +
    "Path:ssml\r\n\r\n" +
    ssml
  );
}

function edgeTtsSsmlVoiceName(voiceId) {
  const trimmed = String(voiceId || "").trim();
  if (trimmed.startsWith("Microsoft Server Speech Text to Speech Voice")) return trimmed;
  if (!trimmed || !trimmed.endsWith("Neural")) {
    return "Microsoft Server Speech Text to Speech Voice (vi-VN, HoaiMyNeural)";
  }
  const [language = "vi", region = "VN", ...nameParts] = trimmed.split("-");
  const name = nameParts.join("-") || "HoaiMyNeural";
  return `Microsoft Server Speech Text to Speech Voice (${language}-${region}, ${name})`;
}

function removeIncompatibleCharacters(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
}

function xmlEscape(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;")
    .replaceAll('"', "&quot;");
}

function ticksToMs(ticks) {
  const numeric = Number(ticks);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor((numeric + 5000) / 10000);
}

function parseHeadersAndData(data, headerStart = 0, headerEnd = null) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const end = headerEnd ?? buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
  if (end < headerStart) throw new Error("Edge TTS frame did not include a header terminator");
  const rawHeaders = buffer.subarray(headerStart, end).toString("utf8");
  const headers = new Map();
  for (const line of rawHeaders.split("\r\n").filter(Boolean)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Edge TTS header is malformed: ${line}`);
    headers.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const dataStart =
    buffer.subarray(end, end + 4).toString("binary") === "\r\n\r\n"
      ? end + 4
      : buffer.subarray(end, end + 2).toString("binary") === "\r\n"
        ? end + 2
        : end;
  return { headers, data: buffer.subarray(dataStart) };
}

function parseBinaryFrame(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < 2) throw new Error("Edge TTS binary frame is missing the header length");
  const headerLength = buffer.readUInt16BE(0);
  const headerEnd = 2 + headerLength;
  if (headerEnd > buffer.length) throw new Error("Edge TTS binary header length exceeds frame size");
  return parseHeadersAndData(buffer, 2, headerEnd);
}

export function parseEdgeTtsMetadataFrame(message) {
  const { headers, data } = parseHeadersAndData(Buffer.from(message));
  if (headers.get("Path") !== "audio.metadata") return [];
  const raw = data.toString("utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const metadata = Array.isArray(parsed.Metadata) ? parsed.Metadata : [];
  return metadata.flatMap((item) => {
    if (String(item?.Type || item?.type || "").toLowerCase() !== "wordboundary") return [];
    const itemData = item.Data || item.data || item;
    const textValue =
      itemData?.text?.Text ??
      itemData?.text?.text ??
      itemData?.Text?.Text ??
      itemData?.Text?.text ??
      itemData?.text ??
      itemData?.Text;
    const text = String(textValue || "").trim();
    if (!text) return [];
    return [
      {
        text,
        offset_ms: ticksToMs(itemData.Offset ?? itemData.offset ?? 0),
        duration_ms: ticksToMs(itemData.Duration ?? itemData.duration ?? 0),
      },
    ];
  });
}

function shouldRequestWordBoundaries(options = {}) {
  return options.wordBoundaries === true || options.word_boundaries === true;
}

function edgeTtsUserAgent() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
}

function synthesizeViaReadaloudWebSocket(text, voiceId, options = {}) {
  return new Promise((resolve, reject) => {
    const audioChunks = [];
    const wordBoundaries = [];
    let settled = false;
    let receivedAudio = false;
    let socket;
    let timeout;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (error) reject(error);
      else resolve(result);
    };

    socket = new WebSocket(edgeTtsWebSocketUrl(), {
      perMessageDeflate: false,
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: EDGE_TTS_ORIGIN,
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": edgeTtsUserAgent(),
        Cookie: `muid=${edgeTtsMuid()};`,
      },
    });
    timeout = setTimeout(() => {
      socket.terminate();
      finish(new Error("Edge TTS websocket timed out"));
    }, options.timeoutMs || EDGE_TTS_TIMEOUT_MS);

    socket.on("open", () => {
      socket.send(
        buildEdgeTtsSpeechConfigMessage({
          wordBoundaries: true,
          sentenceBoundaries: options.sentenceBoundaries === true,
        })
      );
      socket.send(buildEdgeTtsSsmlMessage(text, voiceId, options.rate || "+0%"));
    });

    socket.on("message", (payload, isBinary) => {
      try {
        const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        if (isBinary) {
          const { headers, data } = parseBinaryFrame(buffer);
          if (headers.get("Path") !== "audio") throw new Error("Edge TTS binary frame was not audio");
          const contentType = headers.get("Content-Type");
          if (contentType === "audio/mpeg") {
            if (data.length === 0) throw new Error("Edge TTS returned an empty audio frame");
            receivedAudio = true;
            audioChunks.push(data);
          } else if (contentType || data.length > 0) {
            throw new Error(`Unexpected Edge TTS audio content type: ${contentType || "none"}`);
          }
          return;
        }

        const textFrame = buffer.toString("utf8");
        const { headers } = parseHeadersAndData(buffer);
        const path = headers.get("Path");
        if (path === "audio.metadata") {
          wordBoundaries.push(...parseEdgeTtsMetadataFrame(textFrame));
        } else if (path === "response" || path === "turn.start") {
          return;
        } else if (path === "turn.end") {
          if (!receivedAudio || audioChunks.length === 0) {
            finish(new Error("NoAudioReceived: No audio was received."));
            return;
          }
          finish(null, {
            base64: Buffer.concat(audioChunks).toString("base64"),
            format: "mp3",
            word_boundaries: wordBoundaries,
          });
        } else {
          throw new Error(`Unknown Edge TTS text frame path: ${path || "missing"}`);
        }
      } catch (error) {
        finish(error);
      }
    });

    socket.on("error", (error) => finish(error));
    socket.on("close", (code, reason) => {
      if (!settled) {
        const detail = reason?.toString?.() || `code ${code}`;
        finish(new Error(`Edge TTS websocket closed before completion: ${detail}`));
      }
    });
  });
}

export async function fetchEdgeTtsVoices() {
  const now = Date.now();
  if (_voicesCache && now - _voicesCacheTime < VOICES_TTL) return _voicesCache;
  const res = await fetch(
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4",
    { headers: { "User-Agent": UA } }
  );
  if (!res.ok) throw new Error(`Edge TTS voices fetch failed: ${res.status}`);
  const voices = await res.json();
  _voicesCache = voices;
  _voicesCacheTime = now;
  return voices;
}

export default {
  noAuth: true,
  async synthesize(text, model, _credentials, _responseFormat, options = {}) {
    const voiceId = model || "vi-VN-HoaiMyNeural";
    if (shouldRequestWordBoundaries(options)) {
      return synthesizeViaReadaloudWebSocket(text, voiceId, options);
    }

    let token = await getToken();
    let res = await ttsRequest(text, voiceId, token);

    // 429/403: invalidate cache and retry once
    if (res.status === 429 || res.status === 403) {
      cache.token = null;
      cache.tokenTime = 0;
      token = await getToken();
      res = await ttsRequest(text, voiceId, token);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bing TTS failed: ${res.status}${body ? " - " + body : ""}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error("Bing TTS returned empty audio");
    return { base64: Buffer.from(buf).toString("base64"), format: "mp3" };
  },
};
