// KY CRM Case Review Bookmarklet v4.1.0
// Chrome Extension(v3.1) → Bookmarklet 전환
// Main World에서 실행: Xrm.Page 직접 접근, 페이지 인증 토큰 공유, SW 의존성 제거
(function () {
  "use strict";
  if (window.__kyCrmReview) { window.__kyCrmReview.reinit(); return; }

  // ─── 1. 상수 & 설정 ───────────────────────────────────────────────
  const API_URL = "https://llm.kohyoung.com/v1/messages";
  const MODEL = "claude-sonnet-4-6";
  const DEFAULT_API_KEY = "sk-Sb8xGfx5rcNDwMXqH8I_ow";
  const VERSION = "4.2.0";
  const CORS_PROXY_URL = "http://localhost:18765";

  const MAX_PDF_TEXT_CHARS = 200000;
  const MAX_TOTAL_LINKED_CHARS = 400000;
  const FETCH_TIMEOUT_MS = 15000;

  const MAX_ZIP_TEXT_FILES = 100;
  const MAX_ZIP_TEXT_FILE_SIZE = Number.MAX_SAFE_INTEGER;
  const MAX_ZIP_IMAGES = 5;
  const MAX_NESTED_ZIP_SIZE = Number.MAX_SAFE_INTEGER;
  const MAX_NESTED_ZIPS = 3;
  const MAX_ZIP_IMAGE_SIZE = 2 * 1024 * 1024;

  const VIDEO_EXTENSIONS = /\.(mp4|avi|mov|mkv|webm|wmv)$/i;
  const MAX_VIDEO_SIZE = 500 * 1024 * 1024;
  const VIDEO_FRAME_INTERVAL_SEC = 5;
  const MAX_VIDEO_FRAMES = 20;

  const BUTTON_ID = "ky-crm-review-btn";
  const SETTINGS_ID = "ky-crm-settings-panel";
  const MODAL_ID = "ky-crm-review-modal";

  const SYSTEM_PROMPT = `당신은 고영테크놀러지(Koh Young Technology) TS HQ의 CRM 케이스 리뷰어입니다.
Branch Office가 작성한 영문 케이스 설명을 한국어로 리뷰합니다.

## 반드시 지킬 규칙
1. **반드시 한국어로 작성**하세요. 영어로 작성하지 마세요.
2. 기술 용어(모델명, S/W 버전, 에러명, 설정값 등)는 영문 그대로 유지하세요.
3. R&D팀이 이슈를 바로 파악할 수 있도록 자연스러운 한국어로 작성하세요.
4. 직역하지 말고, 핵심을 파악하여 구조적으로 정리하세요.
5. **마크다운 서식(**, ##, *, - 등)을 절대 사용하지 마세요.** 순수 텍스트로만 작성하세요.
6. **가독성**: 섹션 소제목 앞에 빈 줄을 넣으세요. 긴 문장은 의미 단위로 줄바꿈하세요. 한 줄에 하나의 정보만 담으세요.

## 출력 형식 (반드시 이 구조를 따르세요)

[TS HQ Reviewed by AI {오늘날짜 YYYY.MM.DD}]

핵심 문제
이 케이스의 근본 원인 또는 가장 중요한 에러를 딱 1문장으로. R&D가 이것만 읽고 이슈를 파악할 수 있어야 합니다.

상세 내용
Branch Office 원문 내용만 기반으로 핵심 사실을 간결하게 나열합니다. 첨부 문서 분석 내용은 여기에 포함하지 마세요. 반복·부연 설명 제거. 한 항목당 1~2줄 이내. 기술 용어는 영문 유지합니다.

장비/환경 정보
모델명, S/N, S/W 버전, 라인 정보 등을 정리합니다. (원문에 있는 경우만)

조치 내용
Branch Office에서 시도한 조치 사항을 정리합니다. (원문에 있는 경우만)

참고 자료
로그 파일 링크, Job 파일 링크 등을 정리합니다. (원문에 있는 경우만)

## 첨부 문서 분석 규칙 (링크된 콘텐츠가 있는 경우에만 적용)
1. [첨부 문서 분석]과 [첨부 분석 끝] 마커 사이에 작성.
2. **출처 한 줄 표기**: 섹션 맨 첫 줄에 분석 대상을 간결히 명시. 예: "Collect.zip 로그 분석결과" 또는 "SharePoint 폴더 내 로그 분석결과". 파일이 여러 개면 대표 파일명만.
3. 모든 파일 정상이면 섹션 자체 생략.
4. **가장 핵심 에러 1개만 작성.** 개별 파일명, 에러 메시지 나열 금지. 형식:
   "원인 현상
   → 결과로 판단됨"
   원인과 →결과 사이에 줄바꿈.
5. **이미지**: 중복 제거 후 대표 이미지만 표시. [ZIP_IMG_N] 플레이스홀더 + 관찰 현상 1줄.
6. 권장사항, 코멘트 금지.`;

  // ─── 2. 설정 헬퍼 (localStorage) ──────────────────────────────────
  function getApiKey() {
    return localStorage.getItem("ky_crm_api_key") || DEFAULT_API_KEY;
  }
  function isLinkAnalysisEnabled() {
    return localStorage.getItem("ky_crm_link_analysis") !== "false";
  }

  // ─── 3. 디버그 ────────────────────────────────────────────────────
  let _debugLog = [];
  function _dbg(msg) {
    const ts = new Date().toISOString().substring(11, 19);
    _debugLog.push(`[${ts}] ${msg}`);
    console.log(`[KY-BM] ${msg}`);
  }

  function findMsalToken(resource) {
    const now = Math.floor(Date.now() / 1000);
    const storages = [sessionStorage, localStorage];
    for (const storage of storages) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const val = storage.getItem(key);
          if (!val || val.length < 50) continue;
          if (val[0] === "{") {
            try {
              const parsed = JSON.parse(val);
              if (parsed.credentialType === "AccessToken" && parsed.secret && parsed.target && parsed.target.toLowerCase().includes(resource)) {
                if (!parsed.expiresOn || parseInt(parsed.expiresOn) > now) return parsed.secret;
              }
            } catch { continue; }
          }
          if (key.toLowerCase().includes("accesstoken") && key.toLowerCase().includes(resource)) {
            try {
              const parsed = JSON.parse(val);
              if (parsed.secret) {
                if (!parsed.expiresOn || parseInt(parsed.expiresOn) > now) return parsed.secret;
              }
            } catch { continue; }
          }
        }
      } catch { continue; }
    }
    return null;
  }

  let _proxyAvailable = null;
  async function checkProxy() {
    if (_proxyAvailable !== null) return _proxyAvailable;
    try {
      const resp = await fetch(`${CORS_PROXY_URL}/health`, { signal: AbortSignal.timeout(1500) });
      _proxyAvailable = resp.ok;
    } catch { _proxyAvailable = false; }
    _dbg(`[PROXY] 로컬 프록시 상태: ${_proxyAvailable ? "사용 가능" : "미실행"}`);
    return _proxyAvailable;
  }

  async function fetchViaProxy(url, options = {}) {
    const proxyUrl = `${CORS_PROXY_URL}/fetch?url=${encodeURIComponent(url)}`;
    return await fetch(proxyUrl, { signal: options.signal });
  }

  // ─── 4. 유틸리티 ──────────────────────────────────────────────────
  function getImageMediaType(name) {
    const ext = name.split(".").pop().toLowerCase();
    return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] || null;
  }

  function getVideoMediaType(name) {
    const ext = name.split(".").pop().toLowerCase();
    return { mp4: "video/mp4", webm: "video/webm", mov: "video/mp4", avi: "video/x-msvideo", mkv: "video/x-matroska", wmv: "video/x-ms-wmv" }[ext] || null;
  }

  function uint8ArrayToBase64(arr) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += 8192) {
      chunks.push(String.fromCharCode.apply(null, arr.subarray(i, i + 8192)));
    }
    return btoa(chunks.join(""));
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let i = 0; i < bytes.byteLength; i += 8192) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    }
    return btoa(chunks.join(""));
  }

  // ─── 5. PDF.js 로더 + extractPdfText ──────────────────────────────
  const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";
  let _pdfJsLoaded = null;

  function ensurePdfJsLoaded() {
    if (_pdfJsLoaded) return _pdfJsLoaded;
    if (typeof pdfjsLib !== "undefined") {
      _pdfJsLoaded = Promise.resolve();
      return _pdfJsLoaded;
    }
    _pdfJsLoaded = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${PDFJS_CDN}/pdf.min.js`;
      s.onload = () => {
        try {
          pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
          _dbg("[PDF] pdf.js CDN 로딩 완료");
          resolve();
        } catch (e) { reject(e); }
      };
      s.onerror = () => {
        _pdfJsLoaded = null;
        reject(new Error("pdf.js CDN 로딩 실패"));
      };
      document.head.appendChild(s);
    });
    return _pdfJsLoaded;
  }

  async function extractPdfText(base64Data) {
    await ensurePdfJsLoaded();
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const textParts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str).join(" ");
      if (pageText.trim()) {
        textParts.push(`[Page ${i}]\n${pageText}`);
      }
    }
    if (textParts.length === 0) {
      throw new Error("PDF에서 텍스트를 추출할 수 없습니다 (스캔된 이미지 PDF일 수 있음)");
    }
    return textParts.join("\n\n");
  }

  // ─── 6. ZIP 처리 ──────────────────────────────────────────────────
  function parseZipBuffer(buf) {
    const view = new DataView(buf);
    let eocdPos = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocdPos = i; break; }
    }
    if (eocdPos === -1) return null;
    const cdEntries = view.getUint16(eocdPos + 10, true);
    const cdOffset = view.getUint32(eocdPos + 16, true);
    const entries = [];
    let pos = cdOffset;
    for (let i = 0; i < cdEntries && pos + 46 <= buf.byteLength; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const uncompSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, pos + 46, nameLen));
      entries.push({ name, method, compSize, uncompSize, localOffset });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function _decompressDeflateRaw(dataBuf) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(dataBuf));
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { combined.set(c, off); off += c.length; }
    return combined;
  }

  async function extractTextFromZipBuffer(buf, depth = 0) {
    try {
      const entries = parseZipBuffer(buf);
      if (!entries) return null;
      const view = new DataView(buf);
      _dbg(`[ZIP buf d${depth}] 총 엔트리: ${entries.length}개`);

      const textEntries = entries.filter((e) =>
        /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(e.name) &&
        !e.name.endsWith("/") && e.uncompSize > 0 &&
        e.uncompSize < MAX_ZIP_TEXT_FILE_SIZE && (e.method === 0 || e.method === 8)
      ).slice(0, MAX_ZIP_TEXT_FILES);
      _dbg(`[ZIP buf d${depth}] 텍스트 파일: ${textEntries.length}개`);

      const results = [];
      for (const entry of textEntries) {
        try {
          const lhNameLen = view.getUint16(entry.localOffset + 26, true);
          const lhExtraLen = view.getUint16(entry.localOffset + 28, true);
          const dataStart = entry.localOffset + 30 + lhNameLen + lhExtraLen;
          const dataBuf = buf.slice(dataStart, dataStart + entry.compSize);
          let text;
          if (entry.method === 0) {
            text = new TextDecoder("utf-8").decode(dataBuf);
          } else {
            const dec = await _decompressDeflateRaw(dataBuf);
            text = new TextDecoder("utf-8").decode(dec);
          }
          if (text.length > MAX_PDF_TEXT_CHARS) {
            text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (${Math.round(text.length / 1024)}KB 중 일부만 포함)`;
          }
          results.push({ name: entry.name, text });
        } catch (e) { _dbg(`[ZIP buf d${depth}] ${entry.name}: 추출 실패 — ${e.message}`); }
      }
      _dbg(`[ZIP buf d${depth}] 텍스트 추출 완료: ${results.length}개`);

      const imageEntries = entries.filter((e) =>
        getImageMediaType(e.name) && !e.name.endsWith("/") &&
        e.uncompSize > 0 && e.uncompSize < MAX_ZIP_IMAGE_SIZE && (e.method === 0 || e.method === 8)
      ).slice(0, MAX_ZIP_IMAGES);

      const imageResults = [];
      for (const entry of imageEntries) {
        try {
          const lhNameLen = view.getUint16(entry.localOffset + 26, true);
          const lhExtraLen = view.getUint16(entry.localOffset + 28, true);
          const dataStart = entry.localOffset + 30 + lhNameLen + lhExtraLen;
          const dataBuf = buf.slice(dataStart, dataStart + entry.compSize);
          let raw;
          if (entry.method === 0) { raw = new Uint8Array(dataBuf); }
          else { raw = await _decompressDeflateRaw(dataBuf); }
          imageResults.push({ name: entry.name, base64: uint8ArrayToBase64(raw), mediaType: getImageMediaType(entry.name) });
        } catch (e) { _dbg(`[ZIP buf d${depth}] 이미지 ${entry.name}: 추출 실패 — ${e.message}`); }
      }

      if (depth === 0) {
        const nestedZips = entries.filter((e) =>
          /\.zip$/i.test(e.name) && !e.name.endsWith("/") &&
          e.uncompSize > 0 && e.uncompSize < MAX_NESTED_ZIP_SIZE && (e.method === 0 || e.method === 8)
        ).slice(0, MAX_NESTED_ZIPS);
        for (const nz of nestedZips) {
          try {
            const lhNameLen = view.getUint16(nz.localOffset + 26, true);
            const lhExtraLen = view.getUint16(nz.localOffset + 28, true);
            const dataStart = nz.localOffset + 30 + lhNameLen + lhExtraLen;
            const dataBuf = buf.slice(dataStart, dataStart + nz.compSize);
            let nestedBuf;
            if (nz.method === 0) { nestedBuf = dataBuf; }
            else { nestedBuf = (await _decompressDeflateRaw(dataBuf)).buffer; }
            const nested = await extractTextFromZipBuffer(nestedBuf, 1);
            if (nested) {
              for (const tr of nested.textResults) results.push({ name: `${nz.name} > ${tr.name}`, text: tr.text });
              for (const img of nested.imageResults) {
                if (imageResults.length < MAX_ZIP_IMAGES) imageResults.push({ ...img, name: `${nz.name} > ${img.name}` });
              }
            }
          } catch (err) { _dbg(`[ZIP nested] ${nz.name} 에러: ${err.message}`); }
        }
      }
      return { allEntries: entries, textResults: results, imageResults };
    } catch { return null; }
  }

  async function extractTextFilesFromZip(zipUrl, knownSize = 0, baseOffset = 0, depth = 0) {
    try {
      let fileSize;
      if (knownSize > 0) { fileSize = knownSize; }
      else {
        const headResp = await fetch(zipUrl, { method: "HEAD", credentials: "include" });
        if (!headResp.ok) return null;
        fileSize = parseInt(headResp.headers.get("content-length"));
      }
      if (!fileSize || fileSize < 22) return null;

      const eocdSize = Math.min(65558, fileSize);
      const eocdResp = await fetch(zipUrl, {
        credentials: "include",
        headers: { "Range": `bytes=${baseOffset + fileSize - eocdSize}-${baseOffset + fileSize - 1}` },
      });
      if (eocdResp.status !== 206) return null;
      const eocdBuf = await eocdResp.arrayBuffer();
      const eocdView = new DataView(eocdBuf);

      let eocdPos = -1;
      for (let i = eocdBuf.byteLength - 22; i >= 0; i--) {
        if (eocdView.getUint32(i, true) === 0x06054b50) { eocdPos = i; break; }
      }
      if (eocdPos === -1) return null;

      const cdEntries = eocdView.getUint16(eocdPos + 10, true);
      const cdSize = eocdView.getUint32(eocdPos + 12, true);
      const cdOffset = eocdView.getUint32(eocdPos + 16, true);

      const cdResp = await fetch(zipUrl, {
        credentials: "include",
        headers: { "Range": `bytes=${baseOffset + cdOffset}-${baseOffset + cdOffset + cdSize - 1}` },
      });
      if (cdResp.status !== 206) return null;
      const cdBuf = await cdResp.arrayBuffer();
      const cdView = new DataView(cdBuf);

      const entries = [];
      let pos = 0;
      for (let i = 0; i < cdEntries && pos + 46 <= cdBuf.byteLength; i++) {
        if (cdView.getUint32(pos, true) !== 0x02014b50) break;
        const method = cdView.getUint16(pos + 10, true);
        const compSize = cdView.getUint32(pos + 20, true);
        const uncompSize = cdView.getUint32(pos + 24, true);
        const nameLen = cdView.getUint16(pos + 28, true);
        const extraLen = cdView.getUint16(pos + 30, true);
        const commentLen = cdView.getUint16(pos + 32, true);
        const localOffset = cdView.getUint32(pos + 42, true);
        const name = new TextDecoder().decode(new Uint8Array(cdBuf, pos + 46, nameLen));
        entries.push({ name, method, compSize, uncompSize, localOffset });
        pos += 46 + nameLen + extraLen + commentLen;
      }
      _dbg(`[ZIP d${depth}] ${entries.length}개 엔트리`);

      const textEntries = entries.filter((e) =>
        /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(e.name) &&
        !e.name.endsWith("/") && e.uncompSize > 0 &&
        e.uncompSize < MAX_ZIP_TEXT_FILE_SIZE && (e.method === 0 || e.method === 8)
      ).slice(0, MAX_ZIP_TEXT_FILES);

      const results = [];
      for (const entry of textEntries) {
        try {
          const lhResp = await fetch(zipUrl, {
            credentials: "include",
            headers: { "Range": `bytes=${baseOffset + entry.localOffset}-${baseOffset + entry.localOffset + 29}` },
          });
          if (lhResp.status !== 206) continue;
          const lhBuf = await lhResp.arrayBuffer();
          const lhView = new DataView(lhBuf);
          const lhNameLen = lhView.getUint16(26, true);
          const lhExtraLen = lhView.getUint16(28, true);
          const dataStart = baseOffset + entry.localOffset + 30 + lhNameLen + lhExtraLen;
          const dataResp = await fetch(zipUrl, {
            credentials: "include",
            headers: { "Range": `bytes=${dataStart}-${dataStart + entry.compSize - 1}` },
          });
          if (dataResp.status !== 206) continue;
          const dataBuf = await dataResp.arrayBuffer();
          let text;
          if (entry.method === 0) { text = new TextDecoder("utf-8").decode(dataBuf); }
          else { text = new TextDecoder("utf-8").decode(await _decompressDeflateRaw(dataBuf)); }
          if (text.length > MAX_PDF_TEXT_CHARS) {
            text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (${Math.round(text.length / 1024)}KB 중 일부만 포함)`;
          }
          results.push({ name: entry.name, text });
        } catch (e) { _dbg(`[ZIP d${depth}] ${entry.name}: 추출 실패 — ${e.message}`); }
      }

      const imageEntries = entries.filter((e) =>
        getImageMediaType(e.name) && !e.name.endsWith("/") &&
        e.uncompSize > 0 && e.uncompSize < MAX_ZIP_IMAGE_SIZE && (e.method === 0 || e.method === 8)
      ).slice(0, MAX_ZIP_IMAGES);
      const imageResults = [];
      for (const entry of imageEntries) {
        try {
          const lhResp = await fetch(zipUrl, {
            credentials: "include",
            headers: { "Range": `bytes=${baseOffset + entry.localOffset}-${baseOffset + entry.localOffset + 29}` },
          });
          if (lhResp.status !== 206) continue;
          const lhBuf = await lhResp.arrayBuffer();
          const lhView = new DataView(lhBuf);
          const lhNameLen = lhView.getUint16(26, true);
          const lhExtraLen = lhView.getUint16(28, true);
          const dataStart = baseOffset + entry.localOffset + 30 + lhNameLen + lhExtraLen;
          const dataResp = await fetch(zipUrl, {
            credentials: "include",
            headers: { "Range": `bytes=${dataStart}-${dataStart + entry.compSize - 1}` },
          });
          if (dataResp.status !== 206) continue;
          const dataBuf = await dataResp.arrayBuffer();
          let raw;
          if (entry.method === 0) { raw = new Uint8Array(dataBuf); }
          else { raw = await _decompressDeflateRaw(dataBuf); }
          imageResults.push({ name: entry.name, base64: uint8ArrayToBase64(raw), mediaType: getImageMediaType(entry.name) });
        } catch (e) { _dbg(`[ZIP d${depth}] 이미지 ${entry.name}: 추출 실패 — ${e.message}`); }
      }

      if (depth === 0) {
        const allZipEntries = entries.filter((e) => /\.zip$/i.test(e.name) && !e.name.endsWith("/") && e.uncompSize > 0);
        const nestedZips = allZipEntries.filter((e) => (e.method === 0 || e.method === 8)).slice(0, MAX_NESTED_ZIPS);
        for (const nz of nestedZips) {
          try {
            const lhResp = await fetch(zipUrl, { credentials: "include", headers: { "Range": `bytes=${baseOffset + nz.localOffset}-${baseOffset + nz.localOffset + 29}` } });
            if (lhResp.status !== 206) continue;
            const lhBuf = await lhResp.arrayBuffer();
            const lhView = new DataView(lhBuf);
            const lhNameLen = lhView.getUint16(26, true);
            const lhExtraLen = lhView.getUint16(28, true);
            const nestedStart = baseOffset + nz.localOffset + 30 + lhNameLen + lhExtraLen;
            if (nz.method === 0) {
              const nested = await extractTextFilesFromZip(zipUrl, nz.uncompSize, nestedStart, 1);
              if (nested) {
                for (const tr of nested.textResults) results.push({ name: `${nz.name} > ${tr.name}`, text: tr.text });
                for (const img of nested.imageResults) { if (imageResults.length < MAX_ZIP_IMAGES) imageResults.push({ ...img, name: `${nz.name} > ${img.name}` }); }
              }
            } else if (nz.compSize < MAX_NESTED_ZIP_SIZE) {
              _dbg(`[ZIP nested] deflated ZIP 다운로드: ${nz.name} (${Math.round(nz.compSize / 1024 / 1024)}MB)`);
              const dataResp = await fetch(zipUrl, { credentials: "include", headers: { "Range": `bytes=${nestedStart}-${nestedStart + nz.compSize - 1}` } });
              if (dataResp.status !== 206) continue;
              const dataBuf = await dataResp.arrayBuffer();
              const combined = await _decompressDeflateRaw(dataBuf);
              const nested = await extractTextFromZipBuffer(combined.buffer, 1);
              if (nested) {
                for (const tr of nested.textResults) results.push({ name: `${nz.name} > ${tr.name}`, text: tr.text });
                for (const img of nested.imageResults) { if (imageResults.length < MAX_ZIP_IMAGES) imageResults.push({ ...img, name: `${nz.name} > ${img.name}` }); }
              }
            }
          } catch (err) { _dbg(`[ZIP nested] ${nz.name} 에러: ${err.message}`); }
        }
      }

      _dbg(`[ZIP d${depth}] 완료: 텍스트 ${results.length}개, 이미지 ${imageResults.length}개`);
      return { allEntries: entries, textResults: results, imageResults };
    } catch (err) {
      _dbg(`[ZIP d${depth}] 전체 에러: ${err?.message || "unknown"}`);
      return null;
    }
  }

  // ─── 7. SharePoint ────────────────────────────────────────────────
  const SP_API_ORIGINS = ["https://kohyoung-my.sharepoint.com", "https://kohyoung.sharepoint.com"];

  async function fetchSharePointFilesViaApi(oneDriveUrl, depth = 0, prefix = "") {
    if (depth > 3) return [];
    try {
      const url = new URL(oneDriveUrl);
      const origin = url.origin;
      const folderPath = decodeURIComponent(url.searchParams.get("id"));
      const layoutsIdx = url.pathname.indexOf("/_layouts/");
      let sitePath = layoutsIdx > 0 ? url.pathname.substring(0, layoutsIdx) : "";
      if (!sitePath) { const m = (folderPath || "").match(/^(\/sites\/[^/]+)/); if (m) sitePath = m[1]; }
      if (!sitePath) { const m = url.pathname.match(/^(\/sites\/[^/]+|\/personal\/[^/]+)/); if (m) sitePath = m[1]; }
      if (!folderPath || !sitePath) return null;

      const apiUrl = `${origin}${sitePath}/_api/web/GetFolderByServerRelativeUrl('${folderPath}')/Files?$select=Name,Length,ServerRelativeUrl`;
      const resp = await fetch(apiUrl, { headers: { "Accept": "application/json;odata=verbose" }, credentials: "include" });
      if (!resp.ok) return null;
      const data = await resp.json();
      const files = (data.d?.results || []).map((f) => ({ name: prefix ? `${prefix}/${f.Name}` : f.Name, size: f.Length, url: `${origin}${f.ServerRelativeUrl}` }));

      try {
        const foldersUrl = `${origin}${sitePath}/_api/web/GetFolderByServerRelativeUrl('${folderPath}')/Folders?$select=Name,ServerRelativeUrl`;
        const foldersResp = await fetch(foldersUrl, { headers: { "Accept": "application/json;odata=verbose" }, credentials: "include" });
        if (foldersResp.ok) {
          const foldersData = await foldersResp.json();
          for (const folder of (foldersData.d?.results || [])) {
            if (folder.Name === "Forms") continue;
            const subUrl = new URL(oneDriveUrl);
            subUrl.searchParams.set("id", folder.ServerRelativeUrl);
            const subFiles = await fetchSharePointFilesViaApi(subUrl.toString(), depth + 1, prefix ? `${prefix}/${folder.Name}` : folder.Name);
            if (subFiles) files.push(...subFiles);
          }
        }
      } catch { /* skip */ }
      return files;
    } catch { return null; }
  }

  async function fetchGraphChildren(apiOrigin, driveId, folderId) {
    const url = `${apiOrigin}/_api/v2.0/drives/${driveId}/items/${folderId}/children`;
    const resp = await fetch(url, { credentials: "include", headers: { "Accept": "application/json" } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.value || [];
  }

  async function trySharesApi(apiOrigin, encoded, depth = 0, fetchOpts = null) {
    if (depth > 3) return [];
    const isGraph = apiOrigin.includes("graph.microsoft.com");
    const basePath = isGraph ? `${apiOrigin}/v1.0/shares/${encoded}/driveItem` : `${apiOrigin}/_api/v2.0/shares/${encoded}/driveItem`;
    const dlUrlKey = isGraph ? "@microsoft.graph.downloadUrl" : "@content.downloadUrl";
    const opts = fetchOpts || { credentials: "include", headers: { "Accept": "application/json" } };
    _dbg(`[SP] trySharesApi: ${basePath.substring(0, 80)}... (creds=${opts.credentials})`);
    try {
      const childrenResp = await fetch(`${basePath}/children`, opts);
      _dbg(`[SP] children 응답: ${childrenResp.status}`);
      if (childrenResp.ok) {
        const data = await childrenResp.json();
        const items = data.value || [];
        if (items.length > 0) {
          const files = [];
          for (const item of items) {
            if (item.folder && item.parentReference?.driveId) {
              try {
                const subItems = await fetchGraphChildren(apiOrigin, item.parentReference.driveId, item.id);
                for (const sub of subItems) {
                  if (sub.folder && sub.parentReference?.driveId && depth < 3) {
                    const deepItems = await fetchGraphChildren(apiOrigin, sub.parentReference.driveId, sub.id);
                    for (const deep of deepItems) {
                      if (!deep.folder) files.push({ name: `${item.name}/${sub.name}/${deep.name}`, size: deep.size, url: deep[dlUrlKey] || deep["@content.downloadUrl"] || null });
                    }
                  } else if (!sub.folder) {
                    files.push({ name: `${item.name}/${sub.name}`, size: sub.size, url: sub[dlUrlKey] || sub["@content.downloadUrl"] || null });
                  }
                }
              } catch (err) { _dbg(`[SP] 하위 폴더 오류: ${item.name} — ${err.message}`); }
            } else {
              files.push({ name: item.name, size: item.size, url: item[dlUrlKey] || item["@content.downloadUrl"] || null });
            }
          }
          _dbg(`[SP] 폴더 파일 ${files.length}개 발견`);
          return files;
        }
      }
    } catch (err) { _dbg(`[SP] children 요청 실패: ${err.message}`); }
    try {
      const itemResp = await fetch(basePath, opts);
      _dbg(`[SP] driveItem 응답: ${itemResp.status}`);
      if (!itemResp.ok) return null;
      const item = await itemResp.json();
      if (item.file && item.name) {
        _dbg(`[SP] 단일 파일 발견: ${item.name} (${item.size} bytes)`);
        return [{ name: item.name, size: item.size, url: item[dlUrlKey] || item["@content.downloadUrl"] || null }];
      }
      if (item.name && !item.file) { _dbg(`[SP] driveItem은 폴더 — children 재시도`); }
      return null;
    } catch (err) { _dbg(`[SP] driveItem 요청 실패: ${err.message}`); return null; }
  }

  async function fetchSharePointViaSharesApi(sharingUrl) {
    try {
      const encoded = "u!" + btoa(sharingUrl).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const sharingOrigin = new URL(sharingUrl).origin;
      _dbg(`[SP] Shares API 시도: ${sharingUrl.substring(0, 80)}...`);
      _dbg(`[SP] encoded: ${encoded.substring(0, 40)}...`);

      const origins = [sharingOrigin, ...SP_API_ORIGINS.filter((o) => o !== sharingOrigin)];
      for (const origin of origins) {
        try {
          _dbg(`[SP] SharePoint origin 시도: ${origin}`);
          const result = await trySharesApi(origin, encoded);
          if (result) return result;
        } catch (err) { _dbg(`[SP] origin ${origin} 예외: ${err.message}`); }
      }

      const graphToken = findMsalToken("graph.microsoft.com");
      if (graphToken) {
        _dbg("[SP] MSAL Graph 토큰 발견 — Graph API 시도");
        try {
          const result = await trySharesApi("https://graph.microsoft.com", encoded, 0, { headers: { "Accept": "application/json", "Authorization": `Bearer ${graphToken}` } });
          if (result) return result;
        } catch (err) { _dbg(`[SP] Graph API 예외: ${err.message}`); }
      } else { _dbg("[SP] MSAL Graph 토큰 미발견"); }

      const spToken = findMsalToken("sharepoint.com");
      if (spToken) {
        _dbg("[SP] MSAL SharePoint 토큰 발견 — Bearer 인증 재시도");
        for (const origin of origins) {
          try {
            const result = await trySharesApi(origin, encoded, 0, { headers: { "Accept": "application/json", "Authorization": `Bearer ${spToken}` } });
            if (result) return result;
          } catch (err) { _dbg(`[SP] Bearer origin ${origin} 예외: ${err.message}`); }
        }
      }

      if (await checkProxy()) {
        _dbg("[SP] 로컬 프록시 + Graph API 시도");
        const tokens = [findMsalToken("graph.microsoft.com"), findMsalToken("sharepoint.com")].filter(Boolean);
        for (const token of tokens) {
          try {
            const graphUrl = `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem`;
            const proxyUrl = `${CORS_PROXY_URL}/fetch?url=${encodeURIComponent(graphUrl)}&token=${encodeURIComponent(token)}&accept=${encodeURIComponent("application/json")}`;
            const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
            if (resp.ok) {
              const item = await resp.json();
              _dbg(`[SP] Graph API 성공: ${item.name || "unknown"} (${item.size || 0} bytes)`);
              const dlUrl = item["@microsoft.graph.downloadUrl"] || item["@content.downloadUrl"];
              if (dlUrl) return [{ name: item.name, size: item.size, url: dlUrl }];
              if (item.folder) {
                const childUrl = `${graphUrl}/children`;
                const childProxyUrl = `${CORS_PROXY_URL}/fetch?url=${encodeURIComponent(childUrl)}&token=${encodeURIComponent(token)}&accept=${encodeURIComponent("application/json")}`;
                const childResp = await fetch(childProxyUrl, { signal: AbortSignal.timeout(15000) });
                if (childResp.ok) {
                  const childData = await childResp.json();
                  const files = (childData.value || []).filter(i => !i.folder).map(i => ({ name: i.name, size: i.size, url: i["@microsoft.graph.downloadUrl"] || null }));
                  if (files.length > 0) { _dbg(`[SP] Graph 폴더: ${files.length}개 파일`); return files; }
                }
              }
            } else { _dbg(`[SP] Graph API 응답: ${resp.status}`); }
          } catch (err) { _dbg(`[SP] Graph API 프록시 예외: ${err.message}`); }
        }
        if (tokens.length === 0) {
          _dbg("[SP] MSAL 토큰 미발견 — SharePoint 직접 프록시 시도");
          for (const origin of origins) {
            try {
              const apiUrl = `${origin}/_api/v2.0/shares/${encoded}/driveItem`;
              const proxyUrl = `${CORS_PROXY_URL}/fetch?url=${encodeURIComponent(apiUrl)}&accept=${encodeURIComponent("application/json")}`;
              const resp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
              if (resp.ok) {
                const item = await resp.json();
                if (item.file && item.name) return [{ name: item.name, size: item.size, url: item["@content.downloadUrl"] || null }];
              }
            } catch { /* next */ }
          }
        }
      }

      _dbg("[SP] 모든 Shares API 시도 실패");
      return null;
    } catch (err) { _dbg(`[SP] fetchSharePointViaSharesApi 예외: ${err.message}`); return null; }
  }

  async function processSharePointFileList(link, fileList) {
    const summary = fileList.map((f) => `- ${f.name} (${f.size ? Math.round(Number(f.size) / 1024 / 1024) + "MB" : "크기 불명"})`).join("\n");
    const textFiles = fileList.filter((f) => f.name && /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(f.name) && f.url);
    let textContents = "";
    for (const tf of textFiles) {
      try {
        let tfResp;
        try { tfResp = await fetch(tf.url, { credentials: "include" }); } catch { tfResp = null; }
        if (!tfResp || !tfResp.ok) {
          if (await checkProxy()) { try { tfResp = await fetchViaProxy(tf.url); } catch { tfResp = null; } }
        }
        if (!tfResp || !tfResp.ok) continue;
        const buf = await tfResp.arrayBuffer();
        let text = new TextDecoder("utf-8").decode(buf);
        if (text.length > MAX_PDF_TEXT_CHARS) text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (${Math.round(text.length / 1024)}KB 중 일부만 포함)`;
        textContents += `\n\n--- 텍스트 파일: ${tf.name} ---\n${text}\n--- 끝 ---`;
      } catch { /* skip */ }
    }

    const zipFiles = fileList.filter((f) => f.name && /\.zip$/i.test(f.name) && (f.url || f._buffer));
    const zipImages = [];
    for (const zf of zipFiles) {
      try {
        let zipResult = null;
        const fileSize = zf.size ? Number(zf.size) : (zf._buffer ? zf._buffer.byteLength : 0);
        const MAX_SP_FULL_DOWNLOAD = 200 * 1024 * 1024;
        if (zf._buffer) {
          _dbg(`[SP ZIP] ${zf.name}: 직접 다운로드 버퍼 사용 (${Math.round(zf._buffer.byteLength / 1024)}KB)`);
          zipResult = await extractTextFromZipBuffer(zf._buffer);
        } else if (zf.url) {
          if (fileSize > 0 && fileSize < MAX_SP_FULL_DOWNLOAD) {
            try {
              const zipResp = await fetch(zf.url, { credentials: "include" });
              if (zipResp.ok) zipResult = await extractTextFromZipBuffer(await zipResp.arrayBuffer());
            } catch (e) { _dbg(`[SP ZIP] ${zf.name}: 직접 다운로드 실패 — ${e.message}`); }
          }
          if (!zipResult && await checkProxy()) {
            try {
              _dbg(`[SP ZIP] ${zf.name}: 프록시 경유 다운로드 시도`);
              const zipResp = await fetchViaProxy(zf.url);
              if (zipResp.ok) zipResult = await extractTextFromZipBuffer(await zipResp.arrayBuffer());
            } catch (e) { _dbg(`[SP ZIP] ${zf.name}: 프록시 다운로드 실패 — ${e.message}`); }
          }
        }
        if (!zipResult && zf.url) zipResult = await extractTextFilesFromZip(zf.url, fileSize);
        if (!zipResult) continue;
        for (const tr of zipResult.textResults) textContents += `\n\n--- ZIP 내부 텍스트: ${zf.name} > ${tr.name} ---\n${tr.text}\n--- 끝 ---`;
        const allE = zipResult.allEntries;
        const tN = allE.filter((e) => /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt)$/i.test(e.name) && !e.name.endsWith("/"));
        const iN = allE.filter((e) => getImageMediaType(e.name) && !e.name.endsWith("/"));
        let zipSummary = `ZIP "${zf.name}" (총 ${allE.length}개 파일)`;
        if (tN.length > 0) { zipSummary += `\n  텍스트/로그 (${tN.length}개):`; for (const e of tN.slice(0, 30)) zipSummary += `\n    - ${e.name} (${Math.round(e.uncompSize / 1024)}KB)`; if (tN.length > 30) zipSummary += `\n    ... 외 ${tN.length - 30}개`; }
        if (iN.length > 0) zipSummary += `\n  이미지: ${iN.length}개`;
        const otherCount = allE.length - tN.length - iN.length;
        if (otherCount > 0) zipSummary += `\n  기타: ${otherCount}개`;
        textContents += `\n\n--- ZIP 파일 구성: ${zf.name} ---\n${zipSummary}\n--- 목록 끝 ---`;
        if (zipResult.imageResults) for (const img of zipResult.imageResults) zipImages.push({ ...img, zipName: zf.name });
      } catch (e) { _dbg(`[SP ZIP] ${zf.name}: 처리 실패 — ${e.message}`); }
    }

    const videoFiles = fileList.filter((f) => f.name && VIDEO_EXTENSIONS.test(f.name) && f.url && (!f.size || Number(f.size) < MAX_VIDEO_SIZE));
    for (const vf of videoFiles) {
      try {
        _dbg(`[VIDEO] SharePoint 동영상 프레임 추출: ${vf.name}`);
        const frames = await extractVideoFrames(vf.url);
        if (frames && frames.frames.length > 0) {
          textContents += `\n\n--- 동영상: ${vf.name} (${Math.round(frames.duration)}초, ${frames.width}x${frames.height}) ---\n${frames.frames.length}개 프레임 캡처 (${VIDEO_FRAME_INTERVAL_SEC}초 간격)\n--- 끝 ---`;
          for (const f of frames.frames) {
            if (zipImages.length < MAX_ZIP_IMAGES) {
              zipImages.push({ name: `${vf.name}_${Math.round(f.time)}s.jpg`, base64: f.base64, mediaType: "image/jpeg", zipName: vf.name });
            }
          }
        }
      } catch (e) { _dbg(`[VIDEO] ${vf.name}: 프레임 추출 실패 — ${e.message}`); }
    }

    const imageFiles = fileList.filter((f) => f.name && getImageMediaType(f.name) && f.url && (!f.size || Number(f.size) < MAX_ZIP_IMAGE_SIZE)).slice(0, MAX_ZIP_IMAGES - zipImages.length);
    for (const imgFile of imageFiles) {
      try {
        const imgResp = await fetch(imgFile.url, { credentials: "include" });
        if (!imgResp.ok) continue;
        const imgBuf = await imgResp.arrayBuffer();
        if (imgBuf.byteLength > MAX_ZIP_IMAGE_SIZE) continue;
        zipImages.push({ name: imgFile.name, base64: uint8ArrayToBase64(new Uint8Array(imgBuf)), mediaType: getImageMediaType(imgFile.name) });
      } catch { /* skip */ }
    }

    return { ...link, content: `SharePoint 폴더 "${link.text}" 내 파일 목록:\n${summary}${textContents}`, error: null, zipImages };
  }

  async function fetchSharePointFolder(link) {
    _dbg(`[SP] fetchSharePointFolder: ${link.url.substring(0, 80)}...`);
    try {
      const sharesFileList = await fetchSharePointViaSharesApi(link.url);
      if (sharesFileList && sharesFileList.length > 0) {
        _dbg(`[SP] Shares API 성공: ${sharesFileList.length}개 파일`);
        return await processSharePointFileList(link, sharesFileList);
      }
    } catch (err) { _dbg(`[SP] Shares API 예외: ${err.message}`); }

    const proxyOk = await checkProxy();
    if (proxyOk) {
      _dbg("[SP] 로컬 프록시로 SharePoint 파일 다운로드 시도");
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        const resp = await fetchViaProxy(link.url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          _dbg(`[SP] 프록시 다운로드 성공: ${Math.round(buf.byteLength / 1024)}KB`);
          const fileName = link.text || link.url.split("/").pop()?.split("?")[0] || "download";
          const sig = buf.byteLength >= 2 ? new Uint8Array(buf.slice(0, 2)) : null;
          const isZip = /\.zip$/i.test(fileName) || (sig && sig[0] === 0x50 && sig[1] === 0x4B);
          const isPdf = /\.pdf$/i.test(fileName) || (sig && sig[0] === 0x25 && sig[1] === 0x50);
          const isText = /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(fileName);
          if (isZip) {
            _dbg(`[SP] ZIP 파일 분석: ${fileName}`);
            const zipResult = await extractTextFromZipBuffer(buf);
            if (zipResult) {
              let content = "";
              for (const tr of zipResult.textResults) content += `\n\n--- ZIP 내부 텍스트: ${tr.name} ---\n${tr.text}\n--- 끝 ---`;
              const allE = zipResult.allEntries;
              const tN = allE.filter((e) => /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt)$/i.test(e.name) && !e.name.endsWith("/"));
              const iN = allE.filter((e) => getImageMediaType(e.name) && !e.name.endsWith("/"));
              let zipSum = `ZIP "${fileName}" (총 ${allE.length}개 파일)`;
              if (tN.length > 0) { zipSum += `\n  텍스트/로그 (${tN.length}개):`; for (const e of tN.slice(0, 30)) zipSum += `\n    - ${e.name} (${Math.round(e.uncompSize / 1024)}KB)`; }
              if (iN.length > 0) zipSum += `\n  이미지: ${iN.length}개`;
              content = `${zipSum}${content}`;
              const zipImages = [];
              if (zipResult.imageResults) for (const img of zipResult.imageResults) zipImages.push({ ...img, zipName: fileName });
              return { ...link, content, error: null, zipImages };
            }
          }
          if (isPdf) {
            _dbg(`[SP] PDF 파일 분석: ${fileName}`);
            await ensurePdfJsLoaded();
            const pdfText = await extractPdfText(arrayBufferToBase64(buf));
            return { ...link, content: `PDF "${fileName}":\n${pdfText.length > MAX_PDF_TEXT_CHARS ? pdfText.substring(0, MAX_PDF_TEXT_CHARS) + "\n... (일부만 포함)" : pdfText}`, error: null };
          }
          if (isText) {
            _dbg(`[SP] 텍스트 파일 분석: ${fileName}`);
            let text = new TextDecoder("utf-8").decode(buf);
            if (text.length > MAX_PDF_TEXT_CHARS) text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (일부만 포함)`;
            return { ...link, content: `텍스트 파일 "${fileName}":\n${text}`, error: null };
          }
          return { ...link, content: `SharePoint 파일: "${fileName}" (${Math.round(buf.byteLength / 1024)}KB) — 바이너리 파일`, error: null };
        }
        _dbg(`[SP] 프록시 응답 실패: HTTP ${resp.status}`);
      } catch (err) { _dbg(`[SP] 프록시 다운로드 예외: ${err.message}`); }
    }

    try {
      _dbg("[SP] 직접 fetch fallback 시도");
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(link.url, { credentials: "include", signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
          const buf = await response.arrayBuffer();
          const fileName = link.text || "download";
          return await processSharePointFileList(link, [{ name: fileName, size: buf.byteLength, url: null, _buffer: buf }]);
        }
        const finalUrl = response.url;
        let fileList = null;
        if (finalUrl.includes("/_layouts/15/onedrive.aspx") || finalUrl.includes("/AllItems.aspx")) fileList = await fetchSharePointFilesViaApi(finalUrl);
        else fileList = parseSharePointFolderHtml(await response.text(), link.url);
        if (fileList && fileList.length > 0) return await processSharePointFileList(link, fileList);
      }
    } catch (err) { _dbg(`[SP] 직접 fetch 예외: ${err.message}`); }

    _dbg("[SP] 모든 방법 실패");
    const msg = proxyOk ? "프록시 경유 다운로드 실패" : "CORS 차단 — 로컬 프록시(localhost:18765) 미실행";
    return { ...link, content: `SharePoint 파일 "${link.text}" — ${msg}. 수동 확인 필요\nURL: ${link.url}`, error: null };
  }

  function parseSharePointFolderHtml(html, folderUrl) {
    let origin = "";
    try { origin = new URL(folderUrl).origin; } catch { /* ignore */ }
    function buildFileUrl(item) {
      if (item.EncodedAbsUrl) return item.EncodedAbsUrl;
      if (item.FileRef && origin) return origin + item.FileRef;
      if (item.ServerUrl && origin) return origin + item.ServerUrl;
      return null;
    }
    try {
      const jsonPattern = /"ListData"\s*:\s*(\{[\s\S]*?\})\s*[,;]/;
      const match = html.match(jsonPattern);
      if (match) {
        const data = JSON.parse(match[1]);
        if (data.Row) return data.Row.map((item) => ({ name: item.FileLeafRef || item.LinkFilename, size: item.FileSizeDisplay || item.File_x0020_Size, url: buildFileUrl(item) }));
      }
      const renderMatch = html.match(/"Row"\s*:\s*\[([\s\S]*?)\]/);
      if (renderMatch) {
        const rows = JSON.parse(`[${renderMatch[1]}]`);
        return rows.map((item) => ({ name: item.FileLeafRef || item.LinkFilename || "unknown", size: item.FileSizeDisplay || "", url: buildFileUrl(item) }));
      }
      return null;
    } catch { return null; }
  }

  // ─── 8. NAS (Synology) ────────────────────────────────────────────
  const NAS_ZIP_INCLUDE_PATTERNS = [/^[^/]*\/KYLOG\/.*\.(LOG|log)$/, /^[^/]*\/SystemInfo\//, /^[^/]*\/kohyoung\/AOI\/[^/]*\.ini$/i, /^[^/]*\/kohyoung\/KYI\/Config\/[^/]*\.xml$/i];
  const NAS_ZIP_MAX_ENTRY_SIZE = 5 * 1024 * 1024;
  const NAS_ZIP_MAX_FULL_DOWNLOAD = 200 * 1024 * 1024;

  function isNasRelevantEntry(name) { return NAS_ZIP_INCLUDE_PATTERNS.some((p) => p.test(name)); }

  async function authenticateSynologySharing(sharingUrl) {
    const urlObj = new URL(sharingUrl);
    const pathParts = urlObj.pathname.split("/");
    const sharingIdx = pathParts.indexOf("sharing");
    if (sharingIdx === -1 || sharingIdx + 1 >= pathParts.length) throw new Error("Invalid NAS sharing URL");
    const sharingId = pathParts[sharingIdx + 1];
    const origin = urlObj.origin;
    const loginBody = new URLSearchParams({ api: "SYNO.Core.Sharing.Login", method: "login", version: "1", sharing_id: sharingId });
    const loginResp = await fetch(`${origin}/webapi/entry.cgi`, { method: "POST", body: loginBody, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    if (!loginResp.ok) throw new Error(`NAS login HTTP ${loginResp.status}`);
    const loginData = await loginResp.json();
    if (!loginData.success || !loginData.data?.sharing_sid) throw new Error("NAS sharing login failed");
    const sharingSid = loginData.data.sharing_sid;
    let filename = sharingId;
    try {
      const pageResp = await fetch(sharingUrl);
      if (pageResp.ok) {
        const html = await pageResp.text();
        const fnMatch = html.match(/file_name["\s:=]+["']([^"'<>\n]+?)["']/i) || html.match(/<title>([^<]+)<\/title>/);
        if (fnMatch && fnMatch[1] && !fnMatch[1].includes("Synology") && !fnMatch[1].includes("KYC_NAS")) filename = fnMatch[1].trim();
      }
    } catch {}
    if (filename === sharingId) {
      try {
        const listBody = new URLSearchParams({ api: "SYNO.FileStation.Sharing", method: "list", version: "3", sharing_sid: sharingSid });
        const listResp = await fetch(`${origin}/webapi/entry.cgi`, { method: "POST", body: listBody, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (listResp.ok) { const listData = await listResp.json(); if (listData.success && listData.data?.links) { const lnk = listData.data.links.find((l) => l.id === sharingId); if (lnk?.name) filename = lnk.name; else if (lnk?.path) filename = lnk.path.split("/").pop(); } }
      } catch {}
    }
    return { sharingId, sharingSid, filename, downloadUrl: `${origin}/fsdownload/${sharingId}/${encodeURIComponent(filename)}?sharing_sid=${sharingSid}`, origin };
  }

  async function fetchNasFile(link) {
    try {
      _dbg(`[NAS] 처리 시작: ${link.url}`);
      const auth = await authenticateSynologySharing(link.url);
      _dbg(`[NAS] 인증 완료: filename=${auth.filename}`);
      if (/\.zip$/i.test(auth.filename)) return await fetchNasZip(link, auth);
      return await fetchNasPlainFile(link, auth);
    } catch (err) {
      _dbg(`[NAS] 에러: ${err.message}`);
      return { type: "nas", text: link.text, content: `NAS 링크: ${link.url}\n(접근 실패: ${err.message})`, error: err.message };
    }
  }

  async function fetchNasZip(link, auth) {
    const { downloadUrl, filename } = auth;
    try {
      const headResp = await fetch(downloadUrl, { method: "HEAD" });
      if (!headResp.ok) throw new Error(`HEAD HTTP ${headResp.status}`);
      const fileSize = parseInt(headResp.headers.get("content-length"));
      if (!fileSize || fileSize < 22) throw new Error("Invalid file size");
      _dbg(`[NAS ZIP] 크기: ${Math.round(fileSize / 1024 / 1024)}MB`);
      const eocdSize = Math.min(65558, fileSize);
      const eocdResp = await fetch(downloadUrl, { headers: { Range: `bytes=${fileSize - eocdSize}-${fileSize - 1}` } });
      if (eocdResp.status !== 206) return await fetchNasZipFull(link, auth);
      const eocdBuf = await eocdResp.arrayBuffer();
      const eocdView = new DataView(eocdBuf);
      let eocdPos = -1;
      for (let i = eocdBuf.byteLength - 22; i >= 0; i--) { if (eocdView.getUint32(i, true) === 0x06054b50) { eocdPos = i; break; } }
      if (eocdPos === -1) throw new Error("EOCD not found");
      const cdSize = eocdView.getUint32(eocdPos + 12, true);
      const cdOffset = eocdView.getUint32(eocdPos + 16, true);
      const cdResp = await fetch(downloadUrl, { headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` } });
      if (cdResp.status !== 206) throw new Error("CD fetch failed");
      const cdBuf = await cdResp.arrayBuffer();
      const cdView = new DataView(cdBuf);
      const cdEntries = eocdView.getUint16(eocdPos + 10, true);
      const entries = [];
      let pos = 0;
      for (let i = 0; i < cdEntries && pos + 46 <= cdBuf.byteLength; i++) {
        if (cdView.getUint32(pos, true) !== 0x02014b50) break;
        const method = cdView.getUint16(pos + 10, true); const compSize = cdView.getUint32(pos + 20, true); const uncompSize = cdView.getUint32(pos + 24, true);
        const nameLen = cdView.getUint16(pos + 28, true); const extraLen = cdView.getUint16(pos + 30, true); const commentLen = cdView.getUint16(pos + 32, true);
        const localOffset = cdView.getUint32(pos + 42, true); const name = new TextDecoder().decode(new Uint8Array(cdBuf, pos + 46, nameLen));
        entries.push({ name, method, compSize, uncompSize, localOffset }); pos += 46 + nameLen + extraLen + commentLen;
      }
      const relevant = entries.filter((e) => !e.name.endsWith("/") && e.uncompSize > 0 && e.uncompSize < NAS_ZIP_MAX_ENTRY_SIZE && (e.method === 0 || e.method === 8) && isNasRelevantEntry(e.name));
      const results = [];
      for (const entry of relevant) {
        try {
          const lhResp = await fetch(downloadUrl, { headers: { Range: `bytes=${entry.localOffset}-${entry.localOffset + 29}` } });
          if (lhResp.status !== 206) continue;
          const lhBuf = await lhResp.arrayBuffer(); const lhView = new DataView(lhBuf);
          const lhNameLen = lhView.getUint16(26, true); const lhExtraLen = lhView.getUint16(28, true);
          const dataStart = entry.localOffset + 30 + lhNameLen + lhExtraLen;
          const dataResp = await fetch(downloadUrl, { headers: { Range: `bytes=${dataStart}-${dataStart + entry.compSize - 1}` } });
          if (dataResp.status !== 206) continue;
          const dataBuf = await dataResp.arrayBuffer();
          let text;
          if (entry.method === 0) text = new TextDecoder("utf-8", { fatal: false }).decode(dataBuf);
          else text = new TextDecoder("utf-8", { fatal: false }).decode(await _decompressDeflateRaw(dataBuf));
          if (text.length > MAX_PDF_TEXT_CHARS) text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (일부만 포함)`;
          results.push({ name: entry.name, text });
        } catch (err) { _dbg(`[NAS ZIP] ${entry.name} 추출 실패: ${err.message}`); }
      }
      return buildNasZipContent(link, filename, entries, results);
    } catch (err) {
      _dbg(`[NAS ZIP] Range 방식 실패: ${err.message}`);
      return await fetchNasZipFull(link, auth);
    }
  }

  async function fetchNasZipFull(link, auth) {
    const { downloadUrl, filename } = auth;
    const resp = await fetch(downloadUrl);
    if (!resp.ok) return { type: "nas", text: link.text, content: null, error: `HTTP ${resp.status}` };
    const contentLength = parseInt(resp.headers.get("content-length") || "0");
    if (contentLength > NAS_ZIP_MAX_FULL_DOWNLOAD) return { type: "nas", text: link.text, content: `NAS ZIP "${filename}" (${Math.round(contentLength / 1024 / 1024)}MB — 너무 커서 자동 분석 불가)`, error: null };
    const buffer = await resp.arrayBuffer();
    const zipResult = await extractTextFromZipBuffer(buffer);
    if (!zipResult) return { type: "nas", text: link.text, content: null, error: "ZIP 파싱 실패" };
    return buildNasZipContent(link, filename, [], (zipResult.textResults || []).filter((tr) => isNasRelevantEntry(tr.name)));
  }

  async function fetchNasPlainFile(link, auth) {
    const { downloadUrl, filename } = auth;
    const resp = await fetch(downloadUrl);
    if (!resp.ok) return { type: "nas", text: filename, content: null, error: `HTTP ${resp.status}` };
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength > 10 * 1024 * 1024) return { type: "nas", text: filename, content: `NAS 파일 "${filename}" (너무 큼)`, error: null };
    if (/\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(filename)) {
      let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      if (text.length > MAX_PDF_TEXT_CHARS) text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (일부만 포함)`;
      return { type: "nas", text: filename, content: text, error: null };
    }
    if (/\.pdf$/i.test(filename)) {
      try {
        const base64 = uint8ArrayToBase64(new Uint8Array(buffer));
        const pdfText = await extractPdfText(base64);
        return { type: "nas", text: filename, content: pdfText.length > MAX_PDF_TEXT_CHARS ? pdfText.substring(0, MAX_PDF_TEXT_CHARS) + "\n... (일부만 포함)" : pdfText, error: null };
      } catch (err) { return { type: "nas", text: filename, content: null, error: `PDF 추출 실패: ${err.message}` }; }
    }
    return { type: "nas", text: filename, content: `NAS 파일: ${filename} (자동 분석 미지원 형식)`, error: null };
  }

  function buildNasZipContent(link, filename, allEntries, textResults) {
    const totalCount = allEntries.filter((e) => !e.name.endsWith("/")).length;
    let content = `NAS CheckupTool ZIP "${filename}"`;
    content += totalCount > 0 ? ` (총 ${totalCount}개 파일, ${textResults.length}개 분석)` : ` (${textResults.length}개 파일 분석)`;
    for (const tr of textResults) content += `\n\n--- NAS ZIP: ${tr.name} ---\n${tr.text}\n--- 끝 ---`;
    if (content.length > MAX_TOTAL_LINKED_CHARS) content = content.substring(0, MAX_TOTAL_LINKED_CHARS) + "\n... (잘림)";
    return { type: "nas", text: link.text || filename, content, error: null, zipImages: [] };
  }

  // ─── 9. 외부 파일 ─────────────────────────────────────────────────
  async function fetchExternalFile(link) {
    try {
      const urls = [link.url];
      if (link.url.includes("/sharing/") && !link.url.includes("kohyoung.co:5001")) {
        const shareId = link.url.split("/sharing/").pop().split("?")[0];
        urls.unshift(`${new URL(link.url).origin}/fbdownload/${shareId}`);
      }
      let response = null;
      for (const url of urls) {
        try { const resp = await fetch(url, { redirect: "follow" }); if (resp.ok) { response = resp; break; } } catch { /* next */ }
      }
      if (!response) return { type: "external", text: link.text, content: `외부 링크: ${link.url}\n(접근 불가 — 수동 확인 필요)`, error: "접근 불가" };
      const contentType = response.headers.get("content-type") || "";
      const contentDisposition = response.headers.get("content-disposition") || "";
      const isZip = contentType.includes("application/zip") || contentType.includes("application/x-zip") || contentDisposition.toLowerCase().includes(".zip") || (contentType.includes("octet-stream") && link.url.includes(".zip"));
      const isHtml = contentType.includes("text/html");
      const isText = contentType.startsWith("text/") && !isHtml;
      if (isZip) {
        const buffer = await response.arrayBuffer();
        const zipResult = await extractTextFromZipBuffer(buffer);
        if (!zipResult) return { type: "external", text: link.text, content: null, error: "ZIP 파싱 실패" };
        let content = "";
        for (const tr of zipResult.textResults) content += `\n\n--- ZIP 내부 텍스트: ${tr.name} ---\n${tr.text}\n--- 끝 ---`;
        const allE = zipResult.allEntries;
        const tN = allE.filter((e) => /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt)$/i.test(e.name) && !e.name.endsWith("/"));
        const iN = allE.filter((e) => getImageMediaType(e.name) && !e.name.endsWith("/"));
        let zipSum = `외부 ZIP "${link.text}" (총 ${allE.length}개 파일)`;
        if (tN.length > 0) { zipSum += `\n  텍스트/로그 (${tN.length}개):`; for (const e of tN.slice(0, 30)) zipSum += `\n    - ${e.name} (${Math.round(e.uncompSize / 1024)}KB)`; }
        if (iN.length > 0) zipSum += `\n  이미지: ${iN.length}개`;
        content = `${zipSum}${content}`;
        return { type: "external", text: link.text, content: content.length > MAX_TOTAL_LINKED_CHARS ? content.substring(0, MAX_TOTAL_LINKED_CHARS) + "\n... (잘림)" : content, error: null, zipImages: (zipResult.imageResults || []).map((img) => ({ ...img, zipName: link.text })) };
      }
      if (isText || contentType.includes("octet-stream")) {
        const buffer = await response.arrayBuffer();
        let text = new TextDecoder("utf-8").decode(buffer);
        if (text.length > MAX_PDF_TEXT_CHARS) text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (일부만 포함)`;
        return { type: "external", text: link.text, content: text, error: null };
      }
      if (isHtml) return { type: "external", text: link.text, content: `외부 파일 공유 링크: ${link.url}\n(HTML 페이지 — 수동 확인 필요)`, error: null };
      return { type: "external", text: link.text, content: `외부 링크: ${link.url}\n(Content-Type: ${contentType})`, error: null };
    } catch (err) {
      return { type: "external", text: link.text, content: `외부 링크: ${link.url}\n(접근 실패: ${err.message})`, error: err.message };
    }
  }

  // ─── 10. 동영상 프레임 추출 ────────────────────────────────────────
  async function extractVideoFrames(videoUrl) {
    const resp = await fetch(videoUrl, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    try {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = () => reject(new Error("비디오 로딩 실패"));
        video.src = blobUrl;
      });
      const duration = video.duration;
      if (!duration || duration < 1) throw new Error("영상 길이 불명");
      const width = video.videoWidth;
      const height = video.videoHeight;
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(width, 1280);
      canvas.height = Math.round(canvas.width * height / width);
      const ctx = canvas.getContext("2d");
      const interval = Math.max(VIDEO_FRAME_INTERVAL_SEC, duration / MAX_VIDEO_FRAMES);
      const seekPoints = [];
      for (let t = 0; t < duration; t += interval) { seekPoints.push(t); if (seekPoints.length >= MAX_VIDEO_FRAMES) break; }
      const frames = [];
      for (const t of seekPoints) {
        try {
          video.currentTime = t;
          await new Promise((resolve, reject) => {
            const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
            video.addEventListener("seeked", onSeeked);
            setTimeout(() => { video.removeEventListener("seeked", onSeeked); reject(new Error("seek timeout")); }, 10000);
          });
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          const base64 = dataUrl.split(",")[1];
          frames.push({ time: t, base64 });
        } catch (e) { _dbg(`[VIDEO] 프레임 ${Math.round(t)}초: ${e.message}`); }
      }
      _dbg(`[VIDEO] ${frames.length}/${seekPoints.length} 프레임 캡처 완료 (${Math.round(duration)}초)`);
      return { frames, duration, width, height };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  // ─── 11. CRM 콘텐츠 추출 ──────────────────────────────────────────
  function findEditorArea() {
    const editors = document.querySelectorAll('[aria-label*="Rich Text Editor Control incident"]');
    for (const editor of editors) {
      if (editor.getAttribute("contenteditable") === "true") return editor;
    }
    return null;
  }

  function findContent(editor) {
    const tables = editor.querySelectorAll("table");
    let branchContent = null;
    let hqCell = null;
    for (const table of tables) {
      const rows = table.querySelectorAll("tr");
      for (let i = 0; i < rows.length; i++) {
        const cellText = rows[i].textContent.trim();
        if (cellText === "Branch Office" && i + 1 < rows.length) {
          const cell = rows[i + 1].querySelector("td");
          if (cell && cell.textContent.trim().length > 20) branchContent = cell.innerHTML;
        }
        if (cellText === "HQ" && i + 1 < rows.length) {
          const cell = rows[i + 1].querySelector("td");
          if (cell) hqCell = cell;
        }
      }
      if (!branchContent || branchContent.length < 30) {
        const rows2 = table.querySelectorAll("tr");
        let longestCell = null; let longestLen = 0; const hqInner = hqCell ? hqCell.innerHTML : null;
        for (const row of rows2) { const cell = row.querySelector("td"); if (!cell) continue; if (hqInner && cell.innerHTML === hqInner) continue; const len = cell.textContent.trim().length; if (len > longestLen) { longestLen = len; longestCell = cell; } }
        if (longestCell && longestLen > 30) branchContent = longestCell.innerHTML;
      }
    }
    if (!branchContent || branchContent.length < 30) {
      const table = tables[0]; if (table) { let beforeHtml = ""; let node = editor.firstChild; while (node && node !== table) { if (node.outerHTML) beforeHtml += node.outerHTML; else if (node.textContent) beforeHtml += node.textContent; node = node.nextSibling; } if (beforeHtml.length > 30) branchContent = beforeHtml; }
    }
    if (!branchContent || branchContent.length < 30) { let fullHtml = editor.innerHTML; if (hqCell) fullHtml = fullHtml.replace(hqCell.innerHTML, ""); if (fullHtml.length > 30) branchContent = fullHtml; }
    return { branchContent, hqCell };
  }

  function extractTextAndImages(html) {
    const div = document.createElement("div"); div.innerHTML = html;
    const imgs = div.querySelectorAll("img"); const imageMap = {};
    imgs.forEach((img, idx) => { const key = `[IMAGE_${idx + 1}]`; imageMap[key] = `<img src="${img.src}" alt="${img.alt || ""}" style="max-width:100%;">`; img.replaceWith(key); });
    const origin = window.location.origin;
    for (const a of div.querySelectorAll("a[href]")) { let href = a.getAttribute("href"); if (!href || href === "#") continue; if (href.startsWith("/")) href = origin + href; const lt = a.textContent.trim(); if (lt && href.startsWith("http")) a.replaceWith(`${lt} ( ${href} )`); }
    return { text: div.innerText.trim(), imageMap };
  }

  function extractLinks(editor) {
    const anchors = editor.querySelectorAll("a[href]"); const links = []; const seen = new Set(); const origin = window.location.origin;
    for (const a of anchors) {
      let href = a.getAttribute("href"); if (!href || href === "#") continue; if (href.startsWith("/")) href = origin + href; if (seen.has(href)) continue; seen.add(href);
      const text = a.textContent.trim();
      if (href.includes("msdyn_richtextfiles") && href.includes("msdyn_fileblob")) {
        const lowerText = (text || href).toLowerCase();
        const isTextFile = /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(lowerText);
        const isZipFile = /\.zip$/i.test(lowerText);
        links.push({ type: isTextFile ? "crm_text" : isZipFile ? "crm_zip" : "crm_pdf", url: href, text: text || "CRM 첨부" });
      } else if (href.includes(".sharepoint.com")) {
        links.push({ type: "sharepoint", url: href, text: text || "SharePoint 링크" });
      } else if (href.includes("kohyoung.co:5001/sharing/")) {
        links.push({ type: "nas", url: href, text: text || "NAS 공유 파일" });
      }
    }
    const allText = editor.innerText || "";
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/g; let urlMatch;
    while ((urlMatch = urlRegex.exec(allText)) !== null) {
      let url = urlMatch[0].replace(/[.,;:!?]+$/, ""); if (seen.has(url)) continue; seen.add(url);
      if (url.includes("crm5.dynamics.com") || url.includes("msdyn_richtextfiles")) continue;
      if (url.includes(".sharepoint.com")) { links.push({ type: "sharepoint", url, text: url.split("?")[0].split("/").pop() || "SharePoint 링크" }); continue; }
      if (url.includes("kohyoung.co:5001/sharing/")) { links.push({ type: "nas", url, text: url.split("/").pop() || "NAS" }); continue; }
      links.push({ type: "external", url, text: url.split("/").pop() || "외부 링크" });
    }
    return links;
  }

  function extractNasLinksFromPage(existingLinks) {
    const seen = new Set(existingLinks.map((l) => l.url)); const found = [];
    for (const a of document.querySelectorAll("a[href]")) { const href = a.getAttribute("href"); if (!href || seen.has(href)) continue; if (href.includes("kohyoung.co:5001/sharing/")) { seen.add(href); found.push({ type: "nas", url: href, text: a.textContent.trim() || "NAS" }); } }
    const bodyText = document.body.innerText || ""; const nasUrlRegex = /https?:\/\/[^\s<>"')\]]*kohyoung\.co:5001\/sharing\/[^\s<>"')\]]+/g; let m;
    while ((m = nasUrlRegex.exec(bodyText)) !== null) { let url = m[0].replace(/[.,;:!?]+$/, ""); if (seen.has(url)) continue; seen.add(url); found.push({ type: "nas", url, text: url.split("/").pop() || "NAS" }); }
    return found;
  }

  async function fetchCrmAnnotations() {
    const results = [];
    try {
      const idMatch = window.location.href.match(/id=([0-9a-f-]+)/i);
      if (!idMatch) return results;
      const apiUrl = `${window.location.origin}/api/data/v9.2/annotations?$filter=_objectid_value eq ${idMatch[1]} and isdocument eq true&$select=filename,filesize,annotationid,notetext&$orderby=createdon desc`;
      const resp = await fetch(apiUrl, { headers: { "Accept": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" } });
      if (!resp.ok) return results;
      const data = await resp.json();
      for (const note of (data.value || [])) {
        if (!note.filename) continue;
        const fname = note.filename.toLowerCase();
        const isText = /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|out|err)$/i.test(fname);
        const isPdf = /\.pdf$/i.test(fname); const isZip = /\.zip$/i.test(fname);
        if (!isText && !isPdf && !isZip) continue;
        try {
          const bodyUrl = `${window.location.origin}/api/data/v9.2/annotations(${note.annotationid})/documentbody`;
          const bodyResp = await fetch(bodyUrl, { headers: { "Accept": "application/json", "OData-MaxVersion": "4.0", "OData-Version": "4.0" } });
          if (!bodyResp.ok) continue;
          const base64 = (await bodyResp.json()).value; if (!base64) continue;
          if (isText) results.push({ type: "crm_text", text: note.filename, textContent: atob(base64), error: null });
          else if (isPdf) results.push({ type: "crm_pdf", text: note.filename, base64, error: null });
          else if (isZip) results.push({ type: "crm_zip", text: note.filename, base64, error: null });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return results;
  }

  async function fetchCrmTextFiles(links) {
    const results = [];
    for (const link of links.filter((l) => l.type === "crm_text")) {
      try {
        const response = await fetch(link.url, { credentials: "same-origin" });
        if (!response.ok) { results.push({ ...link, error: `HTTP ${response.status}`, textContent: null }); continue; }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > 10 * 1024 * 1024) { results.push({ ...link, error: "파일이 너무 큼 (>10MB)", textContent: null }); continue; }
        results.push({ ...link, error: null, textContent: new TextDecoder("utf-8").decode(buffer) });
      } catch (err) { results.push({ ...link, error: err.message, textContent: null }); }
    }
    return results;
  }

  async function fetchCrmZips(links) {
    const results = [];
    for (const link of links.filter((l) => l.type === "crm_zip")) {
      try {
        const response = await fetch(link.url, { credentials: "same-origin" });
        if (!response.ok) { results.push({ ...link, error: `HTTP ${response.status}`, base64: null }); continue; }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > 50 * 1024 * 1024) { results.push({ ...link, error: "ZIP too large (>50MB)", base64: null }); continue; }
        results.push({ ...link, error: null, base64: arrayBufferToBase64(buffer) });
      } catch (err) { results.push({ ...link, error: err.message, base64: null }); }
    }
    return results;
  }

  async function fetchCrmPdfs(links) {
    const results = [];
    for (const link of links.filter((l) => l.type === "crm_pdf")) {
      try {
        const response = await fetch(link.url, { credentials: "same-origin" });
        if (!response.ok) { results.push({ ...link, error: `HTTP ${response.status}`, base64: null }); continue; }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > 10 * 1024 * 1024) { results.push({ ...link, error: "PDF too large (>10MB)", base64: null }); continue; }
        results.push({ ...link, error: null, base64: arrayBufferToBase64(buffer) });
      } catch (err) { results.push({ ...link, error: err.message, base64: null }); }
    }
    return results;
  }

  // ─── 12. 프롬프트 빌드 ────────────────────────────────────────────
  function buildEnhancedPrompt(branchText, linkedContent, hasImages, dateStr, zipImageNames, existingHqReview) {
    const imageInstruction = hasImages ? `\n\n중요: 원문에 [IMAGE_1], [IMAGE_2] 등의 이미지 플레이스홀더가 있습니다. 리뷰 시 해당 이미지가 관련된 내용 바로 아래에 플레이스홀더를 그대로 유지해주세요.` : "";
    let zipImageInstruction = "";
    if (zipImageNames && zipImageNames.length > 0) {
      zipImageInstruction = `\n\n참고 파일에서 추출된 이미지 ${zipImageNames.length}장이 함께 첨부되어 있습니다:\n${zipImageNames.map((n, i) => `- [ZIP_IMG_${i + 1}]: ${n}`).join("\n")}\n[첨부 문서 분석] 섹션에서 각 이미지를 설명할 위치에 [ZIP_IMG_N] 플레이스홀더를 배치하고, 바로 아래 줄에 이미지에서 관찰되는 현상을 간결하게 기재하세요.\n플레이스홀더는 반드시 한 줄에 단독으로, 정확한 형식([ZIP_IMG_1], [ZIP_IMG_2] 등)으로 작성하세요.`;
    }
    let linkedSection = "";
    const _analyzed = [], _skipped = [], _truncated = [];
    if (linkedContent.length > 0) {
      let totalChars = 0; const parts = [];
      for (const item of linkedContent) {
        if (item.error && !item.content) { _skipped.push(`${item.text} (${item.error})`); continue; }
        if (!item.content) continue;
        let content = item.content; const remaining = MAX_TOTAL_LINKED_CHARS - totalChars;
        if (remaining <= 0) { _skipped.push(`${item.text} (토큰 제한)`); continue; }
        if (content.length > remaining) { _truncated.push(`${item.text} (${Math.round(item.content.length / 1024)}KB)`); content = content.substring(0, remaining) + `\n... (일부만 포함)`; }
        totalChars += content.length;
        const label = { crm_pdf: "PDF", crm_text: "Log/텍스트", external: "외부 파일", crm_zip: "ZIP", nas: "NAS 파일", sharepoint: "SharePoint 폴더" }[item.type] || item.type;
        parts.push(`--- ${label}: ${item.text} ---\n${content}\n--- 끝 ---`);
        _analyzed.push(`${item.text} (${Math.round(content.length / 1024)}KB)`);
      }
      linkedSection = `\n\n--- 첨부된 문서/리소스 내용 ---\n${parts.join("\n\n")}\n--- 첨부 내용 끝 ---\n\n위 첨부 내용을 분석하여 [첨부 문서 분석]과 [첨부 분석 끝] 마커 사이에 핵심 발견사항을 정리해주세요.`;
    }
    let referenceSection = "";
    if (existingHqReview && existingHqReview.length > 20) {
      const EXCLUDE_REVIEWERS = ["JACE", "BIBI", "AI"];
      const reviews = existingHqReview.split(/(?=\[TS HQ Reviewed by )/);
      const filtered = reviews.filter((r) => { const m = r.match(/\[TS HQ Reviewed by\s+(\w+)/i); if (!m) return false; return !EXCLUDE_REVIEWERS.some((ex) => m[1].toUpperCase().includes(ex)); });
      if (filtered.length > 0) {
        const sample = filtered.slice(-2).join("\n").substring(0, 3000);
        referenceSection = `\n\n--- 기존 HQ 리뷰 참고 (스타일 참조용) ---\n${sample}\n--- 참고 끝 ---\n위 기존 리뷰의 톤, 구조, 표현 방식을 참고하여 비슷한 스타일로 작성하세요. 단, 출력 형식 규칙은 반드시 지키세요.`;
      }
    }
    const prompt = `아래는 CRM 케이스의 Branch Office 영문 설명입니다. 한국어로 리뷰해주세요.\n오늘 날짜는 ${dateStr}입니다.${imageInstruction}${zipImageInstruction}\n\n--- Branch Office 원문 ---\n${branchText}\n--- 원문 끝 ---${linkedSection}${referenceSection}\n\n위 내용을 한국어로 리뷰해주세요. 반드시 한국어로 작성하세요.`;
    return { prompt, fileStats: { analyzed: _analyzed, skipped: _skipped, truncated: _truncated } };
  }

  // ─── 13. 리뷰 처리 ────────────────────────────────────────────────
  async function callApi(content) {
    const apiKey = getApiKey();
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 8192, system: SYSTEM_PROMPT, messages: [{ role: "user", content }] }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      if (resp.status === 401) throw new Error("API 키가 유효하지 않습니다. 설정에서 키를 확인해주세요.");
      if (resp.status === 429) throw new Error("API 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
      return { ok: false, status: resp.status, body: errBody };
    }
    const data = await resp.json();
    if (data.content && data.content.length > 0) return { ok: true, text: data.content[0].text };
    throw new Error("API 응답에 리뷰 내용이 없습니다.");
  }

  async function handleReview(branchText, hasImages, pdfData, textFileData, sharepointLinks, zipData, externalLinks, nasLinks, existingHqReview) {
    _debugLog = [];
    const today = new Date();
    const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;
    const linkedContent = [];
    const allZipImages = [];

    for (const pdf of pdfData) {
      if (pdf.error || !pdf.base64) { linkedContent.push({ type: "crm_pdf", text: pdf.text, content: null, error: pdf.error || "No data" }); continue; }
      try {
        let text = await extractPdfText(pdf.base64);
        if (text.length > MAX_PDF_TEXT_CHARS) text = text.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (일부만 포함)`;
        linkedContent.push({ type: "crm_pdf", text: pdf.text, content: text, error: null });
      } catch (err) { linkedContent.push({ type: "crm_pdf", text: pdf.text, content: null, error: err.message }); }
    }

    for (const tf of textFileData) {
      if (tf.error || !tf.textContent) { linkedContent.push({ type: "crm_text", text: tf.text, content: null, error: tf.error || "No data" }); continue; }
      let content = tf.textContent;
      if (content.length > MAX_PDF_TEXT_CHARS) content = content.substring(0, MAX_PDF_TEXT_CHARS) + `\n... (일부만 포함)`;
      linkedContent.push({ type: "crm_text", text: tf.text, content, error: null });
    }

    for (const zd of (zipData || [])) {
      if (zd.error || !zd.base64) { linkedContent.push({ type: "crm_zip", text: zd.text, content: null, error: zd.error || "No data" }); continue; }
      try {
        const raw = atob(zd.base64); const buf = new ArrayBuffer(raw.length); const arr = new Uint8Array(buf);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        const zipResult = await extractTextFromZipBuffer(buf);
        if (!zipResult) { linkedContent.push({ type: "crm_zip", text: zd.text, content: null, error: "ZIP 파싱 실패" }); continue; }
        let content = "";
        for (const tr of zipResult.textResults) content += `\n\n--- ZIP 내부 텍스트: ${tr.name} ---\n${tr.text}\n--- 끝 ---`;
        const allE = zipResult.allEntries;
        const tN = allE.filter((e) => /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt)$/i.test(e.name) && !e.name.endsWith("/"));
        const iN = allE.filter((e) => getImageMediaType(e.name) && !e.name.endsWith("/"));
        let zipSum = `ZIP "${zd.text}" (총 ${allE.length}개 파일)`;
        if (tN.length > 0) { zipSum += `\n  텍스트/로그 (${tN.length}개):`; for (const e of tN.slice(0, 30)) zipSum += `\n    - ${e.name} (${Math.round(e.uncompSize / 1024)}KB)`; }
        if (iN.length > 0) zipSum += `\n  이미지: ${iN.length}개`;
        content = `${zipSum}${content}`;
        if (zipResult.imageResults) for (const img of zipResult.imageResults) allZipImages.push({ ...img, zipName: zd.text });
        linkedContent.push({ type: "crm_zip", text: zd.text, content: content.length > MAX_TOTAL_LINKED_CHARS ? content.substring(0, MAX_TOTAL_LINKED_CHARS) + "\n... (잘림)" : content, error: null });
      } catch (err) { linkedContent.push({ type: "crm_zip", text: zd.text, content: null, error: err.message }); }
    }

    const spResults = await Promise.allSettled(sharepointLinks.map((link) => fetchSharePointFolder(link)));
    for (const result of spResults) {
      if (result.status === "fulfilled") { linkedContent.push(result.value); if (result.value.zipImages) allZipImages.push(...result.value.zipImages); }
      else linkedContent.push({ type: "sharepoint", text: "Unknown", content: null, error: result.reason?.message || "Unknown error" });
    }

    for (const extLink of (externalLinks || [])) {
      try { const result = await fetchExternalFile(extLink); linkedContent.push(result); if (result.zipImages) allZipImages.push(...result.zipImages); }
      catch (err) { linkedContent.push({ type: "external", text: extLink.text, content: null, error: err.message }); }
    }

    for (const nasLink of (nasLinks || [])) {
      try { const result = await fetchNasFile(nasLink); linkedContent.push(result); if (result.zipImages) allZipImages.push(...result.zipImages); }
      catch (err) { linkedContent.push({ type: "nas", text: nasLink.text, content: null, error: err.message }); }
    }

    const validPrefixes = { "image/jpeg": "/9j/", "image/png": "iVBOR", "image/gif": "R0lG", "image/webp": "UklG" };
    const validatedImages = allZipImages.filter((img) => {
      if (!img.base64 || img.base64.length < 200) return false;
      const prefix = validPrefixes[img.mediaType];
      if (prefix && !img.base64.startsWith(prefix)) return false;
      if (!prefix) return false;
      return true;
    });
    _dbg(`[IMG] 검증: ${allZipImages.length}개 중 ${validatedImages.length}개 유효`);

    const zipImageNames = validatedImages.map((img) => img.name);
    const buildResult = buildEnhancedPrompt(branchText, linkedContent, hasImages, dateStr, zipImageNames, existingHqReview);

    let result; let usedImages = validatedImages;
    if (validatedImages.length > 0) {
      const messageWithImages = [{ type: "text", text: buildResult.prompt }, ...validatedImages.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } }))];
      result = await callApi(messageWithImages);
      if (!result.ok && result.body && result.body.includes("Could not process image")) {
        _dbg("[API] 이미지 처리 실패, 개별 검증");
        const goodImages = [];
        for (const img of validatedImages) {
          try { const t = await callApi([{ type: "text", text: "이 이미지를 설명해주세요." }, { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } }]); if (t.ok) goodImages.push(img); } catch { /* skip */ }
        }
        usedImages = goodImages;
        if (goodImages.length > 0) {
          const retryBuild = buildEnhancedPrompt(branchText, linkedContent, hasImages, dateStr, goodImages.map(i => i.name), existingHqReview);
          result = await callApi([{ type: "text", text: retryBuild.prompt }, ...goodImages.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } }))]);
        } else {
          result = await callApi(buildEnhancedPrompt(branchText, linkedContent, hasImages, dateStr, [], existingHqReview).prompt);
        }
      }
    } else {
      result = await callApi(buildResult.prompt);
    }

    if (!result.ok) throw new Error(`API 오류 (${result.status}): ${result.body}`);
    return { text: result.text, zipImages: usedImages.map((img) => ({ name: img.name, base64: img.base64, mediaType: img.mediaType })), _debug: _debugLog, _fileStats: buildResult.fileStats };
  }

  // ─── 14. Xrm.Page 직접 접근 ───────────────────────────────────────
  function writeToXrm(hqHtml) {
    try {
      if (typeof Xrm === "undefined" || !Xrm.Page) return "xrm_not_available";
      const attr = Xrm.Page.getAttribute("new_ntxt_editor_local");
      if (!attr) return "attr_not_found";
      const currentVal = attr.getValue() || "";
      const parser = new DOMParser();
      const doc = parser.parseFromString(currentVal, "text/html");
      const rows = doc.querySelectorAll("tr");
      let hqCell = null;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].textContent.trim() === "HQ" && i + 1 < rows.length) {
          hqCell = rows[i + 1].querySelector("td");
          break;
        }
      }
      if (!hqCell) return "hq_not_found";
      hqCell.innerHTML = hqHtml;
      const wrapper = doc.querySelector(".ck-content") || doc.body.firstElementChild;
      attr.setValue(wrapper ? wrapper.outerHTML : doc.body.innerHTML);
      attr.setSubmitMode("always");
      attr.fireOnChange();
      _dbg("[XRM] Xrm.Page 직접 쓰기 성공");
      return "ok";
    } catch (e) {
      _dbg(`[XRM] Xrm.Page 에러: ${e.message}`);
      return "error:" + e.message;
    }
  }

  // ─── 15. UI ────────────────────────────────────────────────────────
  function linkifyUrls(text) {
    return text.replace(/(https?:\/\/[^\s)<>]+)/g, '<a href="$1" target="_blank" style="color:#1976D2;text-decoration:underline;">$1</a>');
  }

  function buildReviewHtml(reviewText, zipImages) {
    const sectionKeywords = ["요약", "상세", "장비", "환경", "조치", "참고", "현상", "원인", "배경", "분석", "이력", "결론", "첨부"];
    let inLinkedSection = false;
    const zipImgMap = {};
    if (zipImages && zipImages.length > 0) for (let i = 0; i < zipImages.length; i++) zipImgMap[i + 1] = zipImages[i];

    return reviewText.split("\n").map((line) => {
      line = line.replace(/\*\*/g, "").replace(/^#{1,3}\s*/, "");
      const zipImgMatch = line.trim().match(/^\[ZIP_IMG_(\d+)\]$/);
      if (zipImgMatch) { const img = zipImgMap[parseInt(zipImgMatch[1], 10)]; if (img) return `<p style="margin: 0;"><img src="data:${img.mediaType};base64,${img.base64}" alt="${img.name}" style="max-width:100%;"></p>`; return ""; }
      if (line.startsWith("[첨부 문서 분석]") || line.startsWith("[첨부문서분석]")) { inLinkedSection = true; return `<p style="margin: 0;"><span style="color:#FF6F00;">━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</span></p><p style="margin: 0;"><b><span style="color:#FF6F00;">참고자료 파일 분석</span></b></p>`; }
      if (line.startsWith("[첨부 분석 끝]") || line.startsWith("[첨부분석끝]")) { inLinkedSection = false; return ""; }
      if (inLinkedSection) {
        if (line.startsWith("[파일:") || line.startsWith("[PDF:") || line.startsWith("[폴더:") || line.startsWith("[Log") || line.startsWith("[ZIP")) return `<p style="margin: 0;">&nbsp;</p><p style="margin: 0;"><b><span style="color:#FF6F00;">${linkifyUrls(line.replace(/^\[|\]$/g, ""))}</span></b></p>`;
        if (line.trim() === "") return `<p style="margin: 0;">&nbsp;</p>`;
        return `<p style="margin: 0;">&nbsp;&nbsp;&nbsp;&nbsp;${linkifyUrls(line)}</p>`;
      }
      if (line.startsWith("[TS HQ")) return `<p style="margin: 0;"><b><span style="color:#2E7D32;">${line}</span></b></p>`;
      const trimmed = line.trim();
      const isSection = sectionKeywords.some((kw) => trimmed.startsWith(kw));
      if (isSection && trimmed.length < 30) return `<p style="margin: 0;">&nbsp;</p><p style="margin: 0;"><b><span style="color:#2E7D32;">${trimmed}</span></b></p>`;
      if (trimmed === "") return "";
      return `<p style="margin: 0;">&nbsp;&nbsp;&nbsp;&nbsp;${linkifyUrls(line)}</p>`;
    }).join("");
  }

  function showModal(title, content, isLoading, hasLinks) {
    removeModal();
    const overlay = document.createElement("div"); overlay.id = MODAL_ID;
    overlay.style.cssText = "position:fixed!important;inset:0!important;z-index:100000!important;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
    const modal = document.createElement("div");
    modal.style.cssText = "background:white;border-radius:12px;padding:28px;max-width:700px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);font-family:'Malgun Gothic','Segoe UI',sans-serif;";
    const titleEl = document.createElement("h3"); titleEl.textContent = title;
    titleEl.style.cssText = "margin:0 0 16px 0;font-size:18px;color:#2A302F;border-bottom:2px solid #61A229;padding-bottom:8px;";
    modal.appendChild(titleEl);
    const bodyEl = document.createElement("div"); bodyEl.style.cssText = "font-size:14px;line-height:1.7;color:#333;white-space:pre-wrap;";
    if (isLoading) {
      const loadingMsg = hasLinks ? "첨부 파일을 분석하고 AI 리뷰를 생성하고 있습니다... (약 20~30초)" : "AI가 리뷰를 생성하고 있습니다... (약 10~15초)";
      bodyEl.innerHTML = `<div style="text-align:center;padding:40px 0;"><div style="display:inline-block;width:40px;height:40px;border:4px solid #e0e0e0;border-top-color:#61A229;border-radius:50%;animation:ky-spin 0.8s linear infinite;"></div><p id="ky-loading-msg" style="margin-top:16px;color:#666;">${loadingMsg}</p></div><style>@keyframes ky-spin{to{transform:rotate(360deg);}}</style>`;
    } else { bodyEl.textContent = content; }
    modal.appendChild(bodyEl);
    if (!isLoading) {
      const btnRow = document.createElement("div"); btnRow.style.cssText = "margin-top:20px;text-align:right;";
      const closeBtn = document.createElement("button"); closeBtn.textContent = "닫기";
      closeBtn.style.cssText = "padding:8px 24px;background:#61A229;color:white;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600;";
      closeBtn.addEventListener("click", removeModal); btnRow.appendChild(closeBtn); modal.appendChild(btnRow);
    }
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay && !isLoading) removeModal(); });
    document.body.appendChild(overlay);
    return bodyEl;
  }

  function removeModal() { const el = document.getElementById(MODAL_ID); if (el) el.remove(); }
  function updateLoadingMessage(msg) { const el = document.getElementById("ky-loading-msg"); if (el) el.textContent = msg; }

  function createReviewButton() {
    if (!window.location.href.includes("etn=incident")) return;
    const existingBtn = document.getElementById(BUTTON_ID);
    if (existingBtn && existingBtn.dataset.source === "bookmarklet") return;
    if (existingBtn) { existingBtn.remove(); _dbg("[UI] 확장 프로그램 버튼 제거 (북마클릿으로 대체)"); }

    let targetHeading = null;
    const headings = document.querySelectorAll("h2");
    for (const h of headings) {
      if (h.textContent.trim().startsWith("Issue Description")) { targetHeading = h; break; }
    }

    const btn = document.createElement("button"); btn.id = BUTTON_ID; btn.dataset.source = "bookmarklet"; btn.textContent = "리뷰";
    btn.style.cssText = "margin-left:12px;padding:4px 16px;background-color:#61A229;color:white;border:none;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;vertical-align:middle;transition:background-color 0.2s;";
    btn.addEventListener("mouseenter", () => { btn.style.backgroundColor = "#4E8A22"; });
    btn.addEventListener("mouseleave", () => { btn.style.backgroundColor = "#61A229"; });
    btn.addEventListener("click", handleReviewClick);

    const gear = document.createElement("button"); gear.id = BUTTON_ID + "-gear"; gear.textContent = "⚙";
    gear.style.cssText = "margin-left:6px;width:26px;height:26px;background:white;border:1px solid #ddd;border-radius:50%;font-size:13px;cursor:pointer;color:#666;vertical-align:middle;transition:all 0.2s;";
    gear.addEventListener("mouseenter", () => { gear.style.borderColor = "#61A229"; gear.style.color = "#61A229"; });
    gear.addEventListener("mouseleave", () => { gear.style.borderColor = "#ddd"; gear.style.color = "#666"; });
    gear.addEventListener("click", toggleSettingsPanel);

    if (targetHeading) {
      targetHeading.parentNode.insertBefore(gear, targetHeading.nextSibling);
      targetHeading.parentNode.insertBefore(btn, targetHeading.nextSibling);
      _dbg("[UI] 리뷰 버튼 생성 완료 (Issue Description h2 옆)");
    } else {
      const wrap = document.createElement("div");
      wrap.id = BUTTON_ID + "-wrap";
      wrap.style.cssText = "position:fixed!important;bottom:24px!important;right:24px!important;z-index:99998!important;display:flex!important;gap:6px!important;align-items:center!important;";
      wrap.appendChild(btn);
      wrap.appendChild(gear);
      document.body.appendChild(wrap);
      _dbg("[UI] 리뷰 버튼 생성 완료 (플로팅 fallback — h2 미발견)");
    }
  }

  function toggleSettingsPanel() {
    const existing = document.getElementById(SETTINGS_ID);
    if (existing) { existing.remove(); return; }
    const panel = document.createElement("div"); panel.id = SETTINGS_ID;
    panel.style.cssText = "position:fixed!important;top:80px!important;right:20px!important;z-index:99999!important;background:white;border-radius:12px;padding:20px;width:320px;box-shadow:0 8px 32px rgba(0,0,0,0.2);font-family:'Malgun Gothic','Segoe UI',sans-serif;";
    const title = document.createElement("div"); title.innerHTML = `<b style="font-size:15px;color:#2A302F;">KY CRM Review v${VERSION}</b>`;
    title.style.cssText = "margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #61A229;display:flex;justify-content:space-between;align-items:center;";
    const closeX = document.createElement("span"); closeX.textContent = "✕"; closeX.style.cssText = "cursor:pointer;color:#999;font-size:18px;";
    closeX.addEventListener("click", () => panel.remove()); title.appendChild(closeX);
    panel.appendChild(title);

    const keyLabel = document.createElement("label"); keyLabel.textContent = "API Key"; keyLabel.style.cssText = "font-size:12px;color:#666;display:block;margin-bottom:4px;";
    panel.appendChild(keyLabel);
    const keyInput = document.createElement("input"); keyInput.type = "text"; keyInput.value = localStorage.getItem("ky_crm_api_key") || "";
    keyInput.placeholder = "sk-... (비워두면 기본 키 사용)";
    keyInput.style.cssText = "width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;margin-bottom:12px;";
    keyInput.addEventListener("change", () => { const v = keyInput.value.trim(); if (v) localStorage.setItem("ky_crm_api_key", v); else localStorage.removeItem("ky_crm_api_key"); });
    panel.appendChild(keyInput);

    const checkRow = document.createElement("label"); checkRow.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:8px;";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = isLinkAnalysisEnabled();
    checkbox.addEventListener("change", () => localStorage.setItem("ky_crm_link_analysis", checkbox.checked ? "true" : "false"));
    const checkLabel = document.createElement("span"); checkLabel.textContent = "첨부 링크 자동 분석"; checkLabel.style.cssText = "font-size:13px;";
    checkRow.appendChild(checkbox); checkRow.appendChild(checkLabel); panel.appendChild(checkRow);

    const info = document.createElement("div"); info.style.cssText = "margin-top:12px;padding-top:8px;border-top:1px solid #eee;font-size:11px;color:#999;";
    info.textContent = `Bookmarklet v${VERSION} — Main World 실행`;
    panel.appendChild(info);
    document.body.appendChild(panel);
  }

  // ─── 16. 탭 전환 & 메인 핸들러 ──────────────────────────────────────
  async function ensureIssueDescriptionTab() {
    if (findEditorArea()) return true;
    _dbg("[TAB] 에디터 미발견 — Issue Description & Note 탭 자동 전환 시도");
    const moreTabs = document.querySelector('[role="tab"][aria-label="More Tabs"]');
    if (moreTabs) {
      moreTabs.click();
      await new Promise(r => setTimeout(r, 600));
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent.trim() === "Issue Description & Note") {
          _dbg("[TAB] Issue Description & Note 메뉴 아이템 클릭");
          item.click();
          for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (findEditorArea()) { _dbg("[TAB] 에디터 발견 — 탭 전환 성공"); return true; } }
          break;
        }
      }
    }
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
      const label = tab.getAttribute("aria-label") || tab.textContent.trim();
      if (label.includes("Issue Description")) {
        tab.click();
        for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 300)); if (findEditorArea()) return true; }
        break;
      }
    }
    _dbg("[TAB] 탭 전환 실패");
    return false;
  }

  async function handleReviewClick() {
    await ensureIssueDescriptionTab();
    const editor = findEditorArea();
    if (!editor) { alert("에디터를 찾을 수 없습니다. Issue Description & Note 탭을 수동으로 선택해주세요."); return; }
    const { branchContent, hqCell } = findContent(editor);
    if (!branchContent) { alert("케이스 내용을 찾을 수 없습니다."); return; }
    if (!hqCell) { alert("HQ 셀을 찾을 수 없습니다."); return; }
    const { text: branchText, imageMap } = extractTextAndImages(branchContent);
    if (!branchText || branchText.length < 10) { alert("케이스 내용이 너무 짧습니다."); return; }

    const links = extractLinks(editor);
    const pageNasLinks = extractNasLinksFromPage(links);
    if (pageNasLinks.length > 0) links.push(...pageNasLinks);
    const hasImages = Object.keys(imageMap).length > 0;
    const hasLinks = links.length > 0;
    const linkAnalysisEnabled = isLinkAnalysisEnabled();
    _dbg(`[LINK] 추출된 링크: ${links.length}개 (SP: ${links.filter(l => l.type === "sharepoint").length}, NAS: ${links.filter(l => l.type === "nas").length}, CRM PDF: ${links.filter(l => l.type === "crm_pdf").length}, CRM Text: ${links.filter(l => l.type === "crm_text").length}, CRM ZIP: ${links.filter(l => l.type === "crm_zip").length}, 외부: ${links.filter(l => l.type === "external").length})`);
    for (const l of links) _dbg(`[LINK]   ${l.type}: ${l.text} → ${l.url.substring(0, 80)}...`);
    _dbg(`[LINK] 링크 분석 활성화: ${linkAnalysisEnabled}`);

    showModal("AI 리뷰 생성 중", "", true, hasLinks && linkAnalysisEnabled);

    try {
      let pdfData = [], textFileData = [], sharepointLinks = [], zipData = [], externalLinks = [], nasLinks = [];

      if (linkAnalysisEnabled) {
        updateLoadingMessage("첨부 파일을 가져오고 있습니다...");
        if (hasLinks) {
          pdfData = await fetchCrmPdfs(links);
          textFileData = await fetchCrmTextFiles(links);
          zipData = await fetchCrmZips(links);
          sharepointLinks = links.filter((l) => l.type === "sharepoint");
          externalLinks = links.filter((l) => l.type === "external");
          nasLinks = links.filter((l) => l.type === "nas");
          if (nasLinks.length > 0) updateLoadingMessage("NAS 공유 파일을 다운로드하고 있습니다...");
        }
        const annotations = await fetchCrmAnnotations();
        for (const a of annotations) {
          if (a.type === "crm_text") textFileData.push(a);
          else if (a.type === "crm_pdf") pdfData.push(a);
          else if (a.type === "crm_zip") zipData.push(a);
        }
        updateLoadingMessage("AI가 리뷰를 생성하고 있습니다... (약 20~30초)");
      }

      const existingHqText = hqCell ? hqCell.textContent.trim() : "";

      const reviewResult = await handleReview(branchText, hasImages, pdfData, textFileData, sharepointLinks, zipData, externalLinks, nasLinks, existingHqText);

      const reviewText = reviewResult.text;
      const zipImages = reviewResult.zipImages || [];
      if (reviewResult._debug) console.log("[KY-BM DEBUG]", reviewResult._debug.join("\n"));
      if (reviewResult._fileStats) console.log("[KY-BM 파일분석]", reviewResult._fileStats);

      let reviewHtml = buildReviewHtml(reviewText, zipImages);
      removeModal();
      await new Promise((r) => setTimeout(r, 300));

      let finalHtml = reviewHtml;
      for (const [placeholder, imgTag] of Object.entries(imageMap)) {
        finalHtml = finalHtml.replace(placeholder, `</p>${imgTag}<p>`);
      }

      const xrmResult = writeToXrm(finalHtml);

      if (xrmResult !== "ok") {
        _dbg(`[XRM] Xrm.Page 결과: ${xrmResult}, DOM fallback 시도`);
        const fe = findEditorArea();
        if (fe) {
          const fc = findContent(fe);
          if (fc.hqCell && fc.hqCell.isConnected) {
            fc.hqCell.innerHTML = finalHtml;
            fe.focus();
            const range = document.createRange();
            range.selectNodeContents(fc.hqCell);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("insertText", false, " ");
            document.execCommand("delete", false, null);
            fe.dispatchEvent(new Event("input", { bubbles: true }));
            fe.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }

      showModal("리뷰 완료", reviewText, false);
    } catch (err) {
      removeModal();
      alert("리뷰 생성 중 오류: " + err.message);
      console.error("[KY-BM]", err);
    }
  }

  // ─── 17. 초기화 & 지속성 ──────────────────────────────────────────
  let _observer = null;
  let _intervalId = null;
  let _initRunning = false;

  function injectStyles() {
    if (document.getElementById("ky-crm-review-styles")) return;
    const style = document.createElement("style");
    style.id = "ky-crm-review-styles";
    style.textContent = [
      "#ky-crm-review-btn-wrap{position:fixed!important;bottom:24px!important;right:24px!important;z-index:99998!important;display:flex!important;gap:6px!important;align-items:center!important;}",
      "#ky-crm-review-modal{position:fixed!important;inset:0!important;z-index:100000!important;}",
      "#ky-crm-settings-panel{position:fixed!important;top:80px!important;right:20px!important;z-index:99999!important;}"
    ].join("\n");
    document.head.appendChild(style);
  }

  async function init() {
    injectStyles();
    if (_initRunning) return;
    const existingBtn = document.getElementById(BUTTON_ID);
    if (existingBtn && existingBtn.dataset.source === "bookmarklet") return;
    if (!window.location.href.includes("etn=incident")) return;

    const h2Found = [...document.querySelectorAll("h2")].some(h => h.textContent.trim().startsWith("Issue Description"));
    if (!h2Found) {
      _initRunning = true;
      try {
        _dbg("[INIT] h2 미발견 — 탭 자동 전환 시도");
        await ensureIssueDescriptionTab();
      } finally {
        _initRunning = false;
      }
    }

    createReviewButton();
  }

  async function reinit() {
    _dbg("[INIT] reinit 호출");
    const wrap = document.getElementById(BUTTON_ID + "-wrap");
    if (wrap) wrap.remove();
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();
    const gear = document.getElementById(BUTTON_ID + "-gear");
    if (gear) gear.remove();
    await init();
  }

  function destroy() {
    if (_observer) { _observer.disconnect(); _observer = null; }
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    const wrap = document.getElementById(BUTTON_ID + "-wrap");
    if (wrap) wrap.remove();
    const btn = document.getElementById(BUTTON_ID);
    if (btn) btn.remove();
    const gear = document.getElementById(BUTTON_ID + "-gear");
    if (gear) gear.remove();
    const settings = document.getElementById(SETTINGS_ID);
    if (settings) settings.remove();
    removeModal();
    delete window.__kyCrmReview;
    _dbg("[INIT] destroy 완료");
  }

  let _moTimer = null;
  _observer = new MutationObserver(() => {
    if (_moTimer) return;
    _moTimer = setTimeout(() => { _moTimer = null; const b = document.getElementById(BUTTON_ID); if (!b || b.dataset.source !== "bookmarklet") init(); }, 500);
  });
  _observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(init, 500);
  setTimeout(init, 2000);
  setTimeout(init, 4000);

  _intervalId = setInterval(() => {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn || btn.dataset.source !== "bookmarklet") init();
  }, 2000);

  window.__kyCrmReview = { reinit, destroy, version: VERSION };
  _dbg(`[INIT] KY CRM Review Bookmarklet v${VERSION} 로딩 완료`);
})();
