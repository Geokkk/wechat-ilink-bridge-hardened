import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadMessageMedia, sanitizeAttachmentFileName } from "../../src/core/media-download.js";

async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-media 状态 "));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function encryptAes128Ecb(buffer, keyHex) {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function fakeFetch(bytes) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
  
  return async () => ({
    ok: true,
    status: 200,
    body: stream,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  });
}

function fakeFetchByUrl(values) {
  return async (url) => {
    const bytes = values[String(url)];
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        body: new ReadableStream(),
        async arrayBuffer() {
          return new ArrayBuffer(0);
        }
      };
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });

    return {
      ok: true,
      status: 200,
      body: stream,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    };
  };
}

function fakeFetchStreaming(totalBytes, chunkSize = 1024) {
  let sent = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(chunkSize, totalBytes - sent));
      chunk.fill(0x42); // 'B' byte
      controller.enqueue(chunk);
      sent += chunk.length;
    }
  });
  
  return async () => ({
    ok: true,
    status: 200,
    body: stream
  });
}

test("downloads and decrypts AES media into a safe inbox path", async () => {
  await withTempDir(async (stateDir) => {
    const keyHex = "00112233445566778899aabbccddeeff";
    const plain = Buffer.from("decrypted image bytes");
    const encrypted = encryptAes128Ecb(plain, keyHex);
    const message = {
      id: "msg/../unsafe",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            fileId: "image_001",
            fileName: "../CON?.jpg",
            mimeType: "image/jpeg",
            url: "https://novac2c.cdn.weixin.qq.com/image",
            aesKey: keyHex
          }
        }
      ]
    };

    const result = await downloadMessageMedia(message, {
      stateDir,
      accountId: "bot/media",
      config: {},
      fetchImpl: fakeFetch(encrypted)
    });

    assert.equal(result.attachments.length, 1);
    assert.equal(result.mediaDownload.succeeded, 1);
    assert.equal(path.isAbsolute(result.attachments[0].path), true);
    assert.equal(result.attachments[0].path.startsWith(path.resolve(stateDir, "inbox")), true);
    assert.equal(result.attachments[0].decrypted, true);
    assert.equal((await readFile(result.attachments[0].path)).toString("utf8"), "decrypted image bytes");
    assert.equal(Object.hasOwn(result.items[0].metadata, "aesKey"), false);
    assert.equal(result.items[0].download.ok, true);
  });
});

test("sanitizes attachment names for Windows paths", () => {
  assert.equal(sanitizeAttachmentFileName("../CON?.jpg"), "CON_.jpg");
  assert.equal(sanitizeAttachmentFileName("bad<name>|file.txt"), "bad_name__file.txt");
  assert.ok(sanitizeAttachmentFileName("a".repeat(300) + ".txt").length <= 180);
  assert.ok(sanitizeAttachmentFileName(`file.${"a".repeat(300)}`).length <= 180);
  assert.equal(sanitizeAttachmentFileName(`file.${"a".repeat(300)}`), "file.dat");
});

test("records media download failure without throwing", async () => {
  await withTempDir(async (stateDir) => {
    const result = await downloadMessageMedia({
      id: "msg_missing",
      items: [
        {
          kind: "file",
          metadata: {
            fileName: "missing.txt",
            aesKey: "00112233445566778899aabbccddeeff"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {}
    });

    assert.equal(result.attachments.length, 0);
    assert.equal(result.mediaDownload.failed, 1);
    assert.equal(result.items[0].download.ok, false);
    assert.equal(result.items[0].download.error.code, "MEDIA_URL_MISSING");
    assert.equal(Object.hasOwn(result.items[0].metadata, "aesKey"), false);
  });
});

test("downloads media using encrypt query parameters from the configured CDN", async () => {
  await withTempDir(async (stateDir) => {
    const keyHex = "00112233445566778899aabbccddeeff";
    const plain = Buffer.from("nested encrypted image bytes");
    const encrypted = encryptAes128Ecb(plain, keyHex);
    const result = await downloadMessageMedia({
      id: "msg_encrypt_query",
      timestamp: 1778988481,
      items: [
        {
          kind: "image",
          metadata: {
            fileName: "nested.jpg",
            mimeType: "image/jpeg",
            encryptQueryParam: "?token=abc&fileid=image_nested",
            aesKey: keyHex
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {
        cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c/"
      },
      fetchImpl: fakeFetchByUrl({
        "https://novac2c.cdn.weixin.qq.com/c2c/download?token=abc&fileid=image_nested": encrypted
      })
    });

    assert.equal(result.mediaDownload.succeeded, 1);
    assert.equal(result.items[0].download.ok, true);
    assert.equal((await readFile(result.attachments[0].path)).toString("utf8"), "nested encrypted image bytes");
    assert.equal(Object.hasOwn(result.items[0].metadata, "encryptQueryParam"), false);
    assert.equal(Object.hasOwn(result.items[0].metadata, "aesKey"), false);
  });
});

test("infers common image mime types and extensions from downloaded bytes", async () => {
  await withTempDir(async (stateDir) => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const result = await downloadMessageMedia({
      id: "msg_inferred_image",
      timestamp: 1778989344,
      items: [
        {
          kind: "image",
          metadata: {
            url: "https://novac2c.cdn.weixin.qq.com/image"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {},
      fetchImpl: fakeFetch(jpegBytes)
    });

    assert.equal(result.mediaDownload.succeeded, 1);
    assert.equal(result.attachments[0].mimeType, "image/jpeg");
    assert.equal(result.attachments[0].fileName.endsWith(".jpg"), true);
    assert.equal(result.items[0].metadata.mimeType, "image/jpeg");
    assert.equal((await readFile(result.attachments[0].path)).equals(jpegBytes), true);
  });
});

test("infers common voice and video mime types from downloaded bytes", async () => {
  await withTempDir(async (stateDir) => {
    const silkBytes = Buffer.from("#!SILK_V3\nvoice bytes", "ascii");
    const mp4Bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x6d, 0x70, 0x34, 0x32,
      0x00, 0x00, 0x00, 0x00
    ]);
    const result = await downloadMessageMedia({
      id: "msg_inferred_av",
      timestamp: 1778989934,
      items: [
        {
          kind: "voice",
          metadata: {
            url: "https://novac2c.cdn.weixin.qq.com/voice"
          }
        },
        {
          kind: "video",
          metadata: {
            url: "https://novac2c.cdn.weixin.qq.com/video"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {},
      fetchImpl: fakeFetchByUrl({
        "https://novac2c.cdn.weixin.qq.com/voice": silkBytes,
        "https://novac2c.cdn.weixin.qq.com/video": mp4Bytes
      })
    });

    assert.equal(result.mediaDownload.succeeded, 2);
    assert.equal(result.attachments[0].mimeType, "audio/silk");
    assert.equal(result.attachments[0].fileName.endsWith(".silk"), true);
    assert.equal(result.attachments[1].mimeType, "video/mp4");
    assert.equal(result.attachments[1].fileName.endsWith(".mp4"), true);
  });
});

test("saves file, voice, and video media as raw attachments when no AES key is present", async () => {
  await withTempDir(async (stateDir) => {
    const result = await downloadMessageMedia({
      id: "msg_raw_media",
      timestamp: 1778949153,
      items: [
        {
          kind: "file",
          metadata: {
            fileId: "file_001",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            url: "https://novac2c.cdn.weixin.qq.com/file"
          }
        },
        {
          kind: "voice",
          metadata: {
            fileId: "voice_001",
            fileName: "voice.silk",
            mimeType: "audio/silk",
            url: "https://novac2c.cdn.weixin.qq.com/voice"
          }
        },
        {
          kind: "video",
          metadata: {
            fileId: "video_001",
            fileName: "clip.mp4",
            mimeType: "video/mp4",
            url: "https://novac2c.cdn.weixin.qq.com/video"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {},
      fetchImpl: fakeFetchByUrl({
        "https://novac2c.cdn.weixin.qq.com/file": Buffer.from("file bytes"),
        "https://novac2c.cdn.weixin.qq.com/voice": Buffer.from("voice bytes"),
        "https://novac2c.cdn.weixin.qq.com/video": Buffer.from("video bytes")
      })
    });

    assert.equal(result.mediaDownload.succeeded, 3);
    assert.deepEqual(result.attachments.map((attachment) => attachment.kind), ["file", "voice", "video"]);
    for (const attachment of result.attachments) {
      assert.equal(attachment.encrypted, false);
      assert.equal(attachment.decrypted, false);
      assert.equal(path.isAbsolute(attachment.path), true);
    }
    assert.equal((await readFile(result.attachments[0].path)).toString("utf8"), "file bytes");
    assert.equal((await readFile(result.attachments[1].path)).toString("utf8"), "voice bytes");
    assert.equal((await readFile(result.attachments[2].path)).toString("utf8"), "video bytes");
  });
});

test("rejects media download exceeding size limit (streaming)", async () => {
  await withTempDir(async (stateDir) => {
    const limit = 1024; // 1 KB limit
    const oversize = limit + 512;
    const result = await downloadMessageMedia({
      id: "msg_oversize",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            url: "https://novac2c.cdn.weixin.qq.com/large.jpg"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: { maxDownloadBytes: limit },
      fetchImpl: fakeFetchStreaming(oversize)
    });

    assert.equal(result.mediaDownload.failed, 1);
    assert.equal(result.items[0].download.ok, false);
    assert.equal(result.items[0].download.error.code, "MEDIA_DOWNLOAD_SIZE_EXCEEDED");
  });
});

test("rejects media URL with non-HTTPS protocol", async () => {
  await withTempDir(async (stateDir) => {
    const result = await downloadMessageMedia({
      id: "msg_http",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            url: "http://novac2c.cdn.weixin.qq.com/image.jpg"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {},
      fetchImpl: fakeFetch(Buffer.from("x"))
    });

    assert.equal(result.mediaDownload.failed, 1);
    assert.equal(result.items[0].download.ok, false);
    assert.equal(result.items[0].download.error.code, "MEDIA_URL_NOT_HTTPS");
  });
});

test("rejects media URL with non-whitelisted host", async () => {
  await withTempDir(async (stateDir) => {
    const result = await downloadMessageMedia({
      id: "msg_bad_host",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            url: "https://evil.example.com/image.jpg"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {},
      fetchImpl: fakeFetch(Buffer.from("x"))
    });

    assert.equal(result.mediaDownload.failed, 1);
    assert.equal(result.items[0].download.ok, false);
    assert.equal(result.items[0].download.error.code, "MEDIA_URL_HOST_NOT_ALLOWED");
  });
});

test("allows localhost CDN only when explicitly enabled", async () => {
  await withTempDir(async (stateDir) => {
    // Default: localhost rejected
    let result = await downloadMessageMedia({
      id: "msg_localhost_default",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            url: "https://localhost/image.jpg"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: {},
      fetchImpl: fakeFetch(Buffer.from("x"))
    });
    assert.equal(result.mediaDownload.failed, 1);
    assert.equal(result.items[0].download.error.code, "MEDIA_URL_HOST_NOT_ALLOWED");

    // With allowLocalhostCdn: true, localhost allowed
    result = await downloadMessageMedia({
      id: "msg_localhost_allowed",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            url: "https://localhost/image.jpg"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: { allowLocalhostCdn: true },
      fetchImpl: fakeFetch(Buffer.from("x"))
    });
    assert.equal(result.mediaDownload.succeeded, 1);
    assert.equal(result.items[0].download.ok, true);
  });
});

test("allows configured CDN host", async () => {
  await withTempDir(async (stateDir) => {
    const result = await downloadMessageMedia({
      id: "msg_custom_cdn",
      timestamp: 1778949153,
      items: [
        {
          kind: "image",
          metadata: {
            url: "https://custom.cdn.example/image.jpg"
          }
        }
      ]
    }, {
      stateDir,
      accountId: "bot_001",
      config: { allowedCdnHost: "custom.cdn.example" },
      fetchImpl: fakeFetch(Buffer.from("x"))
    });

    assert.equal(result.mediaDownload.succeeded, 1);
    assert.equal(result.items[0].download.ok, true);
  });
});
