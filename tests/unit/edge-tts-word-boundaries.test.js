import { describe, it, expect } from "vitest";
import { createTtsResponse } from "../../open-sse/handlers/ttsCore.js";
import {
  buildEdgeTtsSpeechConfigMessage,
  parseEdgeTtsMetadataFrame,
} from "../../open-sse/handlers/ttsProviders/edgeTts.js";

describe("Edge TTS word boundaries", () => {
  it("preserves adapter word boundaries in JSON TTS responses", async () => {
    const result = createTtsResponse(
      {
        base64: Buffer.from("audio").toString("base64"),
        format: "mp3",
        word_boundaries: [
          { text: "Xin", offset_ms: 0, duration_ms: 120 },
          { text: "chao", offset_ms: 130, duration_ms: 180 },
        ],
      },
      "json"
    );

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({
      audio: "YXVkaW8=",
      format: "mp3",
      word_boundaries: [
        { text: "Xin", offset_ms: 0, duration_ms: 120 },
        { text: "chao", offset_ms: 130, duration_ms: 180 },
      ],
    });
  });

  it("builds valid Edge speech config with word metadata enabled", () => {
    const message = buildEdgeTtsSpeechConfigMessage({
      wordBoundaries: true,
      sentenceBoundaries: true,
    });
    const payload = JSON.parse(message.split("\r\n\r\n")[1]);

    expect(payload.context.synthesis.audio.metadataoptions).toEqual({
      sentenceBoundaryEnabled: "true",
      wordBoundaryEnabled: "true",
    });
    expect(payload.context.synthesis.audio.outputFormat).toBe(
      "audio-24khz-48kbitrate-mono-mp3"
    );
  });

  it("normalizes Edge audio.metadata word boundary frames", () => {
    const message =
      'Path:audio.metadata\r\n\r\n{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1000000,"Duration":2500000,"text":{"Text":"Xin","Length":3,"BoundaryType":"Word"}}},{"Type":"SentenceBoundary","Data":{"Offset":4000000,"Duration":1000000,"text":{"Text":"Xin chao.","Length":9,"BoundaryType":"Sentence"}}}]}';

    expect(parseEdgeTtsMetadataFrame(message)).toEqual([
      { text: "Xin", offset_ms: 100, duration_ms: 250 },
    ]);
  });
});
