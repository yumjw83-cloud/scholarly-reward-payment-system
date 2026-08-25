/**
 * ============================================================
 * IPFS Pinata 오프체인 저장 연동 실험 (Step 3)
 * ============================================================
 *
 * 실험 목적:
 *   3.2.2절 설계의 오프체인 저장 구조를 검증한다.
 *   DID 문서 및 VC 원문을 IPFS에 업로드하고,
 *   반환된 CID의 SHA-256 해시를 온체인 앵커링값으로 산출한다.
 *
 * 검증 항목:
 *   1. DID 문서 → Pinata IPFS 업로드 → CID 반환
 *   2. VC 원문  → Pinata IPFS 업로드 → CID 반환
 *   3. CID + 원본 해시 일치 검증 (Step 2 vc_hashes.json 활용)
 *   4. IPFS CID v1 형식 확인 (46 bytes, multiformats 명세)
 *   5. 업로드 소요 시간 측정
 *
 * 입력 파일 (Step 2 출력):
 *   - did_document.json
 *   - vc_document.json
 *   - vc_hashes.json
 *
 * 설정:
 *   PINATA_JWT 환경변수로 JWT 토큰을 전달한다.
 *   실행 전: export PINATA_JWT="eyJhbGci..."
 *
 * 의존 패키지:
 *   npm install node-fetch form-data
 *
 * 실행 방법:
 *   PINATA_JWT="your_jwt_here" node ipfs_pinata.js
 * ============================================================
 */

"use strict"

const crypto   = require("crypto")
const fs       = require("fs")
const path     = require("path")
const fetch    = require("node-fetch")
const FormData = require("form-data")

// ============================================================
// 설정
// ============================================================

const PINATA_JWT     = process.env.PINATA_JWT
const PINATA_API_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS"
const IPFS_GATEWAY   = "https://gateway.pinata.cloud/ipfs"

// Step 2 출력 파일 경로
const DID_DOC_FILE  = "did_document.json"
const VC_DOC_FILE   = "vc_document.json"
const HASHES_FILE   = "vc_hashes.json"

const LOG_FILE      = "ipfs_results.txt"

// ============================================================
// 유틸리티
// ============================================================

/** 문자열 → SHA-256 대문자 hex */
function sha256hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex").toUpperCase()
}

/** CID 바이트 길이 확인 (UTF-8 인코딩 기준) */
function cidByteLength(cid) {
  return Buffer.byteLength(cid, "utf8")
}

/** 로그 유틸리티 */
fs.writeFileSync(
  LOG_FILE,
  `IPFS Pinata 오프체인 저장 연동 실험\n실행시각: ${new Date().toLocaleString("ko-KR")}\n${"=".repeat(60)}\n`,
  "utf8"
)

function log(msg = "") {
  console.log(msg)
  fs.appendFileSync(LOG_FILE, msg + "\n", "utf8")
}

function logSection(title) {
  log(`\n${"─".repeat(60)}\n[${title}]\n${"─".repeat(60)}`)
}

// ============================================================
// Pinata 업로드 함수
// ============================================================

/**
 * 파일을 Pinata IPFS에 업로드하고 CID를 반환한다.
 *
 * @param {string} filePath  - 업로드할 파일 경로
 * @param {string} pinName   - Pinata 핀 이름 (메타데이터)
 * @returns {Promise<{cid, elapsedMs, cidBytes}>}
 */
async function uploadToPinata(filePath, pinName) {
  const fileContent = fs.readFileSync(filePath)
  const fileName    = path.basename(filePath)

  const form = new FormData()
  form.append("file", fileContent, { filename: fileName, contentType: "application/json" })
  form.append("pinataMetadata", JSON.stringify({ name: pinName }))
  form.append("pinataOptions",  JSON.stringify({ cidVersion: 1 }))  // CIDv1 요청

  const startMs = Date.now()

  const response = await fetch(PINATA_API_URL, {
    method:  "POST",
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
      ...form.getHeaders()
    },
    body: form
  })

  const elapsedMs = Date.now() - startMs

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Pinata 업로드 실패 (${response.status}): ${errText}`)
  }

  const data     = await response.json()
  const cid      = data.IpfsHash
  const cidBytes = cidByteLength(cid)

  return { cid, elapsedMs, cidBytes }
}

// ============================================================
// 메인 실험
// ============================================================

async function main() {

  // ── JWT 확인 ───────────────────────────────────────────
  if (!PINATA_JWT) {
    console.error("오류: PINATA_JWT 환경변수가 설정되지 않았습니다.")
    console.error("실행 방법: PINATA_JWT=\"your_jwt_here\" node ipfs_pinata.js")
    process.exit(1)
  }

  // ── 입력 파일 확인 ────────────────────────────────────
  for (const f of [DID_DOC_FILE, VC_DOC_FILE, HASHES_FILE]) {
    if (!fs.existsSync(f)) {
      console.error(`오류: ${f} 파일이 없습니다. Step 2를 먼저 실행하세요.`)
      process.exit(1)
    }
  }

  const prevHashes = JSON.parse(fs.readFileSync(HASHES_FILE, "utf8"))
  log("Step 2 해시 로드 완료")
  log(`  VC SHA-256  : ${prevHashes.vc_sha256}`)
  log(`  DID SHA-256 : ${prevHashes.did_sha256}`)

  // ── 1. DID 문서 업로드 ────────────────────────────────
  logSection("1. DID 문서 IPFS 업로드")

  const didRaw  = fs.readFileSync(DID_DOC_FILE, "utf8")
  const didHash = sha256hex(didRaw)

  log(`  업로드 전 SHA-256 : ${didHash}`)
  log(`  Step 2 기준 해시  : ${prevHashes.did_sha256}`)
  log(`  해시 일치         : ${didHash === prevHashes.did_sha256 ? "✅" : "❌ (파일 변경됨)"}`)

  const didResult = await uploadToPinata(DID_DOC_FILE, "did_document_dissertation")

  log(`  CID               : ${didResult.cid}`)
  log(`  CID 바이트 길이   : ${didResult.cidBytes} bytes`)
  log(`  업로드 소요 시간  : ${didResult.elapsedMs} ms`)
  log(`  게이트웨이 URL    : ${IPFS_GATEWAY}/${didResult.cid}`)

  // ── 2. VC 문서 업로드 ─────────────────────────────────
  logSection("2. VC 문서 IPFS 업로드")

  const vcRaw  = fs.readFileSync(VC_DOC_FILE, "utf8")
  const vcHash = sha256hex(vcRaw)

  log(`  업로드 전 SHA-256 : ${vcHash}`)
  log(`  Step 2 기준 해시  : ${prevHashes.vc_sha256}`)
  log(`  해시 일치         : ${vcHash === prevHashes.vc_sha256 ? "✅" : "❌ (파일 변경됨)"}`)

  const vcResult = await uploadToPinata(VC_DOC_FILE, "vc_document_dissertation")

  log(`  CID               : ${vcResult.cid}`)
  log(`  CID 바이트 길이   : ${vcResult.cidBytes} bytes`)
  log(`  업로드 소요 시간  : ${vcResult.elapsedMs} ms`)
  log(`  게이트웨이 URL    : ${IPFS_GATEWAY}/${vcResult.cid}`)

  // ── 3. CID 형식 검증 ──────────────────────────────────
  logSection("3. IPFS CID 형식 검증")

  // CIDv1은 'b'로 시작하는 base32 인코딩
  const didCidValid = didResult.cid.startsWith("b") && didResult.cidBytes >= 40
  const vcCidValid  = vcResult.cid.startsWith("b")  && vcResult.cidBytes  >= 40

  log(`  DID CID 형식 (CIDv1 base32): ${didCidValid ? "PASS ✅" : "FAIL ❌"}`)
  log(`  VC  CID 형식 (CIDv1 base32): ${vcCidValid  ? "PASS ✅" : "FAIL ❌"}`)
  log(`  ※ 3.4.1절 IPFS CID v1 = 46 bytes 가정과 실측 비교:`)
  log(`    DID CID 실측: ${didResult.cidBytes} bytes (설계값 46 bytes)`)
  log(`    VC  CID 실측: ${vcResult.cidBytes}  bytes (설계값 46 bytes)`)

  // ── 4. 온체인 앵커링값 산출 ───────────────────────────
  logSection("4. 온체인 앵커링값 산출")

  // 온체인에 기록할 값: CID 문자열의 SHA-256
  // 실제 시스템에서는 XRPL Memo 필드에 이 값을 기록한다
  const didCidHash = sha256hex(didResult.cid)
  const vcCidHash  = sha256hex(vcResult.cid)

  log(`  DID CID → SHA-256 (온체인 앵커링값): ${didCidHash}`)
  log(`  VC  CID → SHA-256 (온체인 앵커링값): ${vcCidHash}`)
  log(`  ※ 실제 구현에서는 이 해시값을 XRPL Memo 필드에 기록`)

  // ── 5. 결과 저장 ──────────────────────────────────────
  logSection("5. 실험 결과 요약")

  const allPass = didCidValid && vcCidValid &&
                  didHash === prevHashes.did_sha256 &&
                  vcHash  === prevHashes.vc_sha256

  const outputData = {
    experiment:    "Step 3 IPFS Pinata 연동",
    timestamp:     new Date().toISOString(),
    did_document: {
      cid:            didResult.cid,
      cid_bytes:      didResult.cidBytes,
      upload_ms:      didResult.elapsedMs,
      sha256:         didHash,
      cid_sha256:     didCidHash,
      gateway_url:    `${IPFS_GATEWAY}/${didResult.cid}`
    },
    vc_document: {
      cid:            vcResult.cid,
      cid_bytes:      vcResult.cidBytes,
      upload_ms:      vcResult.elapsedMs,
      sha256:         vcHash,
      cid_sha256:     vcCidHash,
      gateway_url:    `${IPFS_GATEWAY}/${vcResult.cid}`
    },
    verification: {
      did_hash_match: didHash === prevHashes.did_sha256,
      vc_hash_match:  vcHash  === prevHashes.vc_sha256,
      did_cid_valid:  didCidValid,
      vc_cid_valid:   vcCidValid
    }
  }

  fs.writeFileSync("ipfs_results.json", JSON.stringify(outputData, null, 2), "utf8")

  log(`  DID 해시 일치    : ${outputData.verification.did_hash_match ? "PASS ✅" : "FAIL ❌"}`)
  log(`  VC  해시 일치    : ${outputData.verification.vc_hash_match  ? "PASS ✅" : "FAIL ❌"}`)
  log(`  DID CID 형식     : ${outputData.verification.did_cid_valid  ? "PASS ✅" : "FAIL ❌"}`)
  log(`  VC  CID 형식     : ${outputData.verification.vc_cid_valid   ? "PASS ✅" : "FAIL ❌"}`)
  log("")
  log("저장 파일:")
  log("  ipfs_results.json — CID·해시·소요시간 상세 결과")
  log("  ipfs_results.txt  — 본 실험 로그")
  log("")
  log(allPass
    ? "=== 모든 검증 통과 — 4.2.3절 IPFS 오프체인 저장 연동 검증 완료 ✅ ==="
    : "=== 일부 검증 실패 — 결과를 확인하세요 ❌ ===")
}

main().catch(err => {
  console.error("오류:", err.message)
  process.exit(1)
})
