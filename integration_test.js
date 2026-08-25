/**
 * ============================================================
 * 통합 실험 스크립트 — End-to-End 기능 검증
 * ============================================================
 *
 * 실험 목적:
 *   3장 설계의 전체 흐름을 단일 스크립트로 연결하여
 *   시스템의 end-to-end 실행 가능성을 검증한다.
 *
 * 실행 흐름:
 *   [Phase 1 — 1회 수행]
 *   1. 저자·발급자 키 쌍 생성
 *   2. W3C DID 문서 생성
 *   3. VC 생성 및 ECDSA 서명
 *   4. DID 문서·VC 원문 IPFS 업로드 → CID 획득
 *   5. VC CID의 SHA-256 = 온체인 앵커링 해시 산출
 *
 *   [Phase 2 — ITERATIONS회 반복]
 *   6. XRPL 지갑 쌍 생성 (funder, receiver)
 *   7. EscrowCreate
 *      - Condition: PREIMAGE-SHA-256 (oracle_sig 역할)
 *      - Memo: VC CID 앵커링 해시 포함 (온체인 연결 증거)
 *   8. EscrowFinish (Fulfillment 제출)
 *   9. Memo 해시 검증 — 온체인 기록 vs Phase 1 산출값 일치 확인
 *
 * 측정 항목:
 *   - Phase 1 전체 소요 시간 (DID/VC 생성 + IPFS 업로드)
 *   - Phase 2 반복당 EscrowCreate / EscrowFinish 소요 시간·수수료
 *   - Memo 해시 일치 여부 (온체인 앵커링 검증)
 *
 * 설정:
 *   PINATA_JWT 환경변수 필수
 *   실행: PINATA_JWT="eyJhbGci..." node integration_test.js
 *
 * 의존 패키지:
 *   npm install xrpl @noble/secp256k1 node-fetch@2 form-data
 * ============================================================
 */

"use strict"

const xrpl     = require("xrpl")
const crypto   = require("crypto")
const fs       = require("fs")
const path     = require("path")
const fetch    = require("node-fetch")
const FormData = require("form-data")

// ============================================================
// 실험 설정
// ============================================================

/** 반복 횟수 (초도 테스트: 3, 본실험: 100) */
const ITERATIONS = 100

const WS_URL         = "wss://s.altnet.rippletest.net:51233"
const PINATA_API_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS"
const IPFS_GATEWAY   = "https://gateway.pinata.cloud/ipfs"

/** Memo 타입 식별자 (UTF-8 → hex) */
const MEMO_TYPE   = Buffer.from("application/xrpl-escrow-vc-anchor").toString("hex").toUpperCase()
const MEMO_FORMAT = Buffer.from("text/plain").toString("hex").toUpperCase()

// ============================================================
// 유틸리티
// ============================================================

const crypto_node = crypto

function sha256hex(data) {
  const str = typeof data === "string" ? data : JSON.stringify(data)
  return crypto_node.createHash("sha256").update(str, "utf8").digest("hex").toUpperCase()
}

function sha256bytes(data) {
  return new Uint8Array(crypto_node.createHash("sha256").update(data).digest())
}

function toHex(arr) {
  return Buffer.from(arr).toString("hex").toUpperCase()
}

function nowISO() { return new Date().toISOString() }

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length }

function stdDev(arr) {
  const m = mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// ============================================================
// 로그 유틸리티
// ============================================================

const LOG_FILE = "integration_results.txt"
const CSV_FILE = "integration_results.csv"

fs.writeFileSync(
  LOG_FILE,
  `통합 실험 — End-to-End 기능 검증\n` +
  `실행시각: ${new Date().toLocaleString("ko-KR")}\n` +
  `반복횟수: ${ITERATIONS}\n` +
  `${"=".repeat(64)}\n`,
  "utf8"
)
fs.writeFileSync(
  CSV_FILE,
  "iteration,phase1_ms,create_ms,create_fee,finish_ms,finish_fee,memo_valid,vc_cid,escrow_hash\n",
  "utf8"
)

function log(msg = "") {
  console.log(msg)
  fs.appendFileSync(LOG_FILE, msg + "\n", "utf8")
}

function logSection(title) {
  log(`\n${"─".repeat(64)}\n[${title}]\n${"─".repeat(64)}`)
}

function appendCsv(line) {
  fs.appendFileSync(CSV_FILE, line + "\n", "utf8")
}

// ============================================================
// Phase 1 — DID/VC 생성 및 IPFS 업로드
// ============================================================

async function runPhase1(secp) {
  const phase1Start = Date.now()

  // 1. 키 쌍 생성
  const authorPriv = secp.utils.randomSecretKey()
  const authorPub  = secp.getPublicKey(authorPriv, true)
  const issuerPriv = secp.utils.randomSecretKey()
  const issuerPub  = secp.getPublicKey(issuerPriv, true)

  const authorAddr = "rMockAuthor" + toHex(authorPub).slice(0, 8)
  const issuerAddr = "rMockIssuer" + toHex(issuerPub).slice(0, 8)
  const authorDid  = `did:xrpl:${authorAddr}`
  const issuerDid  = `did:xrpl:${issuerAddr}`
  const mockOrcid  = "https://orcid.org/0000-0002-MOCK-0001"
  const targetDoi  = "10.1234/mock.dissertation.2026"

  // 2. DID 문서 생성
  const didDoc = {
    "@context": ["https://www.w3.org/ns/did/v1",
                 "https://w3id.org/security/suites/secp256k1-2019/v1"],
    "id": authorDid,
    "verificationMethod": [{
      "id": `${authorDid}#key-1`,
      "type": "EcdsaSecp256k1VerificationKey2019",
      "controller": authorDid,
      "publicKeyHex": toHex(authorPub)
    }],
    "authentication":  [`${authorDid}#key-1`],
    "assertionMethod": [`${authorDid}#key-1`],
    "service": [{
      "id":              `${authorDid}#orcid`,
      "type":            "OrcidProfile",
      "serviceEndpoint": mockOrcid
    }],
    "created": nowISO()
  }
  const didDocStr  = JSON.stringify(didDoc, null, 2)
  const didDocHash = sha256hex(didDocStr)

  // 3. VC 생성 및 ECDSA 서명
  const vcSubject = {
    id: authorDid, orcid: mockOrcid, doi: targetDoi,
    role: "Author",
    claim: "This subject authored the scholarly work identified by the DOI."
  }
  const vcPayloadHash = sha256bytes(Buffer.from(JSON.stringify(vcSubject), "utf8"))
  const vcSigBytes    = secp.sign(vcPayloadHash, issuerPriv)
  const vcSigHex      = toHex(vcSigBytes)

  const vc = {
    "@context": ["https://www.w3.org/2018/credentials/v1", "https://schema.org"],
    "type":     ["VerifiableCredential", "ScholarlyAuthorshipCredential"],
    "id":       `urn:uuid:${crypto.randomUUID()}`,
    "issuer":   issuerDid,
    "issuanceDate": nowISO(),
    "credentialSubject": vcSubject,
    "proof": {
      "type":               "EcdsaSecp256k1Signature2019",
      "created":            nowISO(),
      "verificationMethod": `${issuerDid}#key-1`,
      "proofPurpose":       "assertionMethod",
      "publicKeyHex":       toHex(issuerPub),
      "jws":                vcSigHex
    }
  }
  const vcStr  = JSON.stringify(vc, null, 2)
  const vcHash = sha256hex(vcStr)

  // 4. IPFS 업로드
  const didCid = await uploadToIPFS(didDocStr, "did_document.json", "did_integration")
  const vcCid  = await uploadToIPFS(vcStr,     "vc_document.json",  "vc_integration")

  // 5. 온체인 앵커링 해시 = SHA-256(VC CID 문자열)
  const vcCidAnchorHash = sha256hex(vcCid)

  const phase1Ms = Date.now() - phase1Start

  return {
    phase1Ms,
    authorDid, issuerDid, targetDoi,
    didDocHash, vcHash,
    didCid, vcCid,
    vcCidAnchorHash,   // ← Memo에 기록할 값
    issuerPubHex: toHex(issuerPub)
  }
}

async function uploadToIPFS(content, filename, pinName) {
  const form = new FormData()
  form.append("file", Buffer.from(content), {
    filename,
    contentType: "application/json"
  })
  form.append("pinataMetadata", JSON.stringify({ name: pinName }))
  form.append("pinataOptions",  JSON.stringify({ cidVersion: 1 }))

  const res = await fetch(PINATA_API_URL, {
    method:  "POST",
    headers: { Authorization: `Bearer ${process.env.PINATA_JWT}`, ...form.getHeaders() },
    body:    form
  })
  if (!res.ok) throw new Error(`IPFS 업로드 실패: ${await res.text()}`)
  const data = await res.json()
  return data.IpfsHash
}

// ============================================================
// Phase 2 — XRPL Escrow 실행 (반복)
// ============================================================

async function runPhase2(client, vcCidAnchorHash, iteration) {
  const funder   = (await client.fundWallet()).wallet
  const receiver = (await client.fundWallet()).wallet

  // Condition 생성 (oracle_sig 역할 — Fulfillment는 오라클이 제출)
  const preimage      = crypto.randomBytes(32)
  const preimageHex   = preimage.toString("hex").toUpperCase()
  const conditionHash = crypto.createHash("sha256").update(preimage).digest("hex").toUpperCase()
  const conditionHex  = "A0258020" + conditionHash + "810120"
  const fulfillHex    = "A0228020" + preimageHex

  // Memo: VC CID 앵커링 해시를 온체인에 기록
  const memoData = Buffer.from(vcCidAnchorHash).toString("hex").toUpperCase()

  // EscrowCreate
  const createStart = Date.now()
  const createTx    = {
    TransactionType: "EscrowCreate",
    Account:         funder.address,
    Destination:     receiver.address,
    Amount:          xrpl.xrpToDrops("10"),
    Condition:       conditionHex,
    CancelAfter:     xrpl.isoTimeToRippleTime(
                       new Date(Date.now() + 24 * 60 * 60 * 1_000)
                     ),
    Memos: [{
      Memo: {
        MemoType:   MEMO_TYPE,
        MemoFormat: MEMO_FORMAT,
        MemoData:   memoData
      }
    }]
  }
  const createResult = await client.submitAndWait(createTx, { wallet: funder })
  const createMs     = Date.now() - createStart
  const createTxJson = createResult.result.tx_json
  const createFee    = Number(createTxJson.Fee)
  const createHash   = createResult.result.hash

  // Memo 검증 — 온체인 기록값 vs Phase 1 산출값
  const onchainMemo  = createTxJson.Memos?.[0]?.Memo?.MemoData ?? ""
  const decodedMemo  = Buffer.from(onchainMemo, "hex").toString("utf8")
  const memoValid    = (decodedMemo === vcCidAnchorHash)

  // EscrowFinish
  const finishStart = Date.now()
  const finishTx    = {
    TransactionType: "EscrowFinish",
    Account:         receiver.address,
    Owner:           funder.address,
    OfferSequence:   createTxJson.Sequence,
    Condition:       conditionHex,
    Fulfillment:     fulfillHex
  }
  const finishResult = await client.submitAndWait(finishTx, { wallet: receiver })
  const finishMs     = Date.now() - finishStart
  const finishTxJson = finishResult.result.tx_json
  const finishFee    = Number(finishTxJson.Fee)
  const finishHash   = finishResult.result.hash

  return {
    createMs, createFee, createHash,
    finishMs, finishFee, finishHash,
    memoValid, decodedMemo
  }
}

// ============================================================
// 통계 출력
// ============================================================

function printStats(label, msArr, feeArr) {
  log(`  --- ${label} ---`)
  log(`  평균    (ms)    : ${mean(msArr).toFixed(3)}`)
  log(`  표준편차(ms)    : ${stdDev(msArr).toFixed(3)}`)
  log(`  최솟값  (ms)    : ${Math.min(...msArr)}`)
  log(`  최댓값  (ms)    : ${Math.max(...msArr)}`)
  log(`  p95     (ms)    : ${percentile(msArr, 95).toFixed(3)}`)
  log(`  평균수수료(drops): ${mean(feeArr).toFixed(3)}`)
}

// ============================================================
// 메인 실행
// ============================================================

async function main() {
  // 환경변수 확인
  if (!process.env.PINATA_JWT) {
    console.error("오류: PINATA_JWT 환경변수가 필요합니다.")
    console.error("실행: PINATA_JWT=\"eyJhbGci...\" node integration_test.js")
    process.exit(1)
  }

  // noble/secp256k1 초기화
  const secp = await import("@noble/secp256k1")
  secp.hashes.sha256 = sha256bytes
  secp.hashes.hmacSha256 = (key, ...msgs) =>
    new Uint8Array(
      crypto.createHmac("sha256", key)
            .update(Buffer.concat(msgs.map(m => Buffer.from(m))))
            .digest()
    )

  const client = new xrpl.Client(WS_URL)

  const createMsArr  = []
  const createFeeArr = []
  const finishMsArr  = []
  const finishFeeArr = []
  const phase1MsArr  = []
  let   memoPassCount = 0

  try {
    await client.connect()
    log(`XRPL Testnet 연결 완료: ${WS_URL}`)

    for (let i = 1; i <= ITERATIONS; i++) {
      log(`\n${"=".repeat(64)}`)
      log(`반복 ${i}/${ITERATIONS}`)
      log(`${"=".repeat(64)}`)

      let phase1, phase2

      try {
        // ── Phase 1 ──────────────────────────────────────
        logSection(`Phase 1 — DID/VC 생성 + IPFS 업로드 (반복 ${i})`)

        phase1 = await runPhase1(secp)

        log(`  저자 DID           : ${phase1.authorDid}`)
        log(`  발급자 DID         : ${phase1.issuerDid}`)
        log(`  대상 DOI           : ${phase1.targetDoi}`)
        log(`  DID 온체인 해시    : ${phase1.didDocHash}`)
        log(`  VC  온체인 해시    : ${phase1.vcHash}`)
        log(`  DID IPFS CID       : ${phase1.didCid}`)
        log(`  VC  IPFS CID       : ${phase1.vcCid}`)
        log(`  VC CID 앵커링 해시 : ${phase1.vcCidAnchorHash}`)
        log(`  Phase 1 소요 시간  : ${phase1.phase1Ms} ms`)

        // ── Phase 2 ──────────────────────────────────────
        logSection(`Phase 2 — XRPL Escrow 실행 (반복 ${i})`)

        phase2 = await runPhase2(client, phase1.vcCidAnchorHash, i)

        log(`  EscrowCreate       : ${phase2.createMs} ms  Fee=${phase2.createFee} drops`)
        log(`  EscrowCreate Hash  : ${phase2.createHash}`)
        log(`  EscrowFinish       : ${phase2.finishMs} ms  Fee=${phase2.finishFee} drops`)
        log(`  EscrowFinish Hash  : ${phase2.finishHash}`)
        log(`  Memo 온체인 기록값 : ${phase2.decodedMemo}`)
        log(`  Memo 해시 일치     : ${phase2.memoValid ? "PASS ✅" : "FAIL ❌"}`)

      } catch (iterErr) {
        const msg = `[${i}] 오류 발생 (건너뜀): ${iterErr.message}`
        log(msg)
        continue
      }

      // 통계 누적
      phase1MsArr.push(phase1.phase1Ms)
      createMsArr.push(phase2.createMs)
      createFeeArr.push(phase2.createFee)
      finishMsArr.push(phase2.finishMs)
      finishFeeArr.push(phase2.finishFee)
      if (phase2.memoValid) memoPassCount++

      // CSV 기록
      appendCsv(
        `${i},${phase1.phase1Ms},${phase2.createMs},${phase2.createFee},` +
        `${phase2.finishMs},${phase2.finishFee},${phase2.memoValid},` +
        `${phase1.vcCid},${phase2.createHash}`
      )

      log(`\n  반복 ${i} 완료`)
    }

    // ── 요약 통계 ──────────────────────────────────────
    const n = createMsArr.length
    if (n < 1) {
      log("\n경고: 성공한 반복이 없어 통계 산출 불가")
      return
    }

    logSection(`요약 통계 (성공 ${n}회 기준)`)
    log(`  Phase 1 평균 소요 시간 : ${mean(phase1MsArr).toFixed(1)} ms`)
    log(`  Memo 해시 일치율       : ${memoPassCount}/${n} (${(memoPassCount/n*100).toFixed(1)}%)`)
    log("")
    printStats("EscrowCreate", createMsArr, createFeeArr)
    log("")
    printStats("EscrowFinish", finishMsArr, finishFeeArr)

    // CSV 요약 행
    appendCsv(`AVERAGE,,${mean(createMsArr).toFixed(3)},${mean(createFeeArr).toFixed(3)},${mean(finishMsArr).toFixed(3)},${mean(finishFeeArr).toFixed(3)},${memoPassCount}/${n},,`)
    appendCsv(`STDDEV,,${stdDev(createMsArr).toFixed(3)},,${stdDev(finishMsArr).toFixed(3)},,,`)
    appendCsv(`P95,,${percentile(createMsArr,95).toFixed(3)},,${percentile(finishMsArr,95).toFixed(3)},,,`)

    log("")
    log("저장 파일:")
    log(`  ${LOG_FILE}  — 실험 상세 로그`)
    log(`  ${CSV_FILE}  — 수치 데이터 (논문 표 입력용)`)
    log("")

    const allMemoPass = memoPassCount === n
    log(allMemoPass
      ? `=== 통합 실험 완료 — 온체인 앵커링 연결 검증 성공 ✅ ===`
      : `=== 통합 실험 완료 — Memo 불일치 ${n - memoPassCount}건 확인 필요 ❌ ===`)

  } catch (err) {
    log(`치명적 오류: ${err.message}`)
    console.error(err)
  } finally {
    await client.disconnect()
    log("XRPL 연결 종료")
  }
}

main()
